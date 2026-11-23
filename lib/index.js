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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { CnbApi, CnbError, DEFAULT_LOGIN_DAYS, LoginAttempt, extractMissingScopes, message } from './cnb-client.js'
import { consoleGrantHint, essentialScopes, fetchScopeTable, fullScopes, pluginScopes } from './scopes.js'
import { parseMiniYaml, readWorkspaceConfig } from './mini-yaml.js'
import { qrSvgPath } from './qr.js'
import {
  DEFAULT_CANDIDATES,
  DEFAULT_CLOUD_PORT,
  MARKERS,
  PROVISION_STEPS,
  cloudProviderProfile,
  defaultRepoName,
  markersComplete,
  mintGatewayKey,
  parseGatewayMarkers,
  scaffoldCommitConfig,
  scaffoldCnbYml,
  splitModels,
  wrapInlineStage,
} from './provision.js'
import { buildScaffold } from './scaffold.js'
import { describeModel } from './model-catalog.js'
import { describeSessionAdoption, surveySessionSelections } from './session-adopt.js'
import { classifyGatewayError } from './model-guard.js'

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

/**
 * Credential reference the gateway provider reads its key from.
 *
 * It is deliberately not `CNB_TOKEN`: that name holds whatever the panel signed in
 * with, and the AI gateway accepts only a pipeline token — a personal one is refused
 * with "[NO_RIGHT] OpenAPI only allowed in pipeline". Sharing one name means whichever
 * was written last decides, so the gateway breaks the moment someone scans in.
 */
const GATEWAY_KEY_REF = 'CNB_GATEWAY_TOKEN'

/** Where the gateway's own pipeline token is kept when one has been imported. */
const GATEWAY_CREDENTIAL = `${CREDENTIAL_SCOPE}/gateway-token`

/**
 * 云网关的访问 key 存在哪。
 *
 * 它和 `CNB_GATEWAY_TOKEN` 是两件事：后者是**上游**流水线令牌（只在云环境里有），
 * 前者是**下游**客户端出示给云网关代理的 key。混成一个名字会让「换环境」变成
 * 「换令牌」，而这两个生命周期并不一样。
 */
const CLOUD_KEY_REF = 'DSH_CLOUD_GW_KEY'

/** The models CNB's own AI gateway advertises in its web bootstrap. */
/**
 * Models the CNB gateway serves.
 *
 * The gateway exposes no model-list endpoint — `/v1/models`, `/models` and `/model/list`
 * all answer 404 — so the list is carried here. It was read from a live gateway (through
 * a local proxy over `/-/ai-ide/v2`) and is used as a starting point, not a guarantee:
 * `gateway.probe` takes any id, and the panel lets one be typed in, so a model added
 * upstream still works without a plugin release.
 *
 * Offering one model made the panel look like the gateway had nothing: the selector
 * showed a single entry while the service served ten.
 */
