/**
 * provider 画像里的输入模态必须写成 `input`。
 *
 * 这一条值得单独测，因为错误形态是**静默**的：
 *
 *   · pi-ai 的 `modelProfile` schema 只有 `input` 这个键；
 *   · schemastery 对未知键不报错，原样保留 —— 写 `input_modalities: [text, image]`
 *     能通过校验，配置看起来完全正常；
 *   · 但模型解析出来的 `input` 仍是默认 `[]`，于是 pi-ai 在发请求前就抛
 *     `does not support image input`，请求根本到不了网关。
 *
 * 实测（2026-11，api.cnb.cool，/-/ai-ide/v2）：除未开通的 glm-5.3-flashx 外，
 * 目录里每个模型都真能读图（三圆图数出 3 个、说出横排、认出颜色）。所以声明
 * `text` + `image` 是与实际能力一致的，不是乐观假设。
 */
import assert from 'node:assert/strict'
import { gatewayProviderProfile } from '../lib/index.js'

// --- 1. 默认画像声明了图片输入 ----------------------------------------
{
  const profile = gatewayProviderProfile({
    repo: 'acme/gw',
    model: 'deepseek-v4.1-flash',
    models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000, maxTokens: 128_000 }],
  })
  const model = profile.models[0]
  assert.deepEqual(model.input, ['text', 'image'], 'the model declares image input')
  assert.equal(model.input_modalities, undefined, 'and not the display-only key pi-ai ignores')
  assert.equal(model.contextWindow, 1_000_000)
  assert.equal(model.maxTokens, 128_000)
}

// --- 2. 显式画像能收窄（纯文本模型不该被写成多模态）--------------------
{
  const profile = gatewayProviderProfile({
    repo: 'acme/gw',
    model: 'text-only',
    models: [
      { id: 'text-only', input: ['text'] },
      { id: 'both', input: ['text', 'image'] },
    ],
  })
  assert.deepEqual(profile.models[0].input, ['text'], 'an explicit text-only entry stays text-only')
  assert.deepEqual(profile.models[1].input, ['text', 'image'])
  // 空数组等价于「没说」：`[]` 描述的是一个什么都收不了的模型，pi-ai 会退回默认。
  assert.deepEqual(
    gatewayProviderProfile({ repo: 'r', model: 'm', models: [{ id: 'm', input: [] }] }).models[0].input,
    ['text', 'image'],
    'an empty list falls back to the default rather than describing a model that accepts nothing',
  )
}

// --- 3. 画像里每个模型都带 input（面板逐条读）--------------------------
{
  const ids = ['deepseek-v4.1-flash', 'glm-5.3-flash', 'hy4', 'step-5-preview']
  const profile = gatewayProviderProfile({ repo: 'r', model: ids[0], models: ids.map((id) => ({ id })) })
  for (const model of profile.models) {
    assert.deepEqual(model.input, ['text', 'image'], `${model.id} declares image input`)
  }
}
