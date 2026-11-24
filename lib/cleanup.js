/**
 * 仓库清理：手动批量删除，以及「云网关建出来的仓库没人用了就自动删掉」。
 *
 * 这个模块只做**判断**，不发请求、不碰磁盘，所以每条规则都能离线断言 ——
 * 删除是不可逆的，把「该不该删」做成纯函数是唯一能让它可测、可审的形状。
 *
 * 四条边界，先说清楚（前三条是不可绕过的，没有配置项能放开）：
 *
 *   1. **绝不删正在承载网关的那个仓库。** 它由配置里的 provider（displayName 的
 *      `(org/repo)`）或内存状态指出；判错这一条会当场把模型全断掉。
 *   2. **环境只要还开着，那个仓库就受保护。** 人可能正在里面改东西，删掉会连
 *      未提交的工作一起抹掉。关掉环境之后才可清理 —— 这是唯一的条件。
 *   3. **自动清理只碰本插件建的云网关仓库。** 判据是名字
 *      `dsh-gateway-<日期>-<时间>` 或描述里的标记。用户自建的仓库一律不自动删：
 *      它们的价值判断只有人能做，要删请手动勾选 —— 那是明确的意图。
 *   4. 「不用了」的定义尽量机械：**最后一次活动（`updatedAt`）距今超过
 *      `maxAgeHours`**。默认 24 小时 —— 一次开通要几十秒，人在同一天里重试
 *      几次很常见，太短的窗口会把刚建的那个也扫进去。
 *
 * 环境记录（开发环境历史）是另一条判据，见 `judgeWorkspace`。
 */

/** 本插件自动建出来的仓库名形状：`dsh-gateway-20261124-123456`（冲突时带 4 位后缀）。 */
export const GATEWAY_NAME_PATTERN = /^dsh-gateway-\d{8}-\d{6}(?:-[a-z0-9]{3,8})?$/

/**
 * 描述里的标记。`provisionGateway` 自己写的是第一句；第二句是同一段描述的旧措辞，
 * 曾经手工建过的网关仓库可能只有它。两句都认，是为了让升级前后的仓库都能被识别。
 */
export const GATEWAY_DESCRIPTION_MARKERS = ['由 dsh-cnb 自动创建', '托管 CNB AI 网关代理', 'dsh-cnb']

/**
 * 自动清理的范围。**只有一种。**
 *
 * 曾经有 'prefix' 与 'all'，那是错的：自动清理这个功能的权力应当被限制在
 * 「收回它自己建出来的东西」——也就是云网关仓库。'all' 会让它去删用户自己的
 * 仓库，'prefix' 只是把同一种误删包装成有条件的。自建仓库的删除权属于人，
 * 通过手动勾选表达，不属于一个定时器。
 *
 * 常量保留给设置解析用：老配置里的 'prefix'/'all' 会被归一成 'gateway'。
 */
export const CLEANUP_SCOPES = ['gateway']

/**
 * 环境记录（workspace）的清理范围。
 *
 * 和仓库分开是刻意的：删仓库是不可逆的数据丢失，删一条已经结束的环境记录只是
 * 清掉一条历史。两者的风险差一个量级，所以默认值也不同 —— 仓库默认不自动删，
 * 环境记录默认就清（但只清「已结束」的）。
 */
export const CLEANUP_ENV_SCOPES = ['closed', 'all']

/**
 * 一个已停止的环境记录要保留多久。
 *
 * 默认 **2 小时**，不是 7 天。7 天那次实测下来是这样：手上有一堆早就结束的环境，
 * 面板上却一条都不清 —— 因为「结束」这个动作发生的时间往往就在几小时前，
 * 而记录本身再也不会被用到。留着它的唯一理由是「刚关掉、可能还要回看日志」，
 * 那个需求以小时计，不以天计。
 *
 * 2 小时仍然给回看留了余地，同时让「不跑的环境」当天就消失。
 * 想更保守就把它调大，判据本身不看别的。
 */
export const DEFAULT_ENV_MAX_AGE_HOURS = 2

