/**
 * 仓库清理：批量删除与自动清理的判据。
 *
 * 删除不可逆，所以这一组测试的重点不是「功能能跑」，而是**它在哪些情况下必须
 * 收手**。每条都对应一个真实会踩到的坑：
 *
 *   · 把正在承载网关的仓库删掉 → 模型当场全断，而且看不出是谁删的；
 *   · 把 dsh 自己所在的仓库删掉 → 正在跑的整套工具没了；
 *   · 「没填条件」被当成「全部」→ 一次调用清空整个账号；
 *   · 活动时间读不到时当成「很旧」→ 新仓库刚建就被判成可删；
 *   · 预演与真删用两套选仓库逻辑 → 预览说 3 个、实际删了 5 个。
 */
import assert from 'node:assert/strict'
import {
  CLEANUP_MAX_PER_RUN,
  DEFAULT_CLEANUP_SETTINGS,
  GATEWAY_NAME_PATTERN,
  describeAge,
  hasRunningEnvironment,
  isGatewayRepository,
  judgeRepository,
  matchesFilter,
  normalizeCleanupSettings,
  planRepositoryCleanup,
  planWorkspaceCleanup,
  repoNameOf,
  summarizeBulkDelete,
} from '../lib/cleanup.js'

const NOW = new Date('2026-11-24T12:00:00Z')
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 3_600_000).toISOString()

const settings = (patch = {}) => normalizeCleanupSettings({ enabled: true, ...patch })

// --- 1. 默认设置：自动删除是关的，窗口是 24 小时 ----------------------
{
  assert.equal(DEFAULT_CLEANUP_SETTINGS.enabled, false, 'a fresh install must not delete anything')
  assert.equal(DEFAULT_CLEANUP_SETTINGS.scope, 'gateway', 'and when enabled, only this plugin own repos')
  assert.equal(DEFAULT_CLEANUP_SETTINGS.maxAgeHours, 24)
  // 已经没有「删还有环境在跑的仓库」这个开关了：环境开着就受保护，不可绕过。
  assert.equal('deleteRunning' in DEFAULT_CLEANUP_SETTINGS, false, 'no switch can bypass the running-environment guard')
  assert.equal(normalizeCleanupSettings({}).enabled, false, 'normalizing nothing keeps it off')
  // 归一化而不是报错：面板里填错一个数字不该让整块功能变成「未配置」。
  const loose = normalizeCleanupSettings({ scope: 'nonsense', maxAgeHours: 0, intervalMinutes: 1 })
  assert.equal(loose.scope, 'gateway', 'an unknown scope falls back instead of throwing')
  assert.equal(loose.maxAgeHours, 1, 'zero hours is clamped to one')
  assert.equal(loose.intervalMinutes, 5, 'a one-minute interval is clamped to five')
  assert.deepEqual(loose.rejected, ['scope=nonsense'], 'and the rejected value is reported')
}

// --- 2. 「这是本插件建的」两个判据，任一成立即可 ----------------------
{
  assert.ok(GATEWAY_NAME_PATTERN.test('dsh-gateway-20261124-123456'), 'the generated name shape')
  assert.ok(GATEWAY_NAME_PATTERN.test('dsh-gateway-20261124-123456-a1b2'), 'the conflict-retry suffix')
  assert.ok(!GATEWAY_NAME_PATTERN.test('dsh-gateway'), 'a bare prefix is not a generated name')
  assert.ok(!GATEWAY_NAME_PATTERN.test('mydsh-gateway-20261124-123456'), 'a user repo that merely contains it')

  assert.deepEqual(isGatewayRepository({ slug: 'acme/dsh-gateway-20261124-123456' }), { gateway: true, via: 'name' })
  assert.deepEqual(
    isGatewayRepository({ slug: 'acme/renamed-thing', description: '由 dsh-cnb 自动创建：托管 CNB AI 网关代理' }),
    { gateway: true, via: 'description' },
    'a renamed gateway repo is still recognised by its description',
  )
  assert.deepEqual(isGatewayRepository({ slug: 'acme/real-project', description: '' }), { gateway: false, via: null })
  // 名字从 slug 取不到时退回最后一个 / 之后的部分。
  assert.equal(repoNameOf('acme/alpha'), 'alpha')
  assert.equal(repoNameOf('alpha'), 'alpha')
}

