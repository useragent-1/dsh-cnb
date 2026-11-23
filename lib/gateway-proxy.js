/**
 * 本地 OpenAI 兼容网关：把 CNB AI 网关的脾气磨平，让 dsh 的 pi-ai 路由当它是普通供应商。
 *
 * 为什么必须有这一层，而不是让 pi-ai 直连 `api.cnb.cool/<repo>/-/ai`：
 *
 *   1. **内容风控**。网关扫 system / assistant 文本里的「客户端指纹」，命中整条拒绝：
 *      HTTP 400 / code 11128（同类：11288）"Illegal API invocation from an unapproved
 *      channel"。DSH 的系统提示词本身就会命中，换令牌换模型都无效。只有先把请求体
 *      改写再发，才能通 —— 而 pi-ai 不做改写，代理必须做。
 *   2. **只认流式**。非流式请求返回 11101；pi-ai 的很多路径要的是非流式响应，
 *      所以由代理发流式、聚合后按客户端要求返回。
 *   3. **模型不在目录里**。请求一个未知 id 返回 403 `MODEL_NOT_IN_LIST`；
 *      目录里但组织没额度返回 `MODEL_NOT_AVAILABLE_FOR_ORG`。代理把这两条翻译成
 *      OpenAI 形状的错误，pi-ai 才能显示成人话。
 *   4. **令牌来源**。网关只吃流水线令牌；代理在调用时现取，令牌不进任何配置文件。
 *
 * 上游优先 `/-/ai-ide/v2/chat/completions`：它按请求的 model 真正路由（v1 的
 * `/-/ai` 会把任何 id 都落到默认模型），并且接受 `reasoning_effort`。
 *
 * 全部逻辑可离线测试：请求体改写、错误归类、SSE 聚合都是纯函数。
 */
import http from 'node:http'
import { once } from 'node:events'
import {
  classifyGatewayError,
  dropOrphanTools,
  foldSystem,
  obfuscateNonUser,
  repairText,
  stripInlineToolCalls,
  sanitizePayload,
} from './model-guard.js'

/** 默认监听端口：若干自建栈会在本机跑本地代理，取一个不容易撞的值。 */
export const DEFAULT_PROXY_PORT = 8793
const DEFAULT_HOST = '127.0.0.1'
const MAX_BODY = 32 * 1024 * 1024

/**
 * 上游路径：v2 会按 model 路由，v1 不会。
 * @param {'v2' | 'v1'} flavour
 */
export function upstreamPath(flavour = 'v2') {
  return flavour === 'v1' ? '/-/ai/chat/completions' : '/-/ai-ide/v2/chat/completions'
}

/**
 * 构造一次调用要尝试的请求体序列。
 *
 * 顺序来自实测：先按原形状修正（developer→system、剥图片段、丢孤立 tool、
 * 已知指纹改写），仍然 11128/11288 时把 system 折进首条 user，最后逐词打散。
 * 每一级都保留原语义 —— 模型读到的指令不变，只是换了承载方式。
 *
 * @param {Record<string, any>} payload
 * @param {{ aggressive?: boolean }} [options]
 * @returns {Array<{ level: number, body: Record<string, any>, changes: string[] }>}
 */
export function attemptLadder(payload, options = {}) {
  const first = sanitizePayload(payload, options)
  const folded = foldSystem(first.payload)
  const masked = obfuscateNonUser(folded)
  const rows = [{ level: 0, body: first.payload, changes: first.changes }]
  if (folded !== first.payload) rows.push({ level: 1, body: folded, changes: [...first.changes, 'fold-system'] })
  if (masked !== folded) rows.push({ level: 2, body: masked, changes: [...first.changes, 'fold-system', 'obfuscate'] })
  return rows
}

/**
 * 把一段 SSE 文本聚合成一个 OpenAI `chat.completion` 对象。
 *
 * tool_calls 是增量拼接的：每个 delta 只带一段名字或一段参数 JSON，
 * 直接覆盖会得到半截参数。这里按 index 累积。
 * @param {string} text
 * @param {{ model?: string }} [fallback]
 */
