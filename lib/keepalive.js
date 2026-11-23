/**
 * 云环境保活：把「还能活多久、为什么、怎么办」说清楚。
 *
 * 平台规则（官方文档 /zh/workspaces/workspace-recycling.md，逐条抄的）：
 *
 *   1. 创建后 10 分钟内没进 VS Code 页面 → 回收
 *   2. 打开页面后关闭，超过 10 分钟无操作 → 回收
 *   3. 最大保持时间 18 小时（默认），**持续心跳可维持**
 *   4. 使用超过 8 小时、且处于凌晨 4–6 点 → 强制回收（「环境不过夜」）
 *
 * 第 3 条是保活能起作用的地方：心跳从**环境外部**经 CNB 网关打进来，平台就认为
 * 这个环境在被使用。实测依据：本仓库环境已连续运行 5.8 小时且期间长期无人工
 * 操作，正是靠 crontab 每 5 分钟一次的外部心跳维持的。
 *
 * 第 4 条**保活救不了**：它是按「使用时长 + 时钟」判定的，不是按活跃度。所以
 * 这里的职责不是假装能绕过它，而是提前算出来告诉用户「几点会被收」，好让人
 * 安排在之前重建。这一点很重要 —— 一个不说明这一条的保活界面是在骗人。
 *
 * 心跳必须来自外部：容器内自己 curl localhost 不算（平台按进入环境的连接判定）。
 * 这就是为什么本模块产出的方案一律是「另一个 Runner 去 ping 它」，而不是
 * 「环境里起个定时器」。
 */

/** 官方默认值，可与平台返回的 `duration` 交叉验证。 */
export const MAX_KEEP_MS = 18 * 60 * 60 * 1000
/** 「环境不过夜」的判定阈值。 */
export const OVERNIGHT_USED_MS = 8 * 60 * 60 * 1000
/** 凌晨强制回收窗口（本地时区小时，左闭右开）。 */
export const OVERNIGHT_HOURS = [4, 6]
/** 空闲回收的分钟数。 */
export const IDLE_MINUTES = 10

/**
 * 环境启动至今多久。
 * @param {{ create_time?: string, duration?: number }} workspace
 * @param {Date} [now]
 */
export function ageMs(workspace, now = new Date()) {
  /**
   * **只用 create_time。**
   *
   * 早先这里优先用了平台返回的 `duration`，当成「累计秒数」。实测发现它不是：
   * 一个真实运行 1736 秒的环境 `duration=325661`，另一个运行 2703 秒的
   * `duration=328373` —— 两者只差 2.7k，而真实时长差了一倍，比值也不固定
   * （约 187 倍）。它更像某种剩余配额/计数值，拿来算运行时长会把 0.5 小时
   * 算成 90 小时，界面上就会出现「已运行 3599 小时」这种荒唐数字。
   *
   * `create_time` 是绝对时间戳，与本地时钟相减语义明确，所以只认它。
   */
  const created = workspace?.create_time === undefined ? undefined : new Date(workspace.create_time)
  if (created === undefined || Number.isNaN(created.getTime())) return 0
  return Math.max(0, now.getTime() - created.getTime())
}

/**
 * 距离 18 小时上限还剩多久。
 * @param {{ create_time?: string, duration?: number }} workspace
 * @param {Date} [now]
 */
export function remainingMs(workspace, now = new Date()) {
  return Math.max(0, MAX_KEEP_MS - ageMs(workspace, now))
}

/**
 * 下一次凌晨强制回收的时点，以及它是否**已经在生效范围内**。
 *
 * 「使用超过 8 小时 + 处于 4–6 点」两个条件同时满足才回收。所以：
 *   · 已经用满 8 小时 → 下一个 4 点就会被收（如果现在就在 4–6 点，就是马上）；
 *   · 还没用满 8 小时 → 到 4 点时若累计已超 8 小时才算，否则不受影响。
 *
 * @param {{ create_time?: string, duration?: number }} workspace
 * @param {Date} [now]
 * @returns {{ at: string | null, active: boolean, reason: string }}
 */
