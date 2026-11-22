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
import { CnbApi, CnbError, DEFAULT_TOKEN_SCOPES, LoginAttempt, message } from './cnb-client.js'
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
    if (token === '') return undefined
    return {
      token,
      user: payload.user,
      description: payload.description,
      expiredAt: payload.expiredAt,
      loginAt: payload.loginAt,
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
    await credentials.modifyRecord(`${CREDENTIAL_SCOPE}/${CREDENTIAL_ID}`, async () => {
      if (payload === undefined) return undefined
      return { kind: 'grant', payload }
    })
    if (payload === undefined) await credentials.unset(GATEWAY_KEY_REF)
    else await credentials.set(GATEWAY_KEY_REF, String(payload.token))
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
    api ??= new CnbApi({ token: currentToken, api: apiOrigin, timeoutMs: requestTimeoutMs })
    return api
  }

  // ------------------------------------------------------------------- session

  async function status() {
    const record = await readRecord()
    let user = identity
    if (record !== undefined && user === null) {
      try {
        user = await client().me()
        identity = user
      } catch (error) {
        if (error instanceof CnbError && (error.status === 401 || error.status === 403)) {
          user = null
        } else {
          user = null
        }
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
          },
      pending: attempt !== null && !attempt.closed ? attempt.describe() : null,
      ambientToken: record === undefined && Boolean(process.env.CNB_TOKEN),
      plugin: { webOrigin, apiOrigin, requestTimeoutMs },
    }
  }

  async function beginLogin() {
    if (attempt !== null && !attempt.closed && Date.now() - attempt.createdAt < 240_000) {
      return attempt.describe()
    }
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
    const minted = await attempt.createAccessToken({
      description: 'dsh-cnb plugin',
      scope: DEFAULT_TOKEN_SCOPES,
    })
    const probe = new CnbApi({ token: async () => minted.token, api: apiOrigin, timeoutMs: requestTimeoutMs })
    const user = await probe.me().catch(() => undefined)
    const payload = {
      token: minted.token,
      description: minted.description,
      expiredAt: minted.expiredAt ?? null,
      loginAt: new Date().toISOString(),
      user: user ?? { nickname: result.nickName ?? '' },
      scope: minted.scope,
    }
    await writeRecord(payload)
    identity = user ?? null
    return { state: 'confirmed', login: summarizeLogin(payload) }
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
   * @param {{ token: string, baseURL?: string }} input
   */
  async function importToken(input) {
    const token = asString(input.token)
    if (token === undefined) throw new CnbError('令牌不能为空')
    const probe = new CnbApi({ token: async () => token, api: apiOrigin, timeoutMs: requestTimeoutMs })
    const user = await probe.me()
    const payload = {
      token,
      description: 'dsh-cnb plugin (imported)',
      expiredAt: null,
      loginAt: new Date().toISOString(),
      user,
    }
    await writeRecord(payload)
    identity = user
    return { login: summarizeLogin(payload) }
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
    const defaultBranch = info?.default_branch ?? undefined
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

  /** @param {{ repo: string }} input */
  async function createRepository(input) {
    const slug = requireSlug(input.slug ?? input.org, '组织')
    const repoName = requireRepoName(input.name)
    const created = await client().createRepo(slug, {
      name: repoName,
      visibility: asString(input.visibility) ?? 'private',
      description: asString(input.description) ?? '',
    })
    return { repository: created, slug: `${slug}/${repoName}` }
  }

  /** @param {{ repo: string }} input */
  async function deleteRepository(input) {
    const repo = requireRepo(input.repo)
    if (input.confirm !== true) throw new CnbError(`删除 ${repo} 需要显式确认（confirm: true）`)
    await client().deleteRepo(repo)
    return { deleted: repo }
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
  async function openEnvironment(input) {
    const repo = requireRepo(input.repo)
    const branch = asString(input.branch)
    const started = await client().startWorkspace(repo, branch === undefined ? {} : { branch })
    return {
      repo,
      sn: started?.sn ?? null,
      url: started?.url ?? null,
      message: started?.message ?? null,
      buildLogUrl: started?.buildLogUrl ?? null,
      state: started?.sn === undefined ? 'running' : 'starting',
    }
  }

  /** @param {{ repo: string, sn: string }} input */
  async function environmentDetail(input) {
    const repo = requireRepo(input.repo)
    const sn = asString(input.sn)
    if (sn === undefined) throw new CnbError('缺少环境 sn')
    const detail = await client().workspaceDetail(repo, sn)
    return { repo, sn, detail }
  }

  /** @param {{ sn?: string, pipelineId?: string }} input */
  async function closeEnvironment(input) {
    const body = identityOfWorkspace(input)
    const result = await client().stopWorkspace(body)
    return { action: 'stop', ...body, result }
  }

  /** @param {{ sn?: string, pipelineId?: string }} input */
  async function removeEnvironment(input) {
    const body = identityOfWorkspace(input)
    const result = await client().deleteWorkspace(body)
    return { action: 'delete', ...body, result }
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
    return handler(input)
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
      '停止或删除一个云原生开发环境。action=stop 关闭，action=delete 彻底删除。',
      {
        properties: {
          action: { type: 'string', enum: ['stop', 'delete'] },
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
    requestId: randomUUID(),
  }
}

export default { name, apply }
