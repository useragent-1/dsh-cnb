/**
 * CNB OpenAPI client used by the dsh-cnb Host half.
 *
 * Two credential families are in play, and they are NOT interchangeable:
 *  - `Authorization: Bearer <access token>` against https://api.cnb.cool for the
 *    documented OpenAPI surface (repos, workspace, charge/quota, ai gateway).
 *  - cookie session against the web origin (https://cnb.cool) for the QR sign-in
 *    state machine and for minting a personal access token afterwards.
 */

import { resolveScopes } from './scopes.js'

/** Web origin that owns the QR sign-in state machine and the session cookie. */
export const CNB_WEB = 'https://cnb.cool'
/** OpenAPI origin; every documented REST call lives here. */
export const CNB_API = 'https://api.cnb.cool'

const WEB_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

/** A CNB failure carrying the HTTP status and the service errcode when present. */
export class CnbError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'CnbError'
    this.status = options.status
    this.errcode = options.errcode
    this.body = options.body
  }
}

/** @param {number} status @param {unknown} body */
function describeFailure(status, body) {
  if (body && typeof body === 'object') {
    const errmsg = body.errmsg ?? body.message ?? body.error_msg
    const errcode = body.errcode ?? body.code
    if (typeof errmsg === 'string' && errmsg !== '') {
      return errcode === undefined ? errmsg : `${errmsg} (errcode ${errcode})`
    }
  }
  return `HTTP ${status}`
}

/**
 * Do one HTTP request and parse JSON defensively.
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number }} [init]
 */
async function requestJson(url, init = {}) {
  const { timeoutMs = 20_000, headers, ...rest } = init
  const signal = rest.signal ?? AbortSignal.timeout(timeoutMs)
  const response = await fetch(url, {
    ...rest,
    signal,
    headers: {
      accept: 'application/json',
      ...headers,
    },
  })
  const text = await response.text()
  let body
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (!response.ok) {
    throw new CnbError(describeFailure(response.status, body), {
      status: response.status,
      errcode: body && typeof body === 'object' ? (body.errcode ?? body.code) : undefined,
      body,
    })
  }
  return { body, headers: response.headers }
}

/** ---------------------------------------------------------------------------
 * Scan-to-login state machine (web origin, cookie session)
 * ------------------------------------------------------------------------- */

/** Drop the attributes Node does not need and keep `name=value` pairs. */
function cookiePairs(setCookieList) {
  const pairs = []
  for (const raw of setCookieList) {
    const first = String(raw).split(';')[0]
    if (first.includes('=')) pairs.push(first)
  }
  return pairs
}

