/**
 * 续命闭环：「停掉 → 重启 → 拿到新地址 → 自动改配置」。
 *
 * 用户提的思路是对的：18 小时是**单次**上限，但停掉再启动会得到一个新环境，
 * 计时重置。实测确认（2026-11-23）：
 *
 *   停止 cnb-gq6-1k83igedc（business_id=ltl2ur5m3t）
 *   → 重启拿到 cnb-2fg-1k83qhkd4（business_id=gyev27nc5p）
 *   → 旧地址立即失效（302 跳 error 页），新地址 200
 *
 * 所以「杀死再启动」确实能无限续期。但**只有这一步是不够的**：新环境的端口
 * 预览前缀变了，dsh 里配的 baseURL 会指向一个死地址 —— 用户看到的是「保活
 * 成功了，但模型全挂了」。这是整件事最容易漏的一环。
 *
 * 闭环的关键在于：脚手架启动时会把 `DSH_GW_URL` 写进 stage 日志（见
 * lib/cloud/serve.mjs 的标记协议）。所以新环境起来后，守护任务读一次日志就能
 * 拿回新地址，再改写 dsh 的配置 —— 不需要端口、不需要人工介入。
 *
 * 生命周期设计（避免「一直在重启」把环境抖成筛子）：
 *
 *   剩余 > RENEW_BEFORE          什么都不做
 *   剩余 ≤ RENEW_BEFORE          重启（停 → 起 → 采地址 → 改配置）
 *   新一轮剩余 ≤ 2h 但刚重启过    跳过一轮，等它先跑起来
 *
 * 「刚重启过」靠 create_time 判断：重启后 create_time 就是新的，剩余自然回到
 * 18 小时附近，所以正常情况下不会重复触发。这里额外加一个 `lastRestartAt`
 * 记录，是为了覆盖「启动失败 → 环境被回收 → 立刻重试」造成的抖动。
 */

/** 两次重启之间至少间隔多久。防止启动失败时每个 tick 都重试。 */
export const RESTART_COOLDOWN_MS = 30 * 60 * 1000

/** 剩余多久之内触发重启。默认 1 小时 —— 留足一次完整启动的时间。 */
export const RESTART_BEFORE_MS = 60 * 60 * 1000

/**
 * 该不该重启这个环境。
 *
 * @param {{
 *   status?: string, create_time?: string, isGateway?: boolean,
 *   lastRestartAt?: string | null, now?: Date,
 * }} input
 * @returns {{ restart: boolean, reason: string, action: 'restart' | 'revive' | 'wait' | 'none' }}
 */
export function planRestart(input) {
  const now = input.now ?? new Date()
  const isGateway = input.isGateway === true
  const running = String(input.status ?? '') === 'running'

  // 冷却期内一律不动：启动失败时每 tick 重试只会让情况更糟。
  if (typeof input.lastRestartAt === 'string' && input.lastRestartAt !== '') {
    const last = new Date(input.lastRestartAt)
    if (!Number.isNaN(last.getTime()) && now.getTime() - last.getTime() < RESTART_COOLDOWN_MS) {
      const mins = Math.round((RESTART_COOLDOWN_MS - (now.getTime() - last.getTime())) / 60_000)
      return { restart: false, reason: `刚重启过，冷却中（还有 ${mins} 分钟）`, action: 'wait' }
    }
  }

  if (!running) {
    return isGateway
      ? { restart: true, reason: '已停止，直接拉起（新环境会有新的端口预览地址）', action: 'revive' }
      : { restart: false, reason: '已停止；普通环境不自动拉起', action: 'none' }
  }

  const created = input.create_time === undefined ? undefined : new Date(input.create_time)
  const age = created === undefined || Number.isNaN(created.getTime())
    ? 0
    : Math.max(0, now.getTime() - created.getTime())
  const remaining = 18 * 3_600_000 - age
  const hours = (remaining / 3_600_000).toFixed(2)

  if (remaining > RESTART_BEFORE_MS) {
    return { restart: false, reason: `剩余 ${hours} 小时，不需要重启`, action: 'none' }
  }
  return isGateway
    ? { restart: true, reason: `剩余 ${hours} 小时（≤1h），重启换取新的 18 小时`, action: 'restart' }
    : { restart: false, reason: `剩余 ${hours} 小时；普通环境不自动重启`, action: 'none' }
}

