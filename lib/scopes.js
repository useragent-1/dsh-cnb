/**
 * CNB access-token scopes.
 *
 * A scope is not a permission name: it is `"<group>-<code>:<level>"`, where the
 * level is one of the `values` the service publishes for that code. Sending the
 * bare name (`repo-code`) is accepted by the mint endpoint and produces a token
 * with **no** effective permission — every later call answers
 * `10023 Missing required scopes: …`, which is indistinguishable from "the
 * account has no rights" unless the level is spelled out.
 *
 * So the list is derived from the service's own `GET /config/token/scope` table
 * rather than hard-coded: new permissions the platform adds are picked up by the
 * full profile automatically, and an explicit list is normalized to the highest
 * level each code allows.
 */

/** Scope table endpoint on the web origin (public; no session needed). */
const SCOPE_TABLE_PATH = '/config/token/scope'

/** How long a fetched scope table is reused. */
const TABLE_TTL_MS = 10 * 60_000

/**
 * The permissions this plugin's own calls exercise, most specific first. Each
 * entry is a bare `group-code`; {@link resolveScopes} adds the level.
 */
export const PLUGIN_SCOPES = [
  // repositories: list, detail, code, build history, dev environments, delete
  'repo-basic-info',
  'repo-code',
  'repo-cnb-history',
  'repo-cnb-detail',
  'repo-cnb-trigger',
  'repo-manage',
  'repo-delete',
  // organizations: repo create/list, quota and usage
  'group-resource',
  'group-manage',
  // self: identity, and the workspace stop/delete calls that live on the account
  'account-profile',
  'account-engage',
]

/** One fetched scope table, shared per process. */
let cachedTable = null

/**
 * Read and index `GET /config/token/scope`.
 * @param {{ web?: string, force?: boolean, signal?: AbortSignal }} [options]
 * @returns {Promise<Array<{ scope: string, levels: string[] }>>} every grantable scope with its allowed levels
 */