function mergeCookies(jar, setCookieList) {
  const next = new Map(jar)
  for (const pair of cookiePairs(setCookieList)) {
    const at = pair.indexOf('=')
    next.set(pair.slice(0, at), pair.slice(at + 1))
  }
  return next
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

/**
 * One sign-in attempt. Holds the cookie jar because the poll endpoint and the
 * eventual token mint must present the same session that started the attempt.
 */
export class LoginAttempt {
  /** @param {{ web?: string }} [options] */
  constructor(options = {}) {
    this.web = options.web ?? CNB_WEB
    this.jar = new Map()
    this.state = ''
    this.uuid = ''
    this.createdAt = Date.now()
    this.lastStatus = null
    this.closed = false
  }

  /** Rotate the cookie session and obtain a fresh QR ticket. */
  async start() {
    const seed = await fetch(`${this.web}/login`, {
      headers: { 'user-agent': WEB_UA, accept: 'text/html' },
      signal: AbortSignal.timeout(15_000),
    })
    this.jar = mergeCookies(this.jar, seed.headers.getSetCookie?.() ?? [])
    const { body } = await requestJson(`${this.web}/login/state`, {
      headers: {
        'user-agent': WEB_UA,
        accept: 'application/json',
        ...(this.jar.size > 0 ? { cookie: cookieHeader(this.jar) } : {}),
      },
    })
    if (!body || typeof body.state !== 'string' || typeof body.uuid !== 'string') {
      throw new CnbError('CNB 扫码登录初始化失败：未返回 state/uuid')
    }
    this.state = body.state
    this.uuid = body.uuid
    this.createdAt = Date.now()
    this.lastStatus = null
    return this.describe()
  }

  /** URL the CNB 微信扫码页 consumes; render it as a QR code. */
  get ticketUrl() {
    return `${this.web}/login/wx/jump?ticket=${encodeURIComponent(this.state)}`
  }

  describe() {
    return {
      state: this.state,
      uuid: this.uuid,
      ticketUrl: this.ticketUrl,
      createdAt: this.createdAt,
      lastStatus: this.lastStatus,
      ageMs: Date.now() - this.createdAt,
    }
  }

  /**
   * Poll once. `confirmed` flips after the phone approves; the session cookie
   * then belongs to the approving account.
   * @returns {Promise<{ confirmed: boolean, expired: boolean, nickName?: string, avatar?: string, banned?: boolean }>}
   */
  async poll() {
    if (this.state === '') throw new CnbError('扫码会话尚未初始化')
    const url = `${this.web}/login/state/${encodeURIComponent(this.state)}?uuid=${encodeURIComponent(this.uuid)}`
    const { body, headers } = await requestJson(url, {
      headers: {
        'user-agent': WEB_UA,
        accept: 'application/json',
        ...(this.jar.size > 0 ? { cookie: cookieHeader(this.jar) } : {}),
      },
    })
    // The confirmation response carries the authenticated session cookie; the
    // token mint that follows runs on this jar.
    this.jar = mergeCookies(this.jar, headers.getSetCookie?.() ?? [])
    const status = {
      confirmed: body?.confirmed === true,
      expired: body?.isExpired === true,
      nickName: typeof body?.nickName === 'string' ? body.nickName : '',
      avatar: typeof body?.avatar === 'string' ? body.avatar : '',
    }
    this.lastStatus = status
    if (status.expired) this.closed = true
    return status
  }

  /** The web session's own identity view (requires the confirmed cookie). */
  async sessionUser() {
    const { body, headers } = await requestJson(`${this.web}/user`, {
      headers: {
        'user-agent': WEB_UA,
        accept: 'application/json',
        cookie: cookieHeader(this.jar),
      },
    })
    this.jar = mergeCookies(this.jar, headers.getSetCookie?.() ?? [])
    return body
  }

  /**
   * Mint a personal access token on the signed-in account.
   *
   * `scope` must be the fully-qualified `"<group>-<code>:<level>"` strings; the
   * default is every permission CNB grants, each at its highest level, read from
   * the service's own scope table. CNB returns the secret once, in
   * `result.token`, and never again.
   *
   * @param {{ description?: string, scope?: string[], expiresInDays?: number, profile?: 'full' | 'plugin', web?: string }} [options]
   */
  async createAccessToken(options = {}) {
    const {
      description = 'dsh-cnb plugin',
      expiresInDays,
      profile = 'full',
      web = CNB_WEB,
    } = options
    const scope = options.scope ?? await resolveScopes({ profile, web })
    const payload = { description, scope: [...scope].join(',') }
    if (typeof expiresInDays === 'number' && expiresInDays > 0) {
      const at = new Date(Date.now() + expiresInDays * 86_400_000)
      at.setUTCHours(23, 59, 59, 0)
      payload.expired_at = at.toISOString()
    }
    const csrftoken = this.jar.get('csrftoken')
    const { body } = await requestJson(`${this.web}/user/personal_access_tokens`, {
      method: 'POST',
      headers: {
        'user-agent': WEB_UA,
        accept: 'application/json',
        'content-type': 'application/json',
        cookie: cookieHeader(this.jar),
        ...(csrftoken === undefined ? {} : { csrftoken }),
        origin: this.web,
        referer: `${this.web}/profile/token/create`,
      },
      body: JSON.stringify(payload),
      timeoutMs: 25_000,
    })
    const token = body?.result?.token ?? body?.token
    if (typeof token !== 'string' || token === '') {
      throw new CnbError('CNB 未返回访问令牌明文', { body })
    }
    return {
      token,
      tokenId: body?.result?.token_id ?? body?.token_id,
      description: body?.result?.description ?? description,
      scope: payload.scope,
      expiredAt: body?.result?.expired_at,
    }
  }
}

/**
 * Re-exported for callers that only import the client: the real list is derived
 * from CNB's own scope table in `lib/scopes.js`, because a scope without its
 * `:r`/`:rw` level silently mints a powerless token.
 */
export { PLUGIN_SCOPES, fetchScopeTable, fullScopes, normalizeScopes, pluginScopes, resolveScopes } from './scopes.js'

/** ---------------------------------------------------------------------------
 * OpenAPI client (api.cnb.cool, bearer token)
 * ------------------------------------------------------------------------- */

/**
 * Thin wrapper over the documented OpenAPI. Every method returns parsed JSON and
 * throws {@link CnbError} with the service message on failure.
 */
export class CnbApi {
  /**
   * @param {{ token: () => string | Promise<string>, api?: string, timeoutMs?: number }} options
   */
  constructor(options) {
    this.tokenSource = options.token
    this.api = options.api ?? CNB_API
    this.timeoutMs = options.timeoutMs ?? 25_000
  }

  async #token() {
    const token = await this.tokenSource()
    if (typeof token !== 'string' || token.trim() === '') {
      throw new CnbError('尚未登录 CNB：请先在插件面板扫码登录')
    }
    return token.trim()
  }

  /**
   * @param {string} path
   * @param {{ method?: string, query?: Record<string, unknown>, body?: unknown, timeoutMs?: number }} [options]
   */
  async call(path, options = {}) {
    const { method = 'GET', query, body, timeoutMs } = options
    const url = new URL(path.startsWith('http') ? path : `${this.api}${path}`)
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue
        url.searchParams.set(key, String(value))
      }
    }
    const token = await this.#token()
    try {
      return await requestJson(url.toString(), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.cnb.api+json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs: timeoutMs ?? this.timeoutMs,
      })
    } catch (error) {
      // 10023 means the token exists but was minted without a scope this call
      // needs. Say which scope, and how to get one that has it.
      if (error instanceof CnbError && error.errcode === 10023) {
        const missing = extractMissingScopes(error.message)
        const wrapped = new CnbError(
          `当前 CNB 令牌缺少权限${missing.length === 0 ? '' : `：${missing.join('、')}`}。` +
            '请在面板「账号」页重新扫码登录（会自动按全权限重建令牌），或在 CNB 令牌页补上该权限。',
          { status: error.status, errcode: error.errcode, body: error.body },
        )
        // Keep the scope names structured: callers summarize them, and the raw
        // service text is the only place they appear.
        wrapped.missingScopes = missing
        throw wrapped
      }
      throw error
    }
  }

  // ---- identity ----------------------------------------------------------
  async me() {
    const { body } = await this.call('/user')
    return body
  }

  async myGroups() {
    const { body } = await this.call('/user/groups')
    return Array.isArray(body) ? body : []
  }

  // ---- repositories ------------------------------------------------------
  /**
   * @param {{ page?: number, pageSize?: number, search?: string }} [options]
   */
  async myRepos(options = {}) {
    const { page = 1, pageSize = 50, search } = options
    const { body, headers } = await this.call('/user/repos', {
      query: { page, page_size: pageSize, search },
    })
    return { items: Array.isArray(body) ? body : [], total: Number(headers.get('x-cnb-total') ?? 0) }
  }

  /**
   * @param {string} slug org slug
   * @param {{ page?: number, pageSize?: number, search?: string }} [options]
   */
  async groupRepos(slug, options = {}) {
    const { page = 1, pageSize = 50, search } = options
    const { body, headers } = await this.call(`/${encodeURIComponent(slug)}/-/repos`, {
      query: { page, page_size: pageSize, search, order_by: 'last_updated_at', desc: true },
    })
    return { items: Array.isArray(body) ? body : [], total: Number(headers.get('x-cnb-total') ?? 0) }
  }

  /** @param {string} repo `group/name` */
  async repo(repo) {
    const { body } = await this.call(`/${repo}`)
    return body
  }

  /**
   * @param {string} slug org slug
   * @param {{ name: string, visibility?: string, description?: string }} input
   */
  async createRepo(slug, input) {
    const { body } = await this.call(`/${encodeURIComponent(slug)}/-/repos`, {
      method: 'POST',
      body: {
        name: input.name,
        visibility: input.visibility ?? 'private',
        description: input.description ?? '',
      },
    })
    return body
  }

  /** @param {string} repo `group/name` */
  async deleteRepo(repo) {
    const { body } = await this.call(`/${repo}`, { method: 'DELETE' })
    return body ?? { ok: true }
  }

  // ---- cloud-native development -----------------------------------------
  /** Environments owned by the signed-in user. */
  async workspaces(options = {}) {
    const { page = 1, pageSize = 50, status, slug, branch } = options
    const { body } = await this.call('/workspace/list', {
      query: { page, page_size: pageSize, status, slug, branch },
    })
    return {
      items: Array.isArray(body?.list) ? body.list : [],
      total: Number(body?.total ?? 0),
      hasMore: body?.hasMore === true,
    }
  }

  /**
   * Start (or reopen) a repo's dev environment.
   * @param {string} repo `group/name`
   * @param {{ branch?: string, ref?: string }} [input]
   */
  async startWorkspace(repo, input = {}) {
    const { body } = await this.call(`/${repo}/-/workspace/start`, {
      method: 'POST',
      body: {
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        ...(input.ref === undefined ? {} : { ref: input.ref }),
      },
    })
    return body
  }

  /** @param {string} repo @param {string} sn build sn */
  async workspaceDetail(repo, sn) {
    const { body } = await this.call(`/${repo}/-/workspace/detail/${encodeURIComponent(sn)}`)
    return body
  }

  /**
   * Stop a dev environment through the account-level API.
   *
   * This is the canonical call and needs `account-engage:rw`. Prefer
   * {@link stopBuild} when that scope is unavailable: the repo-scoped build stop
   * terminates the same pipeline under `repo-cnb-trigger:rw`, which every token
   * that can start an environment already holds.
   * @param {{ sn?: string, pipelineId?: string }} input
   */
  async stopWorkspace(input) {
    const { body } = await this.call('/workspace/stop', { method: 'POST', body: input })
    return body
  }

  /**
   * Stop the build (or dev environment) one repo pipeline is running.
   *
   * Scoped to a repository, so it needs `repo-cnb-trigger:rw` rather than the
   * account-wide `account-engage:rw`. A build that already ended answers 422
   * `STOP_FAIL_WRONG_STATUS`, which the caller reports as "already stopped"
   * instead of a failure.
   * @param {string} repo @param {string} sn
   */
  async stopBuild(repo, sn) {
    const { body } = await this.call(`/${repo}/-/build/stop/${encodeURIComponent(sn)}`, {
      method: 'POST',
      body: {},
    })
    return body
  }

  /** @param {string} repo @param {string} sn */
  async buildStatus(repo, sn) {
    const { body } = await this.call(`/${repo}/-/build/status/${encodeURIComponent(sn)}`)
    return body
  }

  /** @param {{ sn?: string, pipelineId?: string }} input */
  async deleteWorkspace(input) {
    const { body } = await this.call('/workspace/delete', { method: 'POST', body: input })
    return body
  }

  // ---- usage / quota -----------------------------------------------------
  /**
   * Monthly quota + used volume for one org. Quota needs no extra rights; the
   * usage half needs the root-org owner role and degrades to `null` otherwise.
   * @param {string} slug @param {string} [month] `YYYYMM`
   */
  async orgUsage(slug, month) {
    const org = encodeURIComponent(slug)
    const [quota, used, privilege] = await Promise.all([
      this.call(`/${org}/-/charge/quota`).then((r) => r.body).catch((error) => ({ error: message(error) })),
      this.call(`/${org}/-/charge/volume`, { query: { month } })
        .then((r) => r.body)
        .catch((error) => ({ error: message(error) })),
      this.call(`/${org}/-/charge/special-amount`)
        .then((r) => r.body)
        .catch((error) => ({ error: message(error) })),
    ])
    return { slug, month, quota, used, privilege }
  }

  /**
   * Per-repository usage for one resource type.
   * @param {string} slug
   * @param {string} type charge_type_git | charge_type_object | charge_type_ci |
   *   charge_type_dev | charge_type_ci_gpu | charge_type_dev_gpu |
   *   charge_type_credit | charge_type_token
   */
  async repoUsage(slug, type, options = {}) {
    const { page = 1, pageSize = 50 } = options
    const { body } = await this.call(`/${encodeURIComponent(slug)}/-/charge/repos-volume`, {
      query: { type, page, page_size: pageSize },
    })
    return Array.isArray(body) ? body : []
  }

  // ---- build status ------------------------------------------------------
  /** @param {string} repo @param {{ page?: number, pageSize?: number, status?: string }} [options] */
  async buildLogs(repo, options = {}) {
    const { page = 1, pageSize = 10, status } = options
    const { body, headers } = await this.call(`/${repo}/-/build/logs`, {
      query: { page, page_size: pageSize, status },
    })
    return {
      items: Array.isArray(body?.data) ? body.data : [],
      total: Number(body?.total ?? headers.get('x-cnb-total') ?? 0),
    }
  }

  /** @param {string} repo @param {string} ref */
  async fileAt(repo, filePath, ref) {
    const { body } = await this.call(`/${repo}/-/git/contents/${filePath}`, { query: { ref } })
    if (typeof body?.content !== 'string') return { path: filePath, text: null, body }
    const text = body.encoding === 'base64'
      ? Buffer.from(body.content, 'base64').toString('utf8')
      : body.content
    return { path: filePath, text, body }
  }

  // ---- AI gateway --------------------------------------------------------
  /**
   * The repo-scoped AI proxy. It speaks OpenAI Chat Completions, streaming only:
   * non-stream requests are rejected with 11101, and completion choice deltas
   * live under `choices[0].delta` with CNB's extra `reasoning_content` field.
   *
   * @param {string} repo route that carries the gateway
   * @param {{ model: string, messages: unknown[], maxTokens?: number, temperature?: number, signal?: AbortSignal }} input
   * @returns {Promise<{ text: string, reasoning: string, model?: string, finish?: string, usage?: unknown }>}
   */
  async chat(repo, input) {
    const token = await this.#token()
    const response = await fetch(`${this.api}/${repo}/-/ai/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        stream: true,
        ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      }),
      signal: input.signal ?? AbortSignal.timeout(120_000),
    })
    if (!response.ok) {
      const text = await response.text()
      throw new CnbError(`AI 网关拒绝请求：${text.slice(0, 400)}`, { status: response.status })
    }
    if (!response.body) throw new CnbError('AI 网关没有返回数据流')

    let text = ''
    let reasoning = ''
    let model
    let finish
    let usage
    let buffered = ''
    const decoder = new TextDecoder()
    for await (const chunk of response.body) {
      buffered += decoder.decode(chunk, { stream: true })
      let index
      while ((index = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, index).trim()
        buffered = buffered.slice(index + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '' || payload === '[DONE]') continue
        let event
        try {
          event = JSON.parse(payload)
        } catch {
          continue
        }
        if (event.model) model = event.model
        if (event.usage) usage = event.usage
        const choice = event.choices?.[0]
        if (!choice) continue
        if (choice.finish_reason) finish = choice.finish_reason
        const delta = choice.delta ?? {}
        if (typeof delta.content === 'string') text += delta.content
        if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
      }
    }
    return { text, reasoning, model, finish, usage }
  }
}

/** @param {unknown} error */
export function message(error) {
  if (error instanceof CnbError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Pull the scope names CNB lists in a 10023 message.
 *
 * The service text looks like `… Missing required scopes: account-engage:rw`,
 * and this plugin appends ` (errcode 10023)` when it surfaces the failure, so the
 * scope is taken by shape rather than by splitting on the last word.
 * @param {string} text
 * @returns {string[]}
 */
export function extractMissingScopes(text) {
  const match = /Missing required scopes:\s*([^()]+)/i.exec(String(text))
  if (match === null) return []
  return match[1]
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter((scope) => /^[a-z][a-z0-9-]*(?::[rw]+)?$/.test(scope))
}
