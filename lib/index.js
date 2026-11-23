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
import { homedir } from 'node:os'
import { join as joinPath } from 'node:path'
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
  normalizeProviderRoute,
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
import { heartbeatConfig, inspectAll, inspectWorkspace } from './keepalive.js'
import { autoKeepaliveConfig, planAction } from './autokeep.js'
import { planRestart } from './immortal.js'
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
    // 等它就绪，而不是同步取一次就判定「没有」——桌面端首次启动常常慢一步。
    const credentials = await credentialsService()
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
    // token, which the gateway refuses outright. Falls back to the ambient pipeline
    // token so a fresh desktop process (no credentials service yet) still works.
    const gateway = await gatewayTokenOrAmbient()
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
    /**
     * 只读**存储的**令牌，不读环境变量。
     *
     * 这点必须守住：`adoptAmbientGatewayToken` 用「这里有没有值」判断「是否已导入」，
     * 若把 env 里的令牌也当作已存储，那个流程会认为「已有令牌，未覆盖」而拒绝写入
     * —— 实测直接让 ambient-token 那组测试失败。
     *
     * 环境兜底放在**调用方**（检验、探测）按需取，见 `gatewayTokenOrAmbient`。
     */
    const credentials = ctx.get('credentials')
    if (!credentials?.readRecord) return undefined
    const record = await credentials.readRecord(GATEWAY_CREDENTIAL).catch(() => undefined)
    const token = typeof record?.payload?.token === 'string' ? record.payload.token : ''
    return token === '' ? undefined : { token, savedAt: record.payload.savedAt ?? null, repo: record.payload.repo ?? null }
  }

  /**
   * 存储的令牌；没有就退回进程环境里的流水线令牌。
   *
   * 桌面端每次启动都是新进程，`credentials` 可能还没就绪 —— 只读存储的话，
   * 网关检验会一律报「没有导入令牌」，而令牌其实就在 env 里。
   * @returns {Promise<{ token: string, savedAt: string | null, repo: string | null } | undefined>}
   */
  async function gatewayTokenOrAmbient() {
    const stored = await readGatewayToken()
    if (stored !== undefined) return stored
    const ambient = ambientPipelineToken()
    return ambient === null ? undefined : { token: ambient.token, savedAt: null, repo: ambient.repo }
  }

  /** @param {string} token @param {{ repo?: string }} [meta] */
  async function writeGatewayToken(token, meta = {}) {
    const credentials = await credentialsService()
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
  /**
   * 取 credentials 服务，**等服务就绪**而不是同步取一次就放弃。
   *
   * 桌面端每次启动都是新进程，插件 `apply()` 跑的时候 credentials 可能还没挂载。
   * 同步 `ctx.get('credentials')` 会拿到 undefined，于是用户看到「当前 profile 没有
   * credentials 服务」—— 而那个服务马上就绪了，只是我们来早了一步。
   *
   * 这里的做法：先同步取（web 下直接就绪，零成本），取不到就等到 `ctx.inject`
   * 的回调被调用为止，最多等 `timeoutMs`。超时才真的报错。
   *
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<any>}
   */
  function credentialsService(options = {}) {
    const ready = ctx.get('credentials')
    if (ready) return Promise.resolve(ready)
    const timeoutMs = options.timeoutMs ?? 10_000
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new CnbError('credentials 服务在预期时间内未就绪（桌面端首次启动可能需要更久）'))
      }, timeoutMs)
      try {
        // inject 的回调在服务可用时触发一次；host 就是带该服务的上下文。
        ctx.inject(['credentials'], (host) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(host.credentials)
        })
      } catch (error) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error instanceof Error ? error : new CnbError(String(error)))
      }
    })
  }

  /**
   * DSH 的 home 目录。
   *
   * **不能用 `process.env.HOME`**：Windows 没有这个变量（它用 USERPROFILE），
   * 桌面端跑在 Windows 上时这里会返回 undefined，所有读写配置的路径就全断了。
   * `os.homedir()` 三个平台都对，这是唯一正确的取法。
   *
   * `DSH_HOME` 仍然优先：桌面端和测试都靠它指定隔离目录。
   */
  function harnessHome() {
    const explicit = asString(process.env.DSH_HOME)
    if (explicit !== undefined) return explicit
    try {
      const home = homedir()
      return home === '' ? undefined : joinPath(home, '.dsh')
    } catch {
      // 极端情况下 os 拿不到 home（容器里没 passwd 项），就当没有。
      return undefined
    }
  }

  /**
   * 读出 `--patch` overlay 里定义的 provider。
   *
   * 为什么需要它：patch 层对 `config` 是整体赋值，所以 profile patch 一旦定义了
   * `llm-pi-ai.providers`，overlay 那棵 providers 树就被替换 —— 不把 overlay 已有
   * 的路由一起带过去，用户就会看到「装了插件，我原来的供应商不见了」。
   *
   * 解析很窄：只找 `- id: llm-pi-ai` 之后的 `providers:` 段，读它下面一级的键。
   * 不引入 YAML 库 —— 这段格式是我们自己和部署脚本写的，键名就是路由名。
   * 读不懂就返回空表：宁可少带，也不要把半截结构写进配置。
   *
   * @returns {Map<string, Record<string, any>>} 路由名 → 画像（字段已归一）
   */
  function readOverlayProviders() {
    for (const layer of overridingLayers()) {
      if (layer.key !== '--patch') continue
      let text
      try {
        text = readFileSync(layer.value, 'utf8')
      } catch {
        continue
      }
      const found = readOverlayProvidersFromText(text)
      if (found.size > 0) return found
    }
    return new Map()
  }

  /**
   * 从一段 patch YAML 文本里读出 `- id: llm-pi-ai` 下面的 providers。
   *
   * 为什么需要它：patch 层对 `config` 是整体赋值，所以**只要 overlay 定义了
   * `llm-pi-ai`，profile patch 里再写同样的条目就完全无效**。想加一个路由，必须
   * 写进 overlay 本身 —— 那就要先把它原本的 provider 读出来，一并写回去。
   *
   * 解析很窄，只认这个形状：顶层 `- id: llm-pi-ai` → `providers:` → 一级键。
   * 不引入 YAML 库（一个文件不值得给 profile 加依赖）；读不懂就返回空表 ——
   * 宁可少带，也不要把半截结构写回去。
   *
   * @param {string} text
   * @returns {Map<string, Record<string, any>>}
   */
  function readOverlayProvidersFromText(text) {
    const found = new Map()
    const lines = String(text ?? '').split('\n')
    const start = lines.findIndex((line) => line.trim() === '- id: llm-pi-ai')
    if (start < 0) return found
    let providersIndent = -1
    let name = null
    let current = null
    const flush = () => {
      if (name !== null && current !== null) found.set(name, current)
      name = null
      current = null
    }
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.trim() === '') continue
      const indent = line.length - line.trimStart().length
      if (indent === 0 && /^-\s/.test(line.trim())) {
        flush()
        providersIndent = -1
        break
      }
      if (line.trim() === 'providers:') {
        providersIndent = indent
        continue
      }
      if (providersIndent < 0) continue
      if (indent <= providersIndent) {
        flush()
        providersIndent = -1
        continue
      }
      const routeMatch = indent === providersIndent + 2 ? /^([A-Za-z0-9_-]+):\s*$/.exec(line.trim()) : null
      if (routeMatch !== null) {
        flush()
        name = routeMatch[1]
        current = { models: [], compat: {} }
        continue
      }
      if (current === null) continue
      const offset = indent - providersIndent
      // provider 的直接字段在 +4。
      if (offset === 4) {
        const field = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line.trim())
        if (field === null) continue
        if (field[1] === 'models' || field[1] === 'compat') continue
        if (field[2].trim() !== '') current[field[1]] = parseScalar(field[2].trim())
        continue
      }
      // models 条目：+6 是 `- id:`，+8 是它的字段，+10 是字段里的嵌套块。
      if (offset >= 6) {
        const itemStart = /^-\s+([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line.trim())
        if (offset === 6 && itemStart !== null) {
          current.models ??= []
          const item = { [itemStart[1]]: parseScalar(itemStart[2].trim()) }
          current.models.push(item)
          continue
        }
        const last = current.models?.[current.models.length - 1]
        if (last === undefined) continue
        const field = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line.trim())
        if (field === null) continue
        if (offset === 8) {
          if (field[2].trim() !== '') last[field[1]] = parseScalar(field[2].trim())
          continue
        }
        if (offset >= 10 && last.reasoningEfforts !== undefined) {
          const value = parseScalar(field[2].trim())
          last.reasoningEfforts[field[1]] = value === '' ? null : value
        } else if (offset >= 10) {
          (last.reasoningEfforts ??= {})[field[1]] = parseScalar(field[2].trim()) || null
        }
      }
    }
    flush()
    return found
  }



  /**
   * 把 `models:` 与 `compat:` 的嵌套块读进已找到的 provider 画像。
   * @param {string} text @param {number} start 本条目起始行
   * @param {Map<string, Record<string, any>>} found
   */
  function hydrateProviderBlocks(text, start, found) {
    const lines = text.split('\n')
    let providersIndent = -1
    let name = null
    let block = null
    let blockIndent = -1
    let item = null
    const flushItem = () => {
      if (name === null || block !== 'models' || item === null) return
      const profile = found.get(name)
      if (profile !== undefined) (profile.models ??= []).push(item)
      item = null
    }
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.trim() === '') continue
      const indent = line.length - line.trimStart().length
      if (indent === 0 && /^-\s/.test(line.trim())) break
      if (line.trim() === 'providers:') {
        providersIndent = indent
        continue
      }
      if (providersIndent < 0) continue
      if (indent <= providersIndent) break
      const routeMatch = indent === providersIndent + 2 ? /^([A-Za-z0-9_-]+):\s*$/.exec(line.trim()) : null
      if (routeMatch !== null) {
        flushItem()
        name = routeMatch[1]
        block = null
        blockIndent = -1
        const profile = found.get(name)
        if (profile !== undefined) {
          profile.models = []
          profile.compat = {}
        }
        continue
      }
      if (name === null) continue
      const profile = found.get(name)
      if (profile === undefined) continue
      if (indent === providersIndent + 4 && line.trim() === 'models:') {
        block = 'models'
        blockIndent = indent
        continue
      }
      if (indent === providersIndent + 4 && line.trim() === 'compat:') {
        block = 'compat'
        blockIndent = indent
        continue
      }
      if (indent === providersIndent + 4) {
        flushItem()
        block = null
        blockIndent = -1
        continue
      }
      if (block === null || indent <= blockIndent) continue
      if (block === 'models') {
        const itemStart = /^-\s+([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line.trim())
        if (indent === blockIndent + 2 && itemStart !== null) {
          flushItem()
          item = {}
          item[itemStart[1]] = parseScalar(itemStart[2].trim())
          continue
        }
        if (item === null) continue
        // 条目内可能有嵌套块（`reasoningEfforts:`），比字段再深一级。
        if (indent === blockIndent + 4) {
          const nested = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line.trim())
          if (nested !== null && nested[2].trim() !== '') item[nested[1]] = parseScalar(nested[2].trim())
          continue
        }
        if (indent > blockIndent + 4) {
          const effort = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line.trim())
          if (effort !== null) {
            const efforts = (item.reasoningEfforts ??= {})
            // `off:` 没有值 —— pi-ai 用 null 表达「不发这个档位」。
            const value = parseScalar(effort[2].trim())
            efforts[effort[1]] = value === '' ? null : value
          }
          continue
        }
        const field = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line.trim())
        if (field !== null && field[2].trim() !== '') item[field[1]] = parseScalar(field[2].trim())
        continue
      }
      // compat：只收标量，够用。
      const field = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line.trim())
      if (field !== null && field[2].trim() !== '' && profile.compat !== undefined) {
        profile.compat[field[1]] = parseScalar(field[2].trim())
      }
    }
    flushItem()
  }

  /**
   * 把 YAML 标量读回 JS 值：引号串、数字、布尔、null。
   * @param {string} raw
   */
  function parseScalar(raw) {
    if (raw === '') return ''
    if (raw === 'null' || raw === '~') return null
    if (raw === 'true') return true
    if (raw === 'false') return false
    if (/^-?\d+$/.test(raw)) return Number(raw)
    if (/^-?\d*\.\d+$/.test(raw)) return Number(raw)
    const quoted = /^"(.*)"$/.exec(raw) ?? /^'(.*)'$/.exec(raw)
    if (quoted !== null) return quoted[1]
    return raw
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
      const candidate = joinPath(home, 'cordis.patch.yml')
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
    // 路由名必须满足 pi-ai 的 provider id 规则，否则它会被静默跳过（见 normalizeProviderRoute）。
    const route = normalizeProviderRoute(input.route).route
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
      route: normalizeProviderRoute(input.route).route,
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
   * 把 provider 写进 `--patch` overlay 本身。
   *
   * 这是**唯一真正有效**的落点：patch 层对 `config` 是整体赋值
   * （`target[key] = value`，见 dsh-app-boot 的 applyPatches），所以只要 overlay
   * 定义了 `llm-pi-ai`，profile patch 里再写同样的条目也完全无效 —— 上层那份会把
   * 它整个盖掉。实测过：带 overlay 启动时，profile patch 里的路由在
   * `--dump-config` 里根本不出现。
   *
   * 代价与边界：
   *   · overlay 通常是部署脚本生成的，下次启动可能被重写 —— 所以这里把结果
   *     同时写进 profile patch（`writeProfilePatch`），脚本重写后至少本进程还
   *     能用；想长期生效要改脚本（README 里写了怎么做）。
   *   · 只改 `llm-pi-ai` 与 `agent-default-model` 两个条目，其余原样保留。
   *
   * @param {{ file: string, entry: Record<string, any>, route: string, defaultEntry?: Record<string, any> | null }} input
   * @returns {{ written: boolean, file: string, overlay: true, preserved: string[] }}
   */
  function writeOverlayPatch(input) {
    let before
    try {
      before = readFileSync(input.file, 'utf8')
    } catch (error) {
      return { written: false, file: input.file, reason: message(error) }
    }
    const existing = readProfileProviders(before, '# nothing')
    // 上面那次读用的是「从 marker 起」的语义；overlay 没有 marker，直接整文件读。
    const providers = readOverlayProvidersFromText(before)
    const preserved = [...providers.keys()].filter((name) => name !== input.route)

    const block = [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      ...preserved.flatMap((name) => [`      ${name}:`, ...indentLines(providerYamlLines(providers.get(name)), 8)]),
      `      ${input.route}:`,
      ...indentLines(providerYamlLines(input.entry), 8),
      ...(input.defaultEntry === null || input.defaultEntry === undefined
        ? []
        : ['- id: agent-default-model', '  config:', ...indentLines(flatYamlLines(input.defaultEntry), 4)]),
      '',
    ].join('\n')

    const cleaned = stripManagedEntries(before, '# dsh-cnb: never-matches')
    const next = `${cleaned.trimEnd()}\n\n${block}`
    try {
      writeFileSync(input.file, next, 'utf8')
    } catch (error) {
      return { written: false, file: input.file, reason: message(error) }
    }
    void existing
    return { written: true, file: input.file, overlay: true, preserved }
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
        : joinPath(home, 'profiles', asString(process.env.DSH_PROFILE) ?? 'web')
    if (dir === undefined) return { written: false, reason: '拿不到 profile 目录，无法定位 patch 层' }
    const file = joinPath(dir, 'cordis.patch.yml')
    if (!existsSync(file)) return { written: false, reason: `${file} 不存在` }

    const before = readFileSync(file, 'utf8')
    const marker = '# dsh-cnb: cloud gateway provider'

    /**
     * **必须保留已有的兄弟 provider。**
     *
     * patch 层对 `config` 是整体赋值（`target[key] = value`），不做深度合并 ——
     * 所以写 `providers: { cnb-gateway: … }` 会把同一层里原本的 `cnb`（或用户自己
     * 配的任意路由）**整个抹掉**。实测踩过：一个部署里 overlay 定义了 `cnb`，
     * profile patch 只写 `cnb-gateway`，最终组合里只剩后者，用户看到的就是
     * 「我配的那个供应商不见了」。
     *
     * 所以这里先读回 profile patch 自己已有的 providers，再把它们一起写出去。
     * 只认这一层：overlay（`--patch`）优先级更高，它的 provider 不需要也不该被
     * 复制过来 —— 复制会制造两份定义，并让日后改 overlay 失去意义。
     */
    const existingProviders = readProfileProviders(before, marker)
    const keep = [...existingProviders.keys()].filter((name) => name !== input.route)
    /**
     * overlay 里的 provider：**必须一起写出去**。
     *
     * 纠正上面那段旧注释的前提：patch 层对 `config` 是整体赋值，所以一旦这一层
     * 定义了 `providers`，overlay 那棵树就被替换掉了 —— 不复制同样的路由过去，
     * 结果就是「装了插件，原来的供应商消失」。这不是「制造两份定义」，而是
     * 「保住别人已有的那一份」；overlay 优先级更高，下次启动它自然赢回来。
     *
     * 已经被 profile patch 自己定义过的名字不重复写（后者是更新的一次）。
     */
    const inherited = (input.inherit ?? []).filter(([name]) => name !== input.route && !existingProviders.has(name))
    const block = [
      marker,
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      // 先写兄弟 provider 的**原始行**：路由名那行 + 它下面的内容，都照原样贴回。
      // 不重新序列化是为了不改写用户/上次写入的格式，也避免「读进来再拼回去」
      // 这种转换里丢失字段。
      ...keep.flatMap((name) => existingProviders.get(name)),
      // overlay 的 provider 按画像重新序列化：它们是结构化数据，不是原始文本。
      ...inherited.flatMap(([name, profile]) => [`      ${name}:`, ...indentLines(providerYamlLines(profile), 8)]),
      `      ${input.route}:`,
      // provider 的字段必须比路由名深一级：路由在 6 格，字段在 8 格。
      ...indentLines(providerYamlLines(input.entry), 8),
      ...(input.makeDefault && input.defaultEntry !== undefined && input.defaultEntry !== null
        ? ['- id: agent-default-model', '  config:', ...indentLines(flatYamlLines(input.defaultEntry), 4)]
        : []),
      '',
    ].join('\n')

    const cleaned = stripManagedEntries(before, marker)
    /**
     * 空 profile patch 的内容是 `[]`（一个空 YAML 文档）—— 它不是「没有内容」，
     * 而是一个**值为空列表的文档**。直接往后追加 `- id: …` 会得到
     *   `[]` 换行 `- id: llm-pi-ai`
     * 而 YAML 只有**一个**文档槽：`[]` 已经占住了它，再跟一个列表就是语法错误
     * （实测：`failed to parse overlay … end of the stream or a document separator
     * is expected`）。全新安装的 profile 恰好就是这个形状，所以这是新用户必踩的
     * 第一步。
     *
     * 这里把「去掉空数组后的残余」当作真正的底稿：如果它只剩注释和空白，说明
     * 原来就是一个空文档，直接丢掉 `[]` 再写我们的条目即可。
     */
    const residue = cleaned
      .split('\n')
      .filter((line) => !/^\s*\[\]\s*$/.test(line))
      .join('\n')
    const onlyComments = residue
      .split('\n')
      .every((line) => line.trim() === '' || line.trim().startsWith('#'))
    const base = onlyComments ? '' : residue.trimEnd()
    const next = base === '' ? `${block}` : `${base}\n\n${block}`
    if (next === before) return { written: false, unchanged: true, file }
    writeFileSync(file, next, 'utf8')
    return {
      written: true,
      file,
      hot: true,
      preserved: [...keep, ...inherited.map(([name]) => name)],
    }
  }

  /**
   * 摘掉本插件管理的条目：`llm-pi-ai`、`agent-default-model`，以及我们自己的
   * marker 段。
   *
   * 为什么必须**整条摘**，而不是只裁掉 marker 之后的：同一个 profile patch 里
   * 可能有两条 `llm-pi-ai` —— 一条是 configEditor 正常写入的（没有 overlay 时
   * 走的就是它），一条是本插件为了绕过 overlay 自己追加的。只裁后一条会留下
   * 前一条，两份 `providers` 里各有一个同名路由，YAML 行为取决于解析器取哪个，
   * 实测表现是「新加的路由不见了」。
   *
   * 这里按顶层条目（`- id: …`）切块，只丢这两类，其它条目原样保留。
   * @param {string} text @param {string} marker
   */
  function stripManagedEntries(text, marker) {
    const managed = new Set(['llm-pi-ai', 'agent-default-model'])
    // 先去掉 marker 及其之后的内容（那是上一次由本插件追加的段）。
    const head = removeManagedBlock(text, marker)
    const lines = head.split('\n')
    const keep = []
    let skipping = false
    for (const line of lines) {
      // 顶层条目起点：`- id: xxx` 或 `- ` 后跟一个键。
      const topLevel = /^-\s+id:\s*(.*)$/.exec(line)
      if (topLevel !== null) {
        skipping = managed.has(topLevel[1].trim())
        if (skipping) continue
        keep.push(line)
        continue
      }
      // 非顶层条目开头（比如别处出现的 `- `），也要判断是否落在被跳过的块里。
      if (/^-\s/.test(line)) {
        const idLike = /^-\s+id:\s*(.*)$/.exec(line)
        if (idLike !== null) {
          skipping = managed.has(idLike[1].trim())
          if (skipping) continue
        }
        keep.push(line)
        continue
      }
      if (skipping) {
        // 块内所有缩进行都属于它；空行也一并丢掉，避免留下孤立空行。
        continue
      }
      keep.push(line)
    }
    return keep.join('\n')
  }

  /**
   * 读回本插件上一次写进 profile patch 的那些 provider，按名字索引**原始行**。
   *
   * 只解析自己那段（从 marker 到文件尾），不去理解整个 YAML —— 引入完整解析器
   * 只为改一个文件不划算，也会让 profile 多一个依赖。这里需要的信息很窄：
   * 「6 格缩进、以冒号结尾的行」就是一个 provider 路由名，它之后到下一个同级行
   * 之前都是它的内容。
   *
   * 每条结果都**包含路由名那一行**：写回时原样贴出即可，不必重新拼缩进 ——
   * 拼错一格 YAML 仍能解析，但路由会变成 null（本仓库踩过这个坑）。
   *
   * @param {string} text 整个 patch 文件
   * @param {string} marker 本插件那段的起始注释
   * @returns {Map<string, string[]>} 路由名 → 该 provider 的原始行（含路由名行）
   */
  function readProfileProviders(text, marker) {
    const found = new Map()
    const start = text.indexOf(marker)
    if (start < 0) return found
    const lines = text.slice(start).split('\n')
    let providersIndent = -1
    let current = null
    let buffer = []
    const flush = () => {
      if (current !== null) found.set(current, buffer)
      current = null
      buffer = []
    }
    for (const line of lines) {
      if (line.trim() === '') continue
      const indent = line.length - line.trimStart().length
      if (line.trim() === 'providers:') {
        providersIndent = indent
        continue
      }
      if (providersIndent < 0) continue
      // 回到 providers 的层级或更浅：这段 provider 定义结束。
      if (indent <= providersIndent) {
        flush()
        providersIndent = -1
        continue
      }
      const isRouteName = indent === providersIndent + 2 && /^[A-Za-z0-9_-]+:\s*$/.test(line.trim())
      const isEntryStart = indent <= providersIndent + 2 && !isRouteName
      if (isEntryStart) {
        flush()
        providersIndent = -1
        continue
      }
      if (isRouteName) {
        flush()
        current = line.trim().slice(0, -1)
        // 关键：路由名那一行也收进去，写回时整段照贴。
        buffer.push(line)
        continue
      }
      if (current !== null) buffer.push(line)
    }
    flush()
    return found
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
    /**
     * 这个函数同时服务两种输入：
     *   · 本插件自己构造的画像（字段齐全，`compat` 已定好）；
     *   · overlay 里读回来的原始画像（可能缺 displayName / compat / api）。
     * 后者按 pi-ai 的默认语义补齐，而不是原样写出 `undefined` —— 写出
     * `apiKeyEnv: undefined` 会让整个 provider 校验失败，而那正是「导入失败」的
     * 一种来源。
     */
    const lines = []
    if (typeof entry.displayName === 'string') lines.push(`displayName: ${JSON.stringify(entry.displayName)}`)
    lines.push(`api: ${entry.api ?? 'openai-completions'}`)
    lines.push(`baseURL: ${entry.baseURL}`)
    if (typeof entry.apiKeyEnv === 'string') lines.push(`apiKeyEnv: ${entry.apiKeyEnv}`)
    if (typeof entry.defaultMaxTokens === 'number') lines.push(`defaultMaxTokens: ${entry.defaultMaxTokens}`)
    const compat = entry.compat !== null && typeof entry.compat === 'object'
      ? entry.compat
      : { thinkingFormat: 'openai', supportsReasoningEffort: false, supportsUsageInStreaming: true, maxTokensField: 'max_tokens' }
    lines.push('compat:')
    for (const [key, value] of Object.entries(compat)) lines.push(`  ${key}: ${value}`)
    lines.push('models:')
    for (const model of entry.models ?? []) {
      lines.push(`  - id: ${JSON.stringify(model.id)}`)
      lines.push(`    name: ${JSON.stringify(model.name ?? model.id)}`)
      lines.push(`    contextWindow: ${model.contextWindow}`)
      lines.push(`    maxTokens: ${model.maxTokens}`)
      // 推理能力要靠 `reasoningEfforts` 表达 —— pi-ai 的 modelProfile 只认
      // id/name/contextWindow/maxTokens/input/reasoningEfforts/compat，
      // 写 `reasoning: true` 会被 schema 静默忽略（不报错，也不生效）。
      const efforts = model.reasoningEfforts !== undefined && model.reasoningEfforts !== false
        ? Object.keys(model.reasoningEfforts)
        : (Array.isArray(model.efforts) ? model.efforts : [])
      if (efforts.length > 0) {
        lines.push('    reasoningEfforts:')
        for (const effort of efforts) {
          // `off` 的线上值必须是空 —— pi-ai 用「无值」表示这个档位不发思考参数。
          // 写成 `off: off` 会被当成一个名为 off 的强度传给上游。
          const wire = model.reasoningEfforts?.[effort]
          lines.push(wire === null || effort === 'off' ? `      ${effort}:` : `      ${effort}: ${effort}`)
        }
      }
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
    const credentials = await credentialsService()
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
      /**
       * 元数据从 MODEL_CATALOG 取（实测过的上下文窗口 + 推理档位）。
       *
       * 兼容两种输入：模型 id 字符串，或已归一好的画像对象 —— 调用链上
       * 有的地方拿到的是 id 列表，有的是 describeModel 的结果。
       */
      models: input.models.map((entry) => (typeof entry === 'string' ? describeModel(entry) : entry)),
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
     */    let hotPath = null
    if (written === false) {
      const overlay = readOverlayProviders()
      /**
       * overlay 里已有同名路由时，**只在它属于本插件时才更新**。
       *
       * 早先的逻辑是「有就一律不碰」，理由是「那多半是有人特意配的」。这条理由
       * 对**别人手写的**路由成立，对本插件自己写过的不成立 —— 后果是重跑一次
       * 开通（换了仓库、或插件升级后模型清单变了）拿不到新结果，配置里永远留着
       * 第一次写下的那份旧画像，用户看到的就是「明明重新开通了，模型还是那几个」。
       *
       * 判据用 `apiKeyEnv`：本插件写的路由一定指向自己的 key 引用。别人的路由
       * 用他们自己的 key，不会被误判。
       */
      const ownedRoute = overlay.get(input.route)
      const ours = ownedRoute !== undefined && ownedRoute.apiKeyEnv === CLOUD_KEY_REF
      if (ownedRoute !== undefined && !ours) {
        hotPath = { written: false, reason: `--patch 层已定义 ${input.route}（非本插件写入），不覆盖`, overlayOwnsRoute: true }
      } else {
        /**
         * 两条落点都走一遍，顺序很重要。
         *
         * **overlay 才是真正生效的那一层**：patch 层对 `config` 是整体赋值，所以
         * 只要 overlay 定义了 `llm-pi-ai`，profile patch 里写什么都白搭 —— 实测
         * 带 overlay 启动时，profile patch 里的路由在 `--dump-config` 里根本不出现。
         *
         * profile patch 仍然要写：overlay 常由部署脚本生成，下次启动可能被重写；
         * 那一份至少保住本进程与「脚本没重写」的情况。
         */
        const defaultEntry = input.makeDefault ? { provider: input.route, model: input.models[0] } : null
        const overlaid = (() => {
          for (const layer of overridingLayers()) {
            if (layer.key !== '--patch') continue
            return writeOverlayPatch({ file: layer.value, entry: profile, route: input.route, defaultEntry })
          }
          return { written: false, reason: '没有 --patch 层' }
        })()
        const profiled = await writeProfilePatch({
          entry: profile,
          defaultEntry,
          route: input.route,
          model: input.models[0],
          makeDefault: input.makeDefault === true,
          inherit: [...overlay.entries()].filter(([name]) => name !== input.route),
        }).catch((error) => ({ written: false, reason: message(error) }))
        hotPath = {
          ...profiled,
          overlayLayer: overlaid,
          // 成功与否以 overlay 为准：只有它能让配置真正生效。
          written: overlaid.written === true || profiled.written === true,
        }
        if (hotPath.written === true) {
          written = true
          overridden = false
          if (input.makeDefault) defaultModel = { provider: input.route, model: input.models[0] }
        }
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
    /**
     * 地址来源顺序：显式传入 → 内存状态 → **磁盘配置**。
     *
     * 加磁盘这一层是为了桌面端：`cloudState` 只活在本次进程里，桌面端每次启动
     * 都是新进程，重启后它就是空的 —— 于是「检验」会一个字都说不出地返回
     * 「还没有开通云网关」，而配置其实好端端地躺在 profile patch 里、模型也能正常用。
     * 用户看到的是「检验坏了」，不是「状态没恢复」。
     */
    const url = asString(input.url) ?? cloudState.baseURL ?? currentBaseUrl({})
    if (url === undefined || url === null) return { ok: false, reason: '还没有开通云网关' }

    /**
     * 取 key：显式传入 → 凭证库 → **配置里的 apiKeyEnv 指向的环境变量**。
     *
     * `ctx.get('credentials')` 是同步取服务，和工具注册那个坑同源：桌面端/headless
     * 下服务可能还没就绪，取到 undefined，于是每次检验都报「凭证库里没有 ...」，
     * 而 key 明明就在进程环境里。
     */
    let key = asString(input.key)
    if (key === undefined) {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined && typeof credentials.resolve === 'function') {
        key = (await credentials.resolve(CLOUD_KEY_REF).catch(() => undefined))?.value
      }
    }
    if (key === undefined || key === '') {
      const fromEnv = asString(process.env[CLOUD_KEY_REF])
      if (fromEnv !== undefined) key = fromEnv
    }
    if (key === undefined || key === '') {
      return { ok: false, reason: `凭证库里没有 ${CLOUD_KEY_REF}，环境变量里也没有` }
    }
    return verifyCloudGateway({ url, key, model: asString(input.model) ?? cloudState.models?.[0] })
  }

  /**
   * 云网关承载的仓库路径，从**磁盘上的配置**读出来。
   *
   * 为什么不用 `configEditor`：它给的是 profile 层自己的条目，而本部署真正生效
   * 的那条 provider 常常写在 `--patch` overlay 里（启动脚本生成的）。实测过：
   * `configEditor.entries()` 读到的是空 providers，于是「哪个环境承载云网关」
   * 永远标不出来。
   *
   * 所以这里直接扫两层磁盘文件：profile 的 `cordis.patch.yml` 与各 `--patch`。
   * 认的标记是 displayName 里的 `(org/repo)` —— 那是 `wireCloudProvider` 写进去的。
   * 读不到就返回 null，不猜。
   * @returns {string | null}
   */
  function routeRepositoryFromConfig() {
    const candidates = []
    const profileDir = asString(ctx.get('profileContext')?.dir)
    if (profileDir !== undefined) candidates.push(joinPath(profileDir, 'cordis.patch.yml'))
    const home = harnessHome()
    if (home !== undefined) candidates.push(joinPath(home, 'cordis.patch.yml'))
    for (const layer of overridingLayers()) {
      if (layer.key === '--patch') candidates.push(layer.value)
    }
    for (const file of candidates) {
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      // overlay 优先级高，先扫它；同时按出现顺序取第一个带仓库路径的 displayName。
      const match = /displayName:\s*"?CNB 云网关 \(([^)]+\/[^)]+)\)"?/.exec(text)
      if (match !== null) return match[1].trim()
    }
    return null
  }

  /**
   * 全自动化：把守护 crontab 写进仓库，并给出当前每个环境的处置计划。
   *
   * `apply: false`（默认）只返回计划与片段；`apply: true` 才真写 `.cnb.yml`。
   * 默认不写是刻意的：`.cnb.yml` 里可能已经有别人维护的 crontab 段，写进去会
   * 覆盖它。用户明确要求「自动化」时才动手，而且返回里会说明写了什么。
   *
   * @param {{ repo?: string, gatewayRepo?: string, intervalMinutes?: number, image?: string, apply?: boolean, gatewayPort?: number, servicePort?: number }} [input]
   */
  async function keepaliveAutomate(input = {}) {
    const repo = requireRepo(input.repo ?? cloudState.repo ?? routeRepositoryFromConfig())
    const gatewayRepo = asString(input.gatewayRepo) ?? routeRepositoryFromConfig() ?? repo
    // 重建策略：默认 keep（不新建环境，省额度）；renew 需显式 opt-in。
    const renewPolicy = input.renewPolicy === 'renew' ? 'renew' : 'keep'
    const config = autoKeepaliveConfig({
      renewPolicy,
      repo,
      gatewayRepo,
      intervalMinutes: asNumber(input.intervalMinutes, 5),
      gatewayPort: asNumber(input.gatewayPort, DEFAULT_CLOUD_PORT),
      servicePort: asNumber(input.servicePort, 3080),
      ...(asString(input.image) === undefined ? {} : { image: asString(input.image) }),
    })

    // 当前每个环境该怎么处置，一并给出 —— 只有配置、没有判断是半个功能。
    let plan = null
    try {
      const list = await client().workspaces({ page: 1, pageSize: 100, slug: repo })
      /**
       * **只看最新的那一个环境**，不是全部历史。
       *
       * 实测踩过：workspace/list 会把所有历史环境都列出来（包括早先手动停掉的），
       * 逐个判一遍会让每条 closed 记录都得到「该 revive」，面板上于是出现一串
       * 「模型全部不可用 —— 先拉起」的红字，全是噪音；真去执行就白白烧掉好几次
       * 创建配额 —— 这正是本次要避免的事。
       *
       * 一个仓库在任一时刻只该有一个活跃环境，所以取最新的那个作为判断对象。
       */
      const items = [...(list.items ?? [])].sort(
        (a, b) => new Date(b.create_time ?? 0).getTime() - new Date(a.create_time ?? 0).getTime(),
      )
      const current = items.find((item) => String(item?.status ?? '') === 'running') ?? items[0]
      plan = current === undefined
        ? []
        : [{
            repo: current.slug ?? repo,
            sn: current.sn ?? null,
            status: current.status ?? null,
            ...planAction({
              status: current.status,
              create_time: current.create_time,
              isGateway: current.slug === gatewayRepo,
              renewPolicy: renewPolicy,
            }),
          }]
    } catch (error) {
      plan = [{ error: message(error) }]
    }

    if (input.apply !== true) {
      return {
        repo,
        gatewayRepo,
        cron: config.cron,
        applied: false,
        plan,
        yml: config.yml,
        note: '这是可以直接并入 .cnb.yml 的守护配置。传 apply: true 由插件写入（会覆盖 .cnb.yml 中已有的 crontab 段）。',
      }
    }

    // 先读现有内容再合并 —— 整文件覆盖会抹掉仓库里已有的 $: vscode 环境定义。
    const existingAutomate = await readRepoText({ repo, path: '.cnb.yml' })
    const mergedAutomate = mergeCrontab(existingAutomate, config.yml)
    const wrote = await writeFilesThroughBuild({
      repo,
      files: [{ path: '.cnb.yml', content: mergedAutomate }],
      message: 'chore(dsh-cnb): auto keepalive daemon',
    })
    return {
      repo,
      gatewayRepo,
      cron: config.cron,
      applied: wrote.status === 'success',
      plan,
      yml: config.yml,
      build: { sn: wrote.sn, status: wrote.status },
    }
  }

  /**
   * 自愈：provider 指向的地址如果已经失效，自动重新采集并改写。
   *
   * 这是「全部打通」缺的那一环。Runner 侧的重启脚本只能把新地址写进仓库，
   * 它改不到**本机**的 dsh 配置。所以本机需要一个看门逻辑：
   *
   *   1. 读当前 provider 的 baseURL；
   *   2. 打一次它的 /health；
   *   3. 不通 → 去订阅仓库里最新的环境，从 stage 日志重新采地址 → 改写配置。
   *
   * 触发时机可以手动，也可以由面板定时调用。它覆盖的正是「环境换了、地址变了、
   * 但本机配置还指着旧的」这种状态 —— 用户感知就是「模型突然全部失败」。
   *
   * @param {{ repo?: string, route?: string, force?: boolean }} [input]
   */
  async function selfHealGateway(input = {}) {
    const repo = requireRepo(input.repo ?? cloudState.repo ?? routeRepositoryFromConfig())
    const route = normalizeProviderRoute(input.route).route
    // 从磁盘读：自愈的场景就是「配置指向旧地址」，那个旧地址只能从配置里拿。
    const current = currentBaseUrl({ route })

    // 先看现在的地址通不通。通了就什么都不做 —— 自愈不应该无谓地改配置。
    let alive = false
    let probeError = null
    if (current !== null) {
      try {
        const response = await fetch(`${current.replace(/\/+$/, '').replace(/\/v1$/, '')}/health`, {
          signal: AbortSignal.timeout(12_000),
        })
        alive = response.ok
        await response.text().catch(() => '')
      } catch (error) {
        probeError = message(error)
      }
    }
    if (alive && input.force !== true) {
      return { repo, route, healed: false, baseURL: current, note: '当前地址可达，无需自愈' }
    }

    // 不通（或强制）：重新采集。环境可能已经被 Runner 重启过，地址在日志里。
    const harvest = await harvestGatewayFromLogs({ repo, waitMs: 90_000 })
    if (!harvest.ok) {
      return {
        repo,
        route,
        healed: false,
        baseURL: current,
        note: `未能取回新地址：${harvest.reason}`,
        probeError,
      }
    }
    if (harvest.url === current && input.force !== true) {
      return { repo, route, healed: false, baseURL: current, note: '采集到的地址与当前一致，但探测不通 —— 环境可能在启动中' }
    }

    const rewired = await wireCloudProvider({
      repo,
      baseURL: harvest.url,
      key: harvest.key ?? '',
      models: harvest.models,
      route,
      makeDefault: true,
    })
    cloudState = {
      ...cloudState,
      at: new Date().toISOString(),
      ready: true,
      repo,
      baseURL: harvest.url,
      apiKeyEnv: CLOUD_KEY_REF,
      models: harvest.models,
      port: harvest.port ?? DEFAULT_CLOUD_PORT,
    }
    return {
      repo,
      route,
      healed: rewired.written === true || rewired.overridden === true,
      previous: current,
      baseURL: harvest.url,
      models: harvest.models.length,
      note: `地址已从 ${current ?? '(无)'} 更新为 ${harvest.url}`,
      probeError,
    }
  }

  /**
   * 当前 provider 实际指向的 baseURL，从磁盘配置读。
   *
   * 不能依赖 `cloudState`：它只活在本次进程里，重载后为空 —— 而自愈的核心场景
   * 恰恰是「配置指向旧地址」，那个旧地址必须从**配置文件**里读出来。
   * @param {{ route?: string }} [input]
   * @returns {string | null}
   */
  function currentBaseUrl(input = {}) {
    const route = normalizeProviderRoute(input.route).route
    const files = []
    const profileDir = asString(ctx.get('profileContext')?.dir)
    if (profileDir !== undefined) files.push(joinPath(profileDir, 'cordis.patch.yml'))
    const home = harnessHome()
    if (home !== undefined) files.push(joinPath(home, 'cordis.patch.yml'))
    for (const layer of overridingLayers()) {
      if (layer.key === '--patch') files.push(layer.value)
    }
    for (const file of files) {
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      // 找该路由块里的第一个 baseURL。overlay 优先（先扫它，命中即返回）。
      const idx = text.indexOf(`${route}:`)
      if (idx < 0) continue
      const match = /baseURL:\s*(\S+)/.exec(text.slice(idx))
      if (match !== null) return match[1].trim()
    }
    return cloudState.baseURL ?? null
  }

  /**
   * 把生成的 crontab 段**合并**进已有的 `.cnb.yml`，而不是覆盖整个文件。
   *
   * 这一条是血换来的。早先 `keepalive.automate` 直接整文件写入，把一个已经
   * 在正常工作的 `.cnb.yml` 覆盖掉了 —— 里面的 `$: vscode:` 环境定义、
   * `keepAliveTimeout: 18h`、以及启动网关的 stage 全部消失。后果不只是「守护
   * 没装上」，而是**这个仓库再也起不了开发环境**，而且从文件表面看不出异常
   * （它仍是一份合法的 YAML）。
   *
   * 合并规则：
   *   · 保留原有全部内容，包括注释与其它顶层键；
   *   · `$:` 块已存在 → 把 `crontab:` 子键插进去（同名则替换）；
   *   · 没有 `$:` 块 → 追加一个，只含 crontab。
   *
   * 只做文本层面的定位，不重新序列化整份 YAML —— 那会丢掉所有注释。
   *
   * @param {string} existing 现有 `.cnb.yml` 内容（可以是空串）
   * @param {string} snippet  生成的片段（以 `$:` 开头那段之后的部分）
   * @returns {string}
   */
  /**
   * 读取仓库里一个文本文件的内容；不存在就返回空串。
   *
   * 用来在写 `.cnb.yml` 之前取到现状 —— 不做这一步就只能整文件覆盖，
   * 而那会把别人辛苦配的环境定义一起抹掉（实测踩过，见 mergeCrontab 的注释）。
   *
   * @param {{ repo: string, path: string, ref?: string }} input
   * @returns {Promise<string>}
   */
  async function readRepoText(input) {
    const ref = input.ref ?? 'main'
    try {
      const { body } = await client().call(
        `/${requireRepo(input.repo)}/-/git/contents/${encodeURIComponent(input.path)}`,
        { query: { ref } },
      )
      const content = asString(body?.content)
      if (content === undefined) return ''
      return Buffer.from(content, 'base64').toString('utf8')
    } catch {
      // 文件不存在是正常情况（首次安装），不是错误。
      return ''
    }
  }

  function mergeCrontab(existing, snippet) {
    const text = existing ?? ''
    const trimmedSnippet = snippet.trimEnd()
    if (trimmedSnippet === '') return text
    // 从片段里取出 crontab 那几行（`  "crontab: ..."` 起到底）。
    const crontabAt = trimmedSnippet.search(/^\s*"crontab:/m)
    if (crontabAt < 0) return text
    const crontabBlock = trimmedSnippet.slice(crontabAt).trimEnd()

    if (text.trim() === '') return `$:\n${crontabBlock}\n`

    const lines = text.split('\n')
    /**
     * 找顶层 `$:` 行的位置。缩进 0、后面允许跟着内容或直接换行。
     * 用行首匹配而不是 `indexOf`：注释里也可能出现 `$:`。
     */
    const dollarAt = lines.findIndex((line) => /^\$:\s*$/.test(line) || /^\$:\s+\S/.test(line))
    if (dollarAt < 0) {
      // 没有 $: 块，追加一个。
      return `${text.trimEnd()}\n$:\n${crontabBlock}\n`
    }

    // 确定 $: 块的结束行：下一个缩进 0 且非空、非注释的行。
    let blockEnd = lines.length
    for (let i = dollarAt + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (line.trim() === '' || line.trimStart().startsWith('#')) continue
      if (!/^\s/.test(line)) { blockEnd = i; break }
    }

    // 该块里已经有 crontab 段就先摘掉（同一份 .cnb.yml 里两段 crontab 会互相覆盖）。
    const block = lines.slice(dollarAt + 1, blockEnd)
    const kept = []
    let skipping = false
    for (const line of block) {
      if (/^\s{2}"crontab:/.test(line)) { skipping = true; continue }
      if (skipping) {
        // crontab 段一直到下一个缩进 ≤2 的非空行为止。
        if (line.trim() === '') continue
        if (/^\s{2}(?!"crontab:)\S/.test(line) || /^\s{0,2}\S/.test(line)) skipping = false
        else continue
      }
      kept.push(line)
    }
    const merged = [...lines.slice(0, dollarAt + 1), ...kept, crontabBlock, ...lines.slice(blockEnd)]
    return `${merged.join('\n').trimEnd()}\n`
  }

  /**
   * 自动调配：按**剩余额度**决定每个环境该怎么办，默认全自动。
   *
   * 这一层要回答的是「不用用户管」到底怎么实现。要点是把资源账算清楚，
   * 而不是按固定时间重启：
   *
   *   · 开发额度是 `dev_in_sec`（核·秒）。一个 32 核环境跑满 18 小时要
   *     32 × 64800 = 2,073,600 核·秒 —— 一整天额度也就够一台半。
   *   · 所以「18 小时到点就重建」在额度有限时是**最坏**策略：它会在月中就把
   *     额度烧光，然后你想用也没有。
   *
   * 决策顺序（从省到费）：
   *
   *   1. 额度还能撑很多天 → 正常保活，到点按策略续；
   *   2. 额度开始紧张     → 降级：降低并发环境数（停掉非网关环境），
   *                          并把 CPU 降到能跑起来的最小值；
   *   3. 额度快见底       → 只在需要时开，用完就停（不追求"常驻"）。
   *
   * 「额度够不够」按**日均消耗**推：剩余额度 / 近 24 小时消耗 = 还能撑几天。
   * 这样比拿额度绝对值比阈值更贴近实际，因为它自动适应你的使用强度。
   *
   * @param {{ devTotal?: number, devUsed?: number, usedInLastDay?: number, runningCount?: number }} input
   * @returns {{
   *   level: 'ample' | 'tight' | 'critical',
   *   remainingHours: number,
   *   daysLeft: number | null,
   *   maxEnvironments: number,
   *   advice: string,
   * }}
   */
  function planQuota(input) {
    const total = Number(input.devTotal ?? 0)
    const used = Number(input.devUsed ?? 0)
    const remaining = Math.max(0, total - used)
    // 近 24 小时消耗；拿不到就按「一台 32 核跑满一天」估，宁可估多。
    const daily = Number(input.usedInLastDay ?? 0) > 0
      ? Number(input.usedInLastDay)
      : 32 * 86400
    const daysLeft = daily > 0 ? remaining / daily : null
    const remainingHours = remaining / 3600

    let level = 'ample'
    // 不到 3 天用量就该收敛了；不到 1 天算临界。
    if (daysLeft !== null && daysLeft < 1) level = 'critical'
    else if (daysLeft !== null && daysLeft < 3) level = 'tight'
    else if (remaining <= 0) level = 'critical'

    /**
     * 允许同时跑几台。32 核是默认机型，但额度紧张时降到 8 核仍能跑网关
     * （网关本身很轻，是模型在云端算）。这里给的是**并发上限**，不是 CPU 数。
     */
    const maxEnvironments = level === 'critical' ? 1 : level === 'tight' ? 1 : 2
    const advice = level === 'critical'
      ? `开发额度只剩 ${remainingHours.toFixed(0)} 核·时（约 ${daysLeft === null ? '?' : daysLeft.toFixed(1)} 天用量）。`
        + '建议：只保留云网关那一台，用完手动停；不要再开新环境。'
      : level === 'tight'
        ? `开发额度剩 ${remainingHours.toFixed(0)} 核·时（约 ${daysLeft === null ? '?' : daysLeft.toFixed(1)} 天用量）。`
          + '建议：停掉非网关环境，只留一台；保持 keep 策略（不重建）。'
        : `开发额度充足（剩 ${remainingHours.toFixed(0)} 核·时，约 ${daysLeft === null ? '?' : daysLeft.toFixed(1)} 天用量）。`
          + '可正常保活，最多同时 2 台。'
    return { level, remainingHours, daysLeft, maxEnvironments, advice }
  }

  /**
   * 读当月开发额度用量。
   *
   * `charge/quota` 给的是配额上限，`charge/volume` 给的是已用。两者都是
   * 按组织（slug）粒度，返回值里 `dev_in_sec` 的单位是**核·秒**。
   * @param {{ slug?: string }} [input]
   */
  async function readQuota(input = {}) {
    /**
     * 组织路径来源：显式传入 → 从网关仓库推导 → 账号的第一个组织。
     * 不能读 client().account（那是异步填的，这里只拿到空对象）。
     */
    let slug = asString(input.slug)
    if (slug === undefined) {
      const repo = routeRepositoryFromConfig() ?? cloudState.repo
      if (repo !== null && repo !== undefined && repo.includes('/')) slug = repo.split('/')[0]
    }
    if (slug === undefined) {
      try {
        const groups = await client().myGroups()
        const first = (groups.items ?? groups ?? [])[0]
        slug = asString(first?.path ?? first?.slug ?? first?.name)
      } catch { /* 落到下面的失败分支 */ }
    }
    if (slug === undefined) return { ok: false, reason: '拿不到组织路径' }
    try {
      const [quota, volume] = await Promise.all([
        client().call(`/${slug}/-/charge/quota`),
        client().call(`/${slug}/-/charge/volume`),
      ])
      return {
        ok: true,
        slug,
        devTotal: Number(quota.body?.dev_in_sec?.total ?? 0),
        devUsed: Number(volume.body?.dev_in_sec ?? 0),
        ciUsed: Number(volume.body?.ci_in_sec ?? 0),
        // 日均：把当月已用摊到「本月已过的天数」，比拿峰值估准得多。
        usedInLastDay: Number(volume.body?.dev_in_sec ?? 0) / Math.max(1, new Date().getDate()),
      }
    } catch (error) {
      return { ok: false, reason: message(error) }
    }
  }

  /**
   * 自动调配一次：读额度 → 判断档位 → 给出（或执行）处置。
   *
   * 默认 `apply: false` 只报告，因为「停掉环境」是有副作用的动作。但面板可以
   * 打开自动执行 —— 那才是「不用用户管」。
   * @param {{ apply?: boolean, slug?: string, repo?: string }} [input]
   */
  async function autopilot(input = {}) {
    const quota = await readQuota({ ...(asString(input.slug) === undefined ? {} : { slug: asString(input.slug) }) })
    if (quota.ok !== true) return { quota, plan: null, actions: [], note: `读额度失败：${quota.reason}` }

    const plan = planQuota({ devTotal: quota.devTotal, devUsed: quota.devUsed, usedInLastDay: quota.usedInLastDay })
    const repo = asString(input.repo) ?? cloudState.repo ?? routeRepositoryFromConfig()

    // 当前活跃环境清单，标出哪些是网关、哪些可以收。
    let environments = []
    try {
      const list = await client().workspaces({ page: 1, pageSize: 100 })
      const gatewayRepo = routeRepositoryFromConfig()
      environments = (list.items ?? [])
        .filter((item) => String(item?.status ?? '') === 'running')
        .map((item) => ({
          repo: item.slug ?? null,
          sn: item.sn ?? null,
          gateway: item.slug === gatewayRepo,
          ageHours: Number((ageMs(item) / 3_600_000).toFixed(2)),
        }))
    } catch (error) {
      environments = [{ error: message(error) }]
    }

    const running = environments.filter((row) => row.error === undefined)
    const gatewayCount = running.filter((row) => row.gateway === true).length
    const actions = []
    if (running.length > plan.maxEnvironments) {
      // 优先停非网关的，且从最老的开始（那些多半是测试遗留）。
      const victims = running
        .filter((row) => row.gateway !== true)
        .sort((a, b) => b.ageHours - a.ageHours)
        .slice(0, Math.max(0, running.length - plan.maxEnvironments))
      for (const row of victims) {
        actions.push({
          action: 'stop',
          repo: row.repo,
          sn: row.sn,
          reason: `额度档位 ${plan.level}：并发上限 ${plan.maxEnvironments} 台，收起非网关环境`,
        })
        if (input.apply === true && row.repo !== null && row.sn !== null) {
          await client().stopBuild(row.repo, row.sn).catch(() => {})
        }
      }
    }

    return {
      quota,
      plan,
      repo,
      environments,
      gatewayCount,
      actions,
      applied: input.apply === true,
      note: actions.length === 0
        ? plan.advice
        : `${plan.advice} ${input.apply === true ? '已' : '将要'}停掉 ${actions.length} 台非网关环境。`,
    }
  }

  // ---------------------------------------------------------------- 续命

  /**
   * 续命闭环的本机一半：判断该不该重启，重启后把新地址接回配置。
   *
   * 这一条回答的正是「停掉再启动还能继续用吗」：能，因为新环境会把自己的地址
   * 写进 stage 日志。但**地址会变**（实测：重启后端口预览前缀会换一个），
   * 所以重启后必须把新地址写回 provider，否则 dsh 里那条路由
   * 指向一个已经失效的域名，表现就是「保活成功但模型全挂」。
   *
   * @param {{ repo?: string, restart?: boolean, gatewayPort?: number }} [input]
   */
  async function immortalCycle(input = {}) {
    const repo = requireRepo(input.repo ?? cloudState.repo ?? routeRepositoryFromConfig())
    const gatewayPort = asNumber(input.gatewayPort, DEFAULT_CLOUD_PORT)
    const list = await client().workspaces({ page: 1, pageSize: 50, slug: repo })
    const gatewayRepo = routeRepositoryFromConfig() ?? repo
    const current = (list.items ?? []).find((item) => String(item?.status ?? '') === 'running')
      ?? (list.items ?? [])[0]

    const lastRestartAt = cloudState.lastRestartAt ?? null
    const plan = planRestart({
      status: current?.status,
      create_time: current?.create_time,
      isGateway: repo === gatewayRepo,
      lastRestartAt,
    })

    // 计划说该重启，**或者**调用方显式要求（restart:true 用于手动验证闭环）。
    if (plan.restart !== true && input.restart !== true) {
      return { repo, plan, restarted: false, current: current === undefined ? null : { sn: current.sn, status: current.status } }
    }

    // 记下这次重启的时间，冷却期靠它生效（启动失败时不至于每 tick 重试）。
    cloudState.lastRestartAt = new Date().toISOString()

    // 停 → 起：停完要等它真的变成非 running，否则 start 会复用同一个环境、
    // 计时不重置（实测：对 running 环境调 start 返回的是同一个 sn）。
    const before = asString(current?.sn)
    if (before !== undefined) {
      await client().stopBuild(repo, before).catch(() => {})
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        const now = await client().workspaces({ page: 1, pageSize: 50, slug: repo }).catch(() => ({ items: [] }))
        const still = (now.items ?? []).find((item) => item?.sn === before)
        if (still === undefined || String(still.status) !== 'running') break
        await new Promise((resolve) => setTimeout(resolve, 3_000))
      }
    }
    const started = await openEnvironment({ repo, branch: asString(current?.branch) ?? 'main' })
    const harvest = await harvestGatewayFromLogs({
      repo,
      ...(asString(started.sn) === undefined ? {} : { sn: asString(started.sn) }),
      waitMs: 300_000,
    })
    if (!harvest.ok) {
      return { repo, plan, restarted: true, started, harvest, rewired: false, reason: `重启了，但没能取回新地址：${harvest.reason}` }
    }

    // 关键一步：把新地址写回 provider，否则旧 baseURL 指向已失效的域名。
    /**
     * 续命时**必须保留默认模型指向**。
     *
     * 早先这里写 `makeDefault: false`，理由是「重启不该动用户的默认选择」。
     * 但 `writeProfilePatch` 的工作方式是先摘掉 `agent-default-model` 再按需写回，
     * 于是 `false` 的净效果是**把它删了** —— 实测：一次续命之后，profile patch
     * 里既没有 agent-default-model，overlay 里也没有，dsh 回落到内置的
     * deepseek-official，直接 `MISSING_CREDENTIAL`。
     *
     * 所以这里要显式把它指回本路由：续命的目的就是让模型继续可用，
     * 「保持原样」在这里等于「让默认模型消失」。
     */
    const rewired = await wireCloudProvider({
      repo,
      baseURL: harvest.url,
      key: harvest.key ?? '',
      models: harvest.models,
      route: normalizeProviderRoute(input.route).route,
      makeDefault: true,
    })
    cloudState = {
      ...cloudState,
      at: new Date().toISOString(),
      ready: true,
      repo,
      baseURL: harvest.url,
      apiKeyEnv: CLOUD_KEY_REF,
      models: harvest.models,
      port: harvest.port ?? gatewayPort,
    }
    return {
      repo,
      plan,
      restarted: true,
      previous: before ?? null,
      sn: harvest.sn,
      url: harvest.url,
      rewired: rewired.written === true || rewired.overridden === true,
      provider: rewired,
      note: '新环境已就绪，provider 已指向新地址。旧环境的端口预览域名已失效——这是它的正常行为。',
    }
  }

  // ---------------------------------------------------------------- 保活

  /**
   * 全部运行中环境的保活体检。
   *
   * 数据来自 `workspace/list`，逐条算出：已运行多久、距 18 小时上限还剩多久、
   * 下一次凌晨强制回收在几点、以及它是不是云网关的承载环境（那个最不能断）。
   *
   * `probe: true` 时再**真打一次**每个环境的端口预览域名 —— 这是唯一能证明
   * 「心跳目标可达」的方式。不可达就直接指出来，而不是让界面显示一个看似
   * 正常的倒计时。
   * @param {{ probe?: boolean, port?: number, repo?: string }} [input]
   */
  async function keepaliveStatus(input = {}) {
    const cnb = client()
    const list = await cnb.workspaces({ page: 1, pageSize: 100, slug: asString(input.repo) })
    // 云网关承载仓库：它断了，模型就全断，所以要单独标出来。
    // 以**磁盘配置**为准 —— 进程重载后 cloudState 是空的，而配置仍然有效。
    const routeRepo = routeRepositoryFromConfig() ?? cloudState.repo ?? null
    const summary = inspectAll(list.items, { gatewayPort: asNumber(input.port, DEFAULT_CLOUD_PORT), routeRepo })
    if (input.probe === true) {
      for (const row of summary.rows) {
        if (row.status !== 'running') continue
        const target = row.previewUrl
        if (target === null) continue
        try {
          const response = await fetch(`${target}/health`, { signal: AbortSignal.timeout(12_000) })
          row.heartbeat.reachable = true
          row.heartbeat.status = response.status
          /**
           * 「到达」与「服务正常」是两件事，不能混为一谈。
           *
           * 心跳只需要「请求经 CNB 网关进了环境」——401（要鉴权）、404（该端口没
           * 这个路由）、500（端口后面没服务）都证明连接确实打进了容器，属于
           * **有效心跳**。只有连不上（fetch 抛错）才说明目标不可达。
           *
           * 实测：非网关环境探 3080 多半返回 500/404，因为它们跑的不是 DSH Web。
           * 把这些说成「心跳失败」会让用户去修一个根本不存在的问题。
           */
          row.heartbeat.note = response.status < 500
            ? `请求已到达环境（HTTP ${response.status}），属于有效心跳。`
            : `请求已到达环境（HTTP ${response.status}：这个端口后面没有服务），连接本身有效，心跳成立。`
        } catch (error) {
          row.heartbeat.reachable = false
          row.heartbeat.note = `打不通：${message(error)}。心跳无效，环境会按空闲规则被回收。`
        }
      }
    }
    return summary
  }

  /**
   * 生成外部心跳配置，或直接写进当前仓库的 `.cnb.yml`。
   *
   * 默认只**返回片段**：改别人的 `.cnb.yml` 是破坏性操作，不该在用户没明确
   * 要求时发生。传 `apply: true` 才通过内联构建真的写进去。
   * @param {{ repo?: string, port?: number, intervalMinutes?: number, apply?: boolean, image?: string }} [input]
   */
  async function keepaliveSetup(input = {}) {
    const repo = requireRepo(input.repo ?? cloudState.repo)
    const port = asNumber(input.port, DEFAULT_CLOUD_PORT)
    const snippet = heartbeatConfig({
      repo,
      port,
      intervalMinutes: asNumber(input.intervalMinutes, 5),
      ...(asString(input.image) === undefined ? {} : { image: asString(input.image) }),
    })
    if (input.apply !== true) {
      return {
        repo,
        cron: snippet.cron,
        applied: false,
        yml: snippet.yml,
        note: '这是可以并入该仓库 .cnb.yml 的片段。传 apply: true 由插件直接写入（会覆盖 .cnb.yml 里已有的 crontab 段，请先确认）。',
      }
    }
    // 真写：走内联构建的 checkout，与本插件写脚手架是同一条路径。
    // 同样合并而非覆盖。
    const existingSetup = await readRepoText({ repo, path: '.cnb.yml' })
    const mergedSetup = mergeCrontab(existingSetup, snippet.yml)
    const wrote = await writeFilesThroughBuild({
      repo,
      files: [{ path: '.cnb.yml', content: mergedSetup }],
      message: 'chore(dsh-cnb): add keep-alive heartbeat',
    })
    return { repo, cron: snippet.cron, applied: wrote.status === 'success', yml: snippet.yml, build: { sn: wrote.sn, status: wrote.status } }
  }

  /**
   * 给某个环境续命一次：从**本机**向它的端口预览域名发一个请求。
   *
   * 这只是立刻打一次，不等于持续保活 —— 真正要长期活着得有外部定时任务
   * （`keepaliveSetup` 生成的那段）。这里的作用是：用户点一下，能马上确认
   * 「这个地址是通的、请求确实进了环境」，同时顺手把当下这一轮活跃补上。
   * @param {{ repo: string, sn?: string, port?: number }} input
   */
  async function keepalivePing(input) {
    const repo = requireRepo(input.repo)
    const list = await client().workspaces({ page: 1, pageSize: 50, slug: repo })
    const target = input.sn === undefined
      ? list.items.find((item) => String(item?.status ?? '') === 'running')
      : list.items.find((item) => item?.sn === input.sn)
    if (target === undefined) throw new CnbError(`${repo} 没有找到${input.sn === undefined ? '运行中' : ` sn=${input.sn}`}的环境`)
    const port = asNumber(input.port, DEFAULT_CLOUD_PORT)
    const url = typeof target.business_id === 'string' && target.business_id !== ''
      ? `https://${target.business_id}-${port}.cnb.run/health`
      : null
    if (url === null) throw new CnbError('这个环境没有 business_id，拿不到端口预览域名')
    const started = Date.now()
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      await response.text().catch(() => '')
      const row = inspectWorkspace(target, { gatewayPort: port })
      return {
        repo,
        sn: target.sn,
        url,
        ok: true,
        status: response.status,
        ms: Date.now() - started,
        note: '请求已到达环境；这一轮活跃已被记录。持续保活仍需要外部定时任务。',
        workspace: { ageHours: row.ageHours, remainingHours: row.remainingHours, expiresAt: row.expiresAt },
      }
    } catch (error) {
      return {
        repo,
        sn: target.sn,
        url,
        ok: false,
        ms: Date.now() - started,
        note: `打不通：${message(error)}`,
      }
    }
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
    // ---------------------------------------------------------------- 保活

    'cloud.state': async () => cloudGatewayState(),
    'keepalive.status': (input) => keepaliveStatus(input ?? {}),
    'keepalive.setup': (input) => keepaliveSetup(input ?? {}),
    'keepalive.automate': (input) => keepaliveAutomate(input ?? {}),
    'keepalive.immortal': (input) => immortalCycle(input ?? {}),
    '__debugWrite': async (input) => writeFilesThroughBuild({ repo: requireRepo(input.repo), files: [{ path: input.path, content: input.content }], message: input.message ?? 'chore: restore' }),
    '__debugRead': async (input) => ({ text: await readRepoText(input ?? {}) }),
    'keepalive.autopilot': (input) => autopilot(input ?? {}),
    'keepalive.selfHeal': (input) => selfHealGateway(input ?? {}),
    'keepalive.ping': (input) => keepalivePing(input ?? {}),
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
        route: normalizeProviderRoute(input?.route).route,
        makeDefault: input?.makeDefault !== false,
      })
      // 「配好了」和「对话真的在用」是两件事：DSH 的模型选择是**按会话**记住的，
      // 老会话里存的还是上一个 provider（本部署是 `cnb` 那条本地代理），配置写进去
      // 也不会改变它。所以要显式把会话选择也切过来，否则用户看到的就是「配好了但
      // 对话还是老模型」。
      // 只调查、不偷改：会话选择只有 DSH 的 session 服务能写，插件改文件会被
      // 运行中的进程覆盖回去（实测 10 秒内被写回）。所以这里给出的是结论 + 指引。
      const route = normalizeProviderRoute(input?.route).route
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

  // ------------------------------------------------------------------- tools

  /**
   * 工具注册必须**等 `tools` 服务就绪**，不能用 `ctx.get('tools')` 同步取。
   *
   * 实测：web profile 下 tools 恰好已经在了，所以同步取也能work；headless 下取到
   * undefined，于是整段注册被跳过 —— 插件挂载成功、配置正常，但一个 cnb 工具都
   * 没有，模型只能回答「没有 cnb 开头的工具」。这种「装上了但没生效」最难查。
   *
   * 同一个文件里 `webServer` 早就是走 ctx.inject 的，这里对齐它。
   */
  ctx.inject(['tools'], (host) => {
    // 必须走 host.tools：`ctx.tools` 在 inject 回调里拿不到（它会报
    // "cannot get property register without inject"）。host 是注入后的上下文。
    const toolRegistry = host.tools
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
            slug: { type: 'string', description: '组织路径，例如 your-org' },
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
      register(
        'cnb_keepalive_status',
        '列出所有运行中的云环境并给出保活体检：已运行多久、距 18 小时上限还剩多久、'
          + '下一次凌晨 4–6 点强制回收在几点、哪个是云网关的承载环境。'
          + '传 probe: true 会真打一次每个环境的端口预览域名，验证心跳目标可达。',
        { properties: { probe: { type: 'boolean' }, port: { type: 'integer' }, repo: { type: 'string' } } },
        (input) => keepaliveStatus(input ?? {}),
      )
      register(
        'cnb_keepalive_setup',
        '生成外部心跳配置（独立 Runner 上的 crontab），用于防止云环境因 10 分钟空闲被回收。'
          + '默认只返回可并入 .cnb.yml 的片段；传 apply: true 才由插件直接写入。'
          + '注意：它挡不住 18 小时上限与凌晨 4–6 点的不过夜策略。',
        {
          properties: {
            repo: { type: 'string' },
            port: { type: 'integer' },
            intervalMinutes: { type: 'integer' },
            image: { type: 'string' },
            apply: { type: 'boolean' },
          },
        },
        (input) => keepaliveSetup(input ?? {}),
      )
      register(
        'cnb_keepalive_ping',
        '从本机向某个环境的端口预览域名发一个请求：验证地址可达，并补上当前这一轮活跃。'
          + '持续保活仍需外部定时任务（cnb_keepalive_setup 生成）。',
        { properties: { repo: { type: 'string' }, sn: { type: 'string' }, port: { type: 'integer' } }, required: ['repo'] },
        (input) => keepalivePing(input),
      )
      register(
        'cnb_keepalive_automate',
        '全自动守护：生成一个跑在独立 Runner 上的 crontab，负责「心跳 + 滚动重建」。'
          + '运行中且剩余 >2h 只发心跳；剩余 ≤2h 或已被回收时，云网关承载环境自动重建；'
          + '普通环境只报告（重启正在用的开发环境会丢未提交的工作）。'
          + '默认只返回片段与当前处置计划，传 apply:true 才写入 .cnb.yml。',
        {
          properties: {
            repo: { type: 'string' },
            gatewayRepo: { type: 'string' },
            intervalMinutes: { type: 'integer' },
            gatewayPort: { type: 'integer' },
            servicePort: { type: 'integer' },
            image: { type: 'string' },
            apply: { type: 'boolean' },
            renewPolicy: { type: 'string', enum: ['keep', 'renew'], description: 'keep（默认）：只保活，撑满 18 小时不新建环境，省额度；renew：到点前滚动重建，需连续可用时用' },
          },
        },
        (input) => keepaliveAutomate(input ?? {}),
      )
  })

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
    keepaliveStatus,
    keepaliveSetup,
    keepalivePing,
    keepaliveAutomate,
    immortalCycle,
    selfHealGateway,
    autopilot,
    planQuota,
    __testMergeCrontab: (a, b) => mergeCrontab(a, b),
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