/** 默认设置。自动删除默认**关闭**：删除不可逆，不能靠一次安装就替人决定。 */
export const DEFAULT_CLEANUP_SETTINGS = {
  enabled: false,
  scope: 'gateway',
  prefix: '',
  maxAgeHours: 24,
  keep: [],
  intervalMinutes: 30,
  dryRun: false,
  /**
   * 环境记录（开发环境历史）的清理，默认**开启但只清已结束的**。
   *
   * 与仓库那条相反的理由：一条已经结束的环境记录不承载任何数据，留着只是
   * 让「开发环境」列表越滚越长；而删错一条仓库是真的丢代码。所以这条默认清，
   * 但只清 `closed`，且默认保留 7 天 —— 刚结束的那次多半还要回看日志。
   */
  environments: true,
  envScope: 'closed',
  envMaxAgeHours: DEFAULT_ENV_MAX_AGE_HOURS,
}

/**
 * 单轮最多处理多少个目标。
 *
 * 50 太小了：环境记录会累积到几百条，一轮只清 50 条意味着用户要点四五次，
 * 而「自动清理」在无人值守时根本清不完 —— 每次定时器只啃掉最旧的一批。
 * 200 仍然是个有限的数（平台限流、日志可读性），但一次就能把常见规模清干净。
 */
export const CLEANUP_MAX_PER_RUN = 200

/** @param {unknown} value */
function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** @param {unknown} value @param {number} fallback */
function asNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/**
 * 归一化设置。
 *
 * 归一而不是报错：这些值来自面板输入框与工具参数，写错一个数字不该让整块功能
 * 变成「未配置」。真正无法归一的（范围名）退回默认值，并在 `rejected` 里报出来。
 *
 * @param {Record<string, unknown>} [input]
 * @param {{ fallback?: Record<string, unknown> }} [options]
 */
export function normalizeCleanupSettings(input = {}, options = {}) {
  const fallback = { ...DEFAULT_CLEANUP_SETTINGS, ...(options.fallback ?? {}) }
  const rejected = []
  const scope = asString(input.scope)
  const keep = Array.isArray(input.keep)
    ? [...new Set(input.keep.map((entry) => asString(entry)).filter(Boolean))]
    : fallback.keep
  // 老设置里的 prefix/all 会落在这里；不是错误，只是被归一掉。
  if (scope !== undefined && !CLEANUP_SCOPES.includes(scope)) rejected.push(`scope=${scope}`)
  const enabled = input.enabled === undefined ? fallback.enabled : input.enabled === true
  const dryRun = input.dryRun === undefined ? fallback.dryRun : input.dryRun === true
  const envScope = asString(input.envScope)
  if (envScope !== undefined && !CLEANUP_ENV_SCOPES.includes(envScope)) rejected.push(`envScope=${envScope}`)
  return {
    enabled,
    // 恒为 gateway：见 CLEANUP_SCOPES 的注释。
    scope: 'gateway',
    // 前缀为空时不能进 prefix 范围：那等于「全部」，必须让人显式选 all。
    prefix: asString(input.prefix) ?? fallback.prefix,
    maxAgeHours: Math.max(1, Math.round(asNumber(input.maxAgeHours, fallback.maxAgeHours))),
    keep,
    intervalMinutes: Math.min(1440, Math.max(5, Math.round(asNumber(input.intervalMinutes, fallback.intervalMinutes)))),
    dryRun,
    // 环境记录那条：默认 true，但只清 closed。
    environments: input.environments === undefined ? fallback.environments !== false : input.environments === true,
    envScope: envScope !== undefined && CLEANUP_ENV_SCOPES.includes(envScope) ? envScope : fallback.envScope,
    envMaxAgeHours: Math.max(1, Math.round(asNumber(input.envMaxAgeHours, fallback.envMaxAgeHours))),
    ...(rejected.length === 0 ? {} : { rejected }),
  }
}

/**
 * 这个仓库是不是本插件建的。
 *
 * 两个判据任一成立即可，因为两者都可能被改：用户可能改描述，也可能改名。
 * 只看名字会漏掉被改名的，只看描述会漏掉别人手工建的、但用了同一段描述的。
 *
 * @param {{ slug?: string, name?: string, description?: string }} repo
 * @returns {{ gateway: boolean, via: string | null }}
 */
