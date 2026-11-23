/**
 * 「模型不止一个」：清单必须从上游实测出来，不能是插件里的一张静态表。
 *
 * CNB AI 网关没有清单接口 —— `/-/ai/models`、`/-/ai-ide/v2/models`、
 * `/-/model/list`、`/-/ai/models/list` 全部 404（逐个探过）。它只提供一枚判定位：
 *
 *   200                                → 可用
 *   [MODEL_NOT_IN_LIST]                → 不在目录里（id 猜错了）
 *   [MODEL_NOT_AVAILABLE_FOR_ORG]      → 在目录里，但当前组织没开通
 *
 * 所以「发现」= 逐个真调用并按错误码分类。这些测试钉住分类本身、并发下的顺序
 * 稳定性，以及最重要的一条：**没额度的模型不能写进 provider** —— 那会让 dsh 的
 * 选择器里出现一个点了必然失败的选项。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { VERDICTS, describeModel, discoverModels, probeModel, resolveModelCatalog } from '../lib/model-catalog.js'

const token = 'test-token'
const repo = 'acme/gateway'

/**
 * 一个按 id 回答的假网关。
 * @param {Record<string, 'ok' | 'not-in-list' | 'not-entitled' | number>} table
 */
function stub(table) {
  const calls = []
  const impl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body.model)
    const verdict = table[body.model] ?? 'not-in-list'
    if (verdict === 'ok') {
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
    }
    if (verdict === 'not-in-list') {
      return new Response(JSON.stringify({ errcode: 403, errmsg: `[MODEL_NOT_IN_LIST]Model ${body.model} is not in the optional models list` }), { status: 403 })
    }
    if (verdict === 'not-entitled') {
      return new Response(JSON.stringify({ errcode: 403, errmsg: `[MODEL_NOT_AVAILABLE_FOR_ORG]Model ${body.model} is not available for your organization` }), { status: 403 })
    }
    return new Response('{}', { status: verdict })
  }
  return { impl, calls }
}

// --- 1. 三种判定必须分清 ---------------------------------------------
{
  const { impl } = stub({ 'good-model': 'ok', 'denied': 'not-entitled' })
  const good = await probeModel({ token, repo, id: 'good-model', fetchImpl: impl })
  assert.equal(good.verdict, VERDICTS.ok)
  assert.equal(good.status, 200)

  const unknown = await probeModel({ token, repo, id: 'made-up', fetchImpl: impl })
  assert.equal(unknown.verdict, VERDICTS.unknown, 'MODEL_NOT_IN_LIST means the id does not exist')

  const denied = await probeModel({ token, repo, id: 'denied', fetchImpl: impl })
  assert.equal(denied.verdict, VERDICTS.notEntitled, 'MODEL_NOT_AVAILABLE_FOR_ORG means the org has no entitlement')

  const broken = await probeModel({ token, repo, id: 'boom', fetchImpl: stub({ boom: 500 }).impl })
  assert.equal(broken.verdict, VERDICTS.error, 'a 500 is neither "unknown" nor "no entitlement"')
}

// --- 2. 探测请求本身要最小：只为一枚错误码 --------------------------
{
  const { impl, calls } = stub({ a: 'ok' })
  await probeModel({ token, repo, id: 'a', fetchImpl: impl })
  assert.deepEqual(calls, ['a'], 'one call per model')
}

// --- 3. 并发发现：分类正确，且结果保持输入顺序 ----------------------
{
  const table = {
    'm1-ok': 'ok',
    'm2-denied': 'not-entitled',
    'm3-ok': 'ok',
    'm4-missing': 'not-in-list',
    'm5-ok': 'ok',
  }
  const { impl } = stub(table)
  const result = await discoverModels({
    token, repo, ids: [...Object.keys(table), 'm1-ok'], fetchImpl: impl, concurrency: 4,
  })
  assert.deepEqual(result.available, ['m1-ok', 'm3-ok', 'm5-ok'], 'only 200s, in input order')
  assert.deepEqual(result.notEntitled, ['m2-denied'])
  assert.deepEqual(result.unknown, ['m4-missing'])
  assert.equal(result.probed, 5, 'the duplicate id is deduplicated')
}