// --- 3. 保护规则：正在用的、正在承载网关的，一律不动 -----------------
{
  const active = 'acme/dsh-gateway-20260101-000000'
  const old = hoursAgo(100)
  const repositories = [
    { slug: active, name: 'dsh-gateway-20260101-000000', description: '由 dsh-cnb 自动创建', updatedAt: old },
    { slug: 'acme/dsh-gateway-20260102-000000', name: 'dsh-gateway-20260102-000000', description: '', updatedAt: old },
    { slug: 'acme/dsh-gateway-20260103-000000', name: 'dsh-gateway-20260103-000000', description: '', updatedAt: old,
      environments: [{ status: 'running', sn: 'cnb-x-001' }] },
    { slug: 'acme/normal-project', name: 'normal-project', description: '', updatedAt: old },
    { slug: 'acme/dsh-gateway-20260104-000000', name: 'dsh-gateway-20260104-000000', description: '', updatedAt: hoursAgo(2) },
  ]
  const plan = planRepositoryCleanup({
    repositories,
    settings: settings(),
    activeRepo: active,
    selfRepo: null,
    now: NOW,
  })

  const deleted = plan.candidates.map((row) => row.repo)
  assert.deepEqual(deleted, ['acme/dsh-gateway-20260102-000000'], 'only the unused, unprotected gateway repo')
  assert.ok(!deleted.includes(active), 'the repo carrying the gateway is never deleted')
  assert.ok(!deleted.includes('acme/dsh-gateway-20260103-000000'), 'a repo with a running environment is left alone')
  assert.ok(!deleted.includes('acme/normal-project'), 'someone else repo is out of scope by default')

  const codes = Object.fromEntries(plan.kept.map((row) => [row.repo, row.code]))
  assert.equal(codes[active], 'protected')
  assert.equal(codes['acme/dsh-gateway-20260103-000000'], 'running')
  assert.equal(codes['acme/normal-project'], 'not-gateway')
  assert.equal(codes['acme/dsh-gateway-20260104-000000'], 'too-new', 'two hours of activity is not "unused"')
}

// --- 4. dsh 自己所在的仓库永远不删，即使它长得像网关仓库 -------------
{
  const plan = planRepositoryCleanup({
    repositories: [
      { slug: 'acme/dsh-gateway-20260101-000000', name: 'dsh-gateway-20260101-000000', description: '', updatedAt: hoursAgo(100) },
      { slug: 'acme/other', name: 'other', description: '', updatedAt: hoursAgo(100) },
    ],
    settings: settings(),
    selfRepo: 'acme/dsh-gateway-20260101-000000',
    now: NOW,
  })
  // 两个都不删：一个是 dsh 自己所在的仓库，另一个是自建仓库（自动清理不碰）。
  assert.deepEqual(plan.candidates.map((row) => row.repo), [], 'neither is auto-deletable')
  assert.equal(plan.summary.scanned, 2, 'both are scanned so the totals add up')
  assert.equal(plan.kept.find((row) => row.repo === 'acme/dsh-gateway-20260101-000000').code, 'self')
  assert.equal(plan.kept.find((row) => row.repo === 'acme/other').code, 'not-gateway', 'a self-built repo is never auto-deleted')
}

// --- 5. 保留名单与运行中开关 ----------------------------------------
{
  const repositories = [
    { slug: 'acme/dsh-gateway-20260101-000000', name: 'dsh-gateway-20260101-000000', updatedAt: hoursAgo(100), description: '' },
    { slug: 'acme/dsh-gateway-20260102-000000', name: 'dsh-gateway-20260102-000000', updatedAt: hoursAgo(100), description: '',
      environments: [{ status: 'running' }] },
  ]
  const kept = planRepositoryCleanup({ repositories, settings: settings({ keep: ['acme/dsh-gateway-20260101-000000'] }), now: NOW })
  assert.equal(kept.candidates.length, 0, 'a keep entry is honoured')
  assert.equal(kept.kept.find((row) => row.repo.endsWith('20260101-000000')).code, 'protected')

  /**
   * 试图绕过「运行中受保护」的每一种写法都必须失败。
   *
   * 这是硬规则：环境还开着，那个仓库就不可自动删。没有开关能放开它 ——
   * 想删就先关环境，或者手动勾选（那是人的明确意图）。
   */
  for (const attempt of [{ deleteRunning: true }, { scope: 'all' }, { scope: 'prefix', prefix: 'dsh-gateway-' }]) {
    const forced = planRepositoryCleanup({ repositories, settings: settings(attempt), now: NOW })
    assert.ok(
      !forced.candidates.some((row) => row.repo.endsWith('20260102-000000')),
      `no setting can delete a repo whose environment is running (tried ${JSON.stringify(attempt)})`,
    )
  }
}

