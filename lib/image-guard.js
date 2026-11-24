/**
 * 图片段归一：把各家客户端的多模态形状，收敛成上游唯一接受的那一种。
 *
 * ## 为什么需要这一层
 *
 * `/-/ai-ide/v2` 只实现 OpenAI 的 `image_url`，而且**只吃 base64 data URL**。
 * 实测（2026-11，逐个形状真打上游）：
 *
 *   { type:'image_url', image_url:{ url:'data:image/png;base64,…' } }   → 200，正确识图
 *   { type:'image_url', image_url:{ url:'https://…/x.png' } }           → 400 / 11133
 *   { type:'image',     source:{ type:'base64', … } }                   → 400 / 11101
 *                                                                         "unsupported
 *                                                                          content type at
 *                                                                          index 1: image"
 *
 * 也就是说：形状不对不是「降级成纯文本」，而是**整条请求被拒**。早先的做法是
 * 把图片段直接丢掉（`drop:image-part`）—— 请求能通，但模型根本没看到图，用户
 * 只会得到一段对着空气的描述。既然上游明明能识图，丢图就是错的。
 *
 * ## 分两步，因为一步做不到
 *
 *   · {@link canonicalizeImageParts} 是**同步纯函数**：只改形状，不碰网络。
 *     它挂在 `sanitizePayload` 里，于是所有形状归一与指纹改写共用同一条路径。
 *   · {@link inlineRemoteImages} 是**异步**的：远程 url 必须由这里下载并转成
 *     data URL。放下载进同步函数会把整条修复阶梯变成 async，那个代价不值。
 *
 * 两步都保持语义：模型读到的图还是那张图，只是换了承载方式。
 */

/** 上游认的三种「图片段」类型名（其余段一律原样保留）。 */
const IMAGE_PART_TYPES = new Set(['image', 'image_url', 'input_image'])

/**
 * 单张内联图上限，默认 4 MiB。
 *
 * base64 之后约膨胀 4/3，加上正文仍在 `MAX_BODY`（32 MiB）之内。超限时**不静默
 * 丢图**：原样透传，让上游给出明确的参数错误 —— 悄悄少一张图比报错更难查。
 */
export const DEFAULT_MAX_IMAGE_BYTES = Number(process.env.DSH_GW_MAX_IMAGE_BYTES ?? 4 * 1024 * 1024)

/** 远程图片下载超时：拿不到就留着原 url，让上游拒绝，不拖住整条请求。 */
export const DEFAULT_IMAGE_TIMEOUT_MS = Number(process.env.DSH_GW_IMAGE_TIMEOUT_MS ?? 10_000)

/**
 * 从一个段里取出图片地址。
 *
 * 覆盖的形状（都来自真实客户端，不是想象）：
 *
 *   OpenAI 新式   { type:'image_url', image_url:{ url } }
 *   OpenAI 简化式 { type:'image_url', image_url:'data:…' }
 *   Responses     { type:'input_image', image_url:'…' }
 *   Anthropic     { type:'image', source:{ type:'base64', media_type, data } }
 *   Anthropic URL { type:'image', source:{ type:'url', url } }
 *   杂牌          { type:'image', url } / { type:'image', data, mime_type }
 *
 * @param {any} part
 * @returns {string} 远程 URL、data URL；'' 表示这不是图片段
 */
export function imageUrlOf(part) {
  if (part === null || typeof part !== 'object') return ''
  if (!IMAGE_PART_TYPES.has(part.type)) return ''

  const direct = part.image_url
  if (typeof direct === 'string') return direct
  if (direct !== null && typeof direct === 'object' && typeof direct.url === 'string') return direct.url

  const source = part.source
  if (source !== null && typeof source === 'object') {
    if (source.type === 'base64' && typeof source.data === 'string' && source.data !== '') {
      const mediaType = typeof source.media_type === 'string' && source.media_type !== ''
        ? source.media_type
        : 'image/png'
      return `data:${mediaType};base64,${source.data}`
    }
    if (typeof source.url === 'string' && source.url !== '') return source.url
  }

  if (typeof part.url === 'string' && part.url !== '') return part.url
  if (typeof part.data === 'string' && part.data !== '') {
    const mediaType = typeof part.mime_type === 'string' && part.mime_type !== ''
      ? part.mime_type
      : 'image/png'
    return `data:${mediaType};base64,${part.data}`
  }
  return ''
}

/**
 * 这个段是不是图片段（不管形状能不能认出来）。
 *
 * 归一要用它：认得出 url 的转成规范形状；**认不出 url 的图片段也不能留** ——
 * 留着就是 11101。这种段被丢掉并且让调用方记一笔，因为那是真的丢内容。
 * @param {any} part
 */
export function isImagePart(part) {
  return part !== null && typeof part === 'object' && IMAGE_PART_TYPES.has(part.type)
}

/** data URL 解回来以后的原始字节数。 */
export function dataUrlBytes(url) {
  const comma = String(url).indexOf(',')
  if (comma === -1) return 0
  const payload = String(url).slice(comma + 1)
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
}

/** 能不能交给上游（只认 data URL）。 */
export function isInlineImageUrl(url) {
  return typeof url === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(url)
}

/**
 * 同步归一：把 `messages[].content` 里的图片段改成上游认的规范形状。
 *
 * 只改形状，不下网络 —— 因此可以放进同步的 `sanitizePayload`。远程 url 在这一步
 * 原样保留，交给 {@link inlineRemoteImages} 处理；`stats.remote` 记录还有几张待内联。
 *
 * @param {Record<string, any>} payload
 * @param {{ maxBytes?: number }} [options]
 * @returns {{ payload: Record<string, any>, stats: { images: number, converted: number, dropped: number, oversize: number, remote: number } }}
 */