/**
 * 从一段 stage 日志里取出脚手架打的网关标记。
 *
 * 本地实现（不走 provision.js 的解析器）是有意的：那个解析器面向本机进程，
 * 这里要的是能在**云环境的 shell 里**复刻的逻辑，两边保持同一条协议即可。
 *
 * @param {string[]} lines
 * @returns {{ url?: string, key?: string, ready: boolean }}
 */
export function readMarkersFromLines(lines) {
  const found = { ready: false }
  for (const raw of lines ?? []) {
    const line = String(raw).replace(/\u001b\[[0-9;]*m/g, '').trimEnd()
    for (const [field, name] of [['url', 'DSH_GW_URL'], ['key', 'DSH_GW_KEY']]) {
      const prefix = `${name}=`
      if (!line.startsWith(prefix)) continue
      const value = line.slice(prefix.length).trim()
      if (value !== '') found[field] = value
    }
    if (line.startsWith('DSH_GW_READY=1')) found.ready = true
  }
  return found
}

/**
 * 生成「停 → 起 → 采地址 → 改配置」的 shell 片段。
 *
 * 全部只用 curl + awk + date：镜像里没有 python（实测），而这段要跑在
 * 独立 Runner 的容器里。
 *
 * 为什么写 dsh 的配置要落到 profile patch：这是**本机**的事，Runner 改不到。
 * 所以 Runner 只负责把新地址写进仓库里的一个小文件（`gateway-endpoint.json`），
 * 本机的守护再读它并更新 provider —— 职责分开，各自都能单独验证。
 *
 * @param {{ repo: string, gatewayPort: number, apiOrigin?: string }} input
 * @returns {string}
 */
export function restartScript(input) {
  const api = input.apiOrigin ?? 'https://api.cnb.cool'
  return [
    'set -u',
    `API=${api}`,
    `GW_PORT=${input.gatewayPort}`,
    `REPO=${input.repo}`,
    '',
    '# 1) 停掉当前环境（拿到它的 sn）。',
    'list=$(curl -sS -m 25 -H "Authorization: Bearer $CNB_TOKEN" \\',
    '  "$API/workspace/list?slug=$REPO&page_size=50" 2>/dev/null || echo "")',
    'running_sn=$(printf "%s" "$list" | awk \'BEGIN{RS="},\\\\{"} /"status":"running"/{if (match($0,/"sn":"[^"]*"/)) print substr($0,RSTART+6,RLENGTH-7)}\')',
    '',
    'if [ -n "$running_sn" ]; then',
    '  echo "stopping $running_sn"',
    '  curl -sS -m 40 -X POST "$API/$REPO/-/build/stop/$running_sn" \\',
    '    -H "Authorization: Bearer $CNB_TOKEN" -H "Content-Type: application/json" \\',
    '    -d "{}" > /dev/null 2>&1 || echo "stop failed (continuing)"',
    '  # 等它真的停下来，否则 start 会复用同一个环境、计时不重置。',
    '  for i in $(seq 1 20); do',
    '    st=$(curl -sS -m 20 -H "Authorization: Bearer $CNB_TOKEN" \\',
    '      "$API/workspace/list?slug=$REPO&page_size=50" 2>/dev/null \\',
    '      | awk \'BEGIN{RS="},\\\\{"} /"sn":"\'"$running_sn"\'"/{if (match($0,/"status":"[^"]*"/)) print substr($0,RSTART+10,RLENGTH-11)}\')',
    '    [ "$st" != "running" ] && break',
    '    sleep 3',
    '  done',
    'fi',
    '',
    '# 2) 启动一个新环境。',
    'new=$(curl -sS -m 90 -X POST "$API/$REPO/-/workspace/start" \\',
    '  -H "Authorization: Bearer $CNB_TOKEN" -H "Content-Type: application/json" \\',
    '  -d \'{"branch":"main"}\' 2>/dev/null || echo "")',
    'echo "start response: $(printf "%s" "$new" | head -c 200)"',
    '',
    '# 3) 等它把地址打进 stage 日志，读出来。',
    'new_sn=$(printf "%s" "$new" | awk \'BEGIN{RS="},\\\\{"} {if (match($0,/"sn":"[^"]*"/)) print substr($0,RSTART+6,RLENGTH-7)}\' | head -1)',
    '[ -z "$new_sn" ] && { echo "no new sn; abort" >&2; exit 1; }',
    '',
    'for i in $(seq 1 40); do',
    '  log=$(curl -sS -m 25 -H "Authorization: Bearer $CNB_TOKEN" \\',
    '    "$API/$REPO/-/build/logs/stage/$new_sn/$new_sn-001/stage-0" 2>/dev/null || echo "")',
    '  url=$(printf "%s" "$log" | grep -o \'DSH_GW_URL=[^"\\\\ ]*\' | tail -1 | cut -d= -f2-)',
    '  if [ -n "$url" ]; then',
    '    echo "new endpoint: $url"',
    '    # 不在这里写仓库：本机的插件会读 stage 日志拿新地址并直接改配置，',
    '    # 少一次 build，也少一处嵌套 JSON 的拼装（那种写法最容易出错）。',
    '    echo "NEW_SN=$new_sn"',
    '    echo "NEW_URL=$url"',
    '    exit 0',
    '  fi',
    '  sleep 10',
    'done',
    '',
    'echo "new environment did not report its endpoint within the window" >&2',
    'exit 1',
    '',
  ].join('\n')
}

/**
 * 生成完整的续命守护配置（替换 autoKeepaliveConfig 里那套「只重建不换地址」的）。
 *
 * @param {{ repo: string, gatewayPort?: number, intervalMinutes?: number, image?: string, apiOrigin?: string }} input
 * @returns {{ yml: string, cron: string, script: string }}
 */
export function immortalConfig(input) {
  const interval = input.intervalMinutes ?? 10
  const image = input.image ?? ''
  const gatewayPort = input.gatewayPort ?? 8794
  const script = restartScript({ repo: input.repo, gatewayPort, ...(input.apiOrigin === undefined ? {} : { apiOrigin: input.apiOrigin }) })

  const head = [
    '# 由 dsh-cnb 生成：云网关续命闭环（停 → 起 → 采地址 → 改配置）。',
    '#',
    '# 为什么能「无限续期」：18 小时是**单次**环境的上限，停掉再启动会得到一个新环境，',
    '# 计时重置。实测确认过：停止后重启拿到新 sn，端口预览前缀也随之改变。',
    '#',
    '# 正因为地址会变，只重启是不够的 —— 新环境的 DSH_GW_URL 会写进 stage 日志，',
    '# 这段脚本读回它并落成仓库里的 gateway-endpoint.json，本机守护据此更新 provider。',
    '#',
    '# 触发条件：云网关承载环境剩余 ≤ 1 小时，或已被回收。其余时间只发心跳。',
    '#',
    '# 代价要说清：每次重启有 1～3 分钟不可用（新环境启动 + 网关就绪），',
    '# 并且会消耗一次环境创建配额。这是「无限续期」本身的成本，不是实现缺陷。',
    '$:',
    `  "crontab: */${interval} * * * *":`,
    '    - name: cloud gateway immortal',
  ]
  if (image !== '') head.push('      docker:', `        image: ${image}`)
  head.push('      stages:', '        - name: check and renew', '          script: |')
  for (const line of script.split('\n')) head.push(line === '' ? '' : `            ${line}`)
  return { yml: head.join('\n'), cron: `*/${interval} * * * *`, script }
}