export function isGatewayRepository(repo) {
  const slug = asString(repo?.slug) ?? ''
  const name = asString(repo?.name) ?? (slug.includes('/') ? slug.slice(slug.indexOf('/') + 1) : slug)
  if (GATEWAY_NAME_PATTERN.test(name)) return { gateway: true, via: 'name' }
  const description = asString(repo?.description) ?? ''
  for (const marker of GATEWAY_DESCRIPTION_MARKERS) {
    if (description.includes(marker)) return { gateway: true, via: 'description' }
  }
  return { gateway: false, via: null }
}

/** 仓库名（去掉组织）。@param {string} slug */
export function repoNameOf(slug) {
  const at = slug.indexOf('/')
  return at === -1 ? slug : slug.slice(at + 1)
}

/** 仓库是否还有环境在跑。@param {{ environments?: Array<{status?: string}> }} repo */
export function hasRunningEnvironment(repo) {
  const environments = Array.isArray(repo?.environments) ? repo.environments : []
  return environments.some((workspace) => String(workspace?.status ?? '').startsWith('running'))
}

/**
 * 匹配「按条件批量选中」：前缀、搜索串、是否只要网关仓库。
 *
 * @param {{ slug?: string, name?: string, description?: string }} repo
 * @param {{ prefix?: string, search?: string, gatewayOnly?: boolean }} filter
 */
export function matchesFilter(repo, filter = {}) {
  const slug = asString(repo?.slug) ?? ''
  if (slug === '') return false
  if (filter.gatewayOnly === true && !isGatewayRepository(repo).gateway) return false
  const prefix = asString(filter.prefix)
  if (prefix !== undefined && !repoNameOf(slug).startsWith(prefix) && !slug.startsWith(prefix)) return false
  const search = asString(filter.search)
  if (search !== undefined && !slug.toLowerCase().includes(search.toLowerCase())) return false
  return true
}

/** 距今天数：活动时间缺失时返回 null（缺失不等于很旧，不能当成可删）。 */
function ageHoursOf(updatedAt, now) {
  if (typeof updatedAt !== 'string' || updatedAt === '') return null
  const stamp = new Date(updatedAt)
  if (Number.isNaN(stamp.getTime())) return null
  return (now.getTime() - stamp.getTime()) / 3_600_000
}

/**
 * 云端定时任务要跑的那段脚本。
 *
 * 为什么是 Node 而不是 shell：镜像里**有** node（网关脚手架本身就是靠
 * `nohup node serve.mjs` 起的），但没有 python（`autokeep.js` 顶部的教训：
 * 第一版用 python3 解析 JSON，在真实环境里整个守护静默失效）。而 shell 里
 * 解析仓库列表 JSON 只能靠 awk 切字符串，字段一多就错位 —— 用 node 是这里
 * 唯一既可靠又有先例的选择。
 *
 * 判据必须与 `judgeRepository` 一致。做法是把**同一组常量**（名字正则、描述
 * 标记、阈值、保护名单）以 JSON 注入脚本，脚本里的判断顺序与 `judgeRepository`
 * 逐条对应；`cleanup-script.test.mjs` 用同一批夹具分别喂给两边，断言两者结论
 * 完全相同 —— 这才是「不分叉」的保证，注释里写「保持一致」不算。
 *
 * @param {{
 *   settings: ReturnType<typeof normalizeCleanupSettings>,
 *   activeRepo?: string | null,
 *   extraProtected?: string[],
 *   apiOrigin?: string,
 *   selfRepo?: string | null,
 *   activeSn?: string | null,
 * }} input
 * @returns {string} 可直接 `node` 执行的脚本文本
 */
