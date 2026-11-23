/**
 * 「配好了」不等于「对话在用」—— 会话级模型选择必须被看见。
 *
 * DSH 的模型选择是**按会话**记住的（`modelSelection.val.lastUsed`）。写好了
 * provider、`agent-default-model` 也指向新路由，一个老会话里存着上一个 provider
 * 时，打开它仍然用老模型。用户看到的就变成「配置明明改了，对话还是原来那个」。
 *
 * 插件**改不到**它：那需要 DSH 的 session 服务（`session.selectModel`），
 * 而它不在插件的可用依赖里。直接改 `storages/session_projcache` 的 JSON 也不行 ——
 * 实测手改后 3 个会话在 10 秒内被运行中的进程写回原值，因为进程持有内存状态。
 *
 * 所以这里的职责是：**准确读出状态，并说清最后一步**。这些测试钉住「读得准」和
 * 「不谎报完成」两件事。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_CACHE, describeSessionAdoption, readSessionSelections, surveySessionSelections } from '../lib/session-adopt.js'

/**
 * 造一个 Harness home，里面放若干会话文件。
 * @param {Array<{ id: string, provider?: string, model?: string }>} sessions
 */
function home(sessions) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sessions-'))
  const dir = join(root, SESSION_CACHE)
  mkdirSync(dir, { recursive: true })
  for (const session of sessions) {
    const doc = {
      entries: {
        modelSelection: {
          ver: 3,
          val: session.provider === undefined ? { lastUsed: null, pending: null } : { lastUsed: { provider: session.provider, model: session.model }, pending: null },
        },
      },
    }
    writeFileSync(join(dir, `${session.id}.json`), JSON.stringify(doc))
  }
  return root
}

// --- 1. 读出每个会话记住的选择 -------------------------------------
{
  const root = home([
    { id: 'a', provider: 'cnb-gateway', model: 'deepseek-v4.1-flash' },
    { id: 'b', provider: 'cnb', model: 'deepseek-v4.1-flash' },
    { id: 'c' },
  ])
  const rows = readSessionSelections({ home: root })
  assert.equal(rows.length, 2, 'a session with no selection is not reported as one')
  assert.deepEqual(rows.map((row) => row.id).sort(), ['a', 'b'])
  assert.equal(rows.find((row) => row.id === 'b').provider, 'cnb')
}

// --- 2. 分类：在路由上 / 记着别处 / 模型已失效 --------------------
{
  const root = home([
    { id: 'good', provider: 'cnb-gateway', model: 'deepseek-v4.1-flash' },
    { id: 'other', provider: 'cnb', model: 'deepseek-v4.1-flash' },
    { id: 'stale', provider: 'cnb-gateway', model: 'hy4' },
  ])
  const survey = surveySessionSelections({
    home: root,
    route: 'cnb-gateway',
    availableModels: ['deepseek-v4.1-flash'],
  })
  assert.equal(survey.total, 3)
  assert.equal(survey.onRoute, 1)
  assert.deepEqual(survey.elsewhere.map((row) => row.id), ['other'])
  // 模型已不在清单里：这个会话一开口就失败，与「记着别的 provider」是两回事。
  assert.deepEqual(survey.staleModel.map((row) => row.id), ['stale'])
}

// --- 3. 全部就绪时不谎报，也不催人做事 ----------------------------
{
  const root = home([{ id: 'a', provider: 'cnb-gateway', model: 'm' }])
  const survey = surveySessionSelections({ home: root, route: 'cnb-gateway', availableModels: ['m'] })
  const advice = describeSessionAdoption({ route: 'cnb-gateway', model: 'm', survey })
  assert.equal(advice.done, true)
  assert.match(advice.message, /1 个会话/, 'says how many are aligned')
}

// --- 4. 还有会话在别处时：说清待办数量和可行的两步 ----------------
{
  const root = home([
    { id: 'a', provider: 'cnb-gateway', model: 'm' },
    { id: 'b', provider: 'cnb', model: 'm' },
    { id: 'c', provider: 'cnb', model: 'm' },
  ])
  const survey = surveySessionSelections({ home: root, route: 'cnb-gateway', availableModels: ['m'] })
  const advice = describeSessionAdoption({ route: 'cnb-gateway', model: 'm', survey })
  assert.equal(advice.done, false, 'never claim success while sessions point elsewhere')
  assert.equal(advice.pending, 2)
  assert.match(advice.message, /2 个/)
  assert.match(advice.message, /model.选择器|模型选择器/, 'names the action that works')
  assert.match(advice.message, /新会话|新的会话/, 'and the zero-action path')
  // 不能假装插件自己改好了 —— 它确实改不到。
  assert.ok(!/已为您切换|已经切换完成/.test(advice.message), 'no false claim of having switched them')
}

// --- 5. 没有历史会话时不该编造状态 --------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'dsh-empty-'))
  const survey = surveySessionSelections({ home: root, route: 'cnb-gateway' })
  assert.equal(survey.total, 0)
  assert.equal(describeSessionAdoption({ route: 'cnb-gateway', model: 'm', survey }).done, true)
}

// --- 6. 坏文件不能让整个调查崩掉 ----------------------------------
{
  const root = home([{ id: 'ok', provider: 'cnb-gateway', model: 'm' }])
  writeFileSync(join(root, SESSION_CACHE, 'broken.json'), '{ not json')
  const survey = surveySessionSelections({ home: root, route: 'cnb-gateway', availableModels: ['m'] })
  assert.equal(survey.total, 1, 'an unparseable file is skipped, not fatal')
}

// --- 7. 深层嵌套的 modelSelection 也要找到 ------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'dsh-deep-'))
  const dir = join(root, SESSION_CACHE)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'deep.json'), JSON.stringify({
    tables: { projection: { byScope: { session: { modelSelection: { val: { lastUsed: { provider: 'cnb', model: 'x' } } } } } } },
  }))
  const rows = readSessionSelections({ home: root })
  assert.equal(rows.length, 1, 'the field can sit at any depth')
  assert.equal(rows[0].provider, 'cnb')
}
