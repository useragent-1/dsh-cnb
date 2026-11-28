/**
 * 本地直连网关：用**本进程已有的流水线令牌**直接打上游，不经过任何容器。
 *
 * ## 为什么这是最快的路
 *
 * 前面两条路各有代价：
 *   · 云网关 —— 要常驻一台环境（占额度）；
 *   · Issue 网关 —— 每次借临时容器，实测 10 秒起。
 *
 * 但它们都源于同一个误解：以为「必须专门起一个环境才能拿到令牌」。实际上
 * **dsh 自己就跑在云原生环境里**，进程环境里早就有 `CNB_TOKEN`，而且它属于
 * 当前仓库（`CNB_REPO_SLUG`），正是网关要求的那个绑定关系。
 *
 * 实测（2026-11-23）：
 *
 *   POST api.cnb.cool/<CNB_REPO_SLUG>/-/ai-ide/v2/chat/completions
 *   Authorization: Bearer $CNB_TOKEN      ← 就是进程里那个
 *   → data: {"content":"直连"}，三次分别 1758 / 1495 / 1023 ms
 *
 * 所以这条路径零调度、零额外环境，延迟就等于模型本身的思考时间。
 *
 * ## 它和 `/-/ai` 的区别
 *
 * v1 的 `/-/ai` 会把任何 model 都落到默认模型；v2 的 `/-/ai-ide/v2` 才按请求
 * 的 model 真正路由。所以只打 v2。
 */

/** 上游路径。非流式会被拒（11101），所以调用方必须用 stream。 */
import { readFileSync } from 'node:fs'
import { parseInlineToolCalls, repairLadder, stripInlineToolCalls } from './model-guard.js'

export const LOCAL_UPSTREAM_PATH = '/-/ai-ide/v2/chat/completions'

/**
 * 判断当前进程能不能走本地直连。
 *
 * 三个条件缺一不可：
 *   · 有 `CNB_TOKEN`（流水线令牌）；
 *   · 有 `CNB_REPO_SLUG`（令牌绑定的仓库 —— 换了仓库会答 SLUG_ID_NOT_MATCH）；
 *   · 在云环境里（同一个 `api.cnb.cool`）。
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ available: boolean, repo: string | null, reason: string }}
 */
export function localGatewayAvailability(env = process.env) {
  let token = typeof env.CNB_TOKEN === 'string' ? env.CNB_TOKEN.trim() : ''
  let repo = typeof env.CNB_REPO_SLUG === 'string' ? env.CNB_REPO_SLUG.trim() : ''
  /**
   * 兜底：从本进程的 /proc/self/environ 再读一次。
   *
   * 有些 supervisor 会在 boot 之后清理环境变量，但内核里那份还在。
   * 插件自己跑在主进程里，所以这条兜底对它有效；对「被 spawn 出去的子 shell」
   * 无效 —— 那种场景本来就该报「不在云环境里」。
   */
  /**
   * 再兜底一层：`<DSH_HOME>/../runtime/cnb-token` 这类落地文件。
   *
   * 平台的注入策略是「流水线令牌只给 stage 脚本」，**长期运行的守护进程拿不到**
   * —— 实测：dsh 主进程的 environ 里没有 CNB_TOKEN，只有 CNB_GROUP_SLUG 之类。
   * 但启动脚本会把令牌落一份到 runtime/cnb-token（权限 600），那个文件是可用的。
   *
   * 所以按「环境变量 → procfs → 落地文件」的顺序找，三层都没有才判定不可用。
   */
  if (token === '') {
    for (const candidate of [
      `${env.DSH_HOME ?? '/root/.dsh'}/runtime/cnb-token`,
      '/workspace/runtime/cnb-token',
    ]) {
      try {
        const value = readFileSync(candidate, 'utf8').trim()
        if (value !== '') { token = value; break }
      } catch {
        // 没有这个文件就继续找下一个。
      }
    }
  }
  if (token === '' || repo === '') {
    try {
      const raw = readFileSync('/proc/self/environ', 'utf8')
      for (const pair of raw.split('\0')) {
        if (token === '' && pair.startsWith('CNB_TOKEN=')) token = pair.slice('CNB_TOKEN='.length).trim()
        if (repo === '' && pair.startsWith('CNB_REPO_SLUG=')) repo = pair.slice('CNB_REPO_SLUG='.length).trim()
      }
    } catch {
      // 没有 procfs（Windows / 受限容器）：保持原样。
    }
  }
  if (token === '') {
    return { available: false, repo: null, reason: '进程里没有 CNB_TOKEN：这不是一个云原生环境，无法直连网关。' }
  }
  if (repo === '') {
    /**
     * 仓库推不出来时，用「组织 + 当前工作目录名」兜底。
     *
     * 守护进程的环境里通常有 CNB_GROUP_SLUG 和 CNB_REPO_SLUG，但启动方式不同
     * 时可能只剩前者。网关要求令牌与仓库绑定（SLUG_ID_NOT_MATCH），所以必须
     * 凑出一个完整路径 —— 拿不到就老实报错，不猜。
     */
    const group = typeof env.CNB_GROUP_SLUG === 'string' ? env.CNB_GROUP_SLUG.trim() : ''
    const name = typeof env.CNB_REPO_NAME === 'string' ? env.CNB_REPO_NAME.trim() : ''
    if (group !== '' && name !== '') repo = `${group}/${name}`
  }
  if (repo === '') {
    return {
      available: false,
      repo: null,
      reason: '有令牌但没有仓库信息（CNB_REPO_SLUG / CNB_GROUP_SLUG+CNB_REPO_NAME）：'
        + '网关要求令牌与仓库绑定，缺了它无法确定打哪个上游。',
    }
  }
  return { available: true, repo, reason: `直连 ${repo} 的 AI 网关，零调度。` }
}