export function cleanupDaemonScript(input) {
  const settings = normalizeCleanupSettings(input.settings ?? {})
  const config = {
    maxAgeHours: settings.maxAgeHours,
    keep: settings.keep ?? [],
    dryRun: settings.dryRun === true,
    // 环境记录那一半：默认开、只清 closed、运行中的永不动。
    environments: settings.environments === true,
    envScope: settings.envScope,
    envMaxAgeHours: settings.envMaxAgeHours,
    activeSn: typeof input.activeSn === 'string' && input.activeSn !== '' ? input.activeSn : '',
    namePattern: GATEWAY_NAME_PATTERN.source,
    descriptionMarkers: GATEWAY_DESCRIPTION_MARKERS,
    protectedRepos: [
      ...new Set([
        ...(typeof input.activeRepo === 'string' && input.activeRepo !== '' ? [input.activeRepo] : []),
        ...(Array.isArray(input.extraProtected) ? input.extraProtected.filter((entry) => typeof entry === 'string' && entry !== '') : []),
        ...(typeof input.selfRepo === 'string' && input.selfRepo !== '' ? [input.selfRepo] : []),
      ]),
    ],
    apiOrigin: input.apiOrigin ?? 'https://api.cnb.cool',
  }
  return `#!/usr/bin/env node
// 由 dsh-cnb 生成：云网关仓库自动清理的一次执行。不要手改 —— 改插件里的设置。
//
// 令牌从环境变量 CNB_CLEANUP_TOKEN 读，不落盘、不进日志。
// 判据与本机 lib/cleanup.js 用的是同一组常量，两边结论由测试逐条比对。
const CONFIG = ${JSON.stringify(config, null, 2)}
const TOKEN = process.env.CNB_CLEANUP_TOKEN || ''
if (TOKEN === '') {
  console.log('DSH_CLEANUP_SKIP=no token')
  process.exit(0)
}
const HEADERS = { authorization: 'Bearer ' + TOKEN, accept: 'application/json' }
const NAME_RE = new RegExp(CONFIG.namePattern)
const now = Date.now()

/** 本插件建的仓库：名字形状或描述标记，任一成立。 */
function isGateway(repo) {
  const name = String(repo.path || repo.name || '').split('/').pop() || ''
  if (NAME_RE.test(name)) return true
  const desc = String(repo.description || '')
  return CONFIG.descriptionMarkers.some((marker) => desc.includes(marker))
}

async function apiJson(path, init) {
  const response = await fetch(CONFIG.apiOrigin + path, { ...init, headers: { ...HEADERS, ...(init?.headers || {}) } })
  const text = await response.text()
  if (!response.ok) throw new Error(path + ' -> ' + response.status + ' ' + text.slice(0, 200))
  return text === '' ? {} : JSON.parse(text)
}

async function listRepos() {
  const out = []
  for (let page = 1; page <= 20; page += 1) {
    const body = await apiJson('/user/repos?page=' + page + '&page_size=100')
    const items = Array.isArray(body) ? body : []
    out.push(...items)
    if (items.length < 100) break
  }
  return out
}

/** 每个仓库还有没有环境在跑。拿不到就当作「有」—— 宁可不动。 */
async function runningBySlug() {
  try {
    const body = await apiJson('/workspace/list?page=1&page_size=100')
    const map = new Map()
    for (const workspace of body.list || []) {
      const slug = workspace.slug
      if (!slug) continue
      if (String(workspace.status || '').startsWith('running')) map.set(slug, true)
      else if (!map.has(slug)) map.set(slug, false)
    }
    return map
  } catch (error) {
    console.log('DSH_CLEANUP_WARN=cannot read workspaces: ' + error.message)
    return null
  }
}

/**
 * 环境记录该不该清。
 *
 * 与本机 judgeWorkspace 逐条对应 —— 包括最要紧的那条：**运行中的永远不动**，
 * 且不受 envScope 影响。envScope=all 的意思是「连别的状态也清」，不是
 * 「连正在跑的也清」；这两件事混在一起过，结果是选 all 就把活跃环境删了。
 */
function decideWorkspace(workspace) {
  const sn = String(workspace.sn || workspace.pipeline_id || '')
  const slug = String(workspace.slug || '')
  const status = String(workspace.status || '')
  if (sn === '') return { del: false, why: 'no-sn' }
  if (CONFIG.activeSn && sn === CONFIG.activeSn) return { del: false, why: 'self' }
  if (CONFIG.protectedRepos.includes(slug)) return { del: false, why: 'protected' }
  if (status.startsWith('running')) return { del: false, why: 'running' }
  if (CONFIG.envScope === 'closed' && status !== 'closed') return { del: false, why: 'not-closed' }
  if (!workspace.create_time) return { del: false, why: 'unknown-age' }
  const at = new Date(workspace.create_time).getTime()
  if (!Number.isFinite(at) || at === 0) return { del: false, why: 'unknown-age' }
  const ageHours = (now - at) / 3600000
  if (ageHours < CONFIG.envMaxAgeHours) return { del: false, why: 'too-new' }
  return { del: true, why: 'stale', ageHours: Math.round(ageHours) }
}

function decide(repo, running) {
  const slug = String(repo.path || repo.name || '')
  if (slug === '') return { del: false, why: 'no-slug' }
  if (CONFIG.protectedRepos.includes(slug)) return { del: false, why: 'protected' }
  if (running === null) return { del: false, why: 'running-unknown' }
  // 环境还开着就受保护，没有开关能放开（与本机 judgeRepository 一致）。
  if (running === true) return { del: false, why: 'running' }
  // 只碰本插件建的云网关仓库：自建仓库只由人手动删。
  if (!isGateway(repo)) return { del: false, why: 'not-gateway' }
  const stamp = repo.updated_at || repo.last_updated_at
  if (!stamp) return { del: false, why: 'unknown-age' }
  const at = new Date(stamp).getTime()
  if (!Number.isFinite(at) || at === 0) return { del: false, why: 'unknown-age' }
  const ageHours = (now - at) / 3600000
  if (ageHours < CONFIG.maxAgeHours) return { del: false, why: 'too-new' }
  return { del: true, why: 'unused', ageHours: Math.round(ageHours) }
}

/**
 * 清环境记录。
 *
 * 和仓库那一半一样，先判再删；区别是这里删的是**记录**不是数据，所以失败通常
 * 意味着权限不够（account-engage:rw），会把原因写进日志而不是静默跳过。
 */
async function cleanWorkspaces() {
  let list
  try {
    // 翻页读完：一页 100 条，而环境记录会累积到几百条。
    // 只读第一页的症状是「每轮只清掉一页」，自动清理永远清不完。
    list = []
    for (let page = 1; page <= 20; page += 1) {
      const body = await apiJson('/workspace/list?page=' + page + '&page_size=100')
      const items = body.list || []
      list.push(...items)
      const total = Number(body.total || 0)
      if (items.length === 0) break
      if (total > 0 && page * 100 >= total) break
      if (items.length < 100) break
    }
  } catch (error) {
    // 读不到就什么都不动 —— 不知道有什么，就不能删。
    console.log('DSH_CLEANUP_ENV_WARN=cannot read workspaces: ' + error.message)
    return
  }
  const verdicts = list.map((workspace) => ({ workspace, ...decideWorkspace(workspace) }))
  const targets = verdicts.filter((row) => row.del)
  console.log('DSH_CLEANUP_ENV_SCANNED=' + list.length)
  console.log('DSH_CLEANUP_ENV_TARGETS=' + targets.length)
  for (const row of targets) {
    const sn = String(row.workspace.sn || row.workspace.pipeline_id || '')
    if (CONFIG.dryRun) {
      console.log('DSH_CLEANUP_ENV_WOULD_DELETE=' + sn)
      continue
    }
    try {
      await apiJson('/workspace/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sn }),
      })
      console.log('DSH_CLEANUP_ENV_DELETED=' + sn)
    } catch (error) {
      console.log('DSH_CLEANUP_ENV_FAILED=' + sn + ' ' + error.message)
    }
  }
}

async function main() {
  const repos = await listRepos()
  const running = await runningBySlug()
  const verdicts = repos.map((repo) => ({ repo, ...decide(repo, running ? running.get(String(repo.path || repo.name || '')) === true : null) }))
  const targets = verdicts.filter((row) => row.del)
  console.log('DSH_CLEANUP_SCANNED=' + repos.length)
  console.log('DSH_CLEANUP_TARGETS=' + targets.length)
  for (const row of verdicts) {
    if (!row.del) continue
    const slug = String(row.repo.path || row.repo.name || '')
    if (CONFIG.dryRun) {
      console.log('DSH_CLEANUP_WOULD_DELETE=' + slug)
      continue
    }
    try {
      await apiJson('/' + slug, { method: 'DELETE' })
      console.log('DSH_CLEANUP_DELETED=' + slug)
    } catch (error) {
      // 根组织下的仓库走不通 Open API（errcode 9）；云端没有登录会话可用，
      // 所以只能报告，由本机面板会话删。
      console.log('DSH_CLEANUP_FAILED=' + slug + ' ' + error.message)
    }
  }
  // 环境记录放在仓库之后：先删仓库，它的环境记录会自然失效，下一轮清就干净了。
  // 反过来会在这一轮留下「指向已删仓库的孤儿记录」。
  if (CONFIG.environments) await cleanWorkspaces()
  console.log('DSH_CLEANUP_DONE=1')
}

main().catch((error) => {
  console.log('DSH_CLEANUP_ERROR=' + error.message)
  process.exit(1)
})
`
}

