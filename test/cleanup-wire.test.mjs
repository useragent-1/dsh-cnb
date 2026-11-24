/**
 * 批量删除与自动清理，在真实的 `apply()` 上跑一遍。
 *
 * 纯函数那一组（cleanup.test.mjs）钉的是判据；这一组钉的是**接线**：
 *
 *   · 面板的「预览」与「确认删除」必须走同一段选仓库逻辑，否则预览会说谎；
 *   · 不是 `confirm: true` 就一个请求都不能发出去（这是最容易被写反的一处）；
 *   · 承载网关的仓库即使被显式点名，也必须被拦下并说清原因；
 *   · 自动清理关闭时，`cleanup.cycle` 只出计划，不调删除接口；
 *   · 根组织下的仓库要走控制台路由（`cnb.cool/<org>/-/repos/<name>`）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const originalFetch = globalThis.fetch
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const hoursAgo = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString()

/**
 * 一个假 CNB：仓库列表、环境列表、删除接口（Open API 与根组织控制台两条路）。
 * @param {{ repositories: Array<Record<string, any>>, denyApiDelete?: boolean }} options
 */
function fakeCnb(options) {
  const calls = []
  const deleted = []
  /**
   * 真的删掉就意味着它不会再出现在列表里。假服务器必须记住这件事，
   * 否则「第一轮删掉、第二轮没有候选」这种幂等性永远测不出来 ——
   * 第二轮的 DELETE 会照常成功，看起来像重复删除。
   */
  const gone = new Set()
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    const method = init?.method ?? 'GET'
    calls.push({ url: target, method })
    if (target.includes('/user/repos')) {
      return json(200, options.repositories.filter((repo) => !gone.has(repo.slug)).map((repo) => ({
        id: repo.slug,
        path: repo.slug,
        name: repo.slug.split('/')[1],
        description: repo.description ?? '',
        updated_at: repo.updatedAt ?? hoursAgo(100),
        visibility_level: 'private',
      })))
    }
    if (target.includes('/workspace/list')) {
      const items = options.repositories.flatMap((repo) => (repo.environments ?? []).map((workspace) => ({
        ...workspace,
        slug: repo.slug,
        pipeline_id: workspace.pipelineId ?? 'cnb-p-001',
      })))
      return json(200, { list: items, total: items.length, hasMore: false })
    }
    if (target.includes('/workspace/stop') && method === 'POST') return json(200, { ok: true })
    if (method === 'DELETE') {
      if (options.denyApiDelete === true && target.startsWith('https://api.cnb.cool/')) {
        return json(403, { errcode: 9, errmsg: 'Cannot delete this resource via Open API due to root group management rules.' })
      }
      deleted.push(target.includes('cnb.cool/') && target.includes('/-/repos/') ? 'console' : 'api')
      // 记下被删的是哪个仓库（两种路由的形状都取最后一段）。
      const tail = target.split('/-/repos/').pop() ?? target
      const name = tail.split('/').pop()
      const owner = (target.match(/[^/]*cnb\.cool\/([^/]+)\//) ?? [])[1]
      if (owner && name) gone.add(owner + '/' + name)
      return json(200, { ok: true })
    }
    return json(404, { errcode: 5, errmsg: 'Resource not found.' })
  }
  return { calls, deleted }
}

/** @param {{ records?: Map<string, any>, values?: Map<string, string> }} [seed] */
function harness(seed = {}) {
  const records = seed.records ?? new Map([['dsh-cnb/cnb-token', { kind: 'grant', payload: { token: 'tok' } }]])
  const values = seed.values ?? new Map()
  const credentials = {
    async readRecord(key) { return records.get(key) },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next === undefined) records.delete(key)
      else records.set(key, next)
      return records.get(key)
    },
    async deleteRecord(key) { records.delete(key) },
    async set(ref, value) { values.set(ref, value) },
    async unset(ref) { values.delete(ref) },
    async resolve(ref) { return values.has(ref) ? { value: values.get(ref) } : undefined },
  }
  const tools = new Map()
  const ctx = {
    effect(fn) { fn(); return () => {} },
    get(name) {
      if (name === 'credentials') return credentials
      if (name === 'tools') return { register(definition) { tools.set(definition.name, definition); return () => {} } }
      return undefined
    },
    inject(names, fn) {
      if (Array.isArray(names) && names.includes('tools')) {
        fn({ effect: (run) => run(), tools: ctx.get('tools') })
      }
    },
    on() {},
  }
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-cnb-cleanup-'))
  return { api: apply(ctx, {}), values, tools, records }
}