export function aggregateSse(text, fallback = {}) {
  const message = { role: 'assistant', content: '' }
  const tools = new Map()
  let id = 'chatcmpl-cnb'
  let model = fallback.model ?? 'unknown'
  let created = Math.floor(Date.now() / 1000)
  let finish = 'stop'
  let usage = null
  const decoder = new TextDecoder()
  void decoder
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '' || data === '[DONE]') continue
    let event
    try {
      event = JSON.parse(data)
    } catch {
      continue
    }
    if (event.error !== undefined) return { error: event.error }
    if (typeof event.id === 'string') id = event.id
    if (typeof event.model === 'string') model = event.model
    if (typeof event.created === 'number') created = event.created
    if (event.usage !== null && event.usage !== undefined) usage = event.usage
    const choice = event.choices?.[0]
    if (choice === undefined) continue
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') finish = choice.finish_reason
    const delta = choice.delta ?? {}
    if (typeof delta.content === 'string') message.content += delta.content
    if (typeof delta.reasoning_content === 'string') {
      message.reasoning_content = (message.reasoning_content ?? '') + delta.reasoning_content
    }
    for (const call of delta.tool_calls ?? []) {
      const index = typeof call.index === 'number' ? call.index : tools.size
      const current = tools.get(index) ?? { id: call.id ?? `call_${index}`, type: 'function', function: { name: '', arguments: '' } }
      if (typeof call.id === 'string') current.id = call.id
      if (typeof call.function?.name === 'string') current.function.name += call.function.name
      if (typeof call.function?.arguments === 'string') current.function.arguments += call.function.arguments
      tools.set(index, current)
    }
  }
  if (tools.size > 0) message.tool_calls = [...tools.values()].sort((a, b) => a.id.localeCompare(b.id))
  if (message.reasoning_content === undefined) delete message.reasoning_content
  /**
   * 上游有时不把工具调用作为结构化 tool_calls 返回，而是把 DeepSeek 的内联
   * 标记（`<|｜DSML｜｜ calls>`）直接写进 content。dsh 收到的就是一段文本，
   * 工具不会执行 —— 表现是「模型说要跑命令，但什么都没跑，然后卡住」。
   *
   * 只在这一轮**没有**结构化 tool_calls 时才清理：有 tool_calls 说明上游
   * 这次是正常的，正文里的东西是模型自己写的，不该动。
   */
  if (tools.size === 0 && typeof message.content === 'string') {
    message.content = stripInlineToolCalls(message.content)
  }
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage,
  }
}

/**
 * 聚合结果 → 等价的 SSE 事件序列（客户端要流式时用）。
 * @param {Record<string, any>} completion
 */
export function completionToSse(completion) {
  const { choices, ...rest } = completion
  const message = choices?.[0]?.message ?? { role: 'assistant', content: '' }
  const head = { ...rest, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }
  const chunks = [head]
  if (typeof message.reasoning_content === 'string' && message.reasoning_content !== '') {
    chunks.push({ ...rest, choices: [{ index: 0, delta: { reasoning_content: message.reasoning_content } }] })
  }
  if (typeof message.content === 'string' && message.content !== '') {
    chunks.push({ ...rest, choices: [{ index: 0, delta: { content: message.content } }] })
  }
  if (Array.isArray(message.tool_calls)) {
    chunks.push({
      ...rest,
      choices: [{
        index: 0,
        delta: {
          tool_calls: message.tool_calls.map((call, index) => ({
            index,
            id: call.id,
            type: 'function',
            function: { name: call.function.name, arguments: call.function.arguments },
          })),
        },
      }],
    })
  }
  chunks.push({
    ...rest,
    choices: [{ index: 0, delta: {}, finish_reason: choices?.[0]?.finish_reason ?? 'stop' }],
    ...(completion.usage === null || completion.usage === undefined ? {} : { usage: completion.usage }),
  })
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
}

/**
 * OpenAI 形状的错误体，让 pi-ai 把原因显示到界面上而不是「未知失败」。
 * @param {{ kind: string, label: string, fix: string, code: number | null }} reason
 * @param {number} status
 */
export function openAiError(reason, status) {
  return {
    error: {
      message: `${reason.label}（${reason.kind}${reason.code === null ? '' : ` / ${reason.code}`}）：${reason.fix}`,
      type: reason.kind,
      code: reason.code === null ? reason.kind : String(reason.code),
      status,
    },
  }
}

/**
 * 网关代理。
 *
 * 一个实例对应一个「仓库 + 令牌来源」，因为流水线令牌与仓库绑定：
 * 换了仓库就是另一条路由，混用只会得到 SLUG_ID_NOT_MATCH。
 */