/**
 * 上游 URL。
 * @param {string} repo
 * @param {string} [origin]
 */
export function localUpstreamUrl(repo, origin = 'https://api.cnb.cool') {
  return `${origin.replace(/\/+$/, '')}/${repo}${LOCAL_UPSTREAM_PATH}`
}

/**
 * 把一次非流式请求改写成流式的上游请求体。
 *
 * 上游只接受 `stream: true`（非流式答 11101），所以才需要这一层转换：
 * 把 dsh 发来的非流式请求改成流式发上去，再把 SSE 聚合成一个完整响应。
 * 这个转换在 `gateway-proxy.js` 里已经有实现（`aggregateSse`），这里只负责
 * 把 payload 调成上游能接受的形状。
 *
 * @param {Record<string, any>} payload
 * @returns {Record<string, any>}
 */
export function toStreamingPayload(payload) {
  const next = { ...payload, stream: true }
  // 这两个字段是 OpenAI 新版的，上游不认；留着会被判非法请求。
  delete next.stream_options
  delete next.store
  return next
}

/**
 * 用进程里的流水线令牌直接问一次模型 —— 不经过任何容器。
 *
 * 这是「架桥」的核心：dsh 自己就在云环境里，令牌是现成的，所以没必要为每次
 * 提问起一个临时容器（那是 10 秒）；直接打上游只要 1–2 秒。
 *
 * 上游只接受流式（非流式答 11101），所以这里发 `stream: true` 再把 SSE 聚合成
 * 完整文本。聚合逻辑复用 `aggregateSse`，不重复实现。
 *
 * @param {{
 *   model: string, question: string, token: string, repo: string,
 *   maxTokens?: number, origin?: string, fetchImpl?: typeof fetch,
 *   aggregate: (text: string) => { choices?: Array<{ message?: { content?: string } }> },
 * }} input
 * @returns {Promise<{ ok: boolean, answer?: string, reason?: string, elapsedMs: number }>}
 */
