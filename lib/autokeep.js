/**
 * 全自动守护：一个盯着环境的 crontab，做「心跳 + 滚动重建」。
 *
 * 先把能力边界说清楚，否则很容易做成假自动化：
 *
 *   · **10 分钟空闲**：挡得住。外部请求经 CNB 网关进来就算活跃。
 *   · **18 小时硬上限**：挡不住。到点必收。能做的只有「在被收之前把新的起好」，
 *     让服务不中断 —— 这是**滚动续命**，不是延长寿命。
 *   · **凌晨 4–6 点不过夜**：同样挡不住，它按使用时长判定。但重建后累计时长
 *     归零，所以重建本身也把这条绕开了（属于副作用，不是目的）。
 *
 * 判断与动作（每个环境独立）：
 *
 *   运行中、剩余 > 2h              → 只发心跳
 *   运行中、剩余 ≤ 2h、是网关承载   → 滚动重建
 *   运行中、剩余 ≤ 2h、普通环境      → 报告，不擅自重建
 *   已停止、是网关承载              → 自动拉起
 *   已停止、普通环境                → 报告
 *
 * 普通环境不自动重建是刻意的：重启一个正在被人用的开发环境会丢未提交的工作，
 * 那种「自动化」比不动更糟。网关承载环境例外 —— 它断了模型就全断，可用性
 * 优先于「可能存在的未提交工作」，而且插件会先起新的、不主动停旧的。
 *
 * ---
 *
 * 实现上有一条硬约束：**镜像里没有 python**。第一版用 python3 解析 JSON，
 * 在真实云环境里直接 `parse failed`，整个守护静默失效 —— 而它看起来「部署成功」。
 * 所以现在只用 `awk` + `paste` + `date`，这些在镜像里都有。
 */
import { MAX_KEEP_MS } from './keepalive.js'

/** 剩余多久之内就该规划重建。留 2 小时，够一次启动 + 失败重试。 */
export const RENEW_BEFORE_MS = 2 * 60 * 60 * 1000

/** 18 小时上限折成秒，写进 shell 时用。 */
const MAX_KEEP_SECONDS = Math.floor(MAX_KEEP_MS / 1000)

/**
 * 一个环境该怎么处理。纯函数，便于测试。
 *
 * @param {{ status?: string, create_time?: string, isGateway?: boolean, now?: Date }} input
 * @returns {{ action: 'heartbeat' | 'renew' | 'revive' | 'report', reason: string, urgent: boolean }}
 */
export function planAction(input) {
  const now = input.now ?? new Date()
  const isGateway = input.isGateway === true
  const running = String(input.status ?? '') === 'running'
  /**
   * 默认策略是 `keep`：只发心跳，让环境自然活满 18 小时，**不新建**。
   *
   * 这是额度受限时的正确选择：重建换来的只是服务连续性，代价是每次都消耗一次
   * 环境创建配额，而且有 1–3 分钟中断。撑满 18 小时再自然结束，反而更省。
   * 需要连续可用时才 opt-in `renew`。
   */
  const policy = input.renewPolicy === 'renew' ? 'renew' : 'keep'

  if (!running) {
    if (!isGateway) {
      return { action: 'report', reason: '已停止；普通环境不擅自重启（可能有未提交的工作）', urgent: false }
    }
    // 即使策略是 keep，环境已经没了也得拉起来 —— 否则网关彻底不可用。
    return { action: 'revive', reason: '云网关承载环境已停止，模型全部不可用 —— 先拉起再说', urgent: true }
  }

  const created = input.create_time === undefined ? undefined : new Date(input.create_time)
  const age = created === undefined || Number.isNaN(created.getTime())
    ? 0
    : Math.max(0, now.getTime() - created.getTime())
  const remaining = Math.max(0, MAX_KEEP_MS - age)
  const hours = (remaining / 3_600_000).toFixed(1)

  if (remaining > RENEW_BEFORE_MS) {
    return { action: 'heartbeat', reason: `剩余 ${hours} 小时，发心跳即可`, urgent: false }
  }
  // 剩余 ≤2 小时。keep 策略下不重建，只说清还有多久到期。
  if (policy === 'keep') {
    return isGateway
      ? {
          action: 'heartbeat',
          reason: `剩余 ${hours} 小时，心跳继续维持到 18 小时上限（keep 策略：不新建环境，省额度）。到期后按需重建。`,
          urgent: false,
          expiresSoon: true,
        }
      : {
          action: 'report',
          reason: `剩余 ${hours} 小时；普通环境只报告，不擅自重启（重启会丢未提交的工作）。`,
          urgent: false,
          expiresSoon: true,
        }
  }
  return isGateway
    ? { action: 'renew', reason: `剩余 ${hours} 小时（≤2h），按 renew 策略滚动重建`, urgent: true }
    : { action: 'report', reason: `剩余 ${hours} 小时（≤2h）；普通环境只报告，请自行提交并重启`, urgent: true }
}