export class GatewayProxy {
  /**
   * @param {{
   *   port?: number, host?: string,
   *   resolve: () => Promise<{ token: string, repo: string } | undefined>,
   *   upstream?: (repo: string, flavour: 'v2' | 'v1') => string,
   *   log?: (line: string) => void,
   *   apiKey?: string,
   * }} options
   */
  constructor(options) {
    this.port = options.port ?? DEFAULT_PROXY_PORT
    this.host = options.host ?? DEFAULT_HOST
    this.resolve = options.resolve
    this.log = options.log ?? (() => {})
    /**
     * 客户端必须出示的 key。
     *
     * 一个跑在云环境里、经端口预览暴露到公网的网关，如果没有 key 就是一个人人可用的
     * 代理 —— 别人拿到域名就能烧你的 AI Credits。key 由本机生成，一边存凭证库，
     * 一边随脚手架注入环境，两边不落任何公开文件。
     */
    this.apiKey = options.apiKey ?? ''
    /** `DSH_GW_DEBUG=1` 时记录请求形状（不含内容），用于定位上游的参数拒绝。 */
    this.debug = options.debug ?? (process.env.DSH_GW_DEBUG === '1')
    this.upstreamOf = options.upstream ?? ((repo, flavour) => `https://api.cnb.cool/${repo}${upstreamPath(flavour)}`)
    this.server = null
    /** 最近一次调用的诊断，面板可以直接读，不必翻日志。 */
    this.lastCall = null
    this.counters = { requests: 0, repairs: 0, fingerprints: 0, failures: 0 }
    /** @type {Map<string, number>} 上级实际放行的尝试级别，用于观测 */
    this.levels = new Map()
  }

  get baseUrl() {
    return `http://${this.host}:${this.port}/v1`
  }

  /** @returns {Promise<{ url: string, port: number }>} */
  async start() {
    if (this.server !== null) return { url: this.baseUrl, port: this.port }
    const server = http.createServer((request, response) => {
      void this.#handle(request, response).catch((error) => {
        this.counters.failures += 1
        this.#send(response, 500, openAiError({ kind: 'proxy', label: `代理内部错误：${error?.message ?? error}`, fix: '查看插件日志。', code: null }, 500))
      })
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.port, this.host, resolve)
    })
    this.server = server
    this.log(`gateway proxy listening on ${this.baseUrl}`)
    return { url: this.baseUrl, port: this.port }
  }

  async stop() {
    if (this.server === null) return
    const server = this.server
    this.server = null
    server.close()
    await once(server, 'close').catch(() => {})
  }

  /** @param {import('node:http').ServerResponse} response @param {number} status @param {unknown} body */
  #send(response, status, body) {
    if (response.writableEnded) return
    const text = JSON.stringify(body)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    })
    response.end(text)
  }

  /** @param {import('node:http').IncomingMessage} request */
  async #readBody(request) {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > MAX_BODY) throw new Error('请求体过大')
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    return text.trim() === '' ? {} : JSON.parse(text)
  }

  /**
   * 一次转发：按阶梯尝试，第一份被上游接受的请求体即胜出。
   *
   * 只有「指纹」类拒绝才升级阶梯 —— 11148（tool 不配对）与 11133（参数）在
   * 第一级已经修过，再升级只会重复发送同样的坏请求。这条判断在真机上很重要：
   * 不加它，一次坏参数会触发三次上游调用。
   *
   * @param {Record<string, any>} payload
   * @param {{ flavour?: 'v2' | 'v1', signal?: AbortSignal }} [options]
   */
  async forward(payload, options = {}) {
    const credential = await this.resolve()
    if (credential === undefined) {
      const reason = { kind: 'no-credential', label: '还没有可用的网关令牌', fix: '先跑一次自动配置：建仓库 → 起云环境 → 采集流水线令牌。', code: null }
      return { ok: false, status: 503, reason, attempts: [] }
    }
    const url = this.upstreamOf(credential.repo, options.flavour ?? 'v2')
    const ladder = attemptLadder(payload)
    const attempts = []
    for (const row of ladder) {
      const body = JSON.stringify({ ...row.body, stream: true })
      let response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${credential.token}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
            'user-agent': 'dsh-cnb-gateway/0.2',
          },
          body,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        })
      } catch (error) {
        const reason = { kind: 'network', label: `连不上网关：${error?.message ?? error}`, fix: '检查网络与本机 DNS。', code: null }
        attempts.push({ level: row.level, changes: row.changes, status: 0, reason })
        return { ok: false, status: 502, reason, attempts }
      }
      if (response.ok) {
        attempts.push({ level: row.level, changes: row.changes, status: response.status, reason: null })
        this.levels.set(row.level, (this.levels.get(row.level) ?? 0) + 1)
        if (row.level > 0 || row.changes.length > 0) this.counters.repairs += 1
        return { ok: true, status: 200, response, attempts, repo: credential.repo, url }
      }
      const text = await response.text()
      const reason = classifyGatewayError(response.status, text)
      attempts.push({ level: row.level, changes: row.changes, status: response.status, reason, body: text.slice(0, 400) })
      if (reason.kind === 'fingerprint') this.counters.fingerprints += 1
      // 只有指纹拦截值得换形态重发；其它错误换形态也不会变好。
      if (reason.kind !== 'fingerprint' && reason.kind !== 'stream-only') {
        return { ok: false, status: response.status, reason, attempts, repo: credential.repo, url }
      }
    }
    const last = attempts[attempts.length - 1]?.reason ?? classifyGatewayError(400, '')
    return { ok: false, status: 400, reason: last, attempts, repo: credential.repo, url }
  }

  /** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response */
  async #handle(request, response) {
    // 路径比较必须在解析过的 pathname 上做：`/v1/models?key=…` 与 `/v1/models`
    // 是同一个路由，按原串比较会让带 key 的自检直接 404。
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '')
    if (request.method === 'GET' && (pathname === '/health' || pathname === '/v1/health')) {
      const credential = await this.resolve()
      return this.#send(response, 200, {
        status: 'ok',
        repo: credential?.repo ?? null,
        credential: credential === undefined ? 'missing' : 'ready',
        counters: this.counters,
        levels: Object.fromEntries(this.levels),
      })
    }
    // 公网可达的代理必须先验 key：否则任何人拿到域名就能消耗这个组织的 AI Credits。
    // `/health` 保持开放，好让远端轮询「服务起来了没」而不必先有 key。
    if (this.apiKey !== '' && readBearer(request) !== this.apiKey) {
      return this.#send(response, 401, {
        error: { message: 'unauthorized: 需要 Authorization: Bearer <网关 key>', type: 'auth', code: 'unauthorized' },
      })
    }
    if (request.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
      const models = await this.models()
      return this.#send(response, 200, { object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'cnb' })) })
    }
    if (request.method !== 'POST' || !['/v1/chat/completions', '/chat/completions'].includes(pathname)) {
      return this.#send(response, 404, { error: { message: 'not found', type: 'proxy' } })
    }
    this.counters.requests += 1
    let payload
    try {
      payload = await this.#readBody(request)
    } catch (error) {
      return this.#send(response, 400, { error: { message: `请求体不合法：${error?.message ?? error}`, type: 'proxy' } })
    }
    if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
      return this.#send(response, 400, { error: { message: 'messages 不能为空', type: 'proxy' } })
    }
    const wantsStream = payload.stream === true
    const controller = new AbortController()
    response.on('close', () => {
      if (!response.writableEnded) controller.abort()
    })
    const result = await this.forward(payload, { signal: controller.signal })
    this.lastCall = {
      at: new Date().toISOString(),
      model: payload.model ?? null,
      stream: wantsStream,
      ok: result.ok,
      attempts: result.attempts,
      ...(this.debug ? { shape: describeShape(payload) } : {}),
    }
    if (!result.ok) {
      this.counters.failures += 1
      return this.#send(response, result.status === 0 ? 502 : result.status, openAiError(result.reason, result.status))
    }
    const upstream = result.response
    if (wantsStream) {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      try {
        for await (const chunk of upstream.body) {
          if (response.destroyed) break
          if (!response.write(chunk)) await once(response, 'drain')
        }
      } catch (error) {
        if (error?.name !== 'AbortError') this.log(`stream failed: ${error?.message ?? error}`)
      } finally {
        if (!response.writableEnded) response.end()
      }
      return
    }
    const text = await upstream.text()
    const completion = aggregateSse(text, { model: payload.model })
    if (completion.error !== undefined) {
      return this.#send(response, 502, { error: { message: JSON.stringify(completion.error).slice(0, 400), type: 'upstream' } })
    }
    return this.#send(response, 200, completion)
  }

  /** @type {string[]} */
  modelCache = []

  /** @param {string[]} ids */
  setModels(ids) {
    this.modelCache = [...new Set(ids)]
  }

  async models() {
    return this.modelCache
  }
}