// --- 6. 活动时间读不到时不当成「很旧」 -------------------------------
{
  const judged = judgeRepository({
    repo: { slug: 'acme/dsh-gateway-20260101-000000', name: 'dsh-gateway-20260101-000000', updatedAt: null, description: '' },
    settings: settings(),
    protectedSet: new Set(),
    now: NOW,
  })
  assert.equal(judged.delete, false)
  assert.equal(judged.code, 'unknown-age', 'a missing timestamp is not evidence of age')
  assert.equal(describeAge(null), '时间未知')
  assert.equal(describeAge(0.5), '30 分钟前')
  assert.equal(describeAge(30), '30 小时前')
  assert.equal(describeAge(72), '3 天前')
}

// --- 7. 按条件选仓库：前缀 / 搜索 / 只要网关仓库 ----------------------
{
  const repo = { slug: 'acme/dsh-gateway-20260101-000000', name: 'dsh-gateway-20260101-000000', description: '' }
  assert.equal(matchesFilter(repo, { prefix: 'dsh-gateway-' }), true)
  assert.equal(matchesFilter(repo, { prefix: 'acme/dsh' }), true, 'a full-path prefix works too')
  assert.equal(matchesFilter(repo, { prefix: 'other' }), false)
  assert.equal(matchesFilter(repo, { search: 'GATEWAY' }), true, 'search is case-insensitive')
  assert.equal(matchesFilter(repo, { gatewayOnly: true }), true)
  assert.equal(matchesFilter({ slug: 'acme/real', name: 'real', description: '' }, { gatewayOnly: true }), false)
  assert.equal(matchesFilter({ slug: '', name: '' }, {}), false, 'an empty slug never matches')
  assert.equal(hasRunningEnvironment({ environments: [{ status: 'closed' }] }), false)
  assert.equal(hasRunningEnvironment({}), false)
}

// --- 8. 单次上限：超出的部分要报出来，不能悄悄丢掉 --------------------
{
  const repositories = Array.from({ length: 8 }, (_, index) => ({
    slug: `acme/dsh-gateway-2026010${index + 1}-000000`,
    name: `dsh-gateway-2026010${index + 1}-000000`,
    description: '',
    updatedAt: hoursAgo(10 * (index + 10)),
  }))
  const plan = planRepositoryCleanup({ repositories, settings: settings(), now: NOW, limit: 3 })
  assert.equal(plan.candidates.length, 3)
  assert.equal(plan.deferred.length, 5, 'the remainder is reported, not silently dropped')
  assert.equal(plan.summary.deletable, 8)
  // 最旧的先删：被截断时留下的是最近还在用的。
  assert.ok((plan.candidates[0].ageHours ?? 0) >= (plan.candidates[2].ageHours ?? 0))
  assert.equal(plan.candidates[0].repo, 'acme/dsh-gateway-20260108-000000', 'the oldest goes first')
  // 200 而不是 50：环境记录会累积到几百条，一轮只清 50 条意味着要点四五次，
  // 而无人值守的自动清理永远清不完。
  assert.equal(CLEANUP_MAX_PER_RUN, 200)
}

// --- 9. 汇总：计划是清单，数量是数量 --------------------------------
{
  // 早先 `planned` 被写成数量，面板读 `.length` 得到 undefined，界面显示
  // 「预演：会删除 0 个」—— 数字与清单对不上。这里把两种语义都钉住。
  const summary = summarizeBulkDelete({
    planned: ['acme/a', 'acme/b'],
    results: [{ repo: 'acme/a', ok: true }, { repo: 'acme/b', ok: false, error: 'errcode 9' }],
  })
  assert.deepEqual(summary.planned, ['acme/a', 'acme/b'], 'planned is the list itself')
  assert.equal(summary.plannedCount, 2, 'and the count is separate')
  assert.deepEqual(summary.deleted, ['acme/a'])
  assert.deepEqual(summary.failed, [{ repo: 'acme/b', error: 'errcode 9' }])
  assert.equal(summary.ok, false)
  assert.match(summary.hint, /根组织/, 'a root-group failure is explained')

  const clean = summarizeBulkDelete({ planned: ['acme/a'], results: [{ repo: 'acme/a', ok: true }] })
  assert.equal(clean.ok, true)
  assert.equal(clean.hint, null)
}