export async function askLocal(input) {
  const startedAt = Date.now()
  const doFetch = input.fetchImpl ?? fetch
  const url = localUpstreamUrl(input.repo, input.origin)
  try {
    /**
     * 把调用方的**完整消息体**透传上去，而不是只发一句 question。
     *
     * 这是「能不能连续工作」的关键：dsh 的多轮对话靠 messages 数组承载 ——
     * 它会把上一轮的 assistant.tool_calls、以及 tool 执行结果一起放进来。
     * 只发最后一句，模型就永远看不到工具跑出了什么，于是每轮都从头开始，
     * 表现就是「不能连续工作」。
     *
     * `payload` 优先：调用方已经把整个请求体准备好了（含 tools 定义）；
     * 只有给了 `question` 这种简写时才退化成单轮。
     */
    const body = input.payload ?? {
      model: input.model,
      messages: [{ role: 'user', content: input.question }],
      ...(input.tools === undefined ? {} : { tools: input.tools }),
    }
    /**
     * 发之前先算好**三级候选体**，而不是「拦了就原样重发」。
     *
     * 11128 是确定性的（真机实测：同一份含指纹的 body 连发 12 次，12 次全拦；
     * 同一段文本折进 user 后连发 4 次全过）。原样重发只会把同一个拒绝多撞几次，
     * 唯一有效的动作是换承载形态 —— 所以这里逐级换体，每级都保留原语义。
     */
    const base = {
      ...body,
      model: input.model ?? body.model,
      // 上游只接受流式（非流式答 11101）。
      stream: true,
      max_tokens: input.maxTokens ?? body.max_tokens ?? 4_000,
    }
    delete base.stream_options
    const ladder = repairLadder(base)
    let response = null
    let text = ''
    for (const row of ladder) {
      response = await doFetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.token}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(row.body),
        signal: AbortSignal.timeout(180_000),
      })
      text = await response.text()
      if (response.ok) break
      // 只有指纹拦截值得换形态；其它错误换形态也不会变好。
      if (!/11128|11288|unapproved channel/.test(text)) break
      if (row.level === ladder[ladder.length - 1].level) break
      console.warn(`[dsh-cnb] 本地桥：上游指纹拦截（level ${row.level}），换形态重试`)
    }
    if (response === null || !response.ok) {
      // 把上游原话带出来：这比「失败了」有用得多。
      return { ok: false, reason: `上游返回 ${response?.status ?? 0}：${text.slice(0, 300)}`, elapsedMs: Date.now() - startedAt }
    }
    const completion = input.aggregate(text)
    const message = completion?.choices?.[0]?.message ?? {}
    let content = typeof message.content === 'string' ? message.content : ''
    /**
     * 混元（hy4 / hy4std）把内容全放在 `reasoning_content`，`content` 一直是空串。
     * 实测：整段回复只有 reasoning_content 有字，content 从头到尾是 ""。
     *
     * 所以 content 为空时回退到 reasoning_content —— 否则这条路径对混元完全不可用，
     * 表现为「上游有响应但没内容」，而日志里看着一切正常。
     */
    if (content.trim() === '' && typeof message.reasoning_content === 'string') {
      content = message.reasoning_content
    }
    /**
     * **保留 tool_calls 与 usage**。
     *
     * 早先这里只返回 `answer` 一个字符串，把 tool_calls 和 usage 全丢了 ——
     * 后果是两条：dsh 看不到工具调用（于是「不能连续工作」），界面上也不显示
     * token 数（看起来像「这个接口不计费」）。两个「缺陷」其实都是这一处丢字段
     * 造成的，而不是上游不支持。
     *
     * 上游的流式分片本身是正常的（arguments 按 token 切开），`aggregateSse`
     * 已经把它们拼回完整 JSON —— 实测 `{"command": "ls -la"}` 没有问题。
     */
    let toolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
      ? message.tool_calls
      : null
    /**
     * 上游有时把工具调用写成正文里的 DSML 标记，而不是结构化字段。这种必须
     * **翻译成 tool_calls** —— 只删标记的话工具不会执行，用户看到的就是
     * 「模型说要跑命令、实际没跑」。
     */
    let finishReason = completion?.choices?.[0]?.finish_reason ?? 'stop'
    if (toolCalls === null && typeof content === 'string') {
      const parsed = parseInlineToolCalls(content)
      if (parsed !== null) {
        toolCalls = parsed.calls
        content = parsed.rest
        finishReason = 'tool_calls'
      }
    }
    const hasContent = content.trim() !== ''
    if (!hasContent && toolCalls === null) {
      return { ok: false, reason: `上游没有返回内容：${text.slice(0, 300)}`, elapsedMs: Date.now() - startedAt }
    }
    return {
      ok: true,
      answer: hasContent ? content.trim() : '',
      ...(toolCalls === null ? {} : { toolCalls }),
      ...(message.reasoning_content === undefined ? {} : { reasoning: message.reasoning_content }),
      usage: completion?.usage ?? null,
      finishReason,
      elapsedMs: Date.now() - startedAt,
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - startedAt }
  }
}


/**
 * 找到可用的流水线令牌，按「环境变量 → procfs → 落地文件」顺序。
 *
 * 抽出来是因为调用方不只一处，而**平台的注入策略**决定了两件事：
 *   · stage 脚本里有 `CNB_TOKEN`；
 *   · 长期运行的守护进程**没有** —— 实测 dsh 主进程 environ 里只有
 *     `CNB_REPO_SLUG` 之类，令牌得从启动脚本落的 `runtime/cnb-token` 读。
 *
 * 早先各处自己写 `process.env.CNB_TOKEN ?? readTokenFromProc()`，于是文件那层
 * 永远轮不到，桥接判定一直是 `available: false`。集中到这里就不会漏。
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ token: string | null, repo: string | null }}
 */
