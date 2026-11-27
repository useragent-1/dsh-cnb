/**
 * Issue 网关的反向代理：把「借容器问模型」包装成标准 OpenAI 接口。
 *
 * ## 为什么需要这一层
 *
 * `issue.ask` 是个一次性的操作（问一句、等答案）。但 dsh 的 provider 需要的是
 * **常驻的 OpenAI 兼容端点** —— pi-ai 会打 `/v1/models`、`/v1/chat/completions`，
 * 期望一个稳定的 baseURL。两者之间要么改 pi-ai，要么在中间放一层。
 *
 * 这一层负责：
 *   · `GET /v1/models`  —— 返回免费模型清单（同步，秒回）；
 *   · `POST /v1/chat/completions` —— 把**整个 OpenAI 请求**（messages 含 `tool`
 *     角色与 `assistant.tool_calls`、`tools`、`tool_choice`、采样参数）翻译成上游
 *     能吃的形状，再把上游结果组回 OpenAI 响应：`content`、结构化的 `tool_calls`、
 *     `finish_reason`、`usage` 一个不丢。
 *
 * 能不能调工具、能不能连续对话，取决于这一层是否**原样搬运**；把历史压成一句话
 * 的写法看起来更"简单"，代价是模型永远看不到工具跑出了什么。
 *
 * ## 慢是设计的一部分，不是缺陷
 *
 * 每次请求要起一个一次性容器（实测 Prepare 阶段约 3.3s，整条 5.3s，加上模型
 * 推理通常几十秒）。所以：
 *
 *   · 超时必须放宽到几分钟，否则好请求会被自己掐掉；
 *   · 并发要限流 —— 每个请求都吃一次容器配额，同时来十个会排队排到超时；
 *   · 响应里带上真实耗时，让调用方知道时间花在哪。
 *
 * 这些都不是「优化」，是这条路径的物理属性。
 */

import { parseInlineToolCalls } from './model-guard.js'

/** 一个请求最多等多久：容器调度 + 模型推理 + 回传。给足 7 分钟。 */
export const ISSUE_PROXY_TIMEOUT_MS = 420_000

/** 同时在跑的容器数上限。超过就排队，而不是把配额打满。 */
export const ISSUE_PROXY_CONCURRENCY = 2

/**
 * 上游请求体：把调用方的 OpenAI 请求**原样**翻译成上游能吃的形状。
 *
 * 这一层存在的理由只有一条：**它决定了接口是不是真的能用**。
 * 早期版本把 messages 压成一句 question，于是
 *
 *   · dsh 回传的 `assistant.tool_calls` 与 `tool` 结果全被扁平化成文本 ——
 *     模型看不到工具跑出了什么，每轮从头开始（"不能连续工作"）；
 *   · `tools`/`tool_choice` 从来没被送上去 —— 上游根本不会返回工具调用
 *     （"不能调工具"）。
 *
 * 这两个"缺陷"都不是上游不支持：实测同一套上游在带 tools 时正常返回
 * `finish_reason: "tool_calls"` 和结构化 `tool_calls`，回传 tool 结果后也能继续。
 *
 * @param {{ messages?: unknown, tools?: unknown, tool_choice?: unknown } & Record<string, unknown>} body
 * @param {{ model: string, maxTokens?: number }} options
 * @returns {Record<string, unknown>}
 */
export function upstreamPayloadFromBody(body, options) {
  const messages = (Array.isArray(body?.messages) ? body.messages : [])
    .map((message) => forwardableMessage(message))
    .filter((message) => message !== null)
  const payload = {
    model: options.model,
    messages,
    // 调用方自己给的优先：它比我们更清楚这一轮要多少预算。
    max_tokens: typeof body?.max_tokens === 'number' ? body.max_tokens : (options.maxTokens ?? 4_000),
    // 上游只接受流式（非流式答 11101），无论调用方要不要流。
    stream: true,
  }
  for (const key of FORWARDED_PARAMS) {
    if (body?.[key] !== undefined) payload[key] = body[key]
  }
  if (Array.isArray(body?.tools) && body.tools.length > 0) payload.tools = body.tools
  return payload
}

/** 可以原样透传给上游的采样参数。 */
const FORWARDED_PARAMS = [
  'temperature',
  'top_p',
  'presence_penalty',
  'frequency_penalty',
  'stop',
  'seed',
  'n',
  'response_format',
  'logprobs',
  'top_logprobs',
  'parallel_tool_calls',
  'tool_choice',
]

/**
 * 一条消息里哪些字段该送上去。
 *
 * `reasoning_content` 故意不带：它是模型的思考过程，历史里带回去既没用，
 * 又可能被上游当成正文的一部分。其余字段（含 `tool_calls`、`tool_call_id`）
 * 必须保留 —— 少了任何一个，配对关系就断了，上游会答 `11148`。
 *
 * @param {any} message
 * @returns {{ role: string } & Record<string, unknown> | null}
 */
function forwardableMessage(message) {
  if (message === null || typeof message !== 'object') return null
  const role = typeof message.role === 'string' ? message.role : ''
  if (role === '') return null
  /** @type {Record<string, unknown>} */
  const out = { role }
  if (typeof message.name === 'string' && message.name !== '') out.name = message.name
  if (message.content !== undefined && message.content !== null) out.content = message.content
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) out.tool_calls = message.tool_calls
  if (typeof message.tool_call_id === 'string' && message.tool_call_id !== '') out.tool_call_id = message.tool_call_id
  // tool 结果必须有 id 才能配对；缺了它整条请求会被上游拒掉，不如这里就丢掉。
  if (role === 'tool' && out.tool_call_id === undefined) return null
  // 既没有正文也没有工具调用的 assistant 消息没有信息量，留着只会让模型困惑。
  if (out.content === undefined && out.tool_calls === undefined) return null
  return out
}

