/**
 * dsh-cnb Host half.
 *
 * One CNB capability surface shared by three callers:
 *  - the Web panel (through `webServer` routes under `/dsh-cnb/`),
 *  - the agent (through the `cnb_*` tools),
 *  - the model gateway automation (through `configEditor`, so the CNB AI proxy
 *    lands in `llm-pi-ai` as a real provider route).
 *
 * The CNB access token is a credential record rather than configuration: it is
 * minted by a QR sign-in, rotates independently of the profile, and must never
 * appear in a patch file.
 */
import { randomUUID } from 'node:crypto'
import { CnbApi, CnbError, DEFAULT_LOGIN_DAYS, LoginAttempt, extractMissingScopes, message } from './cnb-client.js'
import { consoleGrantHint, essentialScopes, fetchScopeTable, fullScopes, pluginScopes } from './scopes.js'
import { parseMiniYaml, readWorkspaceConfig } from './mini-yaml.js'
import { qrSvgPath } from './qr.js'

export const name = 'dsh-cnb'

/** Credential record holding the CNB access token and the account it belongs to. */
const CREDENTIAL_SCOPE = 'dsh-cnb'
const CREDENTIAL_ID = 'cnb-token'

/** Charge resource types the usage view exposes, in display order. */
const USAGE_TYPES = [
  ['charge_type_git', 'Git 存储'],
  ['charge_type_object', '对象存储'],
  ['charge_type_ci', '云原生构建'],
  ['charge_type_dev', '云原生开发'],
  ['charge_type_ci_gpu', '构建 GPU'],
  ['charge_type_dev_gpu', '开发 GPU'],
  ['charge_type_credit', 'AI Credits'],
]

/** The console's pipeline ordinal at the end of a full environment id, e.g. `-001`. */
const PIPELINE_SUFFIX = /-\d{3}$/

/** How desktop editors attach, which is one mechanism rather than per-editor URLs. */
const CLIENT_HINT =
  'VS Code / Cursor / Windsurf / Zed / CodeBuddy 通过 Remote-SSH 连接：镜像需预装 openssh-server，' +
  '客户端装 Remote-SSH 插件后填上面的连接串。JetBrains 走 Gateway（同样 SSH），IDE 需装在 /ide_cnb。'

/** Ports offered as ready-made preview links; the template accepts any. */
const DEFAULT_PREVIEW_PORTS = [3000, 5173, 8080, 8000, 5000]

/** Targets the permission probe aims at: they cannot exist, so nothing happens. */
const DOCTOR_PROBE_SN = 'cnb-dsh-probe-000000'
const DOCTOR_PROBE_REPO = 'dsh-probe/does-not-exist'

/** Default provider route name written into `llm-pi-ai`. */
const DEFAULT_PROVIDER_ROUTE = 'cnb-gateway'

/** Credential reference (`apiKeyEnv`) the gateway provider resolves. */
const GATEWAY_KEY_REF = 'CNB_TOKEN'

/** The models CNB's own AI gateway advertises in its web bootstrap. */
const FALLBACK_MODELS = [
  { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', contextWindow: 128_000, maxTokens: 8_192 },
]

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
 * The provider profile this plugin writes: an OpenAI-compatible route pointed at
 * the repo's AI proxy. CNB's gateway streams only, which is exactly what the
 * adapter does, and echoes `reasoning_content` which pi-ai already reads.
 * @param {{ repo: string, model: string, models: Array<{ id: string, contextWindow?: number, maxTokens?: number }> }} input
 */
export function gatewayProviderProfile(input) {
  return {
    displayName: `CNB 网关 (${input.repo})`,
    api: 'openai-completions',
    baseURL: `https://api.cnb.cool/${input.repo}/-/ai`,
    apiKeyEnv: 'CNB_TOKEN',
    models: input.models.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      contextWindow: model.contextWindow ?? 128_000,
      maxTokens: model.maxTokens ?? 8_192,
      input: ['text'],
      reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' },
      compat: { supportsUsageInStreaming: true, supportsReasoningEffort: false },
    })),
    compat: { supportsUsageInStreaming: true, maxTokensField: 'max_tokens' },
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ webOrigin?: string, apiOrigin?: string, requestTimeoutMs?: number }} [config]
 */