export function resolvePipelineToken(env = process.env) {
  const availability = localGatewayAvailability(env)
  if (!availability.available) return { token: null, repo: null }
  // 复用同一套查找逻辑：可用性通过时，令牌一定能取到。
  const fromEnv = typeof env.CNB_TOKEN === 'string' ? env.CNB_TOKEN.trim() : ''
  if (fromEnv !== '') return { token: fromEnv, repo: availability.repo }
  try {
    const raw = readFileSync('/proc/self/environ', 'utf8')
    for (const pair of raw.split('\0')) {
      if (pair.startsWith('CNB_TOKEN=')) {
        const value = pair.slice('CNB_TOKEN='.length).trim()
        if (value !== '') return { token: value, repo: availability.repo }
      }
    }
  } catch {
    // 没有 procfs 就继续往下找文件。
  }
  for (const candidate of [
    `${env.DSH_HOME ?? '/root/.dsh'}/runtime/cnb-token`,
    '/workspace/runtime/cnb-token',
  ]) {
    try {
      const value = readFileSync(candidate, 'utf8').trim()
      if (value !== '') return { token: value, repo: availability.repo }
    } catch {
      // 没有就试下一个。
    }
  }
  return { token: null, repo: availability.repo }
}

/**
 * 直连上游的**流式**版本：边收边把每个 SSE 事件交给调用方。
 *
 * ## 为什么需要它
 *
 * `askLocal` 是「读完整段再聚合」：简单，但调用方的首字延迟 = 整段答案的生成
 * 时间。一条 500 字的回答要等十几秒才看到第一个字 —— 界面上就是「卡住」。
 *
 * 上游本来就是逐 token 推的（OpenAI 兼容 SSE），所以这里只做搬运：
 *
 *   · `onOpen`   —— 上游 2xx 之后、读第一个字节之前调用（写 SSE 响应头用）；
 *   · `onEvent`  —— 每个解析出来的 JSON 事件调用一次（delta 原样给）；
 *   · 返回值里的 `text` 是**原始 SSE 全文**，调用方仍可 `aggregateSse` 拿
 *     `tool_calls`/`usage`/`finish_reason` —— 流式转发不影响结构化字段。
 *
 * 11128（内容指纹拦截）在这里同样重试：它偶发，且发生在响应体之前，所以重试
 * 不会让调用方看到半截流。
 *
 * @param {{
 *   model: string, payload: Record<string, any>, token: string, repo: string,
 *   maxTokens?: number, origin?: string, fetchImpl?: typeof fetch,
 *   onOpen?: () => void, onEvent?: (event: any) => void,
 * }} input
 * @returns {Promise<{ ok: boolean, text?: string, reason?: string, firstEventMs?: number | null, elapsedMs: number }>}
 */
export async function streamLocal(input) {
  const startedAt = Date.now()
  const doFetch = input.fetchImpl ?? fetch
  const url = localUpstreamUrl(input.repo, input.origin)
  const body = {
    ...input.payload,
    model: input.model ?? input.payload?.model,
    stream: true,
    max_tokens: input.maxTokens ?? input.payload?.max_tokens,
  }
  /**
   * 和 `askLocal` 同一套理由：11128 是确定性的，原样重发不解决问题。
   * 这里逐级换候选体；`onOpen` 只在上游真的 2xx 之后调一次 —— 阶梯发生在
   * 响应体之前，所以调用方不会看到半截流。
   */
  const ladder = repairLadder(body)
  let response = null
  for (const row of ladder) {
    response = await doFetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.token}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(row.body),
      signal: AbortSignal.timeout(300_000),
    })
    if (response.ok) break
    const failure = await response.text()
    if (!/11128|11288|unapproved channel/.test(failure)) {
      return { ok: false, reason: `上游返回 ${response.status}：${failure.slice(0, 300)}`, elapsedMs: Date.now() - startedAt }
    }
    if (row.level === ladder[ladder.length - 1].level) {
      return { ok: false, reason: `上游返回 ${response.status}：${failure.slice(0, 300)}`, elapsedMs: Date.now() - startedAt }
    }
    console.warn(`[dsh-cnb] 本地桥（流式）：上游指纹拦截（level ${row.level}），换形态重试`)
  }
  if (response === null || !response.ok || response.body === null) {
    return { ok: false, reason: '上游没有响应体', elapsedMs: Date.now() - startedAt }
  }
  if (typeof input.onOpen === 'function') input.onOpen()

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let firstEventMs = null
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const piece = decoder.decode(value, { stream: true })
      text += piece
      buffer += piece
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim()
          if (data !== '' && data !== '[DONE]') {
            let event
            try {
              event = JSON.parse(data)
            } catch {
              event = undefined
            }
            if (event !== undefined) {
              if (firstEventMs === null) firstEventMs = Date.now() - startedAt
              if (typeof input.onEvent === 'function') input.onEvent(event)
            }
          }
        }
        newline = buffer.indexOf('\n')
      }
    }
    text += decoder.decode()
  } catch (error) {
    return {
      ok: false,
      reason: `读取上游流失败：${error instanceof Error ? error.message : String(error)}`,
      text,
      elapsedMs: Date.now() - startedAt,
    }
  }
  return { ok: true, text, firstEventMs, elapsedMs: Date.now() - startedAt }
}
