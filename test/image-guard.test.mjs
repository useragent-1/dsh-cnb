/**
 * 图片链路：形状归一、远程内联、失败处置。
 *
 * 这些结论都来自真打上游（2026-11，`/-/ai-ide/v2`）：
 *
 *   · 规范形状 `{type:'image_url', image_url:{url:'data:image/png;base64,…'}}`
 *     → 200，且模型真能识图（三圆图数出 3、说横排、认颜色）；
 *   · 远程 http(s) url 直传 → 400 / 11133（上游不替客户端下载）；
 *   · Anthropic 形状 `{type:'image', source:{…}}` → 400 / 11101
 *     "unsupported content type at index 1: image"。
 *
 * 换句话说：形状错了不是降级，是**整条请求被拒**。所以归一不是优化，是可用性。
 */
import assert from 'node:assert/strict'
import {
  canonicalizeImageParts,
  dataUrlBytes,
  inlineRemoteImages,
  isImagePart,
  isInlineImageUrl,
  imageUrlOf,
  prepareImages,
} from '../lib/image-guard.js'

/** 1x1 PNG，够用来断言字节数与 data URL 形状。 */
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// --- 1. 四种客户端形状都能取出地址 ------------------------------------
{
  assert.equal(imageUrlOf({ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }), 'data:image/png;base64,AA')
  assert.equal(imageUrlOf({ type: 'image_url', image_url: 'data:image/png;base64,AA' }), 'data:image/png;base64,AA')
  assert.equal(imageUrlOf({ type: 'input_image', image_url: 'https://x/y.png' }), 'https://x/y.png')
  assert.equal(
    imageUrlOf({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AA' } }),
    'data:image/jpeg;base64,AA',
    'Anthropic base64 becomes a data URL',
  )
  assert.equal(imageUrlOf({ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }), 'https://x/y.png')
  assert.equal(imageUrlOf({ type: 'image', url: 'https://x/y.png' }), 'https://x/y.png')
  assert.equal(imageUrlOf({ type: 'image', data: 'AA', mime_type: 'image/webp' }), 'data:image/webp;base64,AA')
  // 非图片段不该被误判。
  assert.equal(imageUrlOf({ type: 'text', text: 'hi' }), '')
  assert.equal(imageUrlOf('image_url'), '')
}

// --- 2. 只认 data URL -------------------------------------------------
{
  assert.ok(isInlineImageUrl(TINY_PNG))
  assert.ok(isInlineImageUrl('data:image/svg+xml;base64,AA'), 'svg is still an image/* data url')
  assert.equal(isInlineImageUrl('https://x/y.png'), false)
  assert.equal(isInlineImageUrl('data:text/plain;base64,AA'), false, 'a non-image data url is not an image')
  // 字节数：base64 解码后的大小，用于超限判断。
  assert.ok(dataUrlBytes(TINY_PNG) > 0)
  assert.equal(dataUrlBytes('data:image/png;base64,'), 0)
}

// --- 3. 归一：Anthropic / Responses 形状都落到 image_url --------------
{
  const { payload, stats } = canonicalizeImageParts({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } },
        { type: 'input_image', image_url: 'https://x/y.png' },
      ],
    }],
  })
  const parts = payload.messages[0].content
  assert.equal(stats.images, 2)
  assert.equal(stats.converted, 2, 'both non-canonical shapes are rewritten')
  assert.equal(stats.remote, 1, 'the http url is flagged for inlining')
  assert.deepEqual(parts.map((part) => part.type), ['text', 'image_url', 'image_url'])
  assert.equal(parts[1].image_url.url, 'data:image/png;base64,AA')
  assert.equal(parts[2].image_url.url, 'https://x/y.png')
  // 已经是规范形状的段不该被记成 converted。
  const again = canonicalizeImageParts({ messages: [{ role: 'user', content: [parts[1]] }] })
  assert.equal(again.stats.converted, 0, 'normalisation is idempotent')
}