console.log('cleanup OK · 保护优先于范围，范围优先于年龄；预演与真删共用同一份清单')

// --- 10. 环境记录：运行中的永远不动，且 envScope=all 也不能绕过它 ----
//
// 这是本功能里最不能出错的一条。删掉一条已结束的记录只是少一份历史；
// 停掉一个正在跑的环境会丢未提交的工作。所以「运行中」这条判据排在 envScope
// 之前，且没有任何开关能放开 —— `envScope: 'all'` 的意思是「连别的状态也清」，
// 不是「连正在跑的也清」。这两件事被混在一起过，结果是选 all 就把活环境删了。
{
  const ws = (patch) => ({ sn: 'x', slug: 'o/r', status: 'closed', create_time: hoursAgo(300), ...patch })
  const plan = (workspaces, settings, extra = {}) => planWorkspaceCleanup({
    workspaces,
    settings: normalizeCleanupSettings({ envScope: 'closed', envMaxAgeHours: 168, ...settings }),
    now: NOW,
    ...extra,
  })

  // 默认：只清超过 7 天的 closed
  const base = plan([
    ws({ sn: 'old-closed' }),
    ws({ sn: 'new-closed', create_time: hoursAgo(2) }),
    ws({ sn: 'live', status: 'running' }),
    ws({ sn: 'failed', status: 'failed' }),
  ])
  assert.deepEqual(base.candidates.map((row) => row.sn), ['old-closed'])
  assert.equal(base.kept.find((r) => r.sn === 'live').code, 'running')
  assert.equal(base.kept.find((r) => r.sn === 'new-closed').code, 'too-new')
  assert.equal(base.kept.find((r) => r.sn === 'failed').code, 'not-closed')

  // envScope=all：failed 也清，但 running 依然不动
  const all = plan([
    ws({ sn: 'live', status: 'running' }),
    ws({ sn: 'failed', status: 'failed' }),
  ], { envScope: 'all' })
  assert.deepEqual(all.candidates.map((row) => row.sn), ['failed'], 'all widens the statuses, not the risk')
  assert.equal(all.kept.find((r) => r.sn === 'live').code, 'running', 'a live environment is never a candidate')

  // 自己所在的环境、受保护仓库下的记录，都不动
  const guarded = plan([
    ws({ sn: 'self-sn' }),
    ws({ sn: 'protected-sn', slug: 'o/gateway' }),
  ], {}, { activeSn: 'self-sn', protectedRepos: ['o/gateway'] })
  assert.equal(guarded.candidates.length, 0)
  assert.equal(guarded.kept.find((r) => r.sn === 'self-sn').code, 'self')
  assert.equal(guarded.kept.find((r) => r.sn === 'protected-sn').code, 'protected')

  // 读不到创建时间：不当成「很旧」
  const unknown = plan([ws({ sn: 'no-time', create_time: null })])
  assert.equal(unknown.candidates.length, 0)
  assert.equal(unknown.kept.find((r) => r.sn === 'no-time').code, 'unknown-age')

  // 重复的 sn 只判一次（分页重叠）
  const dup = plan([ws({ sn: 'same' }), ws({ sn: 'same' })])
  assert.equal(dup.candidates.length, 1)
  assert.equal(dup.summary.scanned, 1)

  // 默认设置：仓库那条关、环境那条开，而且是 7 天
  assert.equal(DEFAULT_CLEANUP_SETTINGS.environments, true, 'environment cleanup is on by default')
  assert.equal(DEFAULT_CLEANUP_SETTINGS.envScope, 'closed', 'but only for closed records')
  assert.equal(DEFAULT_CLEANUP_SETTINGS.envMaxAgeHours, 2, 'two hours: a closed record is history, not data')
  assert.equal(DEFAULT_CLEANUP_SETTINGS.enabled, false, 'while repository deletion stays off')
}