export function overnightDeadline(workspace, now = new Date()) {
  const age = ageMs(workspace, now)
  const hour = now.getHours()
  const inWindow = hour >= OVERNIGHT_HOURS[0] && hour < OVERNIGHT_HOURS[1]
  if (age >= OVERNIGHT_USED_MS && inWindow) {
    // 已经在窗口里且超过 8 小时：随时可能被收 —— 这才是「紧迫」。
    return {
      at: now.toISOString(),
      active: true,
      imminent: true,
      ageAtDeadlineHours: Number((age / 3_600_000).toFixed(2)),
      reason: '已超 8 小时且处于凌晨 4–6 点强制回收窗口，随时可能被收',
    }
  }
  // 找下一次 4 点。
  const next = new Date(now)
  next.setHours(OVERNIGHT_HOURS[0], 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  const ageThen = age + (next.getTime() - now.getTime())
  const willBeOldEnough = ageThen >= OVERNIGHT_USED_MS
  /**
   * 两个条件要一起看，否则提示会误导：
   *   · 到 4 点时累计不足 8 小时 → 这条规则根本不适用（环境还年轻）；
   *   · 到 4 点时已经超过 18 小时硬上限 → 它会更早因为上限被收，
   *     「凌晨回收」这件事就轮不到它，不该拿它吓人。
   */
  const withinHardLimit = ageThen < MAX_KEEP_MS
  const active = willBeOldEnough && withinHardLimit
  return {
    at: next.toISOString(),
    active,
    // 还没进窗口：是「会」被收，但不是「马上就要」。
    imminent: false,
    ageAtDeadlineHours: Number((ageThen / 3_600_000).toFixed(2)),
    reason: !willBeOldEnough
      ? '到那个 4 点时累计使用不足 8 小时，不受不过夜策略影响'
      : !withinHardLimit
        ? '到那个 4 点前就已超过 18 小时上限，会更早被回收（凌晨回收轮不到它）'
        : '到那个 4 点时累计使用已超 8 小时，会被强制回收',
  }
}

/**
 * 一个环境此刻的保活体检。
 *
 * @param {{ sn?: string, slug?: string, pipeline_id?: string, status?: string, create_time?: string, duration?: number, business_id?: string }} workspace
 * @param {{ now?: Date, gatewayPort?: number }} [options]
 * @returns {{
 *   sn: string | null, repo: string | null, status: string,
 *   ageHours: number, remainingHours: number, expiresAt: string | null,
 *   overnight: ReturnType<typeof overnightDeadline>,
 *   previewUrl: string | null,
 *   heartbeat: { target: string | null, reachable: boolean | null, note: string },
 *   verdict: 'running' | 'stopped' | 'expiring' | 'overnight-risk',
 *   advice: string,
 * }}
 */
export function inspectWorkspace(workspace, options = {}) {
  const now = options.now ?? new Date()
  const status = String(workspace?.status ?? 'unknown')
  const age = ageMs(workspace, now)
  const remaining = remainingMs(workspace, now)
  const overnight = overnightDeadline(workspace, now)
  /**
   * 探测端口**按环境用途选**，不能全用网关端口。
   *
   * 实测踩过：对 DSH 栈的 k 环境探 8794 得到 500（dial tcp ... connection
   * refused），因为它跑的是 3080 的 DSH Web，根本没有网关。把「端口打不通」
   * 当成「心跳无效」会冤枉一个健康的环境。
   *
   * 所以：网关承载环境用 gatewayPort（默认 8794），其它用其自身服务端口
   * （servicePort，默认 3080）。`options.gateway` 由调用方标明。
   */
  const gatewayPort = options.gatewayPort ?? 8794
  const servicePort = options.servicePort ?? 3080
  const port = options.gateway === true ? gatewayPort : servicePort
  const preview = typeof workspace?.business_id === 'string' && workspace.business_id !== ''
    ? `https://${workspace.business_id}-${port}.cnb.run`
    : null

  const running = status === 'running'
  let verdict = running ? 'running' : 'stopped'
  if (running && remaining < 60 * 60 * 1000) verdict = 'expiring'
  /**
   * 凌晨回收要按**紧迫度**分级，不能一律标红。
   *
   * 「到次日 4 点会被收」对多数环境都成立（跑几小时后加上到 4 点的时长，很容易
   * 就过 8 小时），但那是十几个小时之后的事，和「一小时内就没了」不是同一件
   * 事。一律标红的结果是用户看到满屏红，然后学会忽略它 —— 告警就失效了。
   *
   * 所以只在**已经进入窗口**（真的随时会被收）时才算 risk；还没到窗口的，
   * 用 `overnight-soon` 单独一档。
   */
  if (running && overnight.active) {
    verdict = overnight.imminent === true ? 'overnight-risk' : 'overnight-soon'
  }

  return {
    sn: workspace?.sn ?? null,
    repo: workspace?.slug ?? null,
    status,
    ageHours: Number((age / 3_600_000).toFixed(2)),
    remainingHours: Number((remaining / 3_600_000).toFixed(2)),
    expiresAt: running ? new Date(now.getTime() + remaining).toISOString() : null,
    overnight,
    previewUrl: preview,
    probePort: port,
    heartbeat: {
      target: preview,
      reachable: null,
      // 这里只描述「怎么算有效」，不假装已经测过 —— 探测由调用方真打一次再填。
      note: '心跳必须从环境外部经 CNB 网关打进来；容器内 curl localhost 不算。',
    },
    verdict,
    advice: adviceFor({ running, remaining, overnight }),
  }
}

/**
 * 给人一句能照做的话。
 * @param {{ running: boolean, remaining: number, overnight: ReturnType<typeof overnightDeadline> }} input
 */
export function adviceFor(input) {
  if (!input.running) return '环境已停止；需要时重新启动，保活才能继续。'
  if (input.overnight.active) {
    return '已进入凌晨强制回收窗口（超 8 小时 + 4–6 点）。这条任何心跳都挡不住，'
      + '平台按使用时长判定；请在它被收之前确认状态已落盘，环境会自动重建。'
  }
  if (input.remaining < 3_600_000) {
    return '距 18 小时上限不足 1 小时，即将回收。心跳也无法突破这个上限，'
      + '请把需要保留的东西提交到仓库，或安排重建。'
  }
  const hours = Math.floor(input.remaining / 3_600_000)
  return `持续心跳可维持运行；距 18 小时上限还有约 ${hours} 小时。`
}

/**
 * 生成外部心跳配置：一个跑在**独立 Runner** 上的定时任务。
 *
 * 为什么必须独立 Runner：平台按「进入环境的连接」判定活跃，而这个连接不能由
 * 环境自己发起。`crontab` 触发的是另一个容器，它 curl 环境的端口预览域名，
 * 请求经 CNB 网关进来 —— 这正是平台认的心跳。
 *
 * @param {{ repo: string, port?: number, intervalMinutes?: number, image?: string }} input
 * @returns {{ yml: string, cron: string }}
 */
export function heartbeatConfig(input) {
  const port = input.port ?? 8794
  const minutes = input.intervalMinutes ?? 5
  const image = input.image ?? ''
  // docker 块要么两行、要么没有 —— 用变量拼，避免在模板里嵌套模板。  // 用数组拼行，避免在模板字符串里再嵌模板、也避免缩进靠肉眼对齐。
  const body = [
    '# 由 dsh-cnb 生成：给云环境发外部心跳，维持活跃（防止 10 分钟空闲回收）。',
    '#',
    '# 为什么需要它：平台按「进入环境的连接」判定活跃，容器内 curl localhost 不算。',
    '# 这段 crontab 跑在独立 Runner 上，请求经 CNB 网关进入环境，才是有效心跳。',
    '#',
    '# 注意：它只挡「空闲回收」，挡不住 18 小时上限与凌晨 4–6 点的不过夜策略 ——',
    '# 那两条按使用时长判定，与活跃度无关。',
    '$:',
    `  "crontab: */${minutes} * * * *":`,
    '    - name: keep-alive heartbeat',
  ]
  if (image !== '') {
    body.push('      docker:', `        image: ${image}`)
  }
  body.push(
    '      stages:',
    '        - name: ping running workspace',
    '          script: |',
    '            set -eu',
    '            # 逐个 running 环境发一次真实请求；401 也说明请求到达了环境。',
    `            for repo in ${input.repo}; do`,
    '              json=$(curl -sS -m 20 -H "Authorization: Bearer $CNB_TOKEN" \\',
    '                "https://api.cnb.cool/workspace/list?slug=$repo&status=running&page_size=20" || true)',
    '              for bid in $(printf \'%s\' "$json" | grep -o \'"business_id":"[^"]*"\' | cut -d\'"\' -f4); do',
    `                url="https://\${bid}-${port}.cnb.run/"`,
    '                code=$(curl -sS -o /dev/null -w \'%{http_code}\' -m 15 "$url" || echo 000)',
    '                echo "$(date -u +%FT%TZ) $url -> $code"',
    '              done',
    '            done',
    '',
  )
  return { yml: body.join('\n'), cron: `*/${minutes} * * * *` }
  return { yml, cron: `*/${minutes} * * * *` }
}

/**
 * 一批环境的体检汇总，给面板直接渲染。
 * @param {Array<Record<string, unknown>>} workspaces
 * @param {{ now?: Date, gatewayPort?: number, routeRepo?: string }} [options]
 */
export function inspectAll(workspaces, options = {}) {
  const rows = (workspaces ?? []).map((workspace) => {
    // 先判断它是不是云网关承载环境 —— 探测端口取决于这个，顺序不能反。
    const isGateway = options.routeRepo !== undefined && workspace?.slug === options.routeRepo
    const row = inspectWorkspace(workspace, { ...options, gateway: isGateway })
    return { ...row, gateway: isGateway }
  })
  // 危险的在前面：用户先看到需要处理的。
  // 真紧迫的排最前：已进窗口 > 快到上限 > 今晚会被收 > 正常 > 已停。
  const rank = { 'overnight-risk': 0, expiring: 1, 'overnight-soon': 2, running: 3, stopped: 4 }
  rows.sort((a, b) => (rank[a.verdict] ?? 9) - (rank[b.verdict] ?? 9))
  return {
    total: rows.length,
    running: rows.filter((row) => row.status === 'running').length,
    expiring: rows.filter((row) => row.verdict === 'expiring').length,
    overnightRisk: rows.filter((row) => row.verdict === 'overnight-risk').length,
    // 今晚会被凌晨规则收，但还没进窗口 —— 与「马上就要被收」分开计数。
    overnightSoon: rows.filter((row) => row.verdict === 'overnight-soon').length,
    gateway: rows.find((row) => row.gateway === true) ?? null,
    rows,
  }
}