export async function fetchScopeTable(options = {}) {
  const { web = 'https://cnb.cool', force = false, signal } = options
  if (!force && cachedTable !== null && Date.now() - cachedTable.at < TABLE_TTL_MS) {
    return cachedTable.entries
  }
  const response = await fetch(`${web}${SCOPE_TABLE_PATH}`, {
    headers: { accept: 'application/json' },
    signal: signal ?? AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`读取 CNB 权限表失败：HTTP ${response.status}`)
  const body = await response.json()
  const entries = []
  for (const group of body?.config ?? []) {
    for (const code of group.codes ?? []) {
      const levels = Array.isArray(code.values) ? code.values.filter((level) => typeof level === 'string') : []
      if (levels.length === 0) continue
      entries.push({ scope: `${group.group}-${code.code}`, levels })
    }
  }
  if (entries.length === 0) throw new Error('CNB 权限表为空')
  cachedTable = { at: Date.now(), entries }
  return entries
}

/** `rw` outranks `r`; a table that ever publishes something else keeps order. */
function strongestLevel(levels) {
  if (levels.includes('rw')) return 'rw'
  return levels[levels.length - 1]
}

/**
 * Every permission the platform grants, each at its highest level.
 * @param {Array<{ scope: string, levels: string[] }>} table
 * @returns {string[]}
 */
export function fullScopes(table) {
  return table.map((entry) => `${entry.scope}:${strongestLevel(entry.levels)}`)
}

/**
 * The plugin's own permissions at their highest level. Useful when a token must
 * stay scoped to what this integration does rather than to the whole account.
 * @param {Array<{ scope: string, levels: string[] }>} table
 * @param {string[]} [wanted]
 * @returns {string[]}
 */
export function pluginScopes(table, wanted = PLUGIN_SCOPES) {
  const byName = new Map(table.map((entry) => [entry.scope, entry]))
  const scopes = []
  for (const name of wanted) {
    const entry = byName.get(name)
    if (entry === undefined) continue
    scopes.push(`${name}:${strongestLevel(entry.levels)}`)
  }
  return scopes
}

/**
 * Give every scope the level suffix the service requires.
 *
 * An entry that already carries a valid level is kept as written; one whose
 * level the code does not publish is upgraded to the strongest level it does
 * publish; an unknown permission is dropped rather than sent, because a mistyped
 * scope silently yields a powerless token.
 * @param {string[]} scopes
 * @param {Array<{ scope: string, levels: string[] }>} table
 * @returns {{ scopes: string[], dropped: string[] }}
 */
export function normalizeScopes(scopes, table) {
  const byName = new Map(table.map((entry) => [entry.scope, entry]))
  const resolved = []
  const dropped = []
  for (const raw of scopes) {
    const text = String(raw).trim()
    if (text === '') continue
    const at = text.lastIndexOf(':')
    const name = at === -1 ? text : text.slice(0, at)
    const level = at === -1 ? '' : text.slice(at + 1)
    const entry = byName.get(name)
    if (entry === undefined) {
      dropped.push(text)
      continue
    }
    const chosen = entry.levels.includes(level) ? level : strongestLevel(entry.levels)
    resolved.push(`${name}:${chosen}`)
  }
  return { scopes: [...new Set(resolved)], dropped }
}

/**
 * Build the scope list a mint should request.
 * @param {{ profile?: 'full' | 'plugin', web?: string, force?: boolean, signal?: AbortSignal }} [options]
 * @returns {Promise<string[]>}
 */
export async function resolveScopes(options = {}) {
  const { profile = 'full', ...rest } = options
  const table = await fetchScopeTable(rest)
  return profile === 'plugin' ? pluginScopes(table) : fullScopes(table)
}

/** Test hook: forget the fetched table. */
export function resetScopeTableCache() {
  cachedTable = null
}

/**
 * The console path a person follows to grant one scope by hand, for the cases
 * where a mint is not possible (an imported token, or an account whose own role
 * caps what it can be granted).
 * @param {string} scope bare `group-code`
 * @returns {{ scope: string, group: string, code: string, url: string, label: string } | undefined}
 */
export function consoleGrantHint(scope) {
  const at = String(scope).indexOf('-')
  if (at === -1) return undefined
  const group = String(scope).slice(0, at)
  const code = String(scope).slice(at + 1)
  const groups = {
    account: '账号',
    group: '组织',
    repo: '仓库',
    registry: '制品库',
    mission: '任务集',
  }
  // What the checkbox actually grants, in the service's own words, so the person
  // can find it without guessing which code maps to which row.
  const meanings = {
    'account-engage': '关注仓库、关注者，以及云原生开发环境',
    'account-profile': '用户资料',
    'account-email': '用户认证邮箱',
    'group-resource': '组织资源：新建仓库、任务集等',
    'group-manage': '组织成员、仓库墙与设置',
    'group-delete': '删除组织',
    'repo-cnb-trigger': '触发/停止构建与云原生开发环境',
    'repo-cnb-detail': '查询或删除云原生开发环境',
    'repo-cnb-history': '构建历史',
  }
  return {
    scope,
    group,
    code,
    url: 'https://cnb.cool/profile/token',
    label: `${groups[group] ?? group} · ${code}`,
    meaning: meanings[scope] ?? null,
  }
}

/**
 * The smallest scope list that still makes the panel and its tools work: read the
 * account, list repositories and organizations, read usage, and run the workspace
 * calls. Used as a last resort when the widest list is trimmed by the account's own
 * role — a narrower grant sometimes survives where a broader one is rejected.
 * @param {Array<{ scope: string, levels: string[] }>} table
 * @returns {string[]}
 */
export function essentialScopes(table) {
  const byName = new Map(table.map((entry) => [entry.scope, entry]))
  const wanted = [
    'account-profile',
    'account-engage',
    'repo-basic-info',
    'repo-code',
    'repo-cnb-history',
    'repo-cnb-detail',
    'repo-cnb-trigger',
    'group-resource',
  ]
  const scopes = []
  for (const name of wanted) {
    const entry = byName.get(name)
    if (entry === undefined) continue
    scopes.push(`${name}:${strongestLevel(entry.levels)}`)
  }
  return scopes
}