export function canonicalizeImageParts(payload, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES
  const stats = { images: 0, converted: 0, dropped: 0, oversize: 0, remote: 0 }
  if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.messages)) {
    return { payload, stats }
  }

  const messages = payload.messages.map((message) => {
    if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return message
    let touched = false
    const content = []
    for (const part of message.content) {
      if (!isImagePart(part)) {
        content.push(part)
        continue
      }
      stats.images += 1
      const url = imageUrlOf(part)
      // 认不出地址的图片段：留着必被上游 11101 拒，只能丢，并让调用方知道丢了。
      if (url === '') {
        stats.dropped += 1
        touched = true
        continue
      }
      if (isInlineImageUrl(url)) {
        if (dataUrlBytes(url) > maxBytes) {
          // 超限：原样透传，让上游报明确的参数错，而不是我们悄悄少一张图。
          stats.oversize += 1
          content.push(part)
          continue
        }
      } else if (!/^https?:\/\//i.test(url)) {
        // 既不是 data URL 也不是 http(s)（例如 file://）：上游无法解析。
        stats.dropped += 1
        touched = true
        continue
      } else {
        stats.remote += 1
      }

      const canonical = { type: 'image_url', image_url: { url } }
      // detail 是合法协议字段，能穿透就穿透。
      const detail = part.detail ?? (part.image_url !== null && typeof part.image_url === 'object' ? part.image_url.detail : undefined)
      if (typeof detail === 'string' && detail !== '') canonical.image_url.detail = detail
      if (part.type !== 'image_url' || typeof part.image_url !== 'object') stats.converted += 1
      content.push(canonical)
      touched = true
    }
    return touched ? { ...message, content } : message
  })

  return { payload: { ...payload, messages }, stats }
}

/**
 * 远程图片转成内联 data URL。下载失败返回 ''，由调用方决定怎么处置。
 *
 * 上游不会自己去下载 http(s) 地址（实测直接 11133），所以这一步是「远程图能不能
 * 用」的唯一开关。
 *
 * @param {string} url
 * @param {{ maxBytes: number, timeoutMs: number, fetchImpl?: typeof fetch }} options
 * @returns {Promise<string>}
 */
export async function inlineRemote(url, options) {
  const doFetch = options.fetchImpl ?? fetch
  try {
    const response = await doFetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: { accept: 'image/*' },
      redirect: 'follow',
    })
    if (!response.ok) return ''
    const type = String(response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!type.startsWith('image/')) return ''
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength === 0 || buffer.byteLength > options.maxBytes) return ''
    return `data:${type};base64,${buffer.toString('base64')}`
  } catch {
    return ''
  }
}

/**
 * 异步：把还留着的 http(s) 图片段下载并内联。
 *
 * 下载失败时**把该段变成一句文字说明**而不是删掉。理由：静默删掉的话，模型会
 * 对着一张不存在的图作答，用户永远不知道图没传上去；一段明确的「这张图没能取回」
 * 至少能被模型复述出来。
 *
 * @param {Record<string, any>} payload
 * @param {{ maxBytes?: number, timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ payload: Record<string, any>, stats: { inlined: number, failed: number } }>}
 */
export async function inlineRemoteImages(payload, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS
  const stats = { inlined: 0, failed: 0 }
  if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.messages)) {
    return { payload, stats }
  }

  const messages = await Promise.all(payload.messages.map(async (message) => {
    if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return message
    let touched = false
    const content = await Promise.all(message.content.map(async (part) => {
      const url = imageUrlOf(part)
      if (url === '' || !/^https?:\/\//i.test(url)) return part
      const inlined = await inlineRemote(url, {
        maxBytes,
        timeoutMs,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      })
      touched = true
      if (inlined !== '') {
        stats.inlined += 1
        const canonical = { type: 'image_url', image_url: { url: inlined } }
        const detail = part.detail ?? (part.image_url !== null && typeof part.image_url === 'object' ? part.image_url.detail : undefined)
        if (typeof detail === 'string' && detail !== '') canonical.image_url.detail = detail
        return canonical
      }
      stats.failed += 1
      return { type: 'text', text: `[图片未能取回：${url}]` }
    }))
    return touched ? { ...message, content } : message
  }))

  return { payload: { ...payload, messages }, stats }
}

/**
 * 一步到位：同步归一 + 异步内联。网关在转发前调它。
 *
 * @param {Record<string, any>} payload
 * @param {{ maxBytes?: number, timeoutMs?: number, fetchImpl?: typeof fetch, inlineRemote?: boolean }} [options]
 */
export async function prepareImages(payload, options = {}) {
  const { payload: canonical, stats } = canonicalizeImageParts(payload, options)
  if (stats.remote === 0 || options.inlineRemote === false) {
    return { payload: canonical, stats: { ...stats, inlined: 0, failed: 0 } }
  }
  const { payload: inlined, stats: inline } = await inlineRemoteImages(canonical, options)
  return { payload: inlined, stats: { ...stats, ...inline } }
}

/** 请求里有没有图片段（`/v1/models` 与诊断用）。 */
export function hasImageParts(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  return messages.some((message) => Array.isArray(message?.content) && message.content.some(isImagePart))
}
