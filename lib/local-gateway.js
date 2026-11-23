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
    return {
      available: false,
      repo: null,
      reason: '有 CNB_TOKEN 但没有 CNB_REPO_SLUG：网关要求令牌与仓库绑定，缺了它无法确定打哪个上游。',
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
    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.token}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: input.model,
        stream: true,
        messages: [{ role: 'user', content: input.question }],
        max_tokens: input.maxTokens ?? 4_000,
      }),
      signal: AbortSignal.timeout(180_000),
    })
    const text = await response.text()
    if (!response.ok) {
      // 把上游原话带出来：这比「失败了」有用得多。
      return { ok: false, reason: `上游返回 ${response.status}：${text.slice(0, 300)}`, elapsedMs: Date.now() - startedAt }
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
     *
     * 这只是取值，不是把思考过程当答案：对这类模型，那个字段装的就是它要说的全部。
     */
    if (content.trim() === '' && typeof message.reasoning_content === 'string') {
      content = message.reasoning_content
    }
    if (content.trim() === '') {
      return { ok: false, reason: `上游没有返回内容：${text.slice(0, 300)}`, elapsedMs: Date.now() - startedAt }
    }
    return { ok: true, answer: content.trim(), elapsedMs: Date.now() - startedAt }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - startedAt }
  }
}
