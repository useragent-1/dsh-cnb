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
 * 宽探测的 id 命名池：按家族拼出「可能存在」的 id，让上游自己回答存不存在。
 *
 * ## 为什么需要它
 *
 * 候选表是**静态**的，而上游是**动的**：它加了模型，静态表不会自己长出来。
 * 更糟的是这个失败是沉默的 —— 网关照常工作，只是少几个选项，没人会去数。
 * 实测（2026-11）就撞上过：云端只报 4 个模型，而实际可用 9 个。
 *
 * 既然一次全量探测只要约 3 秒（并发 8），就没有理由只探静态表。
 *
 * ## 代价可控
 *
 * 池子按家族 + 版本号组合，规模在百级；`MODEL_NOT_IN_LIST` 是纯查询、秒回，
 * 真正慢的是可用模型的流式响应，那部分用 `max_tokens: 8` 压住。默认关闭
 * （`DSH_GW_DISCOVER_WIDE=1` 开启），因为多数部署不需要每次启动都探一遍。
 */
export function wideProbeIds(seeds = []) {
  const families = [
    'deepseek-v4', 'deepseek-v4.1', 'deepseek-v4.2',
    'glm-5.3', 'glm-5.4', 'glm-5',
    'step-5', 'step-6',
    'mimo-v2.6', 'mimo-v2',
    'minimax-m3.1', 'minimax-m3',
    'space-bunny', 'hy4', 'hy5',
  ]
  const suffixes = ['', '-flash', '-pro', '-air', '-turbo', '-preview', '-max', '-flashx', 'std', 'free']
  const ids = new Set(seeds)
  for (const family of families) {
    ids.add(family)
    for (const suffix of suffixes) ids.add(`${family}${suffix}`)
  }
  return [...ids]
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
 *//**
 * 已知模型的完整画像：上下文窗口、输出预算、可选的推理档位。
 *
 * 这些数字不是猜的，是本地 8791 网关那份**经实测长期可用**的配置：
 * 每个模型一套 `reasoningEfforts`，直接决定 dsh 模型选择器里显示几个强度档。
 *
 * 为什么必须按模型分开写，而不是套一个统一模板：
 *
 *   · `deepseek-v4-flash` 只有 `high`；给它标上 `low`/`max`，用户选了那些档位
 *     请求就会被上游按不支持的参数处理；
 *   · `step-5-preview` 有 `medium`，`deepseek-v4.1-flash` 有 `off` 和 `max`；
 *   · `space-bunny` 和 `minimax-m3.1-flash` 支持到 `xhigh`。
 *
 * 实测过「上游对任意 reasoning_effort 都回 200」——所以不能靠探测来判断档位，
 * 只能按已知画像来。这也是这张表存在的理由。
 *
 * `efforts` 用 pi-ai 的档位名；`off: null` 表示「关掉思考」这个档位要发空值。
 */
export const MODEL_CATALOG = {
  'deepseek-v4-flash': { contextWindow: 1_000_000, maxTokens: 50_000, efforts: ['high'] },
  'deepseek-v4.1-flash': { contextWindow: 1_000_000, maxTokens: 128_000, efforts: ['off', 'low', 'high', 'max'] },
  'glm-5.3-flash': { contextWindow: 1_000_000, maxTokens: 131_072, efforts: ['low', 'high', 'max'] },
  'glm-5.3-flashx': { contextWindow: 1_000_000, maxTokens: 131_072, efforts: ['low', 'high', 'max'] },
  'step-5-preview': { contextWindow: 1_000_000, maxTokens: 64_000, efforts: ['low', 'medium', 'high'] },
  'space-bunny': { contextWindow: 1_000_000, maxTokens: 128_000, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'mimo-v2.6-pro': { contextWindow: 1_000_000, maxTokens: 128_000, efforts: ['high'] },
  'minimax-m3.1-flash': { contextWindow: 1_000_000, maxTokens: 128_000, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  hy4free: { contextWindow: 960_000, maxTokens: 64_000, efforts: ['high'] },
  hy4std: { contextWindow: 960_000, maxTokens: 64_000, efforts: ['high'] },
  hy4: { contextWindow: 960_000, maxTokens: 64_000, efforts: ['high'] },
}

/**
 * 模型 id → 写进 provider 的元数据。
 *
 * 表里有就照表（那是实测过的档位）；没有就按家族给一个**保守**默认：
 * 上下文窗口宁可小（写大了请求会在中途被上游截断），推理档位宁可少
 * （给了不支持的档位等于制造一个必然失败的选项）。
 *
 * @param {string} id
 * @returns {{ id: string, name: string, contextWindow: number, maxTokens: number, efforts: string[] }}
 */
export function describeModel(id) {
  const known = MODEL_CATALOG[id]
  if (known !== undefined) {
    return { id, name: id, contextWindow: known.contextWindow, maxTokens: known.maxTokens, efforts: [...known.efforts] }
  }
  const lower = String(id).toLowerCase()
  // 先推理后作答的家族：预算要留够，否则只剩 reasoning_content、答案为空。
  const drawsOut = lower.startsWith('hy4') || lower.startsWith('step') || lower.includes('space-bunny')
  return {
    id,
    name: id,
    contextWindow: lower.includes('deepseek') ? 256_000 : 128_000,
    maxTokens: drawsOut ? 32_768 : 8_192,
    // 未知模型的档位只留一个最通用的，不编造它支持哪些强度。
    efforts: ['high'],
  }
}

/**
 * 可选档位的展示顺序：dsh 的选择器按这个顺序排。
 */
export const EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 把 `efforts` 数组排成稳定顺序。
 * @param {string[]} efforts
 */
export function orderEfforts(efforts) {
  return [...new Set(efforts)].sort((a, b) => {
    const ia = EFFORT_ORDER.indexOf(a)
    const ib = EFFORT_ORDER.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
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
