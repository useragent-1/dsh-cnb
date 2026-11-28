/**
 * 导进 dsh 的模型条目：图片默认开、窗口与输出用真实上限。
 *
 * ## 两条都踩过
 *
 * 1. **图片默认关**。`cloudProviderProfile` 里曾写死 `input: ['text']`，于是
 *    每个导进来的模型都只有文本输入。想发图得自己去 dsh 的 provider 设置里
 *    手动勾「图片」—— 而那一栏没有任何提示说明必须这么做，表现就是「图片发
 *    不出去」。CNB 这批模型实测都支持图片输入，所以默认带上。
 *
 * 2. **输出预算过小**。`maxTokens` 的兜底曾是 8_192，对一个 128k 的模型是
 *    浪费：长回答被自己的预算截断，界面上却看不出是谁截的（推理档位那栏一切
 *    正常）。现在上层传实测上限，兜底也提到同一量级。
 *
 * 这个套件钉住这两点，防止有人把它们改回「省一点」的小值。
 */
import assert from 'node:assert/strict'

import { MODEL_CATALOG, describeModel } from '../lib/model-catalog.js'
import { cloudProviderProfile } from '../lib/provision.js'
import { gatewayProviderProfile } from '../lib/index.js'

const PROFILE_ARGS = {
  repo: 'acme/gw',
  baseURL: 'https://example.test/v1',
  apiKeyEnv: 'TEST_KEY',
  models: ['deepseek-v4.1-flash', 'glm-5.3-flash', 'hy4-flash'].map((id) => describeModel(id)),
}

// --- 1. 图片输入默认开 ----------------------------------------------
{
  const profile = cloudProviderProfile(PROFILE_ARGS)
  assert.ok(profile.models.length > 0)
  for (const model of profile.models) {
    assert.ok(
      Array.isArray(model.input) && model.input.includes('image'),
      `${model.id} 的 input 必须含 image，实际 ${JSON.stringify(model.input)}`,
    )
    assert.ok(model.input.includes('text'), `${model.id} 也必须保留 text`)
  }
}

// --- 2. 上下文与输出用真实上限，不是 8192 ----------------------------
{
  const profile = cloudProviderProfile(PROFILE_ARGS)
  for (const model of profile.models) {
    const real = MODEL_CATALOG[model.id]
    assert.notEqual(real, undefined, `${model.id} 必须在 MODEL_CATALOG 里（否则总量会走兜底）`)
    assert.equal(model.contextWindow, real.contextWindow, `${model.id} 的 contextWindow 应与实测一致`)
    assert.equal(model.maxTokens, real.maxTokens, `${model.id} 的 maxTokens 应与实测一致`)
    // 8192 是旧兜底值，不该再出现。
    assert.notEqual(model.maxTokens, 8_192, `${model.id} 的 maxTokens 不该退回 8192`)
    assert.ok(model.maxTokens >= 50_000, `${model.id} 的输出预算应在上限量级`)
  }
}

// --- 3. 漏传元数据时兜底也不能太小 ----------------------------------
{
  const profile = cloudProviderProfile({
    ...PROFILE_ARGS,
    // 只给 id，不给 contextWindow/maxTokens —— 走兜底分支
    models: [{ id: 'mystery-model' }],
  })
  const [model] = profile.models
  assert.equal(model.input[0], 'text')
  assert.ok(model.input.includes('image'), '兜底也要带 image')
  assert.ok(model.contextWindow >= 1_000_000, `兜底 contextWindow 太小：${model.contextWindow}`)
  assert.ok(model.maxTokens >= 128_000, `兜底 maxTokens 太小：${model.maxTokens}`)
}

// --- 4. 调用方可以显式关掉图片 --------------------------------------
{
  const profile = cloudProviderProfile({
    ...PROFILE_ARGS,
    models: [{ id: 'text-only', contextWindow: 1000, maxTokens: 100, input: ['text'] }],
  })
  assert.deepEqual(profile.models[0].input, ['text'], '显式传 input 时应被尊重')
}

// --- 5. 直连 provider 同样不能给出 8192 -----------------------------
{
  const profile = gatewayProviderProfile({
    repo: 'acme/gw',
    model: 'x',
    models: [{ id: 'mystery', input: ['text'] }],
  })
  const [model] = profile.models
  assert.ok(model.maxTokens >= 128_000, `gatewayProviderProfile 兜底 maxTokens 太小：${model.maxTokens}`)
  assert.ok(model.contextWindow >= 1_000_000, `gatewayProviderProfile 兜底 contextWindow 太小：${model.contextWindow}`)
}

// --- 6. hy4-flash 必须有自己的画像 -----------------------------------
{
  // 早先漏在 MODEL_CATALOG 里，走了 modelEntry 的 128k/32k 兜底。
  assert.notEqual(MODEL_CATALOG['hy4-flash'], undefined, 'hy4-flash 必须有实测画像')
  const entry = describeModel('hy4-flash')
  assert.ok(entry.contextWindow >= 960_000, `hy4-flash 的 contextWindow 应 >= 960k，实际 ${entry.contextWindow}`)
}

console.log('provider defaults OK · 图片默认开、上限用实测值、兜底不再过小')