// --- 4. detail 透传；规范形状不被压扁 ---------------------------------
{
  const { payload } = canonicalizeImageParts({
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: TINY_PNG, detail: 'high' } }] }],
  })
  assert.equal(payload.messages[0].content[0].image_url.detail, 'high')
  const fromAnthropic = canonicalizeImageParts({
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'AA' }, detail: 'low' }] }],
  })
  assert.equal(fromAnthropic.payload.messages[0].content[0].image_url.detail, 'low')
}

// --- 5. 认不出地址的图片段要丢，不能发给上游 -------------------------
{
  const { payload, stats } = canonicalizeImageParts({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image_url', image_url: {} },
        { type: 'image', source: { type: 'file', file_id: 'x' } },
      ],
    }],
  })
  assert.equal(stats.dropped, 2, 'parts with no usable url are dropped')
  assert.deepEqual(payload.messages[0].content.map((part) => part.type), ['text'])
  assert.equal(isImagePart({ type: 'image' }), true)
  assert.equal(isImagePart({ type: 'text' }), false)
}

// --- 6. 超限的内联图原样透传（报错比悄悄少一张图好查）----------------
{
  const big = `data:image/png;base64,${'A'.repeat(2048)}`
  const { payload, stats } = canonicalizeImageParts(
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: big } }] }] },
    { maxBytes: 64 },
  )
  assert.equal(stats.oversize, 1)
  assert.equal(payload.messages[0].content[0].image_url.url, big, 'an oversized image is passed through untouched')
}

// --- 7. 远程图内联成功 ------------------------------------------------
{
  const bytes = Buffer.from('fake-png-bytes')
  const fakeFetch = async (url) => {
    assert.equal(url, 'https://x/y.png')
    return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } })
  }
  const { payload, stats } = await inlineRemoteImages(
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] }] },
    { fetchImpl: fakeFetch },
  )
  assert.equal(stats.inlined, 1)
  assert.equal(stats.failed, 0)
  const url = payload.messages[0].content[0].image_url.url
  assert.ok(url.startsWith('data:image/png;base64,'), 'the fetched bytes become a data URL')
  assert.deepEqual(Buffer.from(url.split(',')[1], 'base64'), bytes, 'and they are the original bytes')
}

// --- 8. 取不回的图变成一句说明，而不是消失 ----------------------------
{
  const cases = [
    async () => new Response('nope', { status: 404 }),
    async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    async () => { throw new Error('ETIMEDOUT') },
    async () => new Response('', { status: 200, headers: { 'content-type': 'image/png' } }),
  ]
  for (const fakeFetch of cases) {
    const { payload, stats } = await inlineRemoteImages(
      { messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'https://x/y.png' } }] }] },
      { fetchImpl: fakeFetch },
    )
    assert.equal(stats.failed, 1)
    const parts = payload.messages[0].content
    assert.equal(parts[0].type, 'text', 'the surrounding text is untouched')
    assert.equal(parts[1].type, 'text', 'the dead image becomes a text note')
    assert.match(parts[1].text, /图片未能取回/, 'so the model can say the image never arrived')
  }
}

// --- 9. prepareImages：同步归一 + 异步内联一步到位 --------------------
{
  const fakeFetch = async () => new Response(Buffer.from('abc'), { status: 200, headers: { 'content-type': 'image/jpeg' } })
  const { payload, stats } = await prepareImages(
    {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', source: { type: 'url', url: 'https://x/y.jpg' } },
        ],
      }],
    },
    { fetchImpl: fakeFetch },
  )
  assert.equal(stats.images, 1)
  assert.equal(stats.remote, 1)
  assert.equal(stats.inlined, 1)
  const part = payload.messages[0].content[1]
  assert.equal(part.type, 'image_url')
  assert.ok(part.image_url.url.startsWith('data:image/jpeg;base64,'))
}

// --- 10. 没有图片时不该产生任何消耗 ----------------------------------
{
  const calls = []
  const fakeFetch = async (url) => { calls.push(url); return new Response('x') }
  const { payload, stats } = await prepareImages(
    { messages: [{ role: 'user', content: '纯文字' }] },
    { fetchImpl: fakeFetch },
  )
  assert.equal(calls.length, 0, 'no fetch happens for a text-only request')
  assert.equal(stats.images, 0)
  assert.equal(payload.messages[0].content, '纯文字', 'string content is untouched')
}