/** 人类可读的年龄。@param {number | null} hours */
export function describeAge(hours) {
  if (hours === null || !Number.isFinite(hours)) return '时间未知'
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} 分钟前`
  if (hours < 48) return `${Math.round(hours)} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

/**
 * 判一个仓库该不该被清理。
 *
 * 返回的 `reason` 是给人看的一句话，`code` 用于测试与聚合。顺序是刻意的：
 * 受保护 > 正在用 > 范围 > 太新。判断顺序如果反过来，「太新」会掩盖
 * 「这是正在承载网关的那个」这种致命结论。
 *
 * @param {{ repo: Record<string, any>, settings: ReturnType<typeof normalizeCleanupSettings>, protectedSet: Set<string>, now: Date }} input
 * @returns {{ delete: boolean, code: string, reason: string, repo: string, ageHours: number | null, gateway: boolean }}
 */
export function judgeRepository(input) {
  const repo = input.repo
  const slug = asString(repo?.slug) ?? ''
  const gateway = isGatewayRepository(repo)
  const ageHours = ageHoursOf(repo?.updatedAt, input.now)
  const base = { repo: slug, ageHours, gateway: gateway.gateway, via: gateway.via }
  const verdict = (skip) => ({ ...base, delete: false, code: skip.code, reason: skip.reason })

  if (input.protectedSet.has(slug)) {
    return verdict({ code: 'protected', reason: '受保护（正在承载网关 / 在保留名单里）' })
  }
  /**
   * **环境只要还开着，这个仓库就受保护 —— 没有任何开关能放开。**
   *
   * 这里原先有一个 `deleteRunning` 开关可以绕过，那是错的：一个还在跑的环境
   * 意味着人可能正在里面改东西，删掉仓库会连未提交的工作一起抹掉。既然「运行时
   * 受保护、关掉后才可清理」是明确的规则，就不该留一个能违反它的配置项。
   *
   * 想删这类仓库只有一条路：先把环境关掉（或到 cnb.cool 页面自己删）。
   */
  if (hasRunningEnvironment(repo)) {
    return verdict({ code: 'running', reason: '环境还开着 —— 关掉之后才会被清理' })
  }
  /**
   * **自动清理只碰本插件建的云网关仓库。**
   *
   * 自建的仓库一律不自动删：它们的价值判断只有人能做，而「猜错了」的代价是
   * 不可逆的代码丢失。要删就手动勾选 —— 那是明确的意图，不是启发式的猜测。
   * 这条同样没有开关：`scope: 'all'` 曾经存在过，它让「自动清理」变成了
   * 「自动删账号里所有不活跃的东西」，那不是这个功能该有的权力。
   */
  if (!gateway.gateway) {
    return verdict({ code: 'not-gateway', reason: '不是本插件建的云网关仓库 —— 自建仓库只由手动删除' })
  }
  if (ageHours === null) {
    return verdict({ code: 'unknown-age', reason: '读不到最后活动时间' })
  }
  if (ageHours < input.settings.maxAgeHours) {
    return verdict({
      code: 'too-new',
      reason: `还在活跃期（${describeAge(ageHours)} < ${input.settings.maxAgeHours} 小时）`,
    })
  }
  return {
    ...base,
    delete: true,
    code: 'gateway-unused',
    reason: `${describeAge(ageHours)}没有活动，超过 ${input.settings.maxAgeHours} 小时`,
  }
}