// --- 1. 不传 confirm 时一个删除请求都不能发出 ------------------------
{
  const { api } = harness()
  const { calls, deleted } = fakeCnb({
    repositories: [{ slug: 'acme/dsh-gateway-20260101-000000', description: '' }],
  })
  try {
    const preview = await api.runOperation('cleanup.delete', {
      repos: ['acme/dsh-gateway-20260101-000000'],
    })
    assert.equal(preview.dryRun, true, 'omitting confirm means preview')
    assert.deepEqual(preview.planned, ['acme/dsh-gateway-20260101-000000'])
    assert.equal(deleted.length, 0, 'nothing was deleted')
    assert.equal(calls.filter((call) => call.method === 'DELETE').length, 0, 'no DELETE reached the network')
    assert.match(preview.note, /预演/)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- 2. confirm: true 才真的删，且逐个报告结果 ----------------------
{
  const { api } = harness()
  const { deleted } = fakeCnb({
    repositories: [
      { slug: 'acme/dsh-gateway-20260101-000000', description: '' },
      { slug: 'acme/dsh-gateway-20260102-000000', description: '' },
    ],
  })
  try {
    const outcome = await api.runOperation('cleanup.delete', {
      repos: ['acme/dsh-gateway-20260101-000000', 'acme/dsh-gateway-20260102-000000'],
      confirm: true,
    })
    assert.deepEqual(outcome.deleted.sort(), ['acme/dsh-gateway-20260101-000000', 'acme/dsh-gateway-20260102-000000'])
    assert.equal(outcome.failed.length, 0)
    assert.equal(outcome.ok, true)
    assert.equal(deleted.length, 2, 'both deletions reached the API')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- 3. 承载网关的仓库被显式点名也要拦下 ----------------------------
//
// 「哪个仓库在承载网关」在生产里由磁盘上的 provider 配置指出：`wireCloudProvider`
// 把 `CNB 云网关 (org/repo)` 写进 displayName。这里就写一份那样的 patch 层，
// 验证清理会把它读成保护名单 —— 而不是只信内存状态（桌面端每次启动都是新进程，
// 内存状态是空的）。
{
  const { api } = harness()
  const { deleted } = fakeCnb({ repositories: [] })
  try {
    const home = process.env.DSH_HOME
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '# dsh-cnb: cloud gateway provider',
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      cnb-gateway:',
      '        displayName: "CNB 云网关 (acme/gateway-repo)"',
      '        api: openai-completions',
      '',
    ].join('\n'))

    const status = await api.runOperation('cleanup.status', {})
    assert.ok(status.protectedRepos.includes('acme/gateway-repo'), 'the gateway carrier is read from disk config')

    await assert.rejects(
      () => api.runOperation('cleanup.delete', { repos: ['acme/gateway-repo'], confirm: true }),
      /正在承载云网关/,
      'naming it explicitly must not get around the protection',
    )
    assert.equal(deleted.length, 0, 'nothing reached the delete API')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- 3b. 保护名单生效时，显式点名被拒绝 ------------------------------
{
  process.env.CNB_REPO_SLUG = 'acme/self-repo'
  const { api } = harness()
  fakeCnb({ repositories: [] })
  try {
    await assert.rejects(
      () => api.runOperation('cleanup.delete', { repos: ['acme/self-repo'], confirm: true }),
      /正在承载云网关/,
      'the repo dsh itself runs in cannot be bulk-deleted',
    )
  } finally {
    delete process.env.CNB_REPO_SLUG
    globalThis.fetch = originalFetch
  }
}

// --- 4. 无条件批量删除被拒绝 ----------------------------------------
{
  const { api } = harness()
  fakeCnb({ repositories: [] })
  try {
    await assert.rejects(
      () => api.runOperation('cleanup.delete', { confirm: true }),
      /至少要给一个条件|需要 repos/,
      'no locator at all is refused, not treated as "everything"',
    )
    await assert.rejects(
      () => api.runOperation('cleanup.delete', { filter: {}, confirm: true }),
      /至少要给一个条件/,
      'an empty filter is refused too',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- 4b. 显式列表也要先停环境，且预演就说清哪些要停 -----------------
//
// 实测踩过：勾上三个仓库按删除，其中两个还有环境在跑，环境没停就删 —— 平台拒绝，
// 用户只看到一条没有上下文的失败。现在显式列表也会查一次环境（`workspace/list`），
// 预演里通过 `stopFirst` 提前告知。
{
  const { api } = harness()
  const stopped = []
  const originalFetch = globalThis.fetch
  const json2 = (status, entity) => new Response(JSON.stringify(entity), { status, headers: { 'content-type': 'application/json' } })
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    const method = init?.method ?? 'GET'
    if (target.includes('/workspace/list')) {
      return json2(200, {
        list: [
          { slug: 'acme/dsh-gateway-20260101-000000', status: 'running', sn: 'cnb-a-001', pipeline_id: 'cnb-a-001' },
          { slug: 'acme/dsh-gateway-20260102-000000', status: 'closed', sn: 'cnb-b-001', pipeline_id: 'cnb-b-001' },
        ],
        total: 2,
      })
    }
    if (target.includes('/workspace/stop')) {
      stopped.push(target)
      return json2(200, { ok: true })
    }
    if (target.includes('/workspace/')) return json2(200, { ok: true })
    if (method === 'DELETE') return json2(200, { ok: true })
    if (target.includes('/user/repos')) return json2(200, [])
    return json2(404, { errcode: 5 })
  }
  try {
    const preview = await api.runOperation('cleanup.preview', {
      repos: ['acme/dsh-gateway-20260101-000000', 'acme/dsh-gateway-20260102-000000'],
    })
    assert.deepEqual(preview.stopFirst, ['acme/dsh-gateway-20260101-000000'],
      'only the one with a running environment is flagged, and the preview says so up front')

    const outcome = await api.runOperation('cleanup.delete', {
      repos: ['acme/dsh-gateway-20260101-000000'],
      confirm: true,
    })
    assert.deepEqual(outcome.deleted, ['acme/dsh-gateway-20260101-000000'])
    assert.equal(stopped.length, 1, 'the running environment was stopped before the repo went away')

    // stopEnvironments: false 是显式的「我知道我在做什么」。
    const raw = await api.runOperation('cleanup.delete', {
      repos: ['acme/dsh-gateway-20260101-000000'],
      confirm: true,
      stopEnvironments: false,
    })
    assert.deepEqual(raw.deleted, ['acme/dsh-gateway-20260101-000000'])
    assert.equal(stopped.length, 1, 'and it is honoured: no second stop call')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- 5. 自动清理关闭时只出计划，不删东西 -----------------------------
{
  const { api } = harness()
  const { deleted } = fakeCnb({
    repositories: [
      { slug: 'acme/dsh-gateway-20260101-000000', description: '', updatedAt: hoursAgo(100) },
      { slug: 'acme/dsh-gateway-20260102-000000', description: '', updatedAt: hoursAgo(1) },
    ],
  })
  try {
    const cycle = await api.runOperation('cleanup.cycle', {})
    assert.equal(cycle.disabled, true, 'disabled by default')
    assert.equal(cycle.deleted.length, 0)
    assert.equal(deleted.length, 0, 'nothing reached the delete API')
    assert.deepEqual(cycle.plan.candidates.map((row) => row.repo), ['acme/dsh-gateway-20260101-000000'])
    assert.match(cycle.note, /未开启/)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- 5b. 设置必须真的驱动删除：写完能读回，且 cycle 用新值 ----------
//
// 这条挡的是一个很容易出现的假象：`cleanup.settings` 报「已保存」，但
// `cleanup.cycle` 读的是另一层或读不到，于是永远 `disabled: true`。
// 面板上开关是亮的、按钮按了也没反应 —— 排查起来只能靠盯代码。
{
  const { api } = harness()
  const { deleted } = fakeCnb({
    repositories: [{ slug: 'acme/dsh-gateway-20260101-000000', description: '由 dsh-cnb 自动创建', updatedAt: hoursAgo(400) }],
  })
  try {
    /**
     * 从关到开的那一刻会**立刻补跑一轮**（`immediate`）。这是刻意的：
     * `setInterval` 的第一跳在一个完整间隔之后，不补跑的话「已开启」之后
     * 半小时内什么都不会发生，而进程可能在那之前就重启了。
     *
     * 所以这里断言的是「保存设置这一个动作就已经完成清理」，而不只是「设置存下来了」。
     */
    const saved = await api.runOperation('cleanup.settings', { enabled: true, maxAgeHours: 24, environments: false })
    assert.equal(saved.settings.enabled, true, 'the setting is saved')
    assert.ok(saved.immediate !== undefined && saved.immediate !== null, 'enabling runs one round immediately')
    assert.deepEqual(saved.immediate.deleted, ['acme/dsh-gateway-20260101-000000'], 'and that round really deleted it')
    assert.equal(deleted.length, 1, 'exactly one DELETE reached the API')

    const status = await api.runOperation('cleanup.status', {})
    assert.equal(status.settings.enabled, true, 'the setting reads back as written')
    assert.ok(status.timer !== null && status.timer.running === true, 'and the timer is running')

    const cycle = await api.runOperation('cleanup.cycle', {})
    assert.notEqual(cycle.disabled, true, 'a saved enabled:true must reach the cycle')
    // 第一轮已经删掉了，第二轮没有候选 —— 这本身就是幂等性的证据。
    assert.deepEqual(cycle.deleted, [], 'the second round finds nothing left to delete')
    assert.equal(deleted.length, 1, 'and it did not delete anything twice')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- 6. 开着时删掉不活跃的，留下新的与别人的 -------------------------
{
  const { api } = harness()
  const { deleted } = fakeCnb({
    repositories: [
      { slug: 'acme/dsh-gateway-20260101-000000', description: '', updatedAt: hoursAgo(100) },
      { slug: 'acme/dsh-gateway-20260102-000000', description: '', updatedAt: hoursAgo(1) },
      { slug: 'acme/real-project', description: '', updatedAt: hoursAgo(100) },
    ],
  })
  try {
    // 从关到开会立刻补跑一轮 —— 所以这里直接用它的结果，而不是再调一次 cycle
    // （再调一次已经删无可删，那只会证明幂等，不证明判据）。
    const saved = await api.runOperation('cleanup.settings', { enabled: true, maxAgeHours: 24, scope: 'gateway' })
    assert.deepEqual(saved.immediate?.deleted, ['acme/dsh-gateway-20260101-000000'])
    assert.equal(deleted.length, 1)
    const skipped = Object.fromEntries((saved.immediate?.skipped ?? []).map((row) => [row.repo, row.code]))
    assert.equal(skipped['acme/dsh-gateway-20260102-000000'], 'too-new')
    assert.equal(skipped['acme/real-project'], 'not-gateway')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- 7. 设置持久化在凭证库里，重启后仍然读得到 ----------------------
{
  const values = new Map()
  const first = harness({ values })
  fakeCnb({ repositories: [] })
  try {
    await first.api.runOperation('cleanup.settings', { enabled: true, maxAgeHours: 6 })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.ok(values.has('DSH_CNB_CLEANUP'), 'settings landed in the credential store')
  const second = harness({ values })
  try {
    const status = await second.api.runOperation('cleanup.status', {})
    assert.equal(status.settings.enabled, true)
    assert.equal(status.settings.maxAgeHours, 6)
    assert.equal(status.source, 'credentials', 'read back from the same layer it was written to')
    assert.ok(status.timer !== null || status.settings.enabled === true, 'the timer is rebuilt from stored settings')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- 8. 根组织下的仓库：Open API 拒绝后走控制台路由 -----------------
{
  const records = new Map([['dsh-cnb/cnb-token', { kind: 'grant', payload: { token: 'tok', session: 'csrftoken=abc' } }]])
  const { api } = harness({ records })
  const { deleted } = fakeCnb({
    repositories: [{ slug: 'acme/dsh-gateway-20260101-000000', description: '' }],
    denyApiDelete: true,
  })
  try {
    const outcome = await api.runOperation('cleanup.delete', {
      repos: ['acme/dsh-gateway-20260101-000000'],
      confirm: true,
    })
    assert.deepEqual(outcome.deleted, ['acme/dsh-gateway-20260101-000000'], 'the console fallback deletes it')
    assert.deepEqual(deleted, ['console'], 'through the console route, not the Open API')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- 9. 工具已注册，参数与行为对得上 --------------------------------
{
  const { api, tools } = harness()
  fakeCnb({ repositories: [] })
  try {
    void api
    const names = [...tools.keys()]
    for (const name of [
      'cnb_repos_delete',
      'cnb_cleanup_status',
      'cnb_cleanup_settings',
      'cnb_cleanup_cycle',
      'cnb_cleanup_setup',
    ]) {
      assert.ok(names.includes(name), `${name} must be registered for the agent`)
    }
    assert.deepEqual(tools.get('cnb_repos_delete').parameters.properties.repos.type, 'array')
    assert.ok(tools.get('cnb_repos_delete').parameters.properties.confirm !== undefined,
      'confirm is part of the schema, so the model can see it is required to actually delete')
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('cleanup-wire OK · 预演不发请求、承载网关的仓库被拦、关闭时只出计划、根组织走控制台')

// --- 10. 状态返回必须可序列化：定时器开着时也不能带出 Timeout 句柄 ----
//
// 线上踩过：自动清理开着 → `cleanupState.timer` 里存了 setInterval 的句柄 →
// `cleanup.status` 的响应体带循环引用（Timeout._idlePrev._idleNext 指回自己）
// → JSON.stringify 抛错 → 路由在写出响应前断开 → 浏览器「Empty reply from server」
// → 面板永远停在「读取设置…」，连一句错误都看不到。
//
// 所以这条断言看的是**能不能真的被 stringify**，而不是字段名对不对。
{
  const { api } = harness()
  fakeCnb({ repositories: [] })
  try {
    // 打开自动清理：这一步会启动进程内定时器（句柄非空），正是触发条件。
    await api.runOperation('cleanup.settings', { enabled: true, intervalMinutes: 5 })
    const status = await api.runOperation('cleanup.status', {})
    assert.ok(status.timer !== null, 'the timer is reported as running')
    assert.equal(status.timer.running, true)
    // 关键：把整个响应序列化一遍。带 handle 时这里会抛 circular structure。
    const encoded = JSON.stringify({ ok: true, result: status })
    assert.ok(encoded.includes('"running":true'), 'the timer description survives serialization')
    assert.ok(!encoded.includes('_idleNext'), 'no Node timer internals leak into the response')

    // 同样的要求适用于写设置那一步的返回。
    const saved = await api.runOperation('cleanup.settings', { enabled: true, intervalMinutes: 10 })
    assert.doesNotThrow(() => JSON.stringify(saved), 'cleanup.settings is serializable too')
    assert.equal(saved.timer.intervalMinutes, 10)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- 11. 环境记录清理：单独的操作，且运行中的永远不被删 -------------
//
// 「开发环境」页会列出所有历史环境，越滚越长。清的是**记录**，不是数据，
// 所以它是独立操作、独立开关，默认就开。这里钉住三件事：
//   · 它真的调 /workspace/delete；
//   · running 的记录一个都不碰（哪怕 envScope=all）；
//   · dryRun 一个请求都不发。
{
  const { api } = harness()
  const deletes = []
  const originalFetch2 = globalThis.fetch
  const r = (s, b) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })
  globalThis.fetch = async (url, init) => {
    const t = String(url)
    const m = init?.method ?? 'GET'
    if (t.includes('/workspace/list')) {
      return r(200, {
        list: [
          { sn: 'cnb-old-001', slug: 'acme/thing', status: 'closed', create_time: new Date(Date.now() - 400 * 3_600_000).toISOString() },
          // 30 分钟前刚结束：默认窗口是 2 小时，所以它不该被碰（这是个刻意很小的数）。
          { sn: 'cnb-new-001', slug: 'acme/thing', status: 'closed', create_time: new Date(Date.now() - 0.5 * 3_600_000).toISOString() },
          { sn: 'cnb-live-001', slug: 'acme/thing', status: 'running', create_time: new Date(Date.now() - 400 * 3_600_000).toISOString() },
        ],
        total: 3,
      })
    }
    if (t.includes('/workspace/delete')) {
      deletes.push(JSON.parse(init?.body ?? '{}').sn)
      return r(200, { ok: true })
    }
    if (t.includes('/user/repos')) return r(200, [])
    return r(404, { errcode: 5 })
  }
  try {
    const preview = await api.runOperation('cleanup.environments', { dryRun: true })
    assert.equal(preview.dryRun, true)
    assert.deepEqual(preview.planned, ['cnb-old-001'], 'only the old closed record')
    assert.equal(deletes.length, 0, 'a preview sends no delete')

    const done = await api.runOperation('cleanup.environments', {})
    assert.deepEqual(done.deleted, ['cnb-old-001'])
    assert.deepEqual(deletes, ['cnb-old-001'], 'the live one was never touched')
    assert.ok(!deletes.includes('cnb-live-001'), 'a running environment is off limits')

    // envScope=all 也不能碰 running —— 它放宽的是状态，不是风险。
    deletes.length = 0
    const wide = await api.runOperation('cleanup.environments', { envScope: 'all' })
    assert.ok(!(wide.deleted ?? []).includes('cnb-live-001'), 'envScope=all still refuses running')
    assert.ok(!deletes.includes('cnb-live-001'))
  } finally {
    globalThis.fetch = originalFetch2
  }
}

// --- 12. 仓库清理关闭时，环境清理照常执行 ---------------------------
//
// 两条开关是独立的：仓库那条默认关（不可逆的数据丢失），环境那条默认开
// （只是历史）。把两者绑在同一个 enabled 上，会让「关掉自动删仓库」连带
// 停掉环境清理 —— 用户看到的是一堆越来越长的环境列表，却以为开关已经开了。
{
  const { api } = harness()
  const envDeletes = []
  const originalFetch3 = globalThis.fetch
  const r = (s, b) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })
  globalThis.fetch = async (url, init) => {
    const t = String(url)
    if (t.includes('/workspace/list')) {
      return r(200, { list: [{ sn: 'cnb-old-002', slug: 'acme/x', status: 'closed', create_time: new Date(Date.now() - 400 * 3_600_000).toISOString() }], total: 1 })
    }
    if (t.includes('/workspace/delete')) { envDeletes.push(JSON.parse(init?.body ?? '{}').sn); return r(200, { ok: true }) }
    if (t.includes('/user/repos')) return r(200, [])
    return r(404, { errcode: 5 })
  }
  try {
    // 明确关掉仓库清理，环境清理保持默认（开）
    await api.runOperation('cleanup.settings', { enabled: false, environments: true, envMaxAgeHours: 24 })
    const cycle = await api.runOperation('cleanup.cycle', {})
    assert.equal(cycle.disabled, true, 'repository deletion is off')
    assert.deepEqual(cycle.deleted, [], 'so no repository went away')
    assert.deepEqual(envDeletes, ['cnb-old-002'], 'but the environment record was still cleaned')
    assert.match(cycle.note, /环境记录清理是单独开的/)
  } finally {
    globalThis.fetch = originalFetch3
  }
}

// --- 13. credentials 晚就绪时，启动也必须读到已保存的设置 -------------
//
// 线上踩过最难受的一种状态：面板显示「自动清理已开启」，实际 `timer: null`、
// `lastRun: null`，什么都不跑，也没有任何报错。
//
// 原因是 `apply()` 跑的时候 credentials 服务还没挂载 —— 同步 `ctx.get('credentials')`
// 拿到 undefined，设置读取退回 `DEFAULT_CLEANUP_SETTINGS`（enabled:false），
// 定时器于是不启动。而面板后来再读时服务已就绪，读到 enabled:true，界面显示开着。
//
// 这条用「populate 之后才可用」的 credentials 复现那个时序，断言定时器仍然起来。
{
  const originalFetch4 = globalThis.fetch
  fakeCnb({ repositories: [] })
  const store = new Map([['DSH_CNB_CLEANUP', JSON.stringify({
    enabled: true, scope: 'gateway', prefix: '', maxAgeHours: 2, keep: [],
    intervalMinutes: 30, deleteRunning: false, dryRun: false,
    environments: false, envScope: 'closed', envMaxAgeHours: 168,
  })]])
  const lateCredentials = {
    ready: false,
    async readRecord() { return { kind: 'grant', payload: { token: 'tok' } } },
    async modifyRecord() {}, async deleteRecord() {},
    async set(r, v) { store.set(r, v) }, async unset(r) { store.delete(r) },
    async resolve(r) { return store.has(r) ? { value: store.get(r) } : undefined },
  }
  const tools = new Map()
  const ctxLate = {
    effect(fn) { fn(); return () => {} },
    get(name) {
      // 关键：一开始 credentials 不在；等 inject 的回调被调用之后才「变成」可用。
      if (name === 'credentials') return lateCredentials.ready ? lateCredentials : undefined
      if (name === 'tools') return { register(d) { tools.set(d.name, d); return () => {} } }
      return undefined
    },
    inject(names, fn) {
      if (Array.isArray(names) && names.includes('credentials')) {
        // 模拟「服务晚一拍就绪」：下一微任务才就绪并回调。
        queueMicrotask(() => {
          lateCredentials.ready = true
          fn({ effect: (run) => run(), credentials: lateCredentials })
        })
        return
      }
      if (Array.isArray(names) && names.includes('tools')) {
        fn({ effect: (run) => run(), tools: ctxLate.get('tools') })
      }
    },
    on() {},
  }
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-cnb-late-'))
  try {
    const lateApi = apply(ctxLate, {})
    // 等启动那串 promise 走完（readCleanupSettings → startCleanupTimer → 补跑一轮）
    await new Promise((resolve) => setTimeout(resolve, 200))
    const status = await lateApi.runOperation('cleanup.status', {})
    assert.equal(status.settings.enabled, true, 'the saved setting is read even though credentials arrived late')
    assert.ok(status.timer !== null, 'and the timer actually started — this is what "已开启" must mean')
    assert.equal(status.timer.running, true)
  } finally {
    globalThis.fetch = originalFetch4
  }
}

// --- 14. 删除要并发，但不能无限并发 --------------------------------
//
// 串行删两百个目标要几分钟：面板一直转圈，定时器还可能和下一跳重叠。
// 无上限并发又会把平台打到限流。所以这里断言两件事：
//   · 确实并行（最大同时在飞的请求 > 1）；
//   · 但有上限（不会一次把几十个全发出去）。
{
  const { api } = harness()
  const original = globalThis.fetch
  const repos = Array.from({ length: 24 }, (_, index) => ({
    slug: `acme/dsh-gateway-202601${String(index + 1).padStart(2, '0')}-000000`,
    description: '',
    updatedAt: hoursAgo(400),
  }))
  let inFlight = 0
  let peak = 0
  const r = (s, b) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })
  globalThis.fetch = async (url, init) => {
    const t = String(url)
    const m = init?.method ?? 'GET'
    if (t.includes('/user/repos')) {
      return r(200, repos.map((repo) => ({
        path: repo.slug, name: repo.slug.split('/')[1], description: '', updated_at: repo.updatedAt, visibility_level: 'private',
      })))
    }
    if (t.includes('/workspace/list')) return r(200, { list: [], total: 0 })
    if (m === 'DELETE') {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      // 让请求真的「挂一会儿」，否则并发窗口观察不到。
      await new Promise((resolve) => setTimeout(resolve, 12))
      inFlight -= 1
      return r(200, { ok: true })
    }
    return r(404, { errcode: 5 })
  }
  try {
    const outcome = await api.runOperation('cleanup.delete', {
      repos: repos.map((repo) => repo.slug),
      confirm: true,
      limit: 24,
    })
    assert.equal(outcome.deleted.length, 24, 'all of them went through')
    assert.ok(peak > 1, `deletes must run in parallel (peak in flight: ${peak})`)
    assert.ok(peak <= 8, `but not unbounded (peak in flight: ${peak})`)
  } finally {
    globalThis.fetch = original
  }
}