// --- 4. 没额度的模型绝不进最终清单 ---------------------------------
{
  const table = { 'a-ok': 'ok', 'b-denied': 'not-entitled', 'c-ok': 'ok' }
  const { impl } = stub(table)
  const result = await discoverModels({ token, repo, ids: Object.keys(table), fetchImpl: impl })
  const catalog = resolveModelCatalog({ requested: Object.keys(table), discovered: result.available })
  const denied = new Set([...result.notEntitled, ...result.unknown])
  const final = catalog.filter((id) => !denied.has(id))
  assert.deepEqual(final, ['a-ok', 'c-ok'], 'a model the org cannot use must not reach the provider')
}

// --- 5. 用户点名的优先，实测的补齐 ---------------------------------
{
  const catalog = resolveModelCatalog({
    requested: ['wanted-first'],
    discovered: ['wanted-first', 'discovered-a', 'discovered-b'],
  })
  assert.deepEqual(catalog, ['wanted-first', 'discovered-a', 'discovered-b'], 'requested order wins, no duplicates')
  assert.deepEqual(resolveModelCatalog({ discovered: [] }), [], 'nothing to offer is honest')
  assert.deepEqual(resolveModelCatalog({ discovered: [], fallback: ['f'] }), ['f'], 'the caller can supply a fallback')
}

// --- 6. 元数据按家族给，未知家族保守取小 ---------------------------
{
  assert.equal(describeModel('deepseek-v4.1-flash').contextWindow, 256_000)
  assert.equal(describeModel('glm-5.3-flash').contextWindow, 128_000)
  // 未知家族：宁可小 —— 写大了请求会在中途被上游截断，写小了只是提前压缩历史。
  assert.equal(describeModel('mystery-model-x').contextWindow, 128_000)
  const entry = describeModel('deepseek-v4.1-flash')
  assert.equal(entry.id, 'deepseek-v4.1-flash')
  assert.equal(entry.name, 'deepseek-v4.1-flash')
  assert.ok(entry.maxTokens > 0)
}

// --- 6b. 推理模型要留足预算 --------------------------------------
//
// 实测：`hy4` 在 `max_tokens: 64` 时内容被 `reasoning_content` 占满，
// `content` 为空 —— 而 `finish_reason` 仍是 `stop`，状态上看起来完全成功。
// 所以这类模型必须标出来，并给一个够大的预算。
{
  for (const id of ['hy4', 'hy4std', 'step-5-preview', 'space-bunny']) {
    const model = describeModel(id)
    assert.equal(model.reasoning, true, `${id} thinks before it answers`)
    assert.ok(model.maxTokens >= 32_768, `${id} needs budget for the reasoning phase`)
  }
  for (const id of ['deepseek-v4.1-flash', 'glm-5.3-flash', 'mimo-v2.6-pro']) {
    assert.equal(describeModel(id).reasoning, false, `${id} answers directly`)
    assert.ok(describeModel(id).maxTokens < 32_768, 'no need to reserve reasoning budget')
  }
}

// --- 7. 云端入口真的会去探测，而不是读死表 ------------------------
{
  const serve = readFileSync(new URL('../lib/cloud/serve.mjs', import.meta.url), 'utf8')
  assert.match(serve, /discoverModels\(/, 'the cloud entry discovers instead of trusting the file')
  assert.match(serve, /DSH_GW_DISCOVER/, 'and it can be turned off explicitly')
  // 探测结论要回传：远端才能解释「为什么少了某个模型」。
  assert.match(serve, /DSH_GW_DISCOVERED|marker\('DSH_GW_DISCOVERED'/)
  assert.match(serve, /notEntitled/)
  // 没有 token/repo 就不该起一个坏网关。
  assert.match(serve, /CNB_TOKEN is missing/)
  assert.match(serve, /DSH_GW_REPO is missing/)
}

// --- 8. 脚手架必须把发现模块一起带过去 ----------------------------
{
  const { RUNTIME_SOURCES } = await import('../lib/scaffold.js')
  assert.ok(RUNTIME_SOURCES.includes('model-catalog.js'), 'probing code must exist inside the environment')
}