/**
 * 判一条环境记录该不该清。
 *
 * 与仓库那条判据的关键区别：**运行中的环境永远不动**，没有任何开关能放开。
 * 停掉一个正在被人用的开发环境会丢未提交的工作，那不是「清理」，是破坏；
 * 而环境记录的价值就在于它还在跑。所以 `deleteRunning` 那个开关只作用于仓库，
 * 这里连提都不提。
 *
 * 另外，环境记录的「年龄」用 `create_time` 而不是「最后活动」—— OpenAPI 只给
 * 创建时间。这会让人稍微保守一点（一个跑了两天然后停掉的环境看起来「很旧」），
 * 但 `closed` 状态本身就说明它已经结束了，年龄只是用来避开「刚关掉、还要回看日志」
 * 的那一段。
 *
 * @param {{
 *   workspace: Record<string, any>,
 *   settings: ReturnType<typeof normalizeCleanupSettings>,
 *   protectedRepos: Set<string>,
 *   activeSn?: string | null,
 *   now: Date,
 * }} input
 */
export function judgeWorkspace(input) {
  const workspace = input.workspace ?? {}
  const sn = asString(workspace.sn) ?? asString(workspace.pipeline_id) ?? ''
  const slug = asString(workspace.slug) ?? ''
  const status = String(workspace.status ?? '')
  const createdAt = typeof workspace.create_time === 'string' && workspace.create_time !== ''
    ? new Date(workspace.create_time)
    : null
  const ageHours = createdAt === null || Number.isNaN(createdAt.getTime())
    ? null
    : (input.now.getTime() - createdAt.getTime()) / 3_600_000
  const base = { sn, repo: slug, status, ageHours }
  const skip = (code, reason) => ({ ...base, delete: false, code, reason })

  if (sn === '') return skip('no-sn', '没有 sn，无法定位这条记录')
  // 正在承载 dsh 自己的那个环境：删了就把正在跑的这套连根拔掉。
  if (input.activeSn !== null && input.activeSn !== undefined && sn === input.activeSn) {
    return skip('self', '就是当前正在跑的这个环境')
  }
  if (input.protectedRepos.has(slug)) {
    return skip('protected', '所属仓库正在承载网关 / 在保留名单里')
  }
  /**
   * 运行中的一律不动，且**不看 envScope**。
   *
   * `envScope = 'all'` 的意思是「连属于别人的仓库的环境记录也清」，不是
   * 「连正在跑的也清」。这两件事被混在一起过，结果是选 all 就把活跃环境删了。
   */
  if (status.startsWith('running')) return skip('running', '环境正在运行')
  if (input.settings.envScope === 'closed' && status !== 'closed') {
    return skip('not-closed', `状态是 ${status || '未知'}，只清已结束的`)
  }
  if (ageHours === null) return skip('unknown-age', '读不到创建时间')
  if (ageHours < input.settings.envMaxAgeHours) {
    return skip('too-new', `刚结束不久（${describeAge(ageHours)} < ${input.settings.envMaxAgeHours} 小时）`)
  }
  return {
    ...base,
    delete: true,
    code: 'stale',
    reason: `${describeAge(ageHours)}创建、已结束`,
  }
}