/**
 * 生成守护用的 shell 脚本正文（不含 YAML 外壳）。
 *
 * 抽出来是为了能单独跑 `sh -n` 和真实试跑 —— YAML 里嵌 shell 出错时极难看出。
 *
 * @param {{ repos: string[], gatewayRepo: string, gatewayPort: number, servicePort: number, renewPolicy?: 'keep' | 'renew' }} input
 * @returns {string}
 */
export function daemonScript(input) {
  /**
   * 选探测端口。用 if 而不是 `[ ... ] && ...`：后者在条件为假时返回非零，
   * 配合 set -u/-e 会把循环直接打断（实测：`port: parameter not set`）。
   */
  const portFor = [
    'port=$SVC_PORT',
    'if [ "$gw" = "1" ]; then port=$GW_PORT; fi',
  ].join('\n    ')
  return [
    'set -u',
    'API=https://api.cnb.cool',
    `GW_PORT=${input.gatewayPort}`,
    `SVC_PORT=${input.servicePort}`,
    `GW_REPO="${input.gatewayRepo}"`,
    'RENEW_BEFORE=7200',
    `POLICY="${input.renewPolicy === 'renew' ? 'renew' : 'keep'}"`,
    '',
    '# 从一段 workspace/list JSON 里取一个字段的所有值，每条记录一行（缺失则空行）。',
    '# 只依赖 awk：镜像里没有 python，用 python 会让整个守护静默失效。',
    'field() {',
    '  awk -v key="$1" \'',
    '    BEGIN { RS = "},\\\\{" }',
    '    {',
    '      pat = "\\"" key "\\":\\"[^\\"]*\\""',
    '      if (match($0, pat)) print substr($0, RSTART + length(key) + 4, RLENGTH - length(key) - 5)',
    '      else print ""',
    '    }\' "$2"',
    '}',
    '',
    `for repo in ${input.repos.join(' ')}; do`,
    '  echo "== $repo"',
    '  body=$(curl -sS -m 25 -H "Authorization: Bearer $CNB_TOKEN" \\',
    '    "$API/workspace/list?slug=$repo&page_size=50" 2>/dev/null || echo "")',
    '  if [ -z "$body" ]; then echo "  no data"; continue; fi',
    '',
    '  tmp=$(mktemp)',
    '  printf "%s" "$body" > "$tmp"',
    '  sn_list=$(field sn "$tmp")',
    '  st_list=$(field status "$tmp")',
    '  ct_list=$(field create_time "$tmp")',
    '  bid_list=$(field business_id "$tmp")',
    '  br_list=$(field branch "$tmp")',
    '  rm -f "$tmp"',
    '',
    '  # 五个字段各成一个列表，按行号对齐 —— 用 set -- 拆词会吃掉空行，字段就错位了。',
    '  count=$(printf "%s\\n" "$sn_list" | wc -l | tr -d " ")',
    '  # 先看这个仓库现在有没有在跑的：决定要不要复活停掉的。',
    '  has_running=$(printf "%s\\n" "$st_list" | grep -c "^running$" || true)',
    '  revived=0',
    '  i=1',
    '  while [ "$i" -le "$count" ]; do',
    '    sn=$(printf "%s\\n" "$sn_list" | sed -n "${i}p")',
    '    st=$(printf "%s\\n" "$st_list" | sed -n "${i}p")',
    '    ct=$(printf "%s\\n" "$ct_list" | sed -n "${i}p")',
    '    bid=$(printf "%s\\n" "$bid_list" | sed -n "${i}p")',
    '    br=$(printf "%s\\n" "$br_list" | sed -n "${i}p")',
    '    i=$((i + 1))',
    '    [ -z "$sn" ] && continue',
    '',
    '    gw=0; [ "$repo" = "$GW_REPO" ] && gw=1',
    '',
    '    age=0',
    '    if [ -n "$ct" ]; then',
    '      created=$(date -u -d "$ct" +%s 2>/dev/null || echo 0)',
    '      [ "$created" -gt 0 ] && age=$(( $(date -u +%s) - created ))',
    '    fi',
    `    remain=$(( ${MAX_KEEP_SECONDS} - age ))`,
    '',
    '    if [ "$st" != "running" ]; then',
    '      # 只有「当前没有任何运行中环境」时才有意义去拉起一个。',
    '      # 历史 closed 记录会一直留在列表里；逐个复活会把额度全部烧光',
    '      # （实测：一次守护把两个早已结束的环境都拉了起来）。',
    '      if [ "$gw" = "1" ] && [ "$has_running" = "0" ] && [ "$revived" = "0" ]; then',
    '        echo "  $sn STOPPED and nothing is running -> revive"',
    '        if curl -sS -m 60 -X POST "$API/$repo/-/workspace/start" \\',
    '             -H "Authorization: Bearer $CNB_TOKEN" -H "Content-Type: application/json" \\',
    '             -d "{\\"branch\\":\\"${br:-main}\\"}" > /dev/null 2>&1; then',
    '          echo "  revived $sn"',
    '          revived=1',
    '        else',
    '          echo "  revive FAILED $sn" >&2',
    '        fi',
    '      else',
    '        echo "  $sn stopped (no action)"',
    '      fi',
    '      continue',
    '    fi',
    '',
    `    ${portFor}`,
    '    if [ -n "$bid" ]; then',
    '      code=$(curl -sS -o /dev/null -w "%{http_code}" -m 15 "https://$bid-$port.cnb.run/" 2>/dev/null || echo 000)',
    '      echo "  $sn heartbeat -> $code (age ${age}s remain ${remain}s)"',
    '    else',
    '      echo "  $sn no business_id; heartbeat skipped"',
    '    fi',
    '',
    '    if [ "$remain" -lt "$RENEW_BEFORE" ]; then',
    '      if [ "$gw" != "1" ]; then',
    '        echo "  $sn near limit (not gateway; report only)"',
    '      elif [ "$POLICY" = "renew" ]; then',
    '        echo "  $sn renewing (remain ${remain}s, policy=renew)"',
    '        if curl -sS -m 90 -X POST "$API/$repo/-/workspace/start" \\',
    '             -H "Authorization: Bearer $CNB_TOKEN" -H "Content-Type: application/json" \\',
    '             -d "{\\"branch\\":\\"${br:-main}\\"}" > /dev/null 2>&1; then',
    '          echo "  renew requested"',
    '        else',
    '          echo "  renew FAILED (old one still serving)" >&2',
    '        fi',
    '      else',
    '        echo "  $sn expires in ${remain}s; policy=keep, holding to the 18h cap (no new environment)"',
    '      fi',
    '    fi',
    '  done',
    'done',
    '',
  ].join('\n')
}

