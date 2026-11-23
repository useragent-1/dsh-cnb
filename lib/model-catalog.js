/**
 * 模型发现：上游没有清单接口，只能用「真调用」当探针。
 *
 * CNB AI 网关不提供 `/models`（`/-/ai/models`、`/-/ai-ide/v2/models`、
 * `/-/model/list` 全部 404），而它自己的错误码恰好是一枚判定位：
 *
 *   `[MODEL_NOT_IN_LIST]`              → 这个 id 不在网关目录里（猜错了）
 *   `[MODEL_NOT_AVAILABLE_FOR_ORG]`    → 在目录里，但当前组织没开通
 *   `200`                              → 可用
 *
 * 所以「发现模型」= 拿一批候选 id 并发探一遍，按这三个结果分类。实测 16 个并发
 * 探测约 2.9 秒，代价可以接受，而且只在网关启动时做一次。
 *
 * 候选表只是**起点**，不是真相：用户可以在 `models` 里给任意 id，插件照探不误。
 * 上游以后加了新模型，只要 id 出现在候选表或用户输入里就能被发现，不需要发版。
 */

/** 一次探测的判定。 */
export const VERDICTS = {
  ok: 'ok',
  unknown: 'unknown',
  notEntitled: 'not-entitled',
  error: 'error',
}

/**
 * 对单个模型 id 做一次最小调用，返回判定。
 *
 * `max_tokens` 给 8 而不是 1：`hy4`、`step-5-preview` 这类推理模型会先吐
 * `reasoning_content`，预算太小会让 `content` 为空 —— 探测只看 HTTP 状态，
 * 所以不影响判定，但把预算压在 8 以内有过一次「探测通过、真实调用空回复」的
 * 误判，值得留一点余量。
 *
 * @param {{ token: string, repo: string, id: string, flavour?: 'v2' | 'v1', timeoutMs?: number, fetchImpl?: typeof fetch }} input
 * @returns {Promise<{ id: string, verdict: string, status: number, detail?: string }>}
 */
export async function probeModel(input) {
  const flavour = input.flavour ?? 'v2'
  const path = flavour === 'v1' ? '/-/ai/chat/completions' : '/-/ai-ide/v2/chat/completions'
  const url = `https://api.cnb.cool/${input.repo}${path}`
  const doFetch = input.fetchImpl ?? fetch
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: input.id,
        stream: true,
        // 最小的合法请求：只为一枚错误码，不需要真答案。
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 8,
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 20_000),
    })
    if (response.ok) {
      // 读完 body 才能释放连接；内容不重要。
      await response.text().catch(() => '')
      return { id: input.id, verdict: VERDICTS.ok, status: response.status }
    }
    const text = await response.text().catch(() => '')
    const verdict = /MODEL_NOT_IN_LIST/.test(text)
      ? VERDICTS.unknown
      : /MODEL_NOT_AVAILABLE_FOR_ORG/.test(text)
        ? VERDICTS.notEntitled
        : VERDICTS.error
    return { id: input.id, verdict, status: response.status, detail: text.slice(0, 200) }
  } catch (error) {
    return { id: input.id, verdict: VERDICTS.error, status: 0, detail: String(error?.message ?? error) }
  }
}

/**
 * 并发探测一批模型，分类输出。
 *
 * 并发度默认 8：再高对上游没有好处，而 `MODEL_NOT_IN_LIST` 是纯查询、很快返回，
 * 真正的耗时来自可用模型的流式响应，那一部分用 `max_tokens: 8` 压住。
 *
 * @param {{ token: string, repo: string, ids: string[], concurrency?: number, flavour?: 'v2' | 'v1', fetchImpl?: typeof fetch }} input
 * @returns {Promise<{ available: string[], notEntitled: string[], unknown: string[], failed: Array<{ id: string, detail?: string }>, probed: number }>}
 */
export async function discoverModels(input) {
  const ids = [...new Set(input.ids.map((id) => String(id).trim()).filter(Boolean))]
  const concurrency = Math.max(1, Math.min(16, input.concurrency ?? 8))
  const available = []
  const notEntitled = []
  const unknown = []
  const failed = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
    while (cursor < ids.length) {
      const index = cursor
      cursor += 1
      const id = ids[index]
      const result = await probeModel({
        token: input.token,
        repo: input.repo,
        id,
        flavour: input.flavour,
        // 透传注入的 fetch：测试要能不碰网络地驱动这套分类，云端也可以换成
        // 带重试或带计时的实现。
        ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
      })
      if (result.verdict === VERDICTS.ok) available.push(id)
      else if (result.verdict === VERDICTS.unknown) unknown.push(id)
      else if (result.verdict === VERDICTS.notEntitled) notEntitled.push(id)
      else failed.push({ id, detail: result.detail })
    }
  })
  await Promise.all(workers)
  // 保持输入顺序：面板上的模型列表不该因为并发完成顺序而跳动。
  const order = new Map(ids.map((id, index) => [id, index]))
  const sort = (list) => [...list].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  return {
    available: sort(available),
    notEntitled: sort(notEntitled),
    unknown: sort(unknown),
    failed,
    probed: ids.length,
  }
}

/**
 * 模型 id → 元数据。
 *
 * 网关只回答「能不能用」，不回答上下文窗口。按 id 里的家族线索给一个保守值：
 * 写大了会让请求在中途被上游截断，写小了只是提前压缩历史 —— 所以宁可小。
 *
 * 推理模型（`hy4*`、`step-5*`、`space-bunny`）先吐 `reasoning_content` 再给
 * `content`。实测 `hy4` 在 `max_tokens: 64` 时内容会被推理占满、`content` 为空
 * （`finish_reason` 仍是 `stop`，所以从状态上看是「成功」）。这类模型必须给足
 * 预算，`maxTokens` 因此不同 —— 调用方据此判断「空回复」是不是预算问题。
 *
 * @param {string} id
 * @returns {{ id: string, name: string, contextWindow: number, maxTokens: number, reasoning: boolean }}
 */
export function describeModel(id) {
  const lower = id.toLowerCase()
  let contextWindow = 128_000
  let maxTokens = 8_192
  if (lower.includes('deepseek')) {
    contextWindow = 256_000
    maxTokens = 8_192
  } else if (lower.startsWith('glm')) {
    contextWindow = 128_000
    maxTokens = 8_192
  } else if (lower.startsWith('minimax') || lower.startsWith('mimo')) {
    contextWindow = 128_000
    maxTokens = 8_192
  }
  // 先推理后作答：预算太小会只剩推理、没有答案。
  const reasoning = lower.startsWith('hy4') || lower.startsWith('step') || lower.includes('space-bunny')
  return {
    id,
    name: id,
    contextWindow,
    maxTokens: reasoning ? 32_768 : maxTokens,
    reasoning,
  }
}

/**
 * 合并「用户点名要的」与「探测发现的」，给出最终对外清单。
 *
 * 用户点名但探测失败的照旧**排除** —— 一条永远 403 的模型写进 provider 只会让
 * dsh 的选择器里出现一个必然失败的选项。排除了什么、为什么，由调用方报出来。
 *
 * @param {{ requested?: string[], discovered: string[], fallback?: string[] }} input
 */
export function resolveModelCatalog(input) {
  const requested = (input.requested ?? []).map((id) => String(id).trim()).filter(Boolean)
  const discovered = input.discovered ?? []
  const merged = []
  const seen = new Set()
  for (const id of [...requested, ...discovered]) {
    if (seen.has(id)) continue
    seen.add(id)
    merged.push(id)
  }
  if (merged.length === 0) return [...(input.fallback ?? [])]
  return merged
}