/**
 * 从环境列表得出清理计划。
 *
 * @param {{
 *   workspaces: Array<Record<string, any>>,
 *   settings?: Record<string, unknown>,
 *   protectedRepos?: string[],
 *   activeSn?: string | null,
 *   now?: Date,
 * }} input
 */
export function planWorkspaceCleanup(input) {
  const now = input.now ?? new Date()
  const settings = normalizeCleanupSettings(input.settings ?? {})
  const protectedRepos = new Set(
    (Array.isArray(input.protectedRepos) ? input.protectedRepos : []).map((entry) => asString(entry)).filter(Boolean),
  )
  const deleting = []
  const kept = []
  // 同一个 sn 可能在列表里出现多次（分页重叠）；按「最该保留」的那条判一次即可。
  const seen = new Set()
  for (const workspace of Array.isArray(input.workspaces) ? input.workspaces : []) {
    const judged = judgeWorkspace({
      workspace,
      settings,
      protectedRepos,
      activeSn: input.activeSn ?? null,
      now,
    })
    if (seen.has(judged.sn)) continue
    seen.add(judged.sn)
    if (judged.delete) deleting.push(judged)
    else kept.push(judged)
  }
  deleting.sort((a, b) => (b.ageHours ?? 0) - (a.ageHours ?? 0))
  const limit = Math.max(1, Math.round(asNumber(input.limit, CLEANUP_MAX_PER_RUN)))
  return {
    settings,
    enabled: settings.environments === true,
    candidates: deleting.slice(0, limit),
    deferred: deleting.slice(limit),
    kept,
    summary: {
      scanned: deleting.length + kept.length,
      deletable: deleting.length,
      kept: kept.length,
      byCode: countBy(kept, (row) => row.code),
    },
  }
}

