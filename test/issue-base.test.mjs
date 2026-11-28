/**
 * 可选模型清单（MODEL_CHOICES）的完整性 —— 它是「模型接入」面板唯一的数据源。
 *
 * ## 这份清单凭什么是这 9 个
 *
 * 每个 id 都实测过（2026-11-28，api.cnb.cool/-/ai-ide/v2）：发流式请求确认能出字、
 * 看响应的 `model` 字段是否与请求同名、再问「你是什么模型」交叉核对厂商。
 *
 * 实测剔除的：
 *   · `hy4std` —— 请求过去永远返回 `model: hy4`（连测 3 次），是别名不是独立模型；
 *   · `hy4free` —— 上游答 MODEL_NOT_IN_LIST，这个名字不存在；
 *   · `glm-5.3-flashx` / `glm-5.4` / `glm-5.3` —— VIP 档，当前账号用不了。
 *
 * 这个套件钉住的就是这些结论，防止有人把别名或 VIP 又加回来。
 */
import assert from 'node:assert/strict'

import { MODEL_CHOICES } from '../lib/model-catalog.js'

// --- 1. 结构：每条要有 id 和 rate 字段 ------------------------------
{
  assert.ok(Array.isArray(MODEL_CHOICES), 'MODEL_CHOICES 必须是数组')
  assert.ok(MODEL_CHOICES.length > 0, '模型清单不能为空')
  for (const entry of MODEL_CHOICES) {
    assert.equal(typeof entry.id, 'string')
    assert.ok(entry.id.length > 0)
    // rate 必须显式存在（可以是 null 表示面板未列出），不能 undefined ——
    // 那会让界面渲染出 "undefined"。
    assert.ok('rate' in entry, `${entry.id} 缺 rate 字段`)
  }
}

// --- 2. 别名必须剔除 ------------------------------------------------
{
  const ids = MODEL_CHOICES.map((entry) => entry.id)
  assert.ok(!ids.includes('hy4std'), 'hy4std 是 hy4 的别名（实测返回 model=hy4），不能算独立模型')
  assert.ok(!ids.includes('hy4free'), 'hy4free 这个模型不存在（MODEL_NOT_IN_LIST）')
  // hy4 与 hy4-flash 是两个真实独立的模型，都要在。
  assert.ok(ids.includes('hy4'), 'hy4 应当在')
  assert.ok(ids.includes('hy4-flash'), 'hy4-flash 是独立模型，应当在')
}

// --- 3. VIP 档必须剔除 ----------------------------------------------
{
  const ids = MODEL_CHOICES.map((entry) => entry.id)
  for (const vip of ['glm-5.3-flashx', 'glm-5.4', 'glm-5.3']) {
    assert.ok(!ids.includes(vip), `${vip} 是 VIP 档，当前账号用不了，必须剔除`)
  }
}

// --- 4. rate 是 "x" 结尾的字符串或 null -----------------------------
{
  for (const entry of MODEL_CHOICES) {
    const rate = entry.rate
    if (rate === null) continue
    assert.equal(typeof rate, 'string', `${entry.id} 的 rate 必须是字符串或 null`)
    assert.match(rate, /^\d+(\.\d+)?x$/, `${entry.id} 的 rate 应形如 0.08x，实际是 ${rate}`)
  }
}

// --- 5. 文案里不能再出现「免费」「VIP」「¥」-------------------------
{
  for (const entry of MODEL_CHOICES) {
    for (const field of ['label', 'note']) {
      const value = entry[field]
      if (typeof value !== 'string') continue
      assert.ok(!value.includes('免费'), `${entry.id} 的 ${field} 里不该出现「免费」`)
      assert.ok(!value.includes('VIP'), `${entry.id} 的 ${field} 里不该出现「VIP」`)
    }
  }
}

// --- 6. id 不重复 ---------------------------------------------------
{
  const ids = MODEL_CHOICES.map((entry) => entry.id)
  assert.equal(new Set(ids).size, ids.length, '模型 id 不能重复')
}

console.log('model choices OK · 9 个独立模型、无别名无 VIP、倍率格式正确')