/**
 * 生成完整的 `.cnb.yml` 片段。
 *
 * @param {{ repo: string, gatewayRepo?: string, gatewayPort?: number, servicePort?: number, intervalMinutes?: number, image?: string }} input
 * @returns {{ yml: string, cron: string, repos: string[], script: string }}
 */
export function autoKeepaliveConfig(input) {
  const interval = input.intervalMinutes ?? 5
  const image = input.image ?? ''
  const gatewayPort = input.gatewayPort ?? 8794
  const servicePort = input.servicePort ?? 3080
  const gatewayRepo = input.gatewayRepo ?? input.repo
  const repos = [...new Set([input.repo, gatewayRepo].filter(Boolean))]

  const renewPolicy = input.renewPolicy === 'renew' ? 'renew' : 'keep'
  const script = daemonScript({ repos, gatewayRepo, gatewayPort, servicePort, renewPolicy })
  const lines = [
    '# 由 dsh-cnb 生成：云环境全自动守护（心跳 + 滚动重建）。',
    '#',
    '# 跑在独立 Runner 上 —— 平台按「进入环境的连接」判定活跃，容器内 curl 不算。',
    '#',
    '# 能做到：',
    `#   · 重建策略：${renewPolicy === 'renew' ? 'renew（到点前滚动重建，消耗配额）' : 'keep（只保活，撑满 18 小时，不新建环境）'}；`,
    `#   · 每 ${interval} 分钟心跳一次，挡住「10 分钟空闲回收」；`,
    '#   · 云网关承载环境剩余 ≤2 小时、或已被回收时，自动滚动重建。',
    '#',
    '# 做不到：18 小时硬上限与凌晨 4–6 点不过夜策略按使用时长判定，无法延长，',
    '# 只能靠「到点前重建」让服务不中断。',
    '#',
    '# 普通环境只报告、不擅自重建 —— 重启正在用的开发环境会丢未提交的工作。',
    '$:',
    `  "crontab: */${interval} * * * *":`,
    '    - name: cloud keepalive daemon',
  ]
  if (image !== '') lines.push('      docker:', `        image: ${image}`)
  lines.push('      stages:', '        - name: keepalive + rolling renew', '          script: |')
  for (const line of script.split('\n')) lines.push(line === '' ? '' : `            ${line}`)
  return { yml: lines.join('\n'), cron: `*/${interval} * * * *`, repos, script }
}