/**
 * 从仓库列表得出清理计划。
 *
 * @param {{
 *   repositories: Array<Record<string, any>>,
 *   settings?: Record<string, unknown>,
 *   activeRepo?: string | null,
 *   extraProtected?: string[],
 *   now?: Date,
 *   limit?: number,
 * }} input
 */
export function planRepositoryCleanup(input) {
  const now = input.now ?? new Date()
  const settings = normalizeCleanupSettings(input.settings ?? {})
  const protectedSet = new Set([
    ...(asString(input.activeRepo) === undefined ? [] : [asString(input.activeRepo)]),
    ...(Array.isArray(input.extraProtected) ? input.extraProtected.map((entry) => asString(entry)).filter(Boolean) : []),
    ...settings.keep,
  ])
  const deleting = []
  const kept = []
  for (const repo of Array.isArray(input.repositories) ? input.repositories : []) {
    const slug = asString(repo?.slug)
    if (slug === undefined) continue
    /**
     * 自己（插件跑在里面的那个仓库）永远不删 —— 但要**记进 kept 并说明原因**。
     *
     * 早先这里是 `if (slug === selfRepo) continue`：不删、也不报告。症状是
     * 一个明显该删的仓库既不在 `candidates` 也不在 `kept` 里，从两侧一起消失 ——
     * 用户看到的是「它没被删」，而任何地方都查不到为什么。既然「受保护」这个
     * 结论对用户有价值（他可能正想删它），就必须落在 `kept` 里带着 code。
     */
    if (slug === asString(input.selfRepo)) {
      kept.push({
        repo: slug,
        ageHours: ageHoursOf(repo?.updatedAt, now),
        gateway: isGatewayRepository(repo).gateway,
        via: isGatewayRepository(repo).via,
        delete: false,
        code: 'self',
        reason: 'dsh 自己就跑在这个仓库里',
      })
      continue
    }
    const judged = judgeRepository({ repo, settings, protectedSet, now })
    if (judged.delete) deleting.push(judged)
    else kept.push(judged)
  }
  // 最旧的先删：一次被 limit 截断时，留下的是最近还在用的那些。
  deleting.sort((a, b) => (b.ageHours ?? 0) - (a.ageHours ?? 0))
  const limit = Math.max(1, Math.round(asNumber(input.limit, CLEANUP_MAX_PER_RUN)))
  return {
    settings,
    activeRepo: asString(input.activeRepo) ?? null,
    protectedRepos: [...protectedSet],
    candidates: deleting.slice(0, limit),
    // 超出的部分要报出来，否则面板显示「3 个删除」而实际列表里还有 20 个该删的。
    deferred: deleting.slice(limit),
    kept,
    summary: {
      scanned: deleting.length + kept.length,
      deletable: deleting.length,
      kept: kept.length,
      byCode: countBy(kept, (row) => row.code),
    },
  }
}

/** @param {Array<Record<string, any>>} rows @param {(row: Record<string, any>) => string} keyOf */
function countBy(rows, keyOf) {
  const out = {}
  for (const row of rows) {
    const key = keyOf(row)
    out[key] = (out[key] ?? 0) + 1
  }
  return out
}

/**
 * 批量删除的结果汇总。输入是逐个执行的结果，输出是面板与工具共用的形状。
 *
 * `planned` 是**清单**而不是数量：面板要把它列出来，而 `plannedCount` 才有
 * 数量语义。早先两者同名时，界面读 `planned.length` 得到 undefined，
 * 于是「预演：会删除 0 个」——数字对不上清单，是最容易被当成真话的那种错。
 *
 * @param {{ planned: string[], results: Array<{ repo: string, ok: boolean, error?: string }> }} input
 */
export function summarizeBulkDelete(input) {
  const deleted = input.results.filter((row) => row.ok).map((row) => row.repo)
  const failed = input.results.filter((row) => !row.ok).map((row) => ({ repo: row.repo, error: row.error ?? '未知原因' }))
  return {
    planned: input.planned,
    plannedCount: input.planned.length,
    deleted,
    failed,
    ok: failed.length === 0,
    // 根组织下的仓库走的是控制台路由，失败信息里通常带「控制台路由也全部失败」。
    hint: failed.length === 0
      ? null
      : '删除失败的仓库多半在根组织下 —— CNB 不允许 Open API 删除根组织仓库，插件会用登录会话走控制台接口；仍失败说明会话未保存或不是该组织管理员。',
  }
}