/**
 * 把 `aggregateSse` 的聚合结果拆成响应该用的几块。
 *
 * 三件事必须一起做，缺一个就退化成"不能连续工作"：
 *   · `content` 与 `tool_calls` 分开取（都可能为 null）；
 *   · 上游偶尔把工具调用写成正文里的 DSML 标记，翻译成结构化调用；
 *   · `finish_reason` 跟着走 —— 写了 `tool_calls`，调用方才会执行工具再继续。
 *
 * @param {{ choices?: Array<any>, usage?: unknown } | null | undefined} completion
 * @returns {{ content: string, toolCalls: any[] | null, finishReason: string, usage: unknown, reasoning: string | null }}
 */
export function partsFromCompletion(completion) {
  const choice = completion?.choices?.[0] ?? {}
  const message = choice.message ?? {}
  let content = typeof message.content === 'string' ? message.content : ''
  let toolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0 ? message.tool_calls : null
  let finishReason = typeof choice.finish_reason === 'string' && choice.finish_reason !== '' ? choice.finish_reason : 'stop'
  if (toolCalls === null && content !== '') {
    const parsed = parseInlineToolCalls(content)
    if (parsed !== null) {
      toolCalls = parsed.calls
      content = parsed.rest
      finishReason = 'tool_calls'
    }
  }
  return {
    content: content.trim(),
    toolCalls,
    finishReason,
    usage: completion?.usage ?? null,
    reasoning: typeof message.reasoning_content === 'string' ? message.reasoning_content : null,
  }
}

/**
 * 组一个真正的 OpenAI 非流式响应。
 *
 * `finish_reason` 不再写死 'stop'：带工具调用时必须是 'tool_calls'，
 * 否则调用方会把它当"这轮结束了"，工具永远不执行。
 *
 * @param {{
 *   model: string, content?: string | null, answer?: string | null,
 *   toolCalls?: any[] | null, finishReason?: string, usage?: unknown,
 *   reasoning?: string | null, elapsedMs?: number | null, build?: string | null, via?: string,
 * }} input
 * @returns {Record<string, unknown>}
 */
export function completionResponse(input) {
  const now = Math.floor(Date.now() / 1000)
  const content = input.content ?? input.answer ?? ''
  /** @type {Record<string, unknown>} */
  const message = { role: 'assistant', content: content === '' ? null : content }
  if (typeof input.reasoning === 'string' && input.reasoning !== '' && content === '') {
    // 混元把内容全放在 reasoning_content 里；调用方要能看到字，不能给 null。
    message.content = input.reasoning
  }
  if (Array.isArray(input.toolCalls) && input.toolCalls.length > 0) message.tool_calls = input.toolCalls
  const finishReason = input.finishReason ?? (message.tool_calls === undefined ? 'stop' : 'tool_calls')
  return {
    id: `chatcmpl-issue-${now}`,
    object: 'chat.completion',
    created: now,
    model: input.model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: input.usage ?? null,
    // 非标准但有用：让调用方知道这条路径的真实成本。
    'x-dsh-issue': {
      via: input.via ?? 'container',
      build: input.build ?? null,
      elapsedMs: input.elapsedMs ?? null,
      note: '每一次请求要么直连上游，要么重新调度一个一次性容器；两者都支持 tools 与多轮。',
    },
  }
}

/**
 * 从 OpenAI 请求体里取出要问的那句话。
 *
 * 多轮对话压平成一段文本：这条路径每次都是全新容器，没有会话状态，
 * 所以把历史拼进 prompt 是唯一能保留上下文的方式。
 *
 * @param {{ messages?: Array<{ role?: string, content?: unknown }> }} body
 * @returns {string | null}
 */
export function questionFromBody(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const parts = []
  for (const message of messages) {
    const role = typeof message?.role === 'string' ? message.role : 'user'
    let text = ''
    if (typeof message?.content === 'string') {
      text = message.content
    } else if (Array.isArray(message?.content)) {
      // 多模态请求：只取文本部分，图片在这条路径上没法传（容器里没有视觉能力）。
      text = message.content
        .filter((part) => typeof part?.text === 'string')
        .map((part) => part.text)
        .join('\n')
    }
    if (text === '') continue
    // system 也拼进去：这条路径没有 system 通道，塞进正文最省事。
    parts.push(role === 'user' ? text : `[${role}] ${text}`)
  }
  if (parts.length === 0) return null
  // 只有一条 user 就原样问；多轮则加上说明，避免模型把历史当指令。
  return parts.length === 1 ? parts[0] : `以下是对话历史，请回答最后一条：\n\n${parts.join('\n')}`
}

/**
 * 一个极简并发闸门：超过上限就排队，而不是直接拒绝。
 *
 * 为什么排队而不是拒绝：每个请求要占一次容器配额，瞬间并发十个会把配额打满、
 * 然后十个一起超时。排队能让它们依次完成 —— 反正这条路径本来就慢。
 */
export class Semaphore {
  /** @param {number} limit */
  constructor(limit) {
    this.limit = Math.max(1, limit)
    this.active = 0
    this.queue = []
  }

  /** @returns {Promise<() => void>} 释放函数 */
  acquire() {
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve(() => this.#release())
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1
        resolve(() => this.#release())
      })
    })
  }

  #release() {
    this.active -= 1
    const next = this.queue.shift()
    if (next !== undefined) next()
  }
}