export function apply(ctx, config = {}) {
  const webOrigin = asString(config.webOrigin) ?? 'https://cnb.cool'
  const apiOrigin = asString(config.apiOrigin) ?? 'https://api.cnb.cool'
  const requestTimeoutMs = asNumber(config.requestTimeoutMs, 25_000)

  /** The live QR attempt; only one runs at a time, matching the CNB console. */
  let attempt = null
  /** Cached identity of the signed-in account, invalidated when the token moves. */
  let identity = null

  // ---------------------------------------------------------------- credentials

  /** @returns {Promise<{ token: string, user?: unknown, description?: string, expiredAt?: string, loginAt?: string } | undefined>} */
  async function readRecord() {
    const credentials = ctx.get('credentials')
    if (!credentials) return undefined
    const record = await credentials.readRecord(`${CREDENTIAL_SCOPE}/${CREDENTIAL_ID}`)
    if (!record || record.kind !== 'grant') return undefined
    const payload = record.payload
    if (!payload || typeof payload !== 'object') return undefined
    const token = typeof payload.token === 'string' ? payload.token : ''
    const session = typeof payload.session === 'string' ? payload.session : undefined
    // A session-only record is legitimate: the scan succeeded and the browser session
    // works even when no minted bearer passed verification. It has no token, so
    // anything that needs one must check.
    if (token === '' && session === undefined) return undefined
    return {
      token,
      user: payload.user,
      description: payload.description,
      expiredAt: payload.expiredAt,
      loginAt: payload.loginAt,
      scope: payload.scope,
      scopeProfile: payload.scopeProfile,
      // The web session captured at sign-in. Keeping it here is what allows a
      // later token problem to be repaired without asking for another scan, and it is
      // the only credential a session-only record has.
      session,
      sessionSavedAt: payload.sessionSavedAt,
      tokenName: typeof payload.tokenName === 'string' ? payload.tokenName : undefined,
      sessionExpiresAt: typeof payload.sessionExpiresAt === 'string' ? payload.sessionExpiresAt : undefined,
      sessionMaxAgeSeconds: typeof payload.sessionMaxAgeSeconds === 'number' ? payload.sessionMaxAgeSeconds : undefined,
      cookieName: typeof payload.cookieName === 'string' ? payload.cookieName : undefined,
    }
  }

  /**
   * Persist (or clear) the token record and keep the `CNB_TOKEN` key in sync.
   *
   * The record is this plugin's own state; the key is what `llm-pi-ai` resolves
   * through `apiKeyEnv`, so one QR sign-in both authenticates the panel and feeds
   * the gateway route without a plaintext secret in any patch file.
   * @param {Record<string, unknown> | undefined} payload
   */
  async function writeRecord(payload) {
    const credentials = ctx.get('credentials')
    if (!credentials) throw new CnbError('当前 profile 没有 credentials 服务，无法保存 CNB 令牌')
    const key = `${CREDENTIAL_SCOPE}/${CREDENTIAL_ID}`
    if (payload === undefined) {
      // `modifyRecord` returning `undefined` means "leave the record as it is" — it is
      // not a delete. Clearing a sign-in therefore has to use `deleteRecord`, or the
      // account survives a logout while the panel reports success.
      await credentials.deleteRecord(key)
      await credentials.unset(GATEWAY_KEY_REF)
    } else {
      await credentials.modifyRecord(key, async () => ({ kind: 'grant', payload }))
      await credentials.set(GATEWAY_KEY_REF, String(payload.token))
    }
    identity = null
    api = null
  }

  /** @returns {Promise<string>} */
  async function currentToken() {
    const record = await readRecord()
    if (record === undefined) {
      const ambient = process.env.CNB_TOKEN
      if (typeof ambient === 'string' && ambient.trim() !== '') return ambient.trim()
      throw new CnbError('尚未登录 CNB：请先在 dsh-cnb 面板扫码登录')
    }
    return record.token
  }

  /** Lazily built OpenAPI client bound to whatever token is current. */
  let api = null
  function client() {
    api ??= new CnbApi({
      token: currentToken,
      api: apiOrigin,
      timeoutMs: requestTimeoutMs,
      web: webOrigin,
      // Lets a scope refusal retry as the signed-in person instead of failing:
      // a cookie session is not limited by the token's scopes.
      session: async () => (await readRecord())?.session,
    })
    return api
  }

  // ------------------------------------------------------------------- session

  async function status() {
    const record = await readRecord()
    let user = identity
    let probeError = null
    if (record !== undefined && user === null) {
      try {
        user = await client().me()
        identity = user
      } catch (error) {
        user = null
        probeError = message(error)
      }
    }
    return {
      loggedIn: record !== undefined,
      user: record !== undefined ? user : null,
      account: record === undefined
        ? null
        : {
            description: record.description ?? null,
            expiredAt: record.expiredAt ?? null,
            loginAt: record.loginAt ?? null,
            tokenName: record.tokenName ?? null,
            scope: record.scope ?? null,
          },
      // A token can exist and still be powerless: CNB drops a scope whose level
      // is missing, and the resulting token answers 10023 on every call. Say so
      // explicitly instead of showing "logged in" over an empty panel.
      health: record === undefined
        ? 'signed-out'
        // A session-only record has no bearer; its calls work, but saying "ok" would
        // imply a token exists. The panel uses this to explain what it has.
        : record.scopeProfile === 'session-only'
          ? 'session-only'
        : user !== null
          ? 'ok'
          : /未登录|not logged in|HTTP 401/i.test(String(probeError))
            ? 'invalid'
            : 'no-permission',
      healthDetail: probeError,
      // Whether a future token problem can be repaired without another scan.
      sessionStored: typeof record?.session === 'string' && record.session !== '',
      sessionAge: record?.sessionSavedAt ?? null,
      // How long that session lasts, and when it lapses. The lifetime comes from the
      // record (set at sign-in); the expiry is computed from it because CNB's cookie
      // carries no readable timestamp.
      cookie: sessionLifetime(record),
      pending: attempt !== null && !attempt.closed ? attempt.describe() : null,
      ambientToken: record === undefined && Boolean(process.env.CNB_TOKEN),
      plugin: { webOrigin, apiOrigin, requestTimeoutMs },
    }
  }

  /**
   * Start (or reuse) a scan.
   *
   * No lifetime is requested: CNB decides it and announces it on the confirmation
   * response, which {@link pollLogin} records.
   */
  async function beginLogin() {
    const reusable = attempt !== null && !attempt.closed && Date.now() - attempt.createdAt < 240_000
    if (reusable) return attempt.describe()
    // The lifetime is the server's decision, not a preference: CNB sets the session
    // cookie with its own Max-Age, which is read here and reported back.
    attempt = new LoginAttempt({ web: webOrigin })
    await attempt.start()
    return attempt.describe()
  }

  /**
   * Poll the pending attempt; on confirmation mint a token and store it.
   * @returns {Promise<{ state: 'pending' | 'confirmed' | 'expired' | 'none', detail?: unknown, login?: unknown }>}
   */
  async function pollLogin() {
    if (attempt === null || attempt.closed) return { state: 'none' }
    const result = await attempt.poll()
    if (result.expired) {
      attempt.closed = true
      return { state: 'expired' }
    }
    if (!result.confirmed) {
      return { state: 'pending', detail: { nickName: result.nickName, avatar: result.avatar } }
    }
    attempt.closed = true

    // Mint, then verify, then keep the best of several attempts.
    //
    // CNB answers "created" even when the scope list it was handed grants nothing,
    // and the resulting token looks identical until a call fails. So the mint is
    // not the finish line: each candidate is probed, and one that cannot even read
    // the account is reported as a failure rather than stored as a success.
    //
    // The candidates differ only in how much they ask for, from the whole platform
    // down to what this plugin itself calls. If the account's role caps a grant,
    // a narrower list can still succeed where the widest one is trimmed.
    const table = await fetchScopeTable({ web: webOrigin })
    const candidates = [
      { profile: 'full', scope: fullScopes(table) },
      { profile: 'plugin', scope: pluginScopes(table) },
      { profile: 'read-write-essential', scope: essentialScopes(table) },
    ]

    const tried = []
    for (const candidate of candidates) {
      if (candidate.scope.length === 0) continue
      let minted
      try {
        minted = await attempt.createAccessToken({ scope: candidate.scope })
      } catch (error) {
        tried.push({ profile: candidate.profile, ok: false, error: message(error) })
        continue
      }
      const verification = await verifyStoredToken(minted.token)
      const user = await new CnbApi({ token: async () => minted.token, api: apiOrigin, timeoutMs: requestTimeoutMs })
        .me()
        .catch(() => undefined)
      tried.push({
        profile: candidate.profile,
        ok: verification.ok,
        missingScopes: verification.missingScopes,
        error: verification.ok ? null : '签出的令牌缺少权限',
      })
      if (!verification.ok) continue

      const payload = {
        token: minted.token,
        tokenId: minted.tokenId ?? null,
        description: minted.description,
        tokenName: minted.description,
        expiredAt: minted.expiredAt ?? null,
        loginAt: new Date().toISOString(),
        user: user ?? { nickname: result.nickName ?? '' },
        scope: candidate.scope.join(','),
        scopeProfile: candidate.profile,
        // Keep the web session that just minted this token. It is the same
        // credential the panel used, and replaying it lets a later expiry be
        // repaired automatically instead of asking for another scan.
        session: attempt.session,
        sessionSavedAt: new Date().toISOString(),
        // The expiry the server actually set, when it sent one.
        sessionExpiresAt: attempt.sessionExpiry?.expiresAt ?? null,
        sessionMaxAgeSeconds: attempt.sessionExpiry?.maxAgeSeconds ?? null,
        cookieName: attempt.sessionExpiry?.name ?? null,
      }
      await writeRecord(payload)
      identity = user ?? null
      return { state: 'confirmed', login: summarizeLogin(payload), verification, tried }
    }

    // No minted token passed verification, but the scan itself succeeded and the
    // browser session is valid — it can read the account, and it is what every
    // scope-refused call falls back to. Throwing that away would force another scan
    // for nothing, so the session is kept and the panel is told the token is the part
    // that failed.
    const widest = candidates[0]?.scope.join(',') ?? ''
    const probeUser = await attempt.sessionUser().catch(() => undefined)
    const payload = {
      // A session-only record: no token, so nothing here claims a working bearer.
      token: '',
      description: 'dsh-cnb plugin (session only)',
      expiredAt: null,
      loginAt: new Date().toISOString(),
      user: probeUser ?? { nickname: result.nickName ?? '' },
      scope: '',
      scopeProfile: 'session-only',
      session: attempt.session,
      sessionSavedAt: new Date().toISOString(),
      sessionExpiresAt: attempt.sessionExpiry?.expiresAt ?? null,
      sessionMaxAgeSeconds: attempt.sessionExpiry?.maxAgeSeconds ?? null,
      cookieName: attempt.sessionExpiry?.name ?? null,
    }
    return {
      state: 'confirmed',
      login: summarizeLogin(payload),
      verification: { ok: false, failures: tried, missingScopes: [] },
      tried,
      scopeRequested: widest,
      sessionOnly: true,
    }
  }

  /**
   * Run the doctor against a token and summarize it for the login result.
   * @param {string} token
   */
  async function verifyStoredToken(token) {
    const probe = new CnbApi({ token: async () => token, api: apiOrigin, timeoutMs: requestTimeoutMs })
    const failures = []
    for (const [name, run] of [
      ['identity', () => probe.me()],
      ['repositories', () => probe.myRepos({ pageSize: 1 })],
      ['organizations', () => probe.myGroups()],
    ]) {
      try {
        await run()
      } catch (error) {
        failures.push({ name, error: message(error), missingScopes: extractMissing(error) })
      }
    }
    return {
      ok: failures.length === 0,
      failures,
      missingScopes: [...new Set(failures.flatMap((failure) => failure.missingScopes ?? []))],
    }
  }

  /**
   * Mint a working token from a stored web session, with no user interaction.
   *
   * This is the whole point of keeping the session: once signed in, a token that
   * expires, is revoked, or turns out to lack permissions can be replaced by
   * replaying the session and asking CNB for a new one. Nothing here needs a phone.
   *
   * Every candidate scope list is tried, exactly as at sign-in, and only a token
   * that passes verification is stored.
   *
   * @param {{ reason?: string, session?: string }} [input]
   * @returns {Promise<{ ok: boolean, profile?: string, reason?: string, missingScopes?: string[] }>}
   */
  async function remintToken(input = {}) {
    const record = await readRecord()
    const session = input.session ?? record?.session
    if (typeof session !== 'string' || session === '') {
      return { ok: false, reason: '没有可用的登录会话：需要扫码一次，之后就能自动重签' }
    }
    const attemptForSession = new LoginAttempt({ web: webOrigin, session })
    const probe = await attemptForSession.probeSession()
    if (!probe.signedIn) {
      return { ok: false, reason: '登录会话已失效：需要重新扫码' }
    }

    const table = await fetchScopeTable({ web: webOrigin })
    const candidates = [
      { profile: 'full', scope: fullScopes(table) },
      { profile: 'plugin', scope: pluginScopes(table) },
      { profile: 'read-write-essential', scope: essentialScopes(table) },
    ]
    const tried = []
    for (const candidate of candidates) {
      if (candidate.scope.length === 0) continue
      let minted
      try {
        minted = await attemptForSession.createAccessToken({
          scope: candidate.scope,
        })
      } catch (error) {
        tried.push({ profile: candidate.profile, ok: false, error: message(error) })
        continue
      }
      const verification = await verifyStoredToken(minted.token)
      tried.push({ profile: candidate.profile, ok: verification.ok, missingScopes: verification.missingScopes })
      if (!verification.ok) continue

      const user = await new CnbApi({ token: async () => minted.token, api: apiOrigin, timeoutMs: requestTimeoutMs })
        .me()
        .catch(() => probe.user)
      await writeRecord({
        token: minted.token,
        tokenId: minted.tokenId ?? null,
        description: minted.description,
        tokenName: minted.description,
        expiredAt: minted.expiredAt ?? null,
        loginAt: new Date().toISOString(),
        user: user ?? probe.user ?? null,
        scope: candidate.scope.join(','),
        scopeProfile: candidate.profile,
        session: attemptForSession.session,
        sessionSavedAt: new Date().toISOString(),
        // A re-mint replays an existing session, so it keeps that session's original
        // expiry rather than restarting it.
        sessionExpiresAt: record?.sessionExpiresAt ?? attemptForSession.sessionExpiry?.expiresAt ?? null,
        sessionMaxAgeSeconds: record?.sessionMaxAgeSeconds ?? attemptForSession.sessionExpiry?.maxAgeSeconds ?? null,
        cookieName: record?.cookieName ?? attemptForSession.sessionExpiry?.name ?? null,
        remintReason: input.reason ?? 'expired',
      })
      identity = user ?? null
      return { ok: true, profile: candidate.profile, tried }
    }
    return {
      ok: false,
      reason: '会话有效，但签出的令牌都读不到账号（账号角色限制了可授予的权限）',
      tried,
    }
  }

  async function logout() {
    attempt = null
    identity = null
    api = null
    await writeRecord(undefined)
    return status()
  }

  /**
   * Accept a token minted outside this panel (console, CI, ambient env).
   *
   * The token is probed before it is stored, and the probe deliberately reads
   * both the identity and the repository list: a token minted without levels
   * answers `/user` differently from `/user/repos`, so one call would hide the
   * commonest failure.
   * @param {{ token: string }} input
   */
  async function importToken(input) {
    const token = asString(input.token)
    if (token === undefined) throw new CnbError('令牌不能为空')
    const probe = new CnbApi({
      token: async () => token,
      api: apiOrigin,
      timeoutMs: requestTimeoutMs,
      web: webOrigin,
      session: async () => (await readRecord())?.session,
    })
    const user = await probe.me()
    let repos
    try {
      repos = await probe.myRepos({ pageSize: 1 })
    } catch (error) {
      throw new CnbError(`令牌可用，但读取仓库失败：${message(error)}`, { body: { user } })
    }
    const payload = {
      token,
      description: 'dsh-cnb plugin (imported)',
      expiredAt: null,
      loginAt: new Date().toISOString(),
      user,
      scope: null,
      scopeProfile: 'imported',
      repositories: repos.total,
    }
    await writeRecord(payload)
    identity = user
    return { login: summarizeLogin(payload), repositoryTotal: repos.total }
  }

  /** @param {{ token: string, user?: unknown, description?: string, expiredAt?: string | null, loginAt?: string }} payload */
  function summarizeLogin(payload) {
    return {
      description: payload.description ?? null,
      expiredAt: payload.expiredAt ?? null,
      loginAt: payload.loginAt ?? null,
      user: payload.user ?? null,
    }
  }

  // ------------------------------------------------------------- repositories

  /**
   * Repositories the account can reach, newest first, annotated with whether a
   * dev environment already exists for the current user.
   */
  async function listRepositories(options = {}) {
    const search = asString(options.search)
    const page = Math.max(1, Math.round(asNumber(options.page, 1)))
    const pageSize = Math.min(100, Math.max(1, Math.round(asNumber(options.pageSize, 30))))
    const cnb = client()
    const [{ items, total }, workspaces] = await Promise.all([
      cnb.myRepos({ page, pageSize, search }),
      cnb.workspaces({ page: 1, pageSize: 100 }).catch(() => ({ items: [] })),
    ])
    const running = new Map()
    for (const workspace of workspaces.items) {
      if (workspace?.slug === undefined) continue
      const bucket = running.get(workspace.slug) ?? []
      bucket.push({
        sn: workspace.sn,
        pipelineId: workspace.pipeline_id,
        branch: workspace.branch,
        status: workspace.status,
        createTime: workspace.create_time,
        duration: workspace.duration,
      })
      running.set(workspace.slug, bucket)
    }
    return {
      page,
      pageSize,
      total,
      items: items.map((repo) => ({
        slug: repo.path ?? repo.name,
        id: repo.id,
        name: repo.name,
        visibility: repo.visibility_level,
        description: repo.description ?? '',
        updatedAt: repo.updated_at ?? repo.last_updated_at ?? null,
        webUrl: repo.web_url ?? null,
        defaultBranch: null,
        openIssues: repo.open_issue_count ?? 0,
        openPulls: repo.open_pull_request_count ?? 0,
        stars: repo.star_count ?? 0,
        language: repo.languages?.language ?? null,
        environments: running.get(repo.path ?? '') ?? [],
      })),
    }
  }

  /** Detailed status: repo meta, latest builds, environments, workspace button. */
  async function repositoryStatus(input) {
    const repo = requireRepo(input.repo)
    const cnb = client()
    const [info, builds, workspaces] = await Promise.all([
      cnb.repo(repo),
      cnb.buildLogs(repo, { page: 1, pageSize: 5 }).catch((error) => ({ items: [], total: 0, error: message(error) })),
      cnb.workspaces({ page: 1, pageSize: 20, slug: repo }).catch((error) => ({ items: [], total: 0, error: message(error) })),
    ])
    const defaultBranch = await defaultBranchOf(cnb, repo)
    const workspace = await readWorkspaceButton(repo, defaultBranch).catch(() => null)
    return {
      repo,
      info: {
        id: info?.id ?? null,
        name: info?.name ?? repo,
        visibility: info?.visibility_level ?? null,
        description: info?.description ?? '',
        createdAt: info?.created_at ?? null,
        updatedAt: info?.updated_at ?? null,
        defaultBranch: defaultBranch ?? null,
        openIssues: info?.open_issue_count ?? 0,
        openPulls: info?.open_pull_request_count ?? 0,
        stars: info?.star_count ?? 0,
        forks: info?.fork_count ?? 0,
        language: info?.languages?.language ?? null,
        webUrl: `${webOrigin}/${repo}`,
      },
      builds,
      environments: workspaces.items ?? [],
      workspace,
    }
  }

  /**
   * Read `.cnb/settings.yml` and project the dev-environment launch button.
   * @param {string} repo @param {string | undefined} branch
   */
  async function readWorkspaceButton(repo, branch) {
    const cnb = client()
    const refs = [branch, 'main', 'master'].filter((value, index, all) => value !== undefined && all.indexOf(value) === index)
    let lastError = null
    for (const ref of refs) {
      try {
        const file = await cnb.fileAt(repo, '.cnb/settings.yml', ref)
        if (file.text === null) continue
        const parsed = parseMiniYaml(file.text)
        return { ref, found: true, config: readWorkspaceConfig(parsed) }
      } catch (error) {
        lastError = error
        if (error instanceof CnbError && (error.status === 404 || error.status === 406)) continue
        if (error instanceof CnbError && error.errcode === 404) continue
      }
    }
    return { ref: branch ?? null, found: false, config: null, error: lastError === null ? null : message(lastError) }
  }

  /**
   * Create a repository in an organization.
   *
   * Needs `group-resource:rw`; there is no repo-scoped alternative, because the
   * repository does not exist yet. A token without it is told what to change
   * rather than just refused.
   * @param {{ slug?: string, org?: string, name: string, visibility?: string, description?: string }} input
   */
  async function createRepository(input) {
    const slug = requireSlug(input.slug ?? input.org, '组织')
    const repoName = requireRepoName(input.name)
    try {
      const created = await client().createRepo(slug, {
        name: repoName,
        visibility: asString(input.visibility) ?? 'private',
        description: asString(input.description) ?? '',
      })
      return { repository: created, slug: `${slug}/${repoName}` }
    } catch (error) {
      if (!isMissingScope(error, 'group-resource')) throw error
      throw new CnbError(
        `新建仓库需要 group-resource:rw，当前令牌没有这项权限。` +
          '请在 CNB 令牌页为令牌勾选「组织-资源」的读写，或在本面板重新扫码取得全权限令牌。',
        { status: error.status, errcode: error.errcode },
      )
    }
  }

  /** @param {{ repo: string }} input */
  async function deleteRepository(input) {
    const repo = requireRepo(input.repo)
    if (input.confirm !== true) throw new CnbError(`删除 ${repo} 需要显式确认（confirm: true）`)
    try {
      await client().deleteRepo(repo)
      return { deleted: repo }
    } catch (error) {
      // The platform refuses Open API deletion under a root group; explain that in
      // the panel's own words instead of forwarding a sentence about root admins.
      if (error instanceof CnbError && error.errcode === 9) {
        throw new CnbError(
          `${repo} 位于根组织下，CNB 不允许通过 Open API 删除（errcode 9）。` +
            '插件已尝试用登录会话走控制台接口；仍失败说明会话未保存或不是该组织管理员。' +
            '请先扫码登录，或到仓库 Settings 页手动删除。',
          { body: error.body },
        )
      }
      throw error
    }
  }

  // --------------------------------------------------------------- workspaces

  /** @param {{ repo?: string, status?: string }} [input] */
  async function listWorkspaces(input = {}) {
    const result = await client().workspaces({
      page: 1,
      pageSize: 100,
      status: asString(input.status),
      slug: asString(input.repo),
    })
    return result
  }

  /** @param {{ repo: string, branch?: string }} input */
  /**
   * Start (or reopen) a repository's dev environment.
   *
   * `branch` is mandatory for CNB — the API answers `[PARAM_MISS]branch is
   * required` for an empty body or for `ref` alone — so an omitted branch is
   * resolved from the repository's own default branch instead of being dropped.
   * That is what makes the panel's one-click "启动开发" work without the person
   * having to name a branch.
   * @param {{ repo: string, branch?: string }} input
   */
  async function openEnvironment(input) {
    const repo = requireRepo(input.repo)
    const cnb = client()
    let branch = asString(input.branch)
    if (branch === undefined) branch = await defaultBranchOf(cnb, repo)
    const started = await cnb.startWorkspace(repo, { branch })
    // CNB answers with `sn` only when it starts a new pipeline; reopening an
    // existing environment returns just the URL, which still carries the sn.
    const url = typeof started?.url === 'string' ? started.url : null
    const sn = typeof started?.sn === 'string' && started.sn !== '' ? started.sn : snFromUrl(url)
    // Ask for the canonical WebIDE address once the sn is known: a loading page is
    // useless to copy, the resolved entry is not. This is best effort — a pipeline
    // that has not finished yet has no address to give.
    const detail = sn === null ? null : await cnb.workspaceDetail(repo, sn).catch(() => null)
    return {
      repo,
      branch,
      sn,
      url,
      webide: typeof detail?.webide === 'string' ? detail.webide : null,
      jumpUrl: typeof detail?.jumpUrl === 'string' ? detail.jumpUrl : null,
      message: started?.message ?? null,
      buildLogUrl: started?.buildLogUrl ?? null,
      state: started?.message === null || started?.message === undefined ? 'running' : 'starting',
    }
  }

  /**
   * The pipeline sn embedded in a workspace URL.
   * @param {string | null} url
   * @returns {string | null}
   */
  /**
   * The environment's `sn`, wherever the answer happened to put it.
   *
   * Two shapes come back and both must work:
   *
   *   /-/workspace/loading?branch=main&sn=cnb-x        (a fresh start)
   *   /-/workspace/vscode-web/cnb-x-001/               (reusing a running one)
   *
   * The second carries the sn only in the path, so a query-only reader returns null
   * and the caller loses the environment it just opened.
   * @param {string} url
   * @returns {string | null}
   */
  function snFromUrl(url) {
    if (typeof url !== 'string' || url === '') return null
    const fromQuery = /[?&]sn=([^&#]+)/.exec(url)
    if (fromQuery !== null) return decodeURIComponent(fromQuery[1])
    // Path forms: /workspace/vscode-web/<id>/ or /workspace/jump?pipelineId=<id>
    const fromPath = /\/workspace\/(?:vscode-web|codebuddy|jetbrains)\/([^/?#]+)/.exec(url)
    if (fromPath !== null) return stripPipelineSuffix(decodeURIComponent(fromPath[1]))
    const fromJump = /[?&]pipelineId=([^&#]+)/.exec(url)
    if (fromJump !== null) return stripPipelineSuffix(decodeURIComponent(fromJump[1]))
    return null
  }

  /**
   * `workspace/detail` wants the short sn, while URLs carry the pipeline ordinal.
   * @param {string} value
   */
  function stripPipelineSuffix(value) {
    return PIPELINE_SUFFIX.test(value) ? value.slice(0, value.lastIndexOf('-')) : value
  }

  /**
   * Which branch a repo's dev environment should start on.
   *
   * The repository object has no `default_branch`, so this asks for the branch
   * list and prefers `main`, then `master`, then whatever the service lists
   * first — the same order the console's own button resolves.
   * @param {CnbApi} cnb @param {string} repo
   * @returns {Promise<string | undefined>}
   */
  /**
   * The branch to hand `workspace/start`.
   *
   * A brand-new repository has no commits, so its branch list is empty — but CNB can
   * still start an environment for it, and `start` requires a branch regardless. Being
   * strict here blocks exactly the case a new repository represents, which is why a
   * fresh repo "could not start". So an empty list falls back to the conventional
   * name rather than refusing.
   * @param {import('./cnb-client.js').CnbApi} cnb @param {string} repo
   * @returns {Promise<string>}
   */
  async function defaultBranchOf(cnb, repo) {
    const branches = await cnb.branches(repo).catch(() => [])
    const names = branches.map((entry) => asString(entry?.name)).filter(Boolean)
    for (const preferred of ['main', 'master']) {
      if (names.includes(preferred)) return preferred
    }
    // No branch at all: an empty repository. CNB accepts any name and materializes the
    // environment from the image, so the conventional default is the best guess.
    return names[0] ?? 'main'
  }

  /**
   * Every entry point one dev environment has.
   *
   * `workspace/detail` only answers with two of them. A live environment also has a
   * CodeBuddy Web entry and a port-preview domain, and the person usually wants one
   * of those rather than the WebIDE. They are built from what is known locally:
   *
   *   WebIDE         <web>/<repo>/-/workspace/vscode-web/<sn>/
   *   CodeBuddy Web  <web>/<repo>/-/workspace/codebuddy/<sn>/
   *   跳转页          <web>/<repo>/-/workspace/jump?pipelineId=<sn>
   *   端口预览        https://<prefix>-{{port}}.<domain>   (a template, not a URL)
   *   流水线日志      <web>/<repo>/-/build/logs/<pipelineId>
   *   仓库主页        <web>/<repo>
   *
   * The port preview is the one that matters most in practice and the one that was
   * missing: a service started inside the environment is reachable only at that
   * domain with the port substituted, so it is returned as a template plus a ready
   * list of the usual ports.
   * CNB names one environment two ways, and they are not interchangeable:
   * `workspace/detail` takes the short `sn` (`cnb-lod-1k81349st`), while the WebIDE
   * and CodeBuddy paths in a URL use the pipeline id (`cnb-lod-1k81349st-001`).
   * Passing one where the other belongs answers 404, so both are carried here and
   * each link is built from the form it needs.
   * @param {{ repo: string, sn: string, pipelineId?: string, ports?: number[], proxyDomain?: string }} input
   */
  async function environmentDetail(input) {
    const repo = requireRepo(input.repo)
    const raw = asString(input.sn)
    if (raw === undefined) throw new CnbError('缺少环境 sn')
    // Callers copy the sn from a URL, which carries the pipeline suffix; the detail
    // API only knows the short form. The suffix is the console's pipeline ordinal —
    // `-001`, three digits — and nothing else: a short sn may itself end in a digit
    // (`cnb-1`), and stripping on "trailing digits" would eat that and build
    // `cnb-001`, which addresses nothing.
    const sn = PIPELINE_SUFFIX.test(raw) ? raw.slice(0, raw.lastIndexOf('-')) : raw
    // A closed environment answers 404; the links are still worth listing, so the
    // lookup is best effort.
    const detail = await client().workspaceDetail(repo, sn).catch(() => null)
    // Trailing `-NNN` is the pipeline suffix; a URL built from the short sn 404s.
    const pipelineId = asString(input.pipelineId) ?? `${sn}-001`
    const links = []
    const push = (kind, label, url, note) => {
      if (typeof url !== 'string' || url === '') return
      // The same address arrives with and without a trailing slash depending on
      // which endpoint produced it.
      const bare = (value) => value.replace(/\/+$/, '')
      if (links.some((link) => bare(link.url) === bare(url))) return
      links.push({ kind, label, url, ...(note === undefined ? {} : { note }) })
    }

    push('webide', 'WebIDE', detail?.webide ?? `${webOrigin}/${repo}/-/workspace/vscode-web/${pipelineId}/`)
    push('codebuddy', 'CodeBuddy Web', `${webOrigin}/${repo}/-/workspace/codebuddy/${pipelineId}/`)
    push('jump', '跳转页', detail?.jumpUrl ?? `${webOrigin}/${repo}/-/workspace/jump?pipelineId=${encodeURIComponent(pipelineId)}`)
    push('logs', '流水线日志', `${webOrigin}/${repo}/-/build/logs/${encodeURIComponent(pipelineId)}`)
    push('repo', '仓库主页', `${webOrigin}/${repo}`)


    /**
     * Port preview.
     *
     * The domain's prefix belongs to one environment (this host only knows it for
     * its own, from `CNB_VSCODE_PROXY_URI`), so it is attached only when the caller
     * names that environment's repo. Applying this host's prefix to another repo
     * would produce a link that looks right and answers 500.
     */
    const proxyDomain = asString(input.proxyDomain)
      ?? (repo === asString(process.env.CNB_REPO_SLUG) ? publishedProxyDomain() : undefined)
    const portTemplate = proxyDomain === undefined ? null : `https://${proxyDomain}`
    const ports = Array.isArray(input.ports) && input.ports.length > 0
      ? input.ports.map(Number).filter((port) => Number.isInteger(port) && port > 0 && port < 65536)
      : DEFAULT_PREVIEW_PORTS
    if (portTemplate !== null) {
      push('ports', '端口预览模板', portTemplate, '把 {{port}} 换成实际端口')
      for (const port of ports) {
        push('ports', `端口预览 ${port}`, portTemplate.replace('{{port}}', String(port)))
      }
    }

    /**
     * Desktop editors do have deep links after all — `workspace/detail` returns them.
     *
     * An earlier pass concluded they did not exist because the web app has no page for
     * them, which was the wrong place to look: they are URI-scheme handoffs to a local
     * client (`cursor://`, `vscode://`, `zed://`, …), plus one plain SSH string. They
     * appear only once the environment is running, which is why the schema had to be
     * read from a live one.
     */
    const clients = clientEntries(webOrigin, repo, pipelineId, detail)
    for (const entry of clients) push(entry.kind, entry.label, entry.url, entry.note)

    return { repo, sn, pipelineId, detail, links, portTemplate, clientHint: CLIENT_HINT }
  }

  /**
   * What a client actually needs in order to connect, per editor.
   *
   * CNB has no per-editor web page: the frontend build ships only `jump`,
   * `loading` and `error` under `/-/workspace/`, so a link like
   * `/-/workspace/cursor/<sn>/` does not exist — it answers 401 like every other
   * unknown path because the app is a catch-all. Emitting one would be a fabricated
   * URL that looks right and fails.
   *
   * The real mechanism is documented and different: every third-party editor
   * connects over SSH (Remote-SSH), and the image must ship `openssh-server`.
   * JetBrains adds a Gateway connection that also runs over SSH. So what is
   * returned here is the connection *coordinates*, plus the two browser entries
   * CNB genuinely serves.
   * @param {string} webOrigin @param {string} repo @param {string} pipelineId
   */
  function clientEntries(webOrigin, repo, pipelineId, detail) {
    const entries = []
    // Browser entries that exist as real pages.
    entries.push({ kind: 'webide', label: 'WebIDE（浏览器）', url: `${webOrigin}/${repo}/-/workspace/vscode-web/${pipelineId}/` })
    entries.push({ kind: 'codebuddy-web', label: 'CodeBuddy Web（浏览器）', url: `${webOrigin}/${repo}/-/workspace/codebuddy/${pipelineId}/` })

    /**
     * Each desktop editor as the URI scheme its client registers.
     *
     * Ordering is by how likely it is to be installed, so the useful ones are not
     * buried. A scheme link only opens a window when that editor is installed; the
     * panel shows the raw URL either way so it can be copied into a terminal.
     */
    const editors = [
      ['vscode', 'VS Code'],
      ['cursor', 'Cursor'],
      ['windsurf', 'Windsurf'],
      ['windsurf-next', 'Windsurf (Next)'],
      ['vscode-insiders', 'VS Code Insiders'],
      ['zed', 'Zed'],
      ['antigravity', 'Antigravity'],
      ['codebuddy', 'CodeBuddy'],
      ['codebuddycn', 'CodeBuddy (CN)'],
    ]
    for (const [key, label] of editors) {
      const url = asString(detail?.[key])
      if (url === undefined) continue
      entries.push({ kind: key, label: `${label} 打开`, url, note: '需本地已安装该编辑器' })
    }

    // The plain SSH coordinates: usable by any client, and the only form that works
    // when the editor is not installed.
    const remoteSsh = asString(detail?.remoteSsh)
    if (remoteSsh !== undefined) {
      entries.push({
        kind: 'ssh',
        label: 'Remote-SSH 连接串',
        url: `ssh ${remoteSsh}`,
        note: 'VS Code / Cursor / Windsurf / Zed 通用',
      })
      const [user, host] = remoteSsh.split('@')
      if (user !== undefined && host !== undefined) {
        entries.push({
          kind: 'ssh-config',
          label: '~/.ssh/config 片段',
          url: `Host cnb-${pipelineId}\n  HostName ${host}\n  User ${user}\n  Port 22`,
          note: `放进 config 后 \`ssh cnb-${pipelineId}\` 即可`,
        })
      }
    }

    // JetBrains is an object, not a string: it holds the Gateway connection per IDE.
    if (detail?.jetbrains !== null && typeof detail?.jetbrains === 'object') {
      for (const [key, value] of Object.entries(detail.jetbrains)) {
        const url = asString(value)
        if (url === undefined) continue
        entries.push({ kind: 'jetbrains', label: `JetBrains ${key}`, url, note: '需 Gateway 与对应 IDE' })
      }
    }
    return entries
  }

  /**
   * The SSH endpoint for one pipeline.
   *
   * CNB publishes the workspace's own SSH endpoint inside the environment; outside
   * it, only the documented fingerprint is available, so the host is taken from the
   * environment when this host is running in one and left unset otherwise rather
   * than guessed.
   * @param {string} pipelineId
   * @returns {{ user: string, host: string, port: number } | null}
   */
  function sshCoordinates(pipelineId) {
    const host = asString(process.env.CNB_WORKSPACE_SSH_HOST) ?? asString(process.env.CNB_SSH_HOST)
    if (host === undefined) return null
    return { user: pipelineId, host, port: Number(process.env.CNB_WORKSPACE_SSH_PORT ?? 22) }
  }

  /**
   * The port-preview domain this host's own environment publishes, if any.
   * @returns {string | undefined}
   */
  function publishedProxyDomain() {
    const published = asString(process.env.CNB_VSCODE_PROXY_URI)
    return published === undefined ? undefined : published.replace(/^https?:\/\//, '')
  }

  /** @param {{ sn?: string, pipelineId?: string }} input */
  async function closeEnvironment(input) {
    const body = identityOfWorkspace(input)
    const cnb = client()
    try {
      const result = await cnb.stopWorkspace(body)
      return { action: 'stop', via: 'workspace', ...body, result }
    } catch (error) {
      // `account-engage:rw` covers the account-wide endpoint only. The same
      // pipeline can be stopped through its repository under
      // `repo-cnb-trigger:rw`, which any token able to start an environment has.
      if (!isMissingScope(error, 'account-engage')) throw error
      // `workspace/list` is gated by the same scope, so the repo has to come from
      // the caller or from the record this deployment already holds.
      const repo = asString(input.repo) ?? asString(body.repo) ?? await repositoryOfWorkspace(body)
      if (repo === undefined) {
        throw new CnbError(
          '当前令牌不能访问账号级环境接口（缺 account-engage）。' +
            '停止环境需要同时给出仓库路径：workspaces.stop 传 repo 即可改走仓库级停止。',
        )
      }
      const sn = body.sn
      if (sn === undefined) throw new CnbError('该令牌无法用账号级接口停止环境，且未提供 sn 以改用仓库级停止')
      try {
        const result = await cnb.stopBuild(repo, sn)
        return { action: 'stop', via: 'build', repo, ...body, result }
      } catch (buildError) {
        if (buildError instanceof CnbError && buildError.errcode === 422) {
          return { action: 'stop', via: 'build', repo, ...body, alreadyStopped: true }
        }
        throw buildError
      }
    }
  }

  /**
   * Which repository owns an environment, when the caller did not say.
   * @param {{ sn?: string, pipelineId?: string }} body
   */
  async function repositoryOfWorkspace(body) {
    try {
      const list = await client().workspaces({ page: 1, pageSize: 200 })
      const wanted = body.sn ?? body.pipelineId
      const hit = list.items.find((workspace) =>
        workspace.sn === wanted || workspace.pipeline_id === wanted,
      )
      return asString(hit?.slug)
    } catch {
      return undefined
    }
  }

  /**
   * Whether a failure is this exact missing permission.
   * @param {unknown} error
   * @param {string} scope bare `group-code`
   */
  function isMissingScope(error, scope) {
    if (!(error instanceof CnbError) || error.errcode !== 10023) return false
    const missing = Array.isArray(error.missingScopes) ? error.missingScopes : []
    return missing.some((entry) => String(entry).startsWith(`${scope}:`))
  }

  /**
   * Remove a dev environment's record.
   *
   * Only the account-level endpoint exists, so this genuinely needs
   * `account-engage:rw`; there is no repo-scoped equivalent. When the token lacks
   * it, the failure explains both the alternative (stopping already works through
   * the repository) and what to do about the token.
   * @param {{ sn?: string, pipelineId?: string, repo?: string }} input
   */
  async function removeEnvironment(input) {
    const body = identityOfWorkspace(input)
    try {
      const result = await client().deleteWorkspace(body)
      return { action: 'delete', ...body, result }
    } catch (error) {
      if (!isMissingScope(error, 'account-engage')) throw error
      throw new CnbError(
        '删除环境只有账号级接口，需要 account-engage:rw；当前令牌没有这项权限。' +
          '「停止环境」可以改走仓库级流水线停止（已支持），删除则需要重新扫码拿到全权限令牌。',
        { status: error.status, errcode: error.errcode },
      )
    }
  }

  /** @param {{ sn?: string, pipelineId?: string }} input */
  function identityOfWorkspace(input) {
    const sn = asString(input.sn)
    const pipelineId = asString(input.pipelineId)
    if (sn === undefined && pipelineId === undefined) throw new CnbError('需要 sn 或 pipelineId 之一')
    return { ...(sn === undefined ? {} : { sn }), ...(pipelineId === undefined ? {} : { pipelineId }) }
  }

  // -------------------------------------------------------------------- usage

  /** @param {{ slug?: string, month?: string }} [input] */
  async function usage(input = {}) {
    const cnb = client()
    const groups = await cnb.myGroups()
    const wanted = asString(input.slug)
    const targets = wanted === undefined
      ? groups.map((group) => ({ slug: group.path ?? group.name, name: group.name, role: group.access_role ?? null }))
      : [{ slug: wanted, name: wanted, role: null }]
    const month = asString(input.month)
    const results = await Promise.all(
      targets.map(async (target) => {
        const org = target.slug
        const [summary, repoRows] = await Promise.all([
          cnb.orgUsage(org, month),
          cnb.repoUsage(org, 'charge_type_git', { page: 1, pageSize: 100 }).catch(() => []),
        ])
        return {
          slug: org,
          name: target.name,
          role: target.role ?? null,
          quota: summary.quota,
          used: summary.used,
          privilege: summary.privilege,
          repos: repoRows,
          metrics: buildMetrics(summary),
        }
      }),
    )
    return { month: month ?? currentMonth(), groups: results, types: USAGE_TYPES.map(([id, label]) => ({ id, label })) }
  }

  /**
   * Join quotas and usage into display-ready rows.
   * @param {{ quota?: any, used?: any }} summary
   */
  function buildMetrics(summary) {
    const quota = summary.quota && typeof summary.quota === 'object' && !('error' in summary.quota) ? summary.quota : null
    const used = summary.used && typeof summary.used === 'object' && !('error' in summary.used) ? summary.used : null
    /** @type {Array<{ id: string, total: number | null, free: number | null, used: number | null, severity: string }>} */
    const metrics = []
    for (const [id, label] of USAGE_TYPES) {
      const key = id.replace('charge_type_', '')
      const quotaKey = `${key}_in_sec`.replace('dev_gpu_in_sec', 'dev_gpu_in_sec').replace('ci_gpu_in_sec', 'ci_gpu_in_sec')
      const byteKey = `${key}_in_byte`
      const creditKey = 'credit_in_milli'
      const isByte = key === 'git' || key === 'object'
      const isCredit = key === 'credit'
      const lookup = isCredit ? creditKey : isByte ? byteKey : quotaKey
      const total = quota?.[lookup]?.total ?? null
      const free = quota?.[lookup]?.free ?? null
      const consumed = used?.[lookup] ?? null
      const ratio = total !== null && total > 0 && consumed !== null ? consumed / total : null
      metrics.push({
        id,
        label,
        unit: isCredit ? 'credit' : isByte ? 'byte' : 'core-second',
        total,
        free,
        used: consumed,
        ratio,
        severity: ratio === null ? 'unknown' : ratio >= 0.9 ? 'critical' : ratio >= 0.75 ? 'warning' : 'ok',
      })
    }
    return metrics
  }

  // ----------------------------------------------------------------- gateway

  /**
   * Probe the repo's AI proxy and report what a gateway configuration would use.
   * @param {{ repo?: string, model?: string, prompt?: string }} [input]
   */
  async function gatewayProbe(input = {}) {
    const repo = asString(input.repo)
    const model = asString(input.model) ?? FALLBACK_MODELS[0].id
    if (repo === undefined) return { repo: null, models: FALLBACK_MODELS, reachable: false, reason: '未选择仓库' }
    const probe = await client()
      .chat(repo, {
        model,
        messages: [{ role: 'user', content: asString(input.prompt) ?? '回复 OK 两个字母即可' }],
        maxTokens: 24,
      })
      .then((result) => ({ ok: true, result }))
      .catch((error) => ({ ok: false, error: message(error) }))
    return {
      repo,
      model,
      baseURL: `${apiOrigin}/${repo}/-/ai`,
      models: FALLBACK_MODELS,
      reachable: probe.ok,
      sample: probe.ok ? probe.result.text.slice(0, 200) : null,
      reasoning: probe.ok ? probe.result.reasoning.slice(0, 200) : null,
      usage: probe.ok ? probe.result.usage : null,
      reason: probe.ok ? null : probe.error,
    }
  }

  /**
   * Write (or refresh) the provider route in `llm-pi-ai` and make it the default
   * model selection when asked. Both writes go through the normal config editor,
   * so the profile patch stays the single source of truth.
   *
   * A deployment can boot with a `--patch` overlay or a home patch that already
   * owns these rows; the editor refuses to write beneath one. That is not a
   * failure of this plugin, so it answers with the exact snippet to paste
   * instead of a bare error.
   * @param {{ repo?: string, route?: string, model?: string, makeDefault?: boolean }} [input]
   */
  async function configureGateway(input = {}) {
    const repo = asString(input.repo)
    if (repo === undefined) throw new CnbError('需要仓库路径，例如 group/name')
    const route = asString(input.route) ?? DEFAULT_PROVIDER_ROUTE
    const model = asString(input.model) ?? FALLBACK_MODELS[0].id
    const editor = ctx.get('configEditor')
    if (!editor) throw new CnbError('当前 profile 没有 configEditor，无法写入模型配置')

    const entries = editor.entries()
    const piEntry = entries.find((entry) => entry.options.id === 'llm-pi-ai')
      ?? entries.find((entry) => entry.options.name === '@deepseek-ai/dsh-llm-pi-ai')
    if (!piEntry) throw new CnbError('profile 未挂载 @deepseek-ai/dsh-llm-pi-ai，无法登记网关')

    const profile = gatewayProviderProfile({ repo, model, models: FALLBACK_MODELS })
    const base = {
      route,
      baseURL: profile.baseURL,
      api: profile.api,
      models: profile.models.map((entry) => entry.id),
      credentialRef: profile.apiKeyEnv,
      tokenStored: (await readRecord()) !== undefined,
      defaultModel: null,
    }

    const overlaid = []
    let providerWritten = false
    try {
      await editor.edit(piEntry, (current) => {
        const providers = current.providers && typeof current.providers === 'object' ? current.providers : {}
        return { ...current, providers: { ...providers, [route]: profile } }
      })
      providerWritten = true
    } catch (error) {
      if (!isOverlayRefusal(error)) throw error
      overlaid.push('llm-pi-ai')
    }

    let defaultModel = null
    if (input.makeDefault === true) {
      const defaultEntry = entries.find((entry) => entry.options.id === 'agent-default-model')
      if (defaultEntry) {
        try {
          await editor.edit(defaultEntry, (current) => ({ ...current, provider: route, model }))
          defaultModel = { provider: route, model }
        } catch (error) {
          if (!isOverlayRefusal(error)) throw error
          overlaid.push('agent-default-model')
        }
      }
    }

    if (overlaid.length === 0) return { ...base, defaultModel, written: true, overlay: null }
    return {
      ...base,
      defaultModel,
      written: providerWritten,
      overlay: {
        rows: overlaid,
        // Exactly what an operator pastes into the overlay file that owns these rows.
        snippet: overlaySnippet({ route, profile, makeDefault: input.makeDefault === true, model }),
        hint: `${overlaid.join('、')} 由 home patch 或命令行 --patch 覆盖，configEditor 不会写在更高优先级层之下；把下面的片段并入那份 overlay 即可生效。`,
      },
    }
  }

  /** @param {unknown} error */
  function isOverlayRefusal(error) {
    const text = message(error)
    return text.includes('overridden by a home patch') || text.includes('command-line overlay')
  }

  /**
   * The YAML an overlay file needs for this gateway route.
   * @param {{ route: string, profile: object, makeDefault: boolean, model: string }} input
   */
  function overlaySnippet(input) {
    const models = input.profile.models
      .map((model) => [
        `          - id: "${model.id}"`,
        `            name: "${model.name}"`,
        `            contextWindow: ${model.contextWindow}`,
        `            maxTokens: ${model.maxTokens}`,
        `            reasoningEfforts:`,
        ...Object.entries(model.reasoningEfforts).map(([level, wire]) =>
          wire === null ? `              ${level}:` : `              ${level}: ${wire}`,
        ),
      ].join('\n'))
      .join('\n')
    const rows = []
    if (input.makeDefault) {
      rows.push([
        '- id: agent-default-model',
        '  config:',
        `    provider: ${input.route}`,
        `    model: "${input.model}"`,
      ].join('\n'))
    }
    rows.push([
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      `      ${input.route}:`,
      `        displayName: "${input.profile.displayName}"`,
      `        api: ${input.profile.api}`,
      `        baseURL: ${input.profile.baseURL}`,
      `        apiKeyEnv: ${input.profile.apiKeyEnv}`,
      '        compat:',
      '          thinkingFormat: openai',
      '          supportsReasoningEffort: false',
      '          supportsUsageInStreaming: true',
      '          maxTokensField: max_tokens',
      '        models:',
      models,
    ].join('\n'))
    return rows.join('\n')
  }

  /**
   * Probe what the stored token can actually do.
   *
   * CNB reports a missing permission as `10023` naming the scope, but only for
   * the endpoint that was called, so a single failure says little. This walks the
   * handful of calls the panel makes and reports each one separately, which is
   * how "logged in but the repository list is empty" becomes a named cause.
   */
  async function diagnoseToken() {
    const record = await readRecord()
    if (record === undefined) {
      return { signedIn: false, hint: '尚未登录：请扫码登录，或在面板里粘贴一个访问令牌。' }
    }
    // The probe must carry the session too, or the self-check reports a scope
    // failure for a call the panel can actually complete through the session —
    // a red row for a working feature.
    const probe = new CnbApi({
      token: async () => record.token,
      api: apiOrigin,
      timeoutMs: requestTimeoutMs,
      web: webOrigin,
      session: async () => record.session,
    })
    /** @param {string} name @param {() => Promise<unknown>} run */
    const check = async (name, run) => {
      const before = probe.sessionUsed
      try {
        const value = await run()
        // Distinguish "the token itself is allowed" from "the session carried it":
        // both work, but only the second one means the token's scopes are short.
        const viaSession = probe.sessionUsed > before
        return { name, ok: true, viaSession, value }
      } catch (error) {
        return { name, ok: false, error: message(error), missingScopes: extractMissing(error) }
      }
    }
    const checks = []
    checks.push(await check('identity', async () => {
      const user = await probe.me()
      return { username: user?.username ?? null, nickname: user?.nickname ?? null }
    }))
    checks.push(await check('repositories', async () => {
      const repos = await probe.myRepos({ pageSize: 1 })
      return { total: repos.total, first: repos.items[0]?.path ?? null }
    }))
    checks.push(await check('organizations', async () => {
      const groups = await probe.myGroups()
      return { count: groups.length, slugs: groups.slice(0, 5).map((group) => group.path ?? group.name) }
    }))
    checks.push(await check('quota', async () => {
      const groups = await probe.myGroups()
      const slug = groups[0]?.path ?? groups[0]?.name
      if (slug === undefined) return { skipped: 'no organization' }
      const summary = await probe.orgUsage(slug)
      return { slug, hasQuota: Boolean(summary.quota), hasUsage: Boolean(summary.used) }
    }))
    checks.push(await check('workspaces', async () => {
      const list = await probe.workspaces({ pageSize: 1 })
      return { total: list.total }
    }))

    /**
     * Classify a write probe.
     *
     * CNB checks the scope before it looks at the target, so aiming at something
     * that cannot exist separates the two outcomes without side effects. A 401 is
     * neither: the token is not accepted at all, and reporting that as "granted"
     * would turn an invalid token into a clean bill of health.
     * @param {unknown} error
     */
    const writeOutcome = (error) => {
      if (error instanceof CnbError && error.errcode === 10023) throw error
      if (error instanceof CnbError && (error.status === 401 || error.errcode === 16)) throw error
      return { permission: 'granted' }
    }

    // Write permissions, probed without side effects.
    checks.push(await check('workspace-control', async () => {
      try {
        await probe.stopWorkspace({ sn: DOCTOR_PROBE_SN })
        return { probe: 'unexpected-success', via: 'workspace' }
      } catch (error) {
        if (error instanceof CnbError && error.errcode === 10023) {
          // The account-wide stop is gated by account-engage, but the same
          // pipeline can be stopped through its repository, which only needs
          // repo-cnb-trigger — the permission that starting an environment
          // requires. Report the capability, not the endpoint.
          const missing = extractMissing(error)
          if (missing.some((scope) => scope.startsWith('account-engage:'))) {
            return { via: 'build', note: '账号级停止不可用，改用仓库级流水线停止（需要 repo-cnb-trigger）' }
          }
          throw error
        }
        return writeOutcome(error)
      }
    }))
    checks.push(await check('repo-create', async () => {
      const slug = (await probe.myGroups())[0]?.path ?? (await probe.myGroups())[0]?.name
      if (slug === undefined) return { skipped: 'no organization' }
      try {
        // A name CNB can never accept: the scope is still checked first, so this
        // distinguishes "no permission" from "permission, bad input".
        await probe.createRepo(slug, { name: '', visibility: 'private' })
        return { probe: 'unexpected-success' }
      } catch (error) {
        return { ...writeOutcome(error), slug }
      }
    }))
    checks.push(await check('repo-delete', async () => {
      try {
        await probe.deleteRepo(DOCTOR_PROBE_REPO)
        return { probe: 'unexpected-success' }
      } catch (error) {
        return writeOutcome(error)
      }
    }))
    const failing = checks.filter((entry) => !entry.ok)
    const missing = new Set()
    for (const entry of failing) for (const scope of entry.missingScopes ?? []) missing.add(scope)
    // A token CNB does not accept at all answers 401/16 before any scope check.
    const rejected = failing.length > 0 && failing.every((entry) => /未登录|not logged in|HTTP 401/i.test(String(entry.error)))
    const grants = [...missing].map((scope) => consoleGrantHint(scope.replace(/:.*/, ''))).filter(Boolean)
    const viaSession = checks.filter((check) => check.ok && check.viaSession === true).map((check) => check.name)
    return {
      signedIn: true,
      scopeRecorded: record.scope ?? null,
      checks,
      healthy: failing.length === 0,
      rejected,
      missingScopes: [...missing],
      grants,
      // Capabilities the token could not authorize but the stored session could.
      viaSession,
      sessionStored: typeof record.session === 'string' && record.session !== '',
      hint: failing.length === 0
        ? null
        : rejected
          ? 'CNB 不接受这个令牌（会话无效或令牌已被删除/过期）。请重新扫码登录，或粘贴一个仍有效的访问令牌。'
          : missing.size > 0
            ? `当前令牌缺少：${[...missing].join('、')}。这类令牌通常是按不带级别的名字创建的——CNB 会丢弃那种授权。请在本面板重新扫码登录（会按全权限重新签发），或在 CNB 令牌页重新勾选这些权限项。`
            : '部分接口失败但未指明权限项，请查看上面每一项的错误。',
    }
  }

  /**
   * Scope names a failed call reported.
   * @param {unknown} error
   * @returns {string[]}
   */
  function extractMissing(error) {
    if (error && Array.isArray(error.missingScopes)) return error.missingScopes
    return extractMissingScopes(message(error))
  }

  // --------------------------------------------------------------- validation

  /** @param {unknown} value @param {string} label */
  function requireSlug(value, label) {
    const slug = asString(value)
    if (slug === undefined) throw new CnbError(`缺少${label}`)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) throw new CnbError(`${label}格式不合法：${slug}`)
    return slug
  }

  /** @param {unknown} value */
  function requireRepoName(value) {
    const name = asString(value)
    if (name === undefined) throw new CnbError('缺少仓库名')
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) throw new CnbError(`仓库名格式不合法：${name}`)
    return name
  }

  /** @param {unknown} value */
  function requireRepo(value) {
    const repo = asString(value)
    if (repo === undefined) throw new CnbError('缺少仓库路径，例如 group/name')
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo)) {
      throw new CnbError(`仓库路径格式不合法：${repo}`)
    }
    return repo
  }

  function currentMonth() {
    const now = new Date()
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
  }

  // --------------------------------------------------------------- operations

  /**
   * One operation table so the HTTP panel and the agent tools cannot drift.
   * Every entry takes a plain JSON argument object and returns JSON.
   */
  const operations = {
    status: () => status(),
    'login.begin': async () => {
      const view = await beginLogin()
      const qr = qrSvgPath(view.ticketUrl, { scale: 6, margin: 4 })
      return { ...view, qr }
    },
    'login.poll': () => pollLogin(),
    'login.cancel': async () => {
      attempt = null
      return { state: 'none' }
    },
    'login.logout': () => logout(),
    'login.importToken': (input) => importToken(input),
    'token.doctor': () => diagnoseToken(),
    'token.remint': (input) => remintToken(input ?? {}),
    'login.scopes': async () => {
      const table = await fetchScopeTable({ web: webOrigin })
      return {
        grantable: table.length,
        full: fullScopes(table),
        plugin: pluginScopes(table),
        note: 'CNB 的授权范围必须带 :r/:rw 级别；不带级别的名字会被丢弃，令牌将没有任何权限。',
      }
    },
    'repos.list': (input) => listRepositories(input ?? {}),
    'repos.status': (input) => repositoryStatus(input ?? {}),
    'repos.create': (input) => createRepository(input ?? {}),
    'repos.delete': (input) => deleteRepository(input ?? {}),
    'workspaces.list': (input) => listWorkspaces(input ?? {}),
    'workspaces.open': (input) => openEnvironment(input ?? {}),
    'workspaces.detail': (input) => environmentDetail(input ?? {}),
    'workspaces.stop': (input) => closeEnvironment(input ?? {}),
    'workspaces.delete': (input) => removeEnvironment(input ?? {}),
    'usage.list': (input) => usage(input ?? {}),
    'gateway.probe': (input) => gatewayProbe(input ?? {}),
    'gateway.configure': (input) => configureGateway(input ?? {}),
  }

  /**
   * Run one operation, normalizing every failure into a result the panel and the
   * tools both understand.
   * @param {string} op @param {unknown} input
   */
  async function runOperation(op, input) {
    const handler = operations[op]
    if (handler === undefined) throw new CnbError(`未知操作：${op}`)
    try {
      return await handler(input)
    } catch (error) {
      // A rejected token is recoverable without the user: the stored web session
      // can mint a fresh one. Do that once, then retry the call that failed, so a
      // token expiry never surfaces as "you need to scan again".
      if (!isRecoverableTokenFailure(error)) throw error
      const healed = await remintToken({ reason: message(error) }).catch(() => ({ ok: false }))
      if (!healed.ok) throw error
      return handler(input)
    }
  }

  /**
   * How long the stored browser session lasts, and when it lapses.
   *
   * CNB's session cookie is opaque, so the lifetime is the one chosen at sign-in
   * (default 7 days, `WECHAT_DEFAULT_LOGIN_DAYS`) and the expiry is derived from
   * when the session was captured. Reporting `unknown` beats inventing a date.
   * @param {{ session?: string, sessionSavedAt?: string, sessionExpiresAt?: string, cookieName?: string, sessionMaxAgeSeconds?: number } | undefined} record
   */
  function sessionLifetime(record) {
    if (record === undefined || typeof record.session !== 'string' || record.session === '') {
      return { stored: false, savedAt: null, expiresAt: null, remainingMs: null, source: null, cookieName: null }
    }
    const savedAt = record.sessionSavedAt ?? null
    // The server's own Max-Age/Expires is authoritative; only when it sent none does
    // the documented default stand in, and the answer then says it is an estimate.
    const fromServer = typeof record.sessionExpiresAt === 'string' ? record.sessionExpiresAt : null
    const expiresAt = fromServer
      ?? (savedAt === null ? null : new Date(new Date(savedAt).getTime() + DEFAULT_LOGIN_DAYS * 86_400_000).toISOString())
    const remainingMs = expiresAt === null ? null : new Date(expiresAt).getTime() - Date.now()
    return {
      stored: true,
      savedAt,
      expiresAt,
      remainingMs,
      source: fromServer === null ? 'estimated' : 'server',
      cookieName: record.cookieName ?? null,
      maxAgeSeconds: record.sessionMaxAgeSeconds ?? null,
    }
  }

  /**
   * Whether a failure is a token problem the stored session can repair.
   *
   * 401 means the token is not accepted; 10023 means it is accepted but lacks a
   * scope. Both are fixed by minting again with a different grant, and neither is
   * fixed by retrying the same token.
   * @param {unknown} error
   */
  function isRecoverableTokenFailure(error) {
    if (!(error instanceof CnbError)) return false
    if (error.status === 401 || error.errcode === 16) return true
    return error.errcode === 10023
  }

  ctx.effect(() => () => {
    attempt = null
    identity = null
    api = null
  }, 'dsh-cnb: reset session state')

  // ------------------------------------------------------------------ routes

  /** @param {import('node:http').ServerResponse} response @param {number} status @param {unknown} payload */
  function sendJson(response, status, payload) {
    response.writeHead(status, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    })
    response.end(JSON.stringify(payload))
  }

  /** @param {import('node:http').IncomingMessage} request @param {number} [limit] */
  async function readBody(request, limit = 256 * 1024) {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > limit) throw new CnbError('请求体过大')
      chunks.push(buffer)
    }
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (text === '') return {}
    try {
      return JSON.parse(text)
    } catch {
      throw new CnbError('请求体不是合法 JSON')
    }
  }

  /** @param {import('node:http').IncomingMessage} request */
  function assertTrusted(request) {
    const host = String(request.headers.host ?? '').toLowerCase()
    const origin = String(request.headers.origin ?? '').toLowerCase()
    if (origin !== '' && origin !== 'null') {
      let originHost = ''
      try {
        originHost = new URL(origin).host
      } catch {
        throw new CnbError('来源不合法', { status: 403 })
      }
      if (originHost !== host) throw new CnbError('跨站请求被拒绝', { status: 403 })
    }
    const site = String(request.headers['sec-fetch-site'] ?? '').toLowerCase()
    if (site === 'cross-site') throw new CnbError('跨站请求被拒绝', { status: 403 })
  }

  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const disposers = []
      const register = (path, handler) => {
        try {
          disposers.push(host.webServer.register({ kind: 'prefix', path, handler }))
        } catch (error) {
          console.warn(`[dsh-cnb] route ${path}: ${message(error)}`)
        }
      }

      register('/dsh-cnb/api', async (request, response) => {
        try {
          assertTrusted(request)
          if (request.method === 'OPTIONS') {
            response.writeHead(204, { 'cache-control': 'no-store' })
            response.end()
            return
          }
          const url = new URL(request.url ?? '/dsh-cnb/api', `http://${request.headers.host ?? 'localhost'}`)
          const op = url.pathname.replace(/^\/dsh-cnb\/api\/?/, '').replace(/\/+$/, '')
          const input = request.method === 'GET' ? {} : await readBody(request)
          const result = await runOperation(op === '' ? 'status' : decodeURIComponent(op), { ...Object.fromEntries(url.searchParams), ...input })
          sendJson(response, 200, { ok: true, result })
        } catch (error) {
          const status = error instanceof CnbError && typeof error.status === 'number' ? error.status : 400
          sendJson(response, status === 200 ? 400 : status, { ok: false, error: message(error) })
        }
      })

      return () => {
        for (const dispose of disposers.reverse()) {
          try {
            dispose()
          } catch {
            /* the fibre is going away anyway */
          }
        }
      }
    }, 'dsh-cnb: panel routes')
  })

  // ------------------------------------------------------------------- tools

  const toolRegistry = ctx.get('tools')
  if (toolRegistry) {
    const textOutput = {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    }
    /** @param {string} toolName @param {string} description @param {Record<string, unknown>} parameters @param {(input: any) => Promise<unknown>} execute */
    const register = (toolName, description, parameters, execute) => {
      try {
        toolRegistry.register({
          name: toolName,
          description,
          parameters: { type: 'object', additionalProperties: false, ...parameters },
          output: textOutput,
          async execute(args) {
            try {
              return await execute(args ?? {})
            } catch (error) {
              return { ok: false, error: message(error) }
            }
          },
        })
      } catch (error) {
        console.warn(`[dsh-cnb] tool ${toolName}: ${message(error)}`)
      }
    }

    register(
      'cnb_status',
      '查看 dsh-cnb 的登录状态：当前 CNB 账号、令牌有效期、是否存在待扫码会话。',
      { properties: {} },
      () => status(),
    )
    register(
      'cnb_login_begin',
      '开始 CNB 扫码登录，返回扫码票据 URL 与可直接渲染的二维码 SVG path。用户在手机微信扫码确认后，用 cnb_login_poll 完成登录并自动保存访问令牌。',
      { properties: {} },
      async () => {
        const view = await beginLogin()
        return { ...view, qr: qrSvgPath(view.ticketUrl, { scale: 6, margin: 4 }) }
      },
    )
    register(
      'cnb_login_poll',
      '轮询 CNB 扫码状态一次。confirmed 时插件已自动创建并保存访问令牌（无需再传令牌）。',
      { properties: {} },
      () => pollLogin(),
    )
    register(
      'cnb_login_scopes',
      '列出 CNB 可授权的权限项及其级别。CNB 的授权范围必须写成 <group>-<code>:<level>；不带级别的名字会被服务端丢弃，签出的令牌将没有任何权限。',
      { properties: {} },
      async () => {
        const table = await fetchScopeTable({ web: webOrigin })
        return {
          grantable: table.length,
          full: fullScopes(table),
          plugin: pluginScopes(table),
        }
      },
    )
    register(
      'cnb_repos',
      '列出当前账号可访问的 CNB 仓库，附带每个仓库已有的云原生开发环境。',
      {
        properties: {
          search: { type: 'string', description: '按仓库名过滤' },
          page: { type: 'integer', minimum: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
      (input) => listRepositories(input),
    )
    register(
      'cnb_repo_status',
      '查询单个 CNB 仓库的详细状态：仓库元信息、最近构建、云原生开发环境列表，以及 .cnb/settings.yml 里配置的开发按钮。',
      { properties: { repo: { type: 'string', description: 'group/name' } }, required: ['repo'] },
      (input) => repositoryStatus(input),
    )
    register(
      'cnb_repo_create',
      '在指定组织下创建 CNB 仓库。',
      {
        properties: {
          slug: { type: 'string', description: '组织路径，例如 catboy98' },
          name: { type: 'string', description: '仓库名' },
          visibility: { type: 'string', enum: ['public', 'private', 'secret'] },
          description: { type: 'string' },
        },
        required: ['slug', 'name'],
      },
      (input) => createRepository(input),
    )
    register(
      'cnb_repo_delete',
      '删除 CNB 仓库及其全部数据；必须显式传 confirm: true。',
      {
        properties: {
          repo: { type: 'string', description: 'group/name' },
          confirm: { type: 'boolean', description: '必须为 true 才执行删除' },
        },
        required: ['repo', 'confirm'],
      },
      (input) => deleteRepository(input),
    )
    register(
      'cnb_workspaces',
      '列出当前账号的云原生开发环境，可按仓库或状态过滤。',
      {
        properties: {
          repo: { type: 'string', description: 'group/name，可选' },
          status: { type: 'string', enum: ['running', 'closed'] },
        },
      },
      (input) => listWorkspaces(input),
    )
    register(
      'cnb_workspace_open',
      '启动（或复用）仓库的云原生开发环境，等价于点击仓库页的开发按钮，返回 WebIDE 地址或启动页。',
      {
        properties: {
          repo: { type: 'string', description: 'group/name' },
          branch: { type: 'string' },
        },
        required: ['repo'],
      },
      (input) => openEnvironment(input),
    )
    register(
      'cnb_workspace_control',
      '停止或删除一个云原生开发环境。action=stop 关闭，action=delete 彻底删除。给 repo 时停止可改走仓库级流水线停止，只需要 repo-cnb-trigger 权限。',
      {
        properties: {
          action: { type: 'string', enum: ['stop', 'delete'] },
          repo: { type: 'string', description: 'group/name；停止环境时用于仓库级回退' },
          sn: { type: 'string' },
          pipelineId: { type: 'string' },
        },
        required: ['action'],
      },
      (input) => (input.action === 'delete' ? removeEnvironment(input) : closeEnvironment(input)),
    )
    register(
      'cnb_usage',
      '读取当前账号各组织的月度用量与额度（构建核时、开发核时、GPU、Git、对象存储、AI Credits）。',
      {
        properties: {
          slug: { type: 'string', description: '组织路径，省略则返回全部组织' },
          month: { type: 'string', description: 'YYYYMM，省略为当月' },
        },
      },
      (input) => usage(input),
    )
    register(
      'cnb_token_doctor',
      '诊断当前 CNB 令牌实际能做什么：逐个探测身份、仓库、用量、工作区接口，指出缺哪个权限项，并按需要重新申请全权限令牌的步骤。',
      { properties: {} },
      async () => diagnoseToken(),
    )
    register(
      'cnb_gateway_probe',
      '用仓库自带的 CNB AI 网关（OpenAI 兼容、仅流式）做一次真实调用，确认模型可用。',
      {
        properties: {
          repo: { type: 'string', description: 'group/name' },
          model: { type: 'string' },
          prompt: { type: 'string' },
        },
        required: ['repo'],
      },
      (input) => gatewayProbe(input),
    )
    register(
      'cnb_gateway_configure',
      '把仓库的 CNB AI 网关一键写入 dsh 的 llm-pi-ai 配置（provider 路由 + 模型目录），可同时设为默认模型。令牌由插件自己的凭证记录提供，不需要明文写进配置。',
      {
        properties: {
          repo: { type: 'string', description: '提供网关的仓库，例如 group/name' },
          route: { type: 'string', description: 'provider 路由名，默认 cnb-gateway' },
          model: { type: 'string', description: '默认模型 id' },
          makeDefault: { type: 'boolean', description: '是否同时设为 dsh 默认模型' },
        },
        required: ['repo'],
      },
      (input) => configureGateway(input),
    )
  }

  // Keep the exported surface discoverable for tests and for future hosts.
  return {
    operations,
    runOperation,
    status,
    beginLogin,
    pollLogin,
    listRepositories,
    usage,
    gatewayProbe,
    configureGateway,
    diagnoseToken,
    requestId: randomUUID(),
    // Test seams: drive one sign-in step without a phone or a real CNB session.
    __test: {
      /** Replace the live attempt with a stub that answers the session protocol. */
      setAttempt(stub) {
        attempt = stub
      },
      /** Observe the stored record without going through the panel. */
      readStored: () => readRecord(),
    },
  }
}

export default { name, apply }