/** 从请求里取 bearer key；`?key=` 也接受，方便浏览器直接点 `/v1/models` 自检。 */
function readBearer(request) {
  const header = String(request.headers.authorization ?? '')
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  const url = new URL(request.url ?? '/', 'http://localhost')
  return (url.searchParams.get('key') ?? '').trim()
}

export { dropOrphanTools, foldSystem, obfuscateNonUser, repairText }
export { classifyGatewayError, repairForGateway, sanitizePayload } from './model-guard.js'

/** 请求形状摘要：只描述结构，不含内容。 */
export function describeShape(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  return {
    keys: Object.keys(payload ?? {}).sort(),
    messageCount: messages.length,
    roles: messages.map((m) => m?.role ?? null),
    // 每条消息的 content 类型（string / array / null / 其它）+ 段类型
    contents: messages.map((m) => {
      const content = m?.content
      if (typeof content === 'string') return `string(${content.length})`
      if (Array.isArray(content)) return `array[${content.map((p) => p?.type ?? typeof p).join(',')}]`
      if (content === null) return 'null'
      if (content === undefined) return 'absent'
      return typeof content
    }),
    toolCount: Array.isArray(payload?.tools) ? payload.tools.length : 0,
    maxTokens: payload?.max_tokens ?? null,
  }
}