// --- 11. 自己所在的仓库：不删，但必须报告，不能从两侧一起消失 --------
//
// 线上踩过：`planRepositoryCleanup` 用 `continue` 跳过 selfRepo —— 既不进
// `candidates` 也不进 `kept`。症状是一个明显该删的仓库消失了，任何地方都
// 查不到为什么。既然「受保护」这个结论对用户有价值，它就必须带着 code 落在 kept 里。
{
  const now = new Date()
  const ago = (h) => new Date(now.getTime() - h * 3_600_000).toISOString()
  const plan = planRepositoryCleanup({
    repositories: [
      { slug: 'me/self', description: '由 dsh-cnb 自动创建', updatedAt: ago(400) },
      { slug: 'me/other', description: '由 dsh-cnb 自动创建', updatedAt: ago(400) },
    ],
    settings: normalizeCleanupSettings({ enabled: true }),
    selfRepo: 'me/self',
    now,
  })
  assert.deepEqual(plan.candidates.map((row) => row.repo), ['me/other'], 'the self repo is not a candidate')
  const self = plan.kept.find((row) => row.repo === 'me/self')
  assert.ok(self !== undefined, 'but it IS reported in kept — never silently dropped')
  assert.equal(self.code, 'self')
  assert.match(self.reason, /dsh 自己/)
  assert.equal(plan.summary.scanned, 2, 'scanned counts both, so the totals add up')
}

// --- 12. 三条规则必须是硬的，不能被任何设置绕过 ---------------------
//
// 这是用户明确要求的三条，也是最不能出错的三条：
//
//   1. 云环境开着 → 那个仓库受保护；关掉之后才可清理；
//   2. 自动清理只碰云网关仓库；
//   3. 自建仓库不自动删，只能手动操作。
//
// 每一条都用「穷举所有可能的设置组合」验证，而不是只测默认值 ——
// 一个能绕过规则的开关，比没有这条规则更危险（它看起来像保护）。
{
  const now = new Date('2026-11-24T12:00:00Z')
  const ago = (h) => new Date(now.getTime() - h * 3_600_000).toISOString()
  const LARGE = 1000

  const gatewayOpen = {
    slug: 'acme/dsh-gateway-20260101-000000', name: 'dsh-gateway-20260101-000000',
    description: '', updatedAt: ago(LARGE), environments: [{ status: 'running' }],
  }
  const gatewayClosed = {
    slug: 'acme/dsh-gateway-20260102-000000', name: 'dsh-gateway-20260102-000000',
    description: '', updatedAt: ago(LARGE), environments: [{ status: 'closed' }],
  }
  const ownRepo = {
    slug: 'acme/my-precious-code', name: 'my-precious-code',
    description: '自己的项目', updatedAt: ago(LARGE), environments: [{ status: 'closed' }],
  }
  const repositories = [gatewayOpen, gatewayClosed, ownRepo]

  /**
   * 所有「可能被误当成开关」的设置组合。
   * 包括那些已经被删掉的字段 —— 传进去也必须无效。
   */
  const attempts = [
    {},
    { enabled: true },
    { enabled: true, deleteRunning: true },
    { enabled: true, scope: 'all' },
    { enabled: true, scope: 'prefix', prefix: 'acme/' },
    { enabled: true, scope: 'gateway' },
    { enabled: true, maxAgeHours: 1 },
    { enabled: true, keep: [] },
    { enabled: true, deleteRunning: true, scope: 'all', maxAgeHours: 1 },
  ]

  for (const attempt of attempts) {
    const s = normalizeCleanupSettings(attempt)
    const plan = planRepositoryCleanup({ repositories, settings: s, now })
    const picked = plan.candidates.map((row) => row.repo)
    const label = JSON.stringify(attempt)

    // 规则 1：环境开着就绝不删
    assert.ok(!picked.includes(gatewayOpen.slug), `rule 1: an open environment protects its repo ${label}`)
    // 规则 2 + 3：自建仓库绝不自动删
    assert.ok(!picked.includes(ownRepo.slug), `rule 3: a self-built repo is never auto-deleted ${label}`)
    // 只有「关了环境的网关仓库」可以删
    assert.deepEqual(picked, [gatewayClosed.slug], `only a closed gateway repo is eligible ${label}`)

    // 被跳过的都要有明确 reason，不能凭空消失
    const kept = Object.fromEntries(plan.kept.map((row) => [row.repo, row.code]))
    assert.equal(kept[gatewayOpen.slug], 'running', `the open one says why ${label}`)
    assert.equal(kept[ownRepo.slug], 'not-gateway', `the self-built one says why ${label}`)
  }

  // 设置对象里不该再有能放开规则的字段
  const s = normalizeCleanupSettings({})
  assert.equal('deleteRunning' in s, false, 'no deleteRunning switch exists')
  assert.equal(s.scope, 'gateway', 'scope is fixed')
}
