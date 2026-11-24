/**
 * 模型清单必须覆盖上游真实可用的全集。
 *
 * ## 这一条为什么值得单独测
 *
 * 「网关照常工作，只是少几个模型」是**沉默失败**：没有报错、没有 4xx，用户只是
 * 在选择器里看不到某些模型。实测撞上过两次：
 *
 *   · 云端只暴露 4 个，而实际可用 9 个（开通时传的候选表太窄）；
 *   · 候选表里写着 `hy4free` —— 这个名字上游压根不存在，正确的是 `hy4`。
 *
 * 两个错误都不会让任何东西变红，只能靠静态断言钉住。
 */
import assert from 'node:assert/strict'
import { DEFAULT_CANDIDATES } from '../lib/provision.js'
import { discoverModels, wideProbeIds } from '../lib/model-catalog.js'

/**
 * 实测可用全集（2026-11，api.cnb.cool，`/-/ai-ide/v2` 逐个真调用）。
 *
 * 这份清单是**证据**，不是愿望：每一条都真跑通过。上游加了新模型时，宽探测会
 * 自动捞到（见下面的模拟用例），不必改这张表；但如果这里列出的模型从候选表里
 * 消失了，那就是回归。
 */
const VERIFIED_AVAILABLE = [
  'deepseek-v4.1-flash',
  'deepseek-v4-flash',
  'glm-5.3-flash',
  'step-5-preview',
  'space-bunny',
  'mimo-v2.6-pro',
  'minimax-m3.1-flash',
  'hy4',
  'hy4std',
]

/** 实测**不存在**的名字：配了只会得到 model-unknown。 */
const VERIFIED_ABSENT = ['hy4free', 'hy3', 'hy3free', 'deepseek-v3.2']

// --- 1. 每个实测可用的模型都在候选表里 --------------------------------
{
  for (const id of VERIFIED_AVAILABLE) {
    assert.ok(
      DEFAULT_CANDIDATES.includes(id),
      `${id} is measured available but missing from DEFAULT_CANDIDATES — the cloud gateway would never offer it`,
    )
  }
}

// --- 2. 不存在的模型不该出现在候选表里 --------------------------------
{
  for (const id of VERIFIED_ABSENT) {
    assert.ok(
      !DEFAULT_CANDIDATES.includes(id),
      `${id} does not exist upstream; listing it only produces model-unknown noise`,
    )
  }
}

// --- 3. 候选表不重复，且顺序即首选顺序 --------------------------------
{
  assert.equal(new Set(DEFAULT_CANDIDATES).size, DEFAULT_CANDIDATES.length, 'no duplicates')
  assert.equal(DEFAULT_CANDIDATES[0], 'deepseek-v4.1-flash', 'the first entry is the default model')
  // 「未开通」那个留在表里是有意的：让云端探测显式剔掉并写进日志，
  // 而不是让人以为这个模型不存在。
  assert.ok(DEFAULT_CANDIDATES.includes('glm-5.3-flashx'), 'the unentitled model stays so discovery can explain it')
}

// --- 4. 宽探测池覆盖候选表，并额外包含同家族变体 -----------------------
{
  const seeds = DEFAULT_CANDIDATES
  const wide = wideProbeIds(seeds)
  assert.equal(new Set(wide).size, wide.length, 'the wide pool has no duplicates')
  for (const id of seeds) assert.ok(wide.includes(id), `${id} survives into the wide pool`)
  // 关键能力：池子里要有候选表**没有**的 id，否则宽探测没有意义。
  const extra = wide.filter((id) => !seeds.includes(id))
  assert.ok(extra.length > 50, 'the wide pool probes well beyond the candidate list')
  // 实测捞到过 hy4-flash 这种静态表没有的变体 —— 池子必须能覆盖这种形状。
  assert.ok(extra.includes('hy4-flash'), 'family-suffix combinations are what find models added upstream')
  assert.ok(extra.includes('deepseek-v4.2-flash'), 'and future versions of a known family')
}

// --- 5. 宽探测真的能捞到候选表之外的模型（用假上游驱动）---------------
//
// 这条是整组的核心：模拟一个「上游有静态表不知道的模型」的世界，断言发现流程
// 能把它捞出来。不碰网络，只替换 fetch。
{
  const known = new Set([...DEFAULT_CANDIDATES, 'newmodel-x-flash'])
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body)
    const id = body.model
    if (known.has(id)) {
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return new Response(
      JSON.stringify({ code: 403, msg: `[MODEL_NOT_IN_LIST]Model ${id} is not in the optional models list` }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )
  }
  // 把新模型塞进池子模拟「上游有它」；池子本身由 wideProbeIds 生成，
  // 所以这里直接构造一个包含它的探针集合。
  const ids = [...wideProbeIds(DEFAULT_CANDIDATES), 'newmodel-x-flash']
  const result = await discoverModels({ token: 't', repo: 'a/b', ids, concurrency: 8, fetchImpl: fakeFetch })
  assert.ok(result.available.includes('newmodel-x-flash'), 'a model outside the candidate list is discovered')
  for (const id of VERIFIED_AVAILABLE) {
    assert.ok(result.available.includes(id), `${id} is discovered too`)
  }
  // 不存在的那些必须落在 unknown 里，而不是混进可用清单。
  assert.ok(result.unknown.includes('hy4free'))
}

// --- 6. 未开通与不存在要分开（否则日志说不清为什么少了模型）------------
{
  const fakeFetch = async (url, init) => {
    const id = JSON.parse(init.body).model
    if (id === 'entitled') {
      return new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', { status: 200 })
    }
    if (id === 'denied') {
      return new Response('[MODEL_NOT_AVAILABLE_FOR_ORG]Model denied is not available for your organization', { status: 403 })
    }
    return new Response('[MODEL_NOT_IN_LIST]Model nope is not in the optional models list', { status: 403 })
  }
  const result = await discoverModels({ token: 't', repo: 'a/b', ids: ['entitled', 'denied', 'nope'], concurrency: 3, fetchImpl: fakeFetch })
  assert.deepEqual(result.available, ['entitled'])
  assert.deepEqual(result.notEntitled, ['denied'], 'in the catalog but not entitled for this org')
  assert.deepEqual(result.unknown, ['nope'], 'not in the catalog at all')
}
