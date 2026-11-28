/**
 * 模型清单的完整性：FREE_MODELS 现在住在 model-catalog.js。
 *
 * 这份清单原来在 issue-gateway.js 里（Issue 反代那套已经整个删掉了），
 * 但 `local.*` 本地直连仍然依赖它列模型 —— 所以搬到 model-catalog.js 保留。
 *
 * 钉住三件事：
 *   1. 每条都带标价信息（`pricePerMTok` 不能是 undefined，否则界面显示 ¥undefined）；
 *   2. `free` 只能由单价推导 —— 手写会造出「标着免费但计费」；
 *   3. 真正免费的档位必须包含在内（实测平台面板标 ~¥0.00/MTok 的那几个）。
 */
import assert from 'node:assert/strict'

import { FREE_MODELS } from '../lib/model-catalog.js'

// --- 1. 结构完整 ------------------------------------------------------
{
  assert.ok(Array.isArray(FREE_MODELS), 'FREE_MODELS 必须是数组')
  assert.ok(FREE_MODELS.length > 0, '模型清单不能为空')
  for (const entry of FREE_MODELS) {
    assert.equal(typeof entry.id, 'string')
    assert.ok(entry.id.length > 0)
    assert.notEqual(entry.pricePerMTok, undefined, `${entry.id} 缺 pricePerMTok`)
    assert.equal(
      entry.free === true,
      entry.pricePerMTok === 0,
      `${entry.id} 的 free 与 pricePerMTok 不一致`,
    )
  }
}

// --- 2. 免费档必须包含 ------------------------------------------------
{
  const free = FREE_MODELS.filter((entry) => entry.free === true).map((entry) => entry.id)
  assert.ok(free.includes('deepseek-v4.1-flash'), 'deepseek-v4.1-flash 应当是免费档')
  assert.ok(free.includes('hy4-flash'), 'hy4-flash 应当是免费档')
  // hy4 与 hy4-flash 是两个模型：前者 ¥0.78，后者免费。这个区别踩过。
  assert.ok(!free.includes('hy4'), 'hy4 不是免费档（¥0.78）')
}

// --- 3. 模型 id 不重复 ------------------------------------------------
{
  const ids = FREE_MODELS.map((entry) => entry.id)
  assert.equal(new Set(ids).size, ids.length, '模型 id 不能重复')
}

console.log('model catalog OK · 标价完整、free 由单价推导、免费档齐全')
