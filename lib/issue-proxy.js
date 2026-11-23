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
 *   · `POST /v1/chat/completions` —— 把请求转成一次 `issue.ask`，等答案回来再按
 *     OpenAI 格式返回。支持 `stream: true`（把完整答案切成一个 chunk 吐出，
 *     语义上等价，只是不是逐字流）。
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

/** 一个请求最多等多久。容器调度 + 模型推理，给足 5 分钟。 */
export const ISSUE_PROXY_TIMEOUT_MS = 300_000

/** 同时在跑的容器数上限。超过就排队，而不是把配额打满。 */
export const ISSUE_PROXY_CONCURRENCY = 2

/**
 * 把一次 `issue.ask` 的结果包成 OpenAI 的非流式响应。
 *
 * @param {{ model: string, answer: string, elapsedMs?: number, build?: string }} input
 * @returns {Record<string, unknown>}
 */
export function completionResponse(input) {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: `chatcmpl-issue-${now}`,
    object: 'chat.completion',
    created: now,
    model: input.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: input.answer },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
    // 非标准但有用：让调用方知道这条路径的真实成本。
    'x-dsh-issue': {
      build: input.build ?? null,
      elapsedMs: input.elapsedMs ?? null,
      note: '这条响应由一次性容器产生；每次请求都会重新调度。',
    },
  }
}

/**
 * 把同一份答案转成 SSE 流。
 *
 * pi-ai 与不少客户端默认 `stream: true`，所以这条必须支持。这里不做逐字推送
 * （答案本来就是一次性拿到的），而是发两个 chunk + `[DONE]`：语义与 OpenAI
 * 一致，客户端能正常解析。
 *
 * @param {{ model: string, answer: string }} input
 * @returns {string}
 */
export function completionSse(input) {
  const now = Math.floor(Date.now() / 1000)
  const id = `chatcmpl-issue-${now}`
  const chunk = (delta, finish) => `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: now,
    model: input.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
  return [
    chunk({ role: 'assistant', content: '' }, null),
    chunk({ content: input.answer }, null),
    chunk({}, 'stop'),
    'data: [DONE]\n\n',
  ].join('')
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