const FALLBACK_MODELS = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 256_000, maxTokens: 8_192 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 256_000, maxTokens: 8_192 },
  { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', contextWindow: 128_000, maxTokens: 8_192 },
  { id: 'glm-5.3-flashx', name: 'GLM 5.3 FlashX', contextWindow: 128_000, maxTokens: 8_192 },
  { id: 'step-5-preview', name: 'Step 5 Preview', contextWindow: 128_000, maxTokens: 8_192 },
  { id: 'mimo-v2.6-pro', name: 'MiMo V2.6 Pro', contextWindow: 128_000, maxTokens: 8_192 },
  { id: 'minimax-m3.1-flash', name: 'MiniMax M3.1 Flash', contextWindow: 128_000, maxTokens: 8_192 },
  { id: 'hy4free', name: 'Hy4 Free', contextWindow: 128_000, maxTokens: 8_192 },
  { id: 'hy4std', name: 'Hy4', contextWindow: 128_000, maxTokens: 8_192 },
  { id: 'space-bunny', name: 'Space Bunny', contextWindow: 128_000, maxTokens: 8_192 },
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
    apiKeyEnv: GATEWAY_KEY_REF,
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
  /** What the startup adoption attempt concluded, for the panel to display. */
  let adoptOutcome = null
  /**
   * 云网关的开通结果（最近一次）。
   *
   * 只活在内存里：地址会随环境重建而变，把它持久化等于给用户一个「看起来配好了、
   * 其实指向已死域名」的假象。provider 配置本身由 configEditor 落盘，那才是事实来源。
   */
  let cloudState = {}

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
    } else {
      await credentials.modifyRecord(key, async () => ({ kind: 'grant', payload }))
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
      // A gateway already configured by a higher layer is not a problem to fix.
      overriddenBy: overridingLayers(),
      // Why automatic adoption did or did not happen. A workspace user cannot read the
      // process log, so the answer belongs where the question is asked.
      gatewayAdoption: adoptOutcome,
      ambient: ambientPipelineToken() === null
        ? { token: false, repo: null }
        : { token: true, repo: ambientPipelineToken().repo },
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
    // Prefer the imported pipeline token: the panel's own sign-in is usually a personal
    // token, which the gateway refuses outright.
    const gateway = await readGatewayToken()
    const probe = await (gateway === undefined ? client() : new CnbApi({ token: async () => gateway.token, api: apiOrigin, timeoutMs: requestTimeoutMs }))
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
      blocker: probe.ok ? null : classifyGatewayBlocker(probe.error),
    }
  }

  /**
   * Read and write the gateway's own pipeline token.
   *
   * Kept apart from the panel's sign-in for the reason above: the gateway accepts a
   * pipeline token only, so this credential is imported rather than minted. It lives in
   * the credentials store, and its reference is what `llm-pi-ai` resolves at call time.
   */
  async function readGatewayToken() {
    const credentials = ctx.get('credentials')
    if (!credentials?.readRecord) return undefined
    const record = await credentials.readRecord(GATEWAY_CREDENTIAL)
    const token = typeof record?.payload?.token === 'string' ? record.payload.token : ''
    return token === '' ? undefined : { token, savedAt: record.payload.savedAt ?? null, repo: record.payload.repo ?? null }
  }

  /** @param {string} token @param {{ repo?: string }} [meta] */
  async function writeGatewayToken(token, meta = {}) {
    const credentials = ctx.get('credentials')
    if (!credentials) throw new CnbError('当前 profile 没有 credentials 服务')
    await credentials.modifyRecord(GATEWAY_CREDENTIAL, async () => ({
      kind: 'grant',
      payload: { token, savedAt: new Date().toISOString(), repo: meta.repo ?? null },
    }))
    await credentials.set(GATEWAY_KEY_REF, token)
  }

  /**
   * Import a pipeline token for the gateway and prove it works before keeping it.
   *
   * A token is accepted only if the gateway answers with it, so a wrong type (a
   * personal token) or a token bound to another repository is rejected here with the
   * reason, instead of being stored and failing on every request later.
   * @param {{ token?: string, repo?: string, model?: string }} [input]
   */
  async function importGatewayToken(input = {}) {
    const token = asString(input.token)
    if (token === undefined) throw new CnbError('需要粘贴一个流水线令牌（环境里的 CNB_TOKEN）')
    const model = asString(input.model) ?? FALLBACK_MODELS[0].id

    // Try the named repository first, then discover one, so the person does not have
    // to know which repository a pipeline token belongs to.
    const probeApi = new CnbApi({ token: async () => token, api: apiOrigin, timeoutMs: requestTimeoutMs, web: webOrigin })
    const named = asString(input.repo)
    const candidates = named !== undefined
      ? [named]
      : (await probeApi.myRepos({ pageSize: 40 })).items.map((item) => asString(item.path)).filter(Boolean)

    const tried = []
    for (const repo of candidates) {
      try {
        await probeApi.chat(repo, { model, messages: [{ role: 'user', content: 'ok' }], maxTokens: 8 })
        await writeGatewayToken(token, { repo })
        // A credential alone does not make the model selectable; the provider has to
        // exist too. Report what happened instead of leaving the caller to guess.
        const provider = await wireProviderIfMissing({ repo })
        return { stored: true, repo, model, reason: null, tried, provider }
      } catch (error) {
        tried.push({ repo, error: message(error) })
      }
    }
    const blocker = classifyGatewayBlocker(tried[0]?.error)
    throw new CnbError(
      `这个令牌不能用于 AI 网关：${blocker?.label ?? '未知原因'}。${blocker?.fix ?? ''}`,
      { body: { tried } },
    )
  }

  /**
   * Pick a repository the gateway will answer for, without asking.
   *
   * The gateway accepts only a pipeline token, and a pipeline token answers for one
   * repository — the one whose environment minted it. So the useful question is not
   * "which repository should I choose" but "which repository does this credential
   * work for". This probes until one answers and returns it, which is what the panel
   * needs to configure itself with no decision from the person.
   *
   * When nothing answers it reports why, per category, because the three causes need
   * three different replies: a personal token never works, a pipeline token bound
   * elsewhere needs that other environment, and a repository without AI has no route.
   * @param {{ repos?: string[], model?: string, limit?: number, preferred?: string }} [input]
   */
  async function autopickGateway(input = {}) {
    const model = asString(input.model) ?? FALLBACK_MODELS[0].id
    const preferred = asString(input.preferred)

    let repos = Array.isArray(input.repos) && input.repos.length > 0
      ? input.repos.map((repo) => asString(repo)).filter(Boolean)
      : []
    if (repos.length === 0) {
      // Enumerate with the credential that can actually reach the gateway when one has
      // been imported: the panel's sign-in token often cannot even read repos.
      const gateway = await readGatewayToken()
      const lister = gateway === undefined
        ? client()
        : new CnbApi({ token: async () => gateway.token, api: apiOrigin, timeoutMs: requestTimeoutMs })
      const listed = await lister.myRepos({ pageSize: asNumber(input.limit, 40) })
      repos = listed.items.map((item) => asString(item.path)).filter(Boolean)
    }
    // A previously working repository is tried first, so the choice is stable across
    // runs rather than following list order.
    if (preferred !== undefined && repos.includes(preferred)) {
      repos = [preferred, ...repos.filter((repo) => repo !== preferred)]
    }

    const seen = []
    for (const repo of repos) {
      const probe = await gatewayProbe({ repo, model, prompt: 'ok' })
      seen.push({ repo, reachable: probe.reachable === true, kind: probe.blocker?.kind ?? null })
      if (probe.reachable === true) {
        return { found: true, repo, model, baseURL: probe.baseURL, checked: seen.length, considered: seen, reason: null, fix: null }
      }
    }

    // Nothing worked. Summarise by cause instead of listing the same sentence per row.
    const counts = {}
    for (const entry of seen) {
      const kind = entry.kind ?? 'other'
      counts[kind] = (counts[kind] ?? 0) + 1
    }
    const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other'
    const advice = {
      'personal-token': {
        reason: '当前凭证是个人访问令牌，AI 网关只接受流水线令牌',
        fix: '在任意一个仓库启动一次云环境，用环境里的 CNB_TOKEN 作为网关凭证。',
      },
      'wrong-repo': {
        reason: '当前流水线令牌与这些仓库都不匹配',
        fix: '流水线令牌只对签发它的仓库有效；用它自己所在的仓库，或到目标仓库的环境里取得新令牌。',
      },
      'no-ai': {
        reason: '这些仓库都没有开通 AI 网关',
        fix: '在已开通 AI 的仓库里使用，或先在仓库设置中开通。',
      },
      unauthorized: { reason: '令牌无效或已过期', fix: '重新扫码登录，或粘贴一个可用的令牌。' },
      other: { reason: '没有一个仓库的网关能应答', fix: '展开下方逐项结果查看原始错误。' },
    }[dominant]
    return {
      found: false,
      repo: null,
      model,
      baseURL: null,
      checked: seen.length,
      considered: seen,
      counts,
      reason: advice.reason,
      fix: advice.fix,
    }
  }

  /**
   * Which repositories the gateway will actually answer for, right now.
   *
   * The gateway refuses a personal access token outright, and a pipeline token only
   * works for the repository whose environment minted it. So "configure all my repos"
   * is not a thing to attempt blindly: it writes base URLs that answer 403 forever.
   * This probes a set and returns only the ones that answered, each with the reason
   * the others did not, so the panel can offer what works and explain the rest.
   * @param {{ repos?: string[], model?: string, limit?: number }} [input]
   */
  async function gatewaySurvey(input = {}) {
    const model = asString(input.model) ?? FALLBACK_MODELS[0].id
    let repos = Array.isArray(input.repos) ? input.repos.filter((repo) => asString(repo) !== undefined) : []
    if (repos.length === 0) {
      // Default to the account's own repositories, which is what the panel shows.
      const listed = await client().myRepos({ pageSize: asNumber(input.limit, 30) })
      repos = listed.items.map((item) => asString(item.path)).filter(Boolean)
    }
    const limit = asNumber(input.limit, 30)
    const targets = repos.slice(0, limit)

    const results = []
    for (const repo of targets) {
      const probe = await gatewayProbe({ repo, model, prompt: 'ok' })
      results.push({
        repo,
        reachable: probe.reachable === true,
        baseURL: probe.baseURL,
        reason: probe.reason,
        blocker: probe.blocker ?? null,
      })
    }
    const usable = results.filter((entry) => entry.reachable)
    return {
      model,
      checked: results.length,
      usable: usable.map((entry) => entry.repo),
      // Grouped so the panel can say "3 need a pipeline token, 1 has no AI" rather
      // than repeating the same sentence per row.
      blocked: results
        .filter((entry) => !entry.reachable)
        .map((entry) => ({ repo: entry.repo, kind: entry.blocker?.kind ?? 'other', label: entry.blocker?.label ?? '未知原因', fix: entry.blocker?.fix ?? null, reason: entry.reason })),
      results,
    }
  }

  /**
   * Why the gateway refused, in terms a person can act on.
   *
   * Three failures look alike in a status code but need different replies:
   *
   *   `[NO_RIGHT] OpenAPI only` — a personal access token was sent. The gateway
   *        accepts environment/pipeline tokens only, whatever scopes the PAT has, so
   *        no amount of re-granting fixes it.
   *   `SLUG_ID_NOT_MATCH` — the token belongs to a different repository. Each
   *        pipeline token is bound to the repository whose environment minted it.
   *   404 — the repository has no AI capability at all.
   * @param {string | null} reason
   * @returns {{ kind: string, label: string, fix: string } | null}
   */
  function classifyGatewayBlocker(reason) {
    const text = String(reason ?? '')
    if (/NO_RIGHT|OpenAPI only/i.test(text)) {
      return {
        kind: 'personal-token',
        label: '个人令牌不被网关接受',
        fix: 'AI 网关只认环境/流水线令牌。在这个仓库启动一次云环境，用它注入的 CNB_TOKEN。',
      }
    }
    if (/SLUG_ID_NOT_MATCH/i.test(text)) {
      return {
        kind: 'wrong-repo',
        label: '令牌属于别的仓库',
        fix: '流水线令牌与签发它的仓库绑定。要用这个仓库的令牌，需在该仓库的环境里取得。',
      }
    }
    if (/\b404\b|Resource not found/i.test(text)) {
      return {
        kind: 'no-ai',
        label: '该仓库没有 AI 能力',
        fix: '这个仓库未开通 AI 网关，配置了也不会通。',
      }
    }
    if (/401|not logged in/i.test(text)) {
      return { kind: 'unauthorized', label: '令牌无效', fix: '重新扫码登录，或粘贴一个可用的令牌。' }
    }
    return { kind: 'other', label: '未知原因', fix: '查看上面的原始错误。' }
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
  /**
   * The pipeline token CNB injected into this process, if there is one.
   *
   * A CNB workspace injects `CNB_TOKEN` into the container, so every process it starts —
   * this one included — inherits it. That value is a pipeline token, which is exactly
   * what the gateway accepts, so it can be adopted without asking the user for anything.
   *
   * The variable is read from this process rather than from a shell, because a
   * separately spawned shell does not inherit it; `/proc/self/environ` is also consulted
   * so a supervisor that scrubs the environment after boot does not hide it.
   * @returns {{ token: string, repo: string | null, source: string } | null}
   */
  function ambientPipelineToken() {
    // A workspace injects CNB_TOKEN itself. A secret repository imported through
    // `.cnb.yml` imports lands under whatever name the secret file uses, so the two
    // names this plugin documents are checked as well — that is what lets a repository
    // be configured once and simply work afterwards.
    const fromEnv = asString(process.env.CNB_TOKEN)
      ?? asString(process.env.CNB_API_TOKEN)
      ?? asString(process.env.CNB_GATEWAY_TOKEN)
    if (fromEnv !== undefined) {
      const source = process.env.CNB_TOKEN !== undefined
        ? 'environment'
        : process.env.CNB_API_TOKEN !== undefined ? 'CNB_API_TOKEN' : 'imported secret'
      return { token: fromEnv, repo: asString(process.env.CNB_REPO_SLUG) ?? null, source }
    }
    // A supervisor may start this process with the variable set and then replace its
    // environment; the original is still in the kernel's copy.
    try {
      const raw = readFileSync('/proc/self/environ', 'utf8')
      const entry = raw.split('\0').find((pair) => pair.startsWith('CNB_TOKEN='))
      if (entry !== undefined) {
        const token = entry.slice('CNB_TOKEN='.length)
        if (token !== '') {
          const repoEntry = raw.split('\0').find((pair) => pair.startsWith('CNB_REPO_SLUG='))
          return { token, repo: repoEntry === undefined ? null : repoEntry.slice('CNB_REPO_SLUG='.length), source: '/proc/self/environ' }
        }
      }
    } catch {
      // No procfs, or no permission: fall through.
    }
    return null
  }

  /**
   * Register the gateway provider when the credential exists but the provider does not.
   *
   * Storing a gateway token makes the credential available; it does not make the model
   * appear. Without a provider in `llm-pi-ai`, DSH's config has no gateway at all, which
   * reads as "the token was imported but nothing shows up".
   *
   * A higher-priority layer may own `llm-pi-ai` (a deployment booting with `--patch`),
   * and that is reported rather than treated as a failure: it means someone already
   * decided how the provider is configured.
   * @param {{ repo: string | null }} input
   */
  async function wireProviderIfMissing(input) {
    if (input.repo === null) return { written: false, reason: '不知道这个令牌属于哪个仓库' }
    const editor = ctx.get('configEditor')
    if (!editor) return { written: false, reason: '当前 profile 没有 configEditor' }
    const entries = editor.entries()
    const piEntry = entries.find((entry) => entry.options.id === 'llm-pi-ai')
      ?? entries.find((entry) => entry.options.name === '@deepseek-ai/dsh-llm-pi-ai')
    if (!piEntry) return { written: false, reason: 'profile 未挂载 @deepseek-ai/dsh-llm-pi-ai' }
    const existing = piEntry.options?.config?.providers
    if (existing !== null && typeof existing === 'object' && existing[DEFAULT_PROVIDER_ROUTE] !== undefined) {
      return { written: false, reason: 'provider 已存在' }
    }
    try {
      await editor.edit(piEntry, (current) => {
        const providers = current.providers && typeof current.providers === 'object' ? current.providers : {}
        return {
          ...current,
          providers: { ...providers, [DEFAULT_PROVIDER_ROUTE]: gatewayProviderProfile({ repo: input.repo, model: FALLBACK_MODELS[0].id, models: FALLBACK_MODELS }) },
        }
      })
      return { written: true, route: DEFAULT_PROVIDER_ROUTE, repo: input.repo }
    } catch (error) {
      if (isOverlayRefusal(error)) {
        return { written: false, overridden: true, reason: 'llm-pi-ai 由更高优先级的 --patch 层接管，插件不写入' }
      }
      return { written: false, reason: message(error) }
    }
  }

  /**
   * Adopt the injected pipeline token as the gateway credential, if it works.
   *
   * Only a token the gateway actually accepts is stored, so a workspace whose injected
   * value is a personal token is left alone rather than producing a provider that fails
   * on every call. The check is skipped when a gateway credential already exists, since
   * replacing a working one on every boot would be surprising.
   * @param {{ force?: boolean }} [input]
   */
  async function adoptAmbientGatewayToken(input = {}) {
    const ambient = ambientPipelineToken()
    if (ambient === null) {
      // Outside a workspace there is still something useful to do: if a token is already
      // stored, make sure the provider exists. Storing a credential is only half of it —
      // without a provider the model never appears in the selector.
      const existing = await readGatewayToken()
      if (existing !== undefined) {
        const wired = await wireProviderIfMissing({ repo: existing.repo })
        return { adopted: false, reason: '这个进程不在 CNB 云环境里，没有可继承的 CNB_TOKEN', provider: wired }
      }
      return { adopted: false, reason: '这个进程不在 CNB 云环境里，没有可继承的 CNB_TOKEN' }
    }
    if (input.force !== true) {
      const existing = await readGatewayToken()
      if (existing !== undefined) {
        // Same reasoning: a stored token with no provider is a half-configured state.
        const wired = await wireProviderIfMissing({ repo: existing.repo })
        return { adopted: false, reason: '已有网关令牌，未覆盖', repo: existing.repo, provider: wired }
      }
    }
    const model = FALLBACK_MODELS[0].id
    const probeApi = new CnbApi({ token: async () => ambient.token, api: apiOrigin, timeoutMs: requestTimeoutMs })
    /**
     * Which repository's gateway this token can open.
     *
     * The token belongs to the repository whose environment minted it, which is not
     * necessarily the one being run. A secret repository can inject a token into a
     * *different* repository's workspace — that is the whole point of importing it — and
     * the gateway there answers `SLUG_ID_NOT_MATCH` for the host repository. So the
     * candidate list starts with the host (the common case, one probe) and then walks the
     * repositories this token can see until one answers.
     */
    const ordered = []
    if (ambient.repo !== null) ordered.push(ambient.repo)
    const listed = await probeApi.myRepos({ pageSize: 40 }).catch(() => ({ items: [] }))
    for (const item of listed.items ?? []) {
      const repo = asString(item.path)
      if (repo !== undefined && !ordered.includes(repo)) ordered.push(repo)
    }

    const failures = []
    for (const repo of ordered) {
      try {
        await probeApi.chat(repo, { model, messages: [{ role: 'user', content: 'ok' }], maxTokens: 8 })
        await writeGatewayToken(ambient.token, { repo })
        const provider = await wireProviderIfMissing({ repo })
        return {
          adopted: true,
          repo,
          // Say when the token came from somewhere other than this workspace: that is
          // why the provider points at a different repository than the one being run.
          foreign: ambient.repo !== null && repo !== ambient.repo,
          source: ambient.source,
          reason: null,
          provider,
        }
      } catch (error) {
        failures.push({ repo, error: message(error) })
        // A refusal for one repository says nothing about the next: keep looking.
        continue
      }
    }
    const last = failures[failures.length - 1]
    return {
      adopted: false,
      reason: ordered.length === 0 ? '注入的令牌没有可用的仓库' : '这个令牌对能看见的仓库都调不通网关',
      blocker: last === undefined ? null : classifyGatewayBlocker(last.error),
      tried: failures.slice(0, 5),
    }
  }

  /**
   * What a first-time user must do to get a gateway token, in the fewest steps.
   *
   * The gateway accepts only a pipeline token, and a pipeline token is injected into a
   * running environment as `CNB_TOKEN`. A personal access token cannot read that value
   * and cannot call the gateway either — verified on both AI paths — so it cannot be
   * fetched on the user's behalf. What can be removed is the guesswork: this starts an
   * environment on a repository the account owns and returns the exact place to read the
   * value from.
   *
   * @param {{ repo?: string, branch?: string }} [input]
   */
  async function gatewayTokenGuide(input = {}) {
    // No repository named: start one on whatever the account can use, since the point is
    // to reach a terminal, not to pick a particular project.
    let repo = asString(input.repo)
    let started
    if (repo !== undefined) {
      started = await openEnvironment({ repo, branch: asString(input.branch) })
    } else {
      // Walk the account's repositories until one actually starts. A repository can be
      // listed and still answer 404 here — the credential is a pipeline token, so it only
      // sees the repositories it belongs to — and failing on the first one would tell a
      // first-time user nothing they could act on.
      const listed = await client().myRepos({ pageSize: 20 })
      const candidates = listed.items.map((item) => asString(item.path)).filter(Boolean)
      if (candidates.length === 0) throw new CnbError('这个账号没有可用仓库，无法启动环境来取得网关令牌')
      const failures = []
      for (const candidate of candidates) {
        try {
          started = await openEnvironment({ repo: candidate, branch: asString(input.branch) })
          repo = candidate
          break
        } catch (error) {
          failures.push({ repo: candidate, error: message(error) })
        }
      }
      if (started === undefined) {
        throw new CnbError(
          `这些仓库都启动不了环境：${failures.slice(0, 3).map((f) => f.repo).join('、')}。` +
            '当前凭证可能只属于某个特定仓库，请显式指定一个。',
          { body: { failures } },
        )
      }
    }
    return {
      repo: started.repo,
      branch: started.branch,
      sn: started.sn,
      webide: started.webide,
      // The environment's terminal is where `echo $CNB_TOKEN` runs; the WebIDE link is
      // the shortest way there, and `地址` lists the alternatives.
      webideUrl: started.webide,
      steps: [
        `打开 ${started.repo} 的 WebIDE（环境 ${started.sn ?? '启动中'}）`,
        '在它的终端里执行：echo $CNB_TOKEN',
        '把输出粘到上面的「导入网关令牌」',
      ],
      note: '网关只接受流水线令牌；个人访问令牌无法调用网关，与权限大小无关。',
    }
  }

  /**
   * Whether a higher-priority layer already owns the gateway configuration.
   *
   * The profile boots with `--patch <file>` here, and that file defines both
   * `llm-pi-ai` and `agent-default-model`. Writing them through configEditor is refused
   * by design — the write would sit below the overlay and change nothing — so the panel
   * must not present it as a task to complete. When an existing setup answers, the useful
   * advice is to leave it alone.
   * @returns {{ key: string, value: string }[]}
   */
  /**
   * Harness home，两种约定都要认。
   *
   * `DSH_HOME` 指向的就是 `.dsh` 目录本身（本部署设成 `/root/.dsh`），而 `HOME`
   * 指向用户主目录（`/root`）。早先两处都按 `${home}/.dsh/...` 拼，于是在设了
   * `DSH_HOME` 的部署上得到 `/root/.dsh/.dsh/...` —— 一个不存在的路径，
   * 而它只体现为「patch 层不存在」这种听起来无害的提示。
   * @returns {string | undefined}
   */
  function harnessHome() {
    const explicit = asString(process.env.DSH_HOME)
    if (explicit !== undefined) return explicit
    const userHome = asString(process.env.HOME)
    return userHome === undefined ? undefined : `${userHome}/.dsh`
  }

  function overridingLayers() {
    const layers = []
    const argv = Array.isArray(process.argv) ? process.argv : []
    const at = argv.indexOf('--patch')
    if (at >= 0 && typeof argv[at + 1] === 'string') layers.push({ key: '--patch', value: argv[at + 1] })
    for (const arg of argv) {
      if (arg.startsWith('--patch=')) layers.push({ key: '--patch', value: arg.slice(8) })
    }
    const home = harnessHome()
    if (home !== undefined) {
      const candidate = `${home}/cordis.patch.yml`
      if (existsSync(candidate)) layers.push({ key: 'home patch', value: candidate })
    }
    return layers
  }

  async function configureGateway(input = {}) {
    let repo = asString(input.repo)
    // No repository named: discover one that answers, rather than refusing. This is the
    // path the panel takes, since the useful question is "which repository does this
    // credential work for" and only a probe can answer it.
    let discovered = null
    if (repo === undefined) {
      discovered = await autopickGateway({ model: asString(input.model), limit: input.limit })
      if (discovered.found !== true) {
        throw new CnbError(`${discovered.reason}。${discovered.fix}`, { body: { considered: discovered.considered } })
      }
      repo = discovered.repo
    }
    const route = asString(input.route) ?? DEFAULT_PROVIDER_ROUTE
    const model = asString(input.model) ?? FALLBACK_MODELS[0].id
    // Refuse to write a base URL that cannot work. The gateway rejects a personal
    // token outright and a pipeline token only answers for its own repository, so a
    // silently-written provider would fail on every request with no hint why.
    if (input.skipProbe !== true && discovered === null) {
      const probe = await gatewayProbe({ repo, model })
      if (probe.reachable !== true) {
        const blocker = probe.blocker ?? { label: '网关不可用', fix: '查看原始错误。' }
        throw new CnbError(
          `无法为 ${repo} 配置网关：${blocker.label}。${blocker.fix}`,
          { body: { repo, reason: probe.reason, blocker } },
        )
      }
    }

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

    const chosen = discovered === null ? null : { repo: discovered.repo, checked: discovered.checked }
    if (overlaid.length === 0) return { ...base, defaultModel, written: true, overlay: null, discovered: chosen }
    return {
      ...base,
      defaultModel,
      written: providerWritten,
      discovered: chosen,
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

  // ------------------------------------------------------------ cloud gateway

  /**
   * 新仓库没有 commit 就没有分支，而 `workspace/start` 必须要 branch。
   *
   * OpenAPI 不提供写文件的接口（`/-/git/contents` 只有 GET），但**内联 `config`
   * 触发的构建**跑在签出好的 `/workspace` 上，那里就是该仓库的最新代码。
   * 于是「写文件」的真实路径只有一条：在内联 stage 里 `git commit && git push`。
   *
   * 这条路径同时解决空仓库初始化：一次构建既写入脚手架，又建立 main 分支。
   * @param {{ repo: string, files: Array<{ path: string, content: string }>, message?: string, branch?: string }} input
   */
  async function writeFilesThroughBuild(input) {
    const repo = requireRepo(input.repo)
    const branch = asString(input.branch) ?? 'main'
    const config = scaffoldCommitConfig({ files: input.files, message: input.message })
    const started = await client().startBuildWithConfig(repo, { branch, config, title: 'dsh-cnb: 写入网关脚手架' })
    const sn = asString(started?.sn)
    if (sn === undefined) throw new CnbError('平台没有返回构建号，无法确认脚手架是否写入', { body: started })
    const outcome = await waitForBuild(repo, sn, { timeoutMs: 180_000 })
    return { repo, sn, branch, ...outcome }
  }

  /**
   * 轮询一次构建，直到它结束或超时。
   *
   * 平台把「已受理」和「已跑完」分得很开：`build/start` 立刻返回 sn 和
   * `didn't finish build yet`。要判断脚手架到底写没写进去，只能等状态收敛。
   * @param {string} repo @param {string} sn
   * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
   */
  async function waitForBuild(repo, sn, options = {}) {
    const timeoutMs = options.timeoutMs ?? 180_000
    const intervalMs = options.intervalMs ?? 2_000
    const deadline = Date.now() + timeoutMs
    const cnb = client()
    let last = null
    while (Date.now() < deadline) {
      last = await cnb.buildStatus(repo, sn).catch((error) => ({ status: 'unknown', error: message(error) }))
      const status = String(last?.status ?? '')
      if (status === 'success' || status === 'failed' || status === 'canceled' || status === 'closed') {
        return { status, pipelineId: `${sn}-001`, detail: last }
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
    return { status: 'timeout', pipelineId: `${sn}-001`, detail: last }
  }

  /**
   * 读一个 stage 的日志行。
   *
   * 日志是这条链路上唯一的回传通道：平台不会让 runner 回调任意地址（实测从
   * runner 打本机的 3080 是通的，但反过来让 stage 把结果 POST 回本机并不被支持），
   * 而 OpenAPI 能把 stage 日志读回来。
   * @param {string} repo @param {string} sn @param {string} stageId
   */
  async function readStageLog(repo, sn, stageId) {
    const body = await client().buildStageLog(repo, sn, `${sn}-001`, stageId).catch((error) => {
      if (error instanceof CnbError) return { content: [], error: message(error) }
      throw error
    })
    const content = Array.isArray(body?.content) ? body.content : []
    return content.map((line) => String(line))
  }

  /**
   * 脚手架写进仓库的网关 key 与端口。
   *
   * key 落在仓库的 `.cnb.yml` 的 `env:` 里 —— 新仓库没有别的注入通道，而它的
   * 作用域就是这个仓库的网关。读回来是为了写进本机凭证库，让 dsh 能出示它。
   * @param {string} repo @param {string} branch
   */
  async function readScaffoldKey(repo, branch) {
    const file = await client().fileAt(repo, '.cnb.yml', branch).catch(() => ({ text: null }))
    if (typeof file.text !== 'string') return { key: null, port: DEFAULT_CLOUD_PORT }
    const keyMatch = /DSH_GW_KEY:\s*"([^"]+)"/.exec(file.text)
    const portMatch = /DSH_GW_PORT="(\d+)"/.exec(file.text)
    return {
      key: keyMatch === null ? null : keyMatch[1],
      port: portMatch === null ? DEFAULT_CLOUD_PORT : Number(portMatch[1]),
    }
  }

  /**
   * 全自动开通：建仓库 → 写脚手架 → 云原生启动 → 采集网关 → 写 provider。
   *
   * 每一步都返回它自己的结论，而不是「成功/失败」两个字：用户需要知道卡在哪，
   * 因为卡在「建仓库」是权限问题，卡在「采集」是环境没起来，两者要做的完全不同。
   *
   * @param {{
   *   org?: string, name?: string, visibility?: string, description?: string,
   *   image?: string, models?: string[], port?: number,
   *   route?: string, makeDefault?: boolean, waitMs?: number,
   * }} [input]
   */
  async function provisionGateway(input = {}) {
    const steps = []
    const record = (id, state, detail) => {
      steps.push({ id, state, detail, at: new Date().toISOString() })
      return steps[steps.length - 1]
    }

    // 1) 组织：没给就用账号的第一个组织（面板上「一键」不该先问).
    let org = asString(input.org)
    if (org === undefined) {
      const groups = await client().myGroups()
      const first = groups.map((group) => asString(group.path ?? group.name)).filter(Boolean)[0]
      if (first === undefined) throw new CnbError('这个账号没有任何组织，无法建仓库')
      org = first
    }
    record('group', 'ok', org)

    // 2) 仓库：名字可以指定，也可以是「再来一个」。
    //
    // 名字冲突（10009）必须自己消化，不能当成失败：一次开通要几十秒，用户看到报错
    // 后立刻重试，或者上一次请求在客户端超时但服务端已经建好仓库，都会撞上同名。
    // 指定了名字时冲突是真冲突（该报错）；自动生成的名字则换一个后缀重试 ——
    // 用户的意图是「再开一个」，不是「必须叫这个名字」。
    const explicitName = asString(input.name)
    let name = explicitName ?? defaultRepoName()
    let repo
    const conflicts = []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await client().createRepo(org, {
          name,
          visibility: asString(input.visibility) ?? 'private',
          description: asString(input.description) ?? '由 dsh-cnb 自动创建：托管 CNB AI 网关代理',
        })
        repo = `${org}/${name}`
        record('repo', 'ok', repo)
        if (conflicts.length > 0) record('repo.renamed', 'ok', { tried: conflicts, used: name })
        break
      } catch (error) {
        if (isMissingScope(error, 'group-resource')) {
          // 会话路径：缺 scope 时 client 已经自动改走过 cnb.cool 的会话接口。
          // 走到这里说明会话也没权限，给出可执行的下一步。
          record('repo', 'failed', message(error))
          throw new CnbError(
            `新建仓库需要 group-resource:rw：${message(error)}。`
              + '扫码登录会按全权限重新签发令牌；若账号在这些组织里是管理员，插件也会用登录会话代替令牌完成。',
            { body: { step: 'repo', org, name } },
          )
        }
        const conflict = error instanceof CnbError
          && (error.errcode === 10009 || /conflicts with an existing resource/i.test(message(error)))
        if (!conflict) {
          record('repo', 'failed', message(error))
          throw error
        }
        conflicts.push(name)
        if (explicitName !== undefined) {
          record('repo', 'failed', message(error))
          throw new CnbError(
            `${org}/${explicitName} 已经存在（errcode 10009）。换一个仓库名，或留空让插件自动生成。`,
            { body: { step: 'repo', org, name: explicitName } },
          )
        }
        // 自动名：加一个短后缀再来。时间戳只到秒，同一秒内的两次调用仍会撞。
        name = `${defaultRepoName()}-${Math.random().toString(36).slice(2, 6)}`
      }
    }
    if (repo === undefined) {
      record('repo', 'failed', `连续 ${conflicts.length} 次名字冲突`)
      throw new CnbError(
        `连续 ${conflicts.length} 次生成的名字都已被占用，请显式指定仓库名`,
        { body: { step: 'repo', org, conflicts } },
      )
    }

    // 3) 脚手架：key 先定下来，仓库自带，环境重启后仍然一致。
    //
    // `models` 是**候选**，不是最终清单：云环境启动时会逐个真调用，按上游错误码
    // 判定哪些真的能用（见 lib/model-catalog.js）。没给就带一整套候选，让发现
    // 自己去筛 —— 这正是「模型不止一个」被写死成一张表时要修掉的地方。
    const key = mintGatewayKey()
    const port = asNumber(input.port, DEFAULT_CLOUD_PORT)
    const candidates = Array.isArray(input.models) && input.models.length > 0
      ? input.models.map((entry) => asString(entry)).filter(Boolean)
      : DEFAULT_CANDIDATES
    const files = buildScaffold({ key, port, models: candidates, repo })
    // buildScaffold 生成的 .cnb.yml 用的是默认 key 占位；这里用真实值重写一份，
    // 保证仓库里自带 key，而本机不必再回读。
    const withKey = files.map((file) => (file.path === '.cnb.yml'
      ? { ...file, content: scaffoldCnbYml({ port, models: candidates, key, ...(asString(input.image) === undefined ? {} : { image: asString(input.image) }) }) }
      : file))
    let wrote
    try {
      wrote = await writeFilesThroughBuild({
        repo,
        files: withKey,
        message: 'chore: dsh-cnb gateway scaffold',
      })
      const logLines = wrote.status === 'success' ? await readStageLog(repo, wrote.sn, 'stage-0') : []
      const pushed = logLines.some((line) => line.includes('SCAFFOLD_WRITTEN=1'))
      record('scaffold', wrote.status === 'success' && pushed ? 'ok' : 'failed', {
        sn: wrote.sn,
        pushed,
        status: wrote.status,
        tail: logLines.slice(-8),
      })
    } catch (error) {
      record('scaffold', 'failed', message(error))
      throw new CnbError(`写入网关脚手架失败：${message(error)}`, { body: { step: 'scaffold', repo } })
    }

    // 4) 云原生启动：新仓库的第一条 main 流水线，会跑 .cnb.yml 里的 vscode 环境。
    let workspace
    try {
      workspace = await openEnvironment({ repo, branch: 'main' })
      record('launch', 'ok', { sn: workspace.sn, url: workspace.url })
    } catch (error) {
      record('launch', 'failed', message(error))
      throw new CnbError(`云原生启动失败：${message(error)}`, { body: { step: 'launch', repo } })
    }

    // 5) 采集：读环境流水线的 stage 日志，拿公开地址与 key。
    const harvest = await harvestGatewayFromLogs({
      repo,
      sn: asString(workspace.sn),
      waitMs: asNumber(input.waitMs, 240_000),
    })
    record('harvest', harvest.ok ? 'ok' : 'failed', harvest)
    if (!harvest.ok) {
      throw new CnbError(
        `没能从云环境里采集到网关地址：${harvest.reason}。` +
          '环境刚起来时 stage 需要几十秒；可以稍后点「重新采集」，或打开环境的构建日志确认 pod 是否启动。',
        { body: { step: 'harvest', harvest, repo } },
      )
    }

    // 6) 校验：从本机真打一次这个公网地址，确认端口预览、key、上游三者都通。
    //
    // 用清单里的第一个模型探：它是云端实测可用的那一个，拿它验证才能把「端口
    // 预览没映射」与「这个模型没开通」分开。清单顺序已由探测结果决定。
    const verify = await verifyCloudGateway({ url: harvest.url, key: harvest.key ?? key, model: harvest.models[0] })
    record('verify', verify.ok ? 'ok' : 'failed', verify)

    // 7) provider：写进 llm-pi-ai，并把 key 存进凭证库。
    const provider = await wireCloudProvider({
      repo,
      baseURL: harvest.url,
      key: harvest.key ?? key,
      models: harvest.models,
      route: asString(input.route) ?? DEFAULT_PROVIDER_ROUTE,
      makeDefault: input.makeDefault !== false,
    })
    record('provider', provider.written || provider.overridden === true ? 'ok' : 'failed', provider)

    return {
      repo,
      org,
      name,
      port: harvest.port ?? port,
      steps,
      harvest,
      verify,
      provider,
      // 对外清单是云端实测出来的，不是插件里那张候选表；差别要在结果里说清楚。
      models: harvest.models,
      discovery: harvest.discovery ?? null,
      ready: verify.ok === true && (provider.written === true || provider.overridden === true),
    }
  }

  /**
   * 从环境流水线的 stage 日志里取网关标记，必要时重试。
   *
   * 环境刚创建时流水线还在 Prepare，日志读回来是 404；这不是失败，是「还没到」。
   * 所以这里按 timeoutMs 轮询，直到出现 READY 或明确错误标记。
   *
   * @param {{ repo: string, sn?: string, waitMs?: number }} input
   */
  async function harvestGatewayFromLogs(input) {
    const repo = requireRepo(input.repo)
    const deadline = Date.now() + (input.waitMs ?? 240_000)
    let sn = asString(input.sn)
    const tried = []
    while (Date.now() < deadline) {
      if (sn === undefined) {
        // 没给 sn 就按仓库找最近一条运行中的环境。
        const list = await client().workspaces({ page: 1, pageSize: 20, slug: repo }).catch(() => ({ items: [] }))
        const running = list.items.find((item) => String(item?.status ?? '').startsWith('running')) ?? list.items[0]
        sn = asString(running?.sn)
      }
      if (sn !== undefined) {
        const markers = parseGatewayMarkers(await readStageLog(repo, sn, 'stage-0'))
        tried.push({ sn, at: new Date().toISOString(), ready: markers.ready === '1', error: markers.error ?? null })
        if (markersComplete(markers)) {
          const models = splitModels(markers.models).length > 0 ? splitModels(markers.models) : DEFAULT_CANDIDATES
          return {
            ok: true,
            repo,
            sn,
            url: markers.url,
            key: markers.key,
            port: markers.port === undefined ? null : Number(markers.port),
            models,
            // 探测结论：云端真的逐个调过，这里把「为什么少了某个模型」一并带回来。
            discovery: {
              summary: markers.discovered ?? null,
              notEntitled: splitModels(markers.notEntitled),
              unknown: splitModels(markers.unknown),
              discovered: markers.discovered !== undefined,
            },
            reason: null,
            tried: tried.slice(-6),
          }
        }
        if (typeof markers.error === 'string') {
          return { ok: false, repo, sn, url: null, key: null, port: null, models: [], discovery: null, reason: markers.error, tried: tried.slice(-6) }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000))
    }
    return {
      ok: false,
      repo,
      sn: sn ?? null,
      url: null,
      key: null,
      port: null,
      models: [],
      discovery: null,
      reason: sn === undefined ? '这个仓库还没有启动过环境' : '环境里的 stage 还没有打出就绪标记',
      tried: tried.slice(-6),
    }
  }

  /**
   * 从本机真打一次云网关，确认整条链路通。
   *
   * 这一步不能省：端口预览是否映射、key 是否一致、上游是否放行模型，只有真发一次
   * 请求才能同时验证。失败时把归类结果带回去 —— 「域名没映射」与「模型没开通」
   * 是两种完全不同的处理。
   * @param {{ url: string, key: string, model?: string }} input
   */
  async function verifyCloudGateway(input) {
    const base = input.url.replace(/\/+$/, '')
    const model = asString(input.model) ?? DEFAULT_CANDIDATES[0]
    try {
      const health = await fetch(`${base.replace(/\/v1$/, '')}/health`, { signal: AbortSignal.timeout(15_000) })
      if (!health.ok) {
        return { ok: false, kind: 'health', reason: `健康检查返回 ${health.status}`, model, base }
      }
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${input.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: '回复 OK' }], max_tokens: 16 }),
        signal: AbortSignal.timeout(60_000),
      })
      const text = await response.text()
      if (!response.ok) {
        const reason = classifyGatewayError(response.status, text)
        return { ok: false, kind: reason.kind, label: reason.label, fix: reason.fix, reason: text.slice(0, 300), model, base }
      }
      let reply = null
      try {
        reply = JSON.parse(text)?.choices?.[0]?.message?.content ?? null
      } catch {
        reply = text.slice(0, 120)
      }
      return { ok: true, kind: 'ok', model, base, reply }
    } catch (error) {
      return { ok: false, kind: 'network', reason: message(error), model, base }
    }
  }

  /**
   * 写进 profile 自己的 patch 层，让 HMR 立即生效。
   *
   * 这是本部署真正能用的一层：`--patch` overlay 的优先级高于 profile patch，
   * 所以 configEditor 拒绝写入；但 `profile/cordis.patch.yml` 由 HMR 监听，
   * 一改就 recompose —— 不需要重启进程，也不需要用户手工合并片段。
   *
   * 代价说清楚：overlay 里如果**也**定义了同一个 provider，overlay 赢。
   * 所以这里只在 overlay 没有该路由时写入，并在结果里说明是哪一层在生效。
   *
   * @param {{ providerId: string, entry: Record<string, unknown>, defaultEntry?: Record<string, unknown> | null, route: string, model: string, makeDefault: boolean }} input
   */
  async function writeProfilePatch(input) {
    // profile 目录以 loader 的 profileContext 为准：它才是「当前实际在跑的 profile」。
    // 用 DSH_PROFILE 或硬编码名字去猜，在别的 profile 上会写进另一个文件 ——
    // 那种失败看起来像「patch 层不存在」，实际是定位错了。
    const profileDir = asString(ctx.get('profileContext')?.dir)
    const home = harnessHome()
    const dir = profileDir !== undefined
      ? profileDir
      : home === undefined
        ? undefined
        : `${home}/profiles/${asString(process.env.DSH_PROFILE) ?? 'web'}`
    if (dir === undefined) return { written: false, reason: '拿不到 profile 目录，无法定位 patch 层' }
    const file = `${dir}/cordis.patch.yml`
    if (!existsSync(file)) return { written: false, reason: `${file} 不存在` }

    const before = readFileSync(file, 'utf8')
    // 用极简的行级合并：这段 YAML 由本插件生成，只需替换/追加两个顶层条目，
    // 引入完整 YAML 库去改一个文件不划算，也会让 profile 多一个依赖。
    const marker = '# dsh-cnb: cloud gateway provider'
    const block = [
      marker,
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      `      ${input.route}:`,
      // provider 的字段必须比路由名深一级：路由在 6 格，字段在 8 格。
      ...indentLines(providerYamlLines(input.entry), 8),
      ...(input.makeDefault && input.defaultEntry !== undefined && input.defaultEntry !== null
        ? ['- id: agent-default-model', '  config:', ...indentLines(flatYamlLines(input.defaultEntry), 4)]
        : []),
      '',
    ].join('\n')

    const cleaned = removeManagedBlock(before, marker)
    const next = `${cleaned.trimEnd()}\n\n${block}`
    if (next === before) return { written: false, unchanged: true, file }
    writeFileSync(file, next, 'utf8')
    return { written: true, file, hot: true }
  }

  /**
   * 去掉上一次由本插件管理的那一段，避免重复追加。
   * @param {string} text @param {string} marker
   */
  function removeManagedBlock(text, marker) {
    const index = text.indexOf(marker)
    if (index < 0) return text
    return text.slice(0, index)
  }

  /**
   * 把若干 YAML 行统一缩进。
   * @param {string[]} lines @param {number} spaces
   */
  function indentLines(lines, spaces) {
    const pad = ' '.repeat(spaces)
    return lines.map((line) => (line === '' ? line : pad + line))
  }

  /**
   * provider 画像 → YAML 行（不含条目标题，调用方负责缩进）。
   *
   * 参数是 `llm-pi-ai` 的 provider 画像；`agent-default-model` 那种扁平条目走
   * {@link flatYamlLines}，两者形状不同，不能用一个函数猜。
   * @param {Record<string, any>} entry
   * @returns {string[]}
   */
  function providerYamlLines(entry) {
    const lines = [
      `displayName: ${JSON.stringify(entry.displayName)}`,
      `api: ${entry.api}`,
      `baseURL: ${entry.baseURL}`,
      `apiKeyEnv: ${entry.apiKeyEnv}`,
      'compat:',
      '  thinkingFormat: openai',
      '  supportsReasoningEffort: false',
      '  supportsUsageInStreaming: true',
      '  maxTokensField: max_tokens',
      'models:',
    ]
    for (const model of entry.models ?? []) {
      lines.push(`  - id: ${JSON.stringify(model.id)}`)
      lines.push(`    name: ${JSON.stringify(model.name)}`)
      lines.push(`    contextWindow: ${model.contextWindow}`)
      lines.push(`    maxTokens: ${model.maxTokens}`)
      if (model.reasoning === true) lines.push('    reasoning: true')
    }
    return lines
  }

  /**
   * 扁平对象 → `key: value` 行（`agent-default-model` 用）。
   * @param {Record<string, unknown>} entry
   * @returns {string[]}
   */
  function flatYamlLines(entry) {
    return Object.entries(entry)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => (typeof value === 'string' ? `${key}: ${JSON.stringify(value)}` : `${key}: ${String(value)}`))
  }

  /**
   * 把云网关写成 `llm-pi-ai` 的 provider，并把 key 存进凭证库。
   *
   * key 走 credentials 的具名引用（`apiKeyEnv`），所以配置文件里没有任何明文；
   * 而 provider 是否存在决定了模型选择器里看不看得到 —— 只存 key 不写 provider
   * 正是「导入了但什么都没出现」的那种状态。
   *
   * @param {{ repo: string, baseURL: string, key: string, models: string[], route: string, makeDefault: boolean }} input
   */
  /**
   * 问云网关自己有哪些模型。
   *
   * 云端入口在启动时已经探测过一轮，把实测可用的写进 `/v1/models`；所以这一次
   * HTTP 比插件本地那张候选表权威得多。拿不到就返回 `null`，由调用方决定降级 ——
   * 不在这里编一个空清单出来。
   * @param {{ baseURL: string, key: string }} input
   * @returns {Promise<string[] | null>}
   */
  async function fetchModelsFromGateway(input) {
    const base = input.baseURL.replace(/\/+$/, '')
    try {
      const response = await fetch(`${base}/models`, {
        headers: { authorization: `Bearer ${input.key}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) return null
      const body = await response.json()
      const ids = Array.isArray(body?.data)
        ? body.data.map((entry) => asString(entry?.id)).filter(Boolean)
        : []
      return ids.length > 0 ? ids : null
    } catch {
      return null
    }
  }

  async function wireCloudProvider(input) {
    const credentials = ctx.get('credentials')
    if (!credentials) throw new CnbError('当前 profile 没有 credentials 服务，无法保存网关 key')
    const ref = CLOUD_KEY_REF
    await credentials.set(ref, input.key)

    const editor = ctx.get('configEditor')
    if (!editor) return { written: false, reason: '当前 profile 没有 configEditor，无法写入 provider', ref }

    const entries = editor.entries()
    const piEntry = entries.find((entry) => entry.options.id === 'llm-pi-ai')
      ?? entries.find((entry) => entry.options.name === '@deepseek-ai/dsh-llm-pi-ai')
    if (!piEntry) return { written: false, reason: 'profile 未挂载 @deepseek-ai/dsh-llm-pi-ai', ref }

    const profile = cloudProviderProfile({
      repo: input.repo,
      baseURL: input.baseURL,
      apiKeyEnv: ref,
      // 元数据按模型家族给保守值：网关只回答「能不能用」，不回答上下文窗口。
      models: input.models.map((id) => describeModel(id)),
    })
    let written = false
    let overridden = false
    try {
      await editor.edit(piEntry, (current) => {
        const providers = current.providers && typeof current.providers === 'object' ? current.providers : {}
        return { ...current, providers: { ...providers, [input.route]: profile } }
      })
      written = true
    } catch (error) {
      if (!isOverlayRefusal(error)) throw error
      overridden = true
    }

    let defaultModel = null
    if (input.makeDefault) {
      const defaultEntry = entries.find((entry) => entry.options.id === 'agent-default-model')
      if (defaultEntry) {
        try {
          await editor.edit(defaultEntry, (current) => ({ ...current, provider: input.route, model: input.models[0] }))
          defaultModel = { provider: input.route, model: input.models[0] }
        } catch (error) {
          if (!isOverlayRefusal(error)) throw error
          overridden = true
        }
      }
    }

    /**
     * `--patch` 层赢过 configEditor，但 profile 自己的 patch 层由 HMR 监听。
     *
     * 这一步是把「生成了片段，请你自己合并」变成「已经写进去，正在生效」。
     * 只在 overlay 挡住了写入时才走，且 provider 已存在时不覆盖 —— 用户可能正是
     * 在 overlay 里精心配了那一路，插件不该抢。
     */
    let hotPath = null
    if (written === false) {
      const overlayOwnsRoute = (() => {
        const layers = overridingLayers()
        for (const layer of layers) {
          if (layer.key !== '--patch') continue
          try {
            const text = readFileSync(layer.value, 'utf8')
            if (text.includes(`${input.route}:`)) return true
          } catch {
            // 读不到就当作不拥有：宁可尝试写入，也不会破坏什么。
          }
        }
        return false
      })()
      if (!overlayOwnsRoute) {
        hotPath = await writeProfilePatch({
          entry: profile,
          defaultEntry: input.makeDefault ? { provider: input.route, model: input.models[0] } : null,
          route: input.route,
          model: input.models[0],
          makeDefault: input.makeDefault === true,
        }).catch((error) => ({ written: false, reason: message(error) }))
        if (hotPath.written === true) {
          written = true
          overridden = false
          if (input.makeDefault) defaultModel = { provider: input.route, model: input.models[0] }
        }
      } else {
        hotPath = { written: false, reason: `--patch 层已定义 ${input.route}，不覆盖`, overlayOwnsRoute: true }
      }
    }

    return {
      written,
      overridden: overridden && written === false ? true : false,
      route: input.route,
      baseURL: profile.baseURL,
      apiKeyEnv: ref,
      models: profile.models.map((model) => model.id),
      defaultModel,
      hotPath,
      ...(overridden
        ? {
            snippet: cloudOverlaySnippet({ route: input.route, profile, model: input.models[0], makeDefault: input.makeDefault }),
            hint: 'llm-pi-ai / agent-default-model 由更高优先级的 --patch 层接管，configEditor 不会写在它下面；把片段并入那份 overlay 即可生效。',
          }
        : {}),
    }
  }

  /**
   * 云网关的 overlay 片段。
   *
   * 与直连版本的结构一致，只差 baseURL 与凭证引用；单独写一份是为了让「云网关」
   * 这条路由在 overlay 里也能一眼认出来。
   * @param {{ route: string, profile: any, model: string, makeDefault: boolean }} input
   */
  function cloudOverlaySnippet(input) {
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
      ...input.profile.models.flatMap((model) => [
        `          - id: "${model.id}"`,
        `            name: "${model.name}"`,
        `            contextWindow: ${model.contextWindow}`,
        `            maxTokens: ${model.maxTokens}`,
      ]),
    ].join('\n'))
    return rows.join('\n')
  }

  /** 云端网关的进度快照，供面板在开通后随时回看。 */
  function cloudGatewayState() {
    return {
      ready: cloudState.ready === true,
      at: cloudState.at ?? null,
      repo: cloudState.repo ?? null,
      baseURL: cloudState.baseURL ?? null,
      apiKeyEnv: cloudState.apiKeyEnv ?? null,
      models: cloudState.models ?? [],
      steps: cloudState.steps ?? [],
      stepsDefinition: PROVISION_STEPS,
      cloudPort: cloudState.port ?? DEFAULT_CLOUD_PORT,
      markers: MARKERS,
    }
  }

  /** 读一次仍是活的云网关（面板「测一下」用）。 */
  async function probeCloudGateway(input = {}) {
    const url = asString(input.url) ?? cloudState.baseURL
    if (url === undefined) return { ok: false, reason: '还没有开通云网关' }
    const credentials = ctx.get('credentials')
    const key = asString(input.key)
      ?? (credentials ? (await credentials.resolve(CLOUD_KEY_REF).catch(() => undefined))?.value : undefined)
    if (key === undefined || key === '') return { ok: false, reason: `凭证库里没有 ${CLOUD_KEY_REF}` }
    return verifyCloudGateway({ url, key, model: asString(input.model) ?? cloudState.models?.[0] })
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
    'gateway.survey': (input) => gatewaySurvey(input ?? {}),
    'gateway.autopick': (input) => autopickGateway(input ?? {}),
    'gateway.importToken': (input) => importGatewayToken(input ?? {}),
    'gateway.guide': (input) => gatewayTokenGuide(input ?? {}),
    'gateway.adoptAmbient': (input) => adoptAmbientGatewayToken(input ?? {}),
    'gateway.token': async () => {
      const found = await readGatewayToken()
      return found === undefined ? { stored: false } : { stored: true, repo: found.repo, savedAt: found.savedAt }
    },
    'gateway.configure': (input) => configureGateway(input ?? {}),
    'cloud.state': async () => cloudGatewayState(),
    'cloud.provision': async (input) => {
      const result = await provisionGateway(input ?? {})
      cloudState = {
        at: new Date().toISOString(),
        ready: result.ready,
        repo: result.repo,
        baseURL: result.harvest.url ?? null,
        apiKeyEnv: CLOUD_KEY_REF,
        models: result.harvest.models ?? [],
        port: result.port,
        steps: result.steps,
      }
      return result
    },
    'cloud.harvest': async (input) => {
      const harvest = await harvestGatewayFromLogs(input ?? {})
      if (harvest.ok) {
        cloudState = {
          ...cloudState,
          at: new Date().toISOString(),
          ready: true,
          repo: harvest.repo,
          baseURL: harvest.url,
          apiKeyEnv: CLOUD_KEY_REF,
          models: harvest.models,
          port: harvest.port ?? DEFAULT_CLOUD_PORT,
        }
      }
      return harvest
    },
    'cloud.verify': (input) => probeCloudGateway(input ?? {}),
    'cloud.wire': async (input) => {
      const repo = requireRepo(input?.repo)
      const baseURL = asString(input?.baseURL)
      const key = asString(input?.key)
      if (baseURL === undefined) throw new CnbError('需要云网关的 baseURL（形如 https://xxx-8794.cnb.run/v1）')
      if (key === undefined) throw new CnbError('需要云网关的访问 key')
      // 没给模型就沿用上一次开通/采集的清单，最后才退回候选表。
      //
      // 退回候选表是**最后**手段：它可能包含这个组织没开通的模型，写进 provider
      // 就是一个点了必然失败的选项。所以已采集到的清单优先 —— 那是云端实测过的。
      const fromInput = Array.isArray(input?.models) && input.models.length > 0
        ? input.models.map((entry) => asString(entry)).filter(Boolean)
        : null
      // 没给清单时的优先级：已采集的 → 当面问网关 → 候选表。
      //
      // 「当面问」这一步是关键：`/v1/models` 由云网关自己回答，那是**实测过**的
      // 清单（探测阶段已经把没额度的剔掉了）。退回候选表是最后手段 —— 它可能
      // 包含这个组织没开通的模型，写进 provider 就是一个点了必然失败的选项。
      let models = fromInput
      if (models === null && Array.isArray(cloudState.models) && cloudState.models.length > 0) {
        models = cloudState.models
      }
      if (models === null) {
        const listed = await fetchModelsFromGateway({ baseURL, key }).catch(() => null)
        models = listed !== null && listed.length > 0 ? listed : null
      }
      const catalogSource = models === null ? 'candidates' : (fromInput !== null ? 'input' : 'gateway')
      if (models === null) models = DEFAULT_CANDIDATES
      const provider = await wireCloudProvider({
        repo,
        baseURL,
        key,
        models,
        route: asString(input?.route) ?? DEFAULT_PROVIDER_ROUTE,
        makeDefault: input?.makeDefault !== false,
      })
      // 「配好了」和「对话真的在用」是两件事：DSH 的模型选择是**按会话**记住的，
      // 老会话里存的还是上一个 provider（本部署是 `cnb` 那条本地代理），配置写进去
      // 也不会改变它。所以要显式把会话选择也切过来，否则用户看到的就是「配好了但
      // 对话还是老模型」。
      // 只调查、不偷改：会话选择只有 DSH 的 session 服务能写，插件改文件会被
      // 运行中的进程覆盖回去（实测 10 秒内被写回）。所以这里给出的是结论 + 指引。
      const route = asString(input?.route) ?? DEFAULT_PROVIDER_ROUTE
      const model = models[0]
      const survey = surveySessionSelections({ home: harnessHome(), route, availableModels: models })
      const adopted = describeSessionAdoption({ route, model, survey })
      cloudState = {
        ...cloudState,
        at: new Date().toISOString(),
        ready: provider.written === true || provider.overridden === true,
        repo,
        baseURL,
        apiKeyEnv: CLOUD_KEY_REF,
        models,
        port: cloudState.port ?? DEFAULT_CLOUD_PORT,
      }
      return { ...provider, catalogSource, sessionAdoption: adopted }
    },
    'cloud.scaffold': async (input) => {
      // 只生成不写盘：面板用它做「先看我要放进仓库的是什么」。
      const port = asNumber(input?.port, DEFAULT_CLOUD_PORT)
      const models = Array.isArray(input?.models) && input.models.length > 0
        ? input.models.map((entry) => asString(entry)).filter(Boolean)
        : DEFAULT_CANDIDATES
      const key = asString(input?.key) ?? mintGatewayKey()
      const files = buildScaffold({ key, port, models, repo: asString(input?.repo) ?? '' })
      return {
        key,
        port,
        files: files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content), preview: file.content.slice(0, 400) })),
        cnf: files.find((file) => file.path === '.cnb.yml')?.content ?? '',
      }
    },
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

  /**
   * Adopt the injected pipeline token once at startup.
   *
   * A CNB workspace injects `CNB_TOKEN` into the container, so this process has it and
   * the gateway accepts it. Adopting it silently means a fresh workspace can use the
   * gateway without anyone copying a value by hand. Nothing is written when the token is
   * absent, when it fails a real gateway call, or when a working credential is already
   * stored — an automatic action must not replace a deliberate one.
   */
  ctx.effect(() => {
    void adoptAmbientGatewayToken()
      .then((result) => {
        adoptOutcome = { at: new Date().toISOString(), ...result }
        if (result.adopted === true) {
          console.info(`[dsh-cnb] adopted the injected CNB_TOKEN for the gateway (${result.repo})`)
        } else {
          console.info(`[dsh-cnb] did not adopt an injected token: ${result.reason}`)
        }
      })
      .catch((error) => {
        // A failure here is not worth interrupting boot for: the panel still offers the
        // manual path, and the reason is visible there.
        adoptOutcome = { at: new Date().toISOString(), adopted: false, reason: message(error) }
        console.warn(`[dsh-cnb] could not adopt the injected CNB_TOKEN: ${message(error)}`)
      })
    return () => {}
  }, 'dsh-cnb: adopt the injected gateway token')

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
    register(
      'cnb_cloud_gateway',
      '全自动开通一条「云环境自己托管的 AI 网关」：建仓库 → 写入零依赖网关脚手架 → 云原生启动 → 从环境 stage 日志采集对外地址与 key → 本机校验 → 写进 dsh 的 llm-pi-ai（provider 路由 cnb-gateway）。'
        + '为什么必须这样：CNB 网关只接受流水线令牌，而该令牌与仓库、与管道生命周期绑定，拿到别的机器上会被网络策略拦下（10412），所以代理只能跑在云环境里、经端口预览域名对外。'
        + '同时适配 11288 / 11128 内容风控：代理在发请求前改写客户端指纹（身份词插零宽空格、已知指纹句换等价表述），必要时把 system 折进首条 user，最后逐词打散；非流式请求由代理从流式聚合。',
      {
        properties: {
          org: { type: 'string', description: '组织路径；省略则用账号第一个组织' },
          name: { type: 'string', description: '仓库名；省略则用 dsh-gateway-<日期>-<时间>' },
          visibility: { type: 'string', enum: ['public', 'private', 'secret'], description: '默认 private' },
          description: { type: 'string' },
          image: { type: 'string', description: '云开发镜像；省略用平台默认' },
          models: { type: 'array', items: { type: 'string' }, description: '要曝光的模型 id 列表' },
          port: { type: 'integer', description: '云网关监听端口，默认 8794' },
          route: { type: 'string', description: 'provider 路由名，默认 cnb-gateway' },
          makeDefault: { type: 'boolean', description: '是否同时设为 dsh 默认模型，默认 true' },
          waitMs: { type: 'integer', description: '等待环境打出就绪标记的毫秒数，默认 240000' },
        },
      },
      (input) => operations['cloud.provision'](input),
    )
    register(
      'cnb_cloud_gateway_harvest',
      '重新从云端环境的 stage 日志采集网关地址与 key（环境重启、或首次采集超时后用）。',
      { properties: { repo: { type: 'string' }, sn: { type: 'string' }, waitMs: { type: 'integer' } }, required: ['repo'] },
      (input) => operations['cloud.harvest'](input),
    )
    register(
      'cnb_cloud_gateway_verify',
      '从本机真打一次云网关，确认端口预览、key、上游模型三者都通。',
      { properties: { url: { type: 'string' }, key: { type: 'string' }, model: { type: 'string' } } },
      (input) => operations['cloud.verify'](input),
    )
    register(
      'cnb_cloud_gateway_wire',
      '把已采集到的云网关写成 dsh 的 llm-pi-ai provider（可手工跳过建仓库那一步）。',
      {
        properties: {
          repo: { type: 'string' },
          baseURL: { type: 'string', description: '形如 https://xxx-8794.cnb.run/v1' },
          key: { type: 'string' },
          models: { type: 'array', items: { type: 'string' } },
          route: { type: 'string' },
          makeDefault: { type: 'boolean' },
        },
        required: ['repo', 'baseURL', 'key'],
      },
      (input) => operations['cloud.wire'](input),
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
    provisionGateway,
    harvestGatewayFromLogs,
    verifyCloudGateway,
    wireCloudProvider,
    cloudGatewayState,
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
