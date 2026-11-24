/**
 * 云端定时脚本与本地判据必须给出**完全相同**的结论。
 *
 * 这是整个功能最容易出问题的地方：自动清理有两条执行路径 ——
 *   1. 本机 `cleanupCycle`（面板「现在跑一轮」/ 进程内定时器）；
 *   2. 云端 crontab 里那段 node 脚本（dsh 关掉之后继续跑）。
 *
 * 两条路径各自实现了一遍判断，所以「注释里写着保持一致」完全没有保证力：
 * 改一处阈值、漏一条保护，症状是「云端删掉了一个本机不会删的仓库」—— 不可逆，
 * 而且现场已经没了。
 *
 * 唯一能真的钉住它的办法：把同一批夹具分别喂给两边，逐条比对结论。
 * 这个文件就是那件事。
 *
 * 脚本通过 `node -e` 执行，`fetch` 用一个记录调用的假实现替换掉 ——
 * 这样「它真的会发 DELETE」和「它不会发 DELETE」都能被观察到。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanupDaemonScript,
  judgeRepository,
  normalizeCleanupSettings,
  planRepositoryCleanup,
  planWorkspaceCleanup,
} from '../lib/cleanup.js'

const shebangOf = (text) => (text.startsWith('#!') ? text.slice(0, text.indexOf('\n')) : '')
const bodyOf = (text) => (text.startsWith('#!') ? text.slice(text.indexOf('\n') + 1) : text)

const SCRATCH = mkdtempSync(join(tmpdir(), 'dsh-cnb-daemon-'))
let scriptSeq = 0

/** 把一段脚本落到临时文件，返回路径。调完就删，不留在工作区。@param {string} text */
function writeScript(text) {
  scriptSeq += 1
  const file = join(SCRATCH, `daemon-${scriptSeq}.mjs`)
  writeFileSync(file, text, 'utf8')
  return file
}

const NOW = new Date('2026-11-24T12:00:00Z')
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 3_600_000).toISOString()

/**
 * 一组覆盖面足够宽的夹具：每个分支至少一条。
 * `expected` 是「人读规则后认为的答案」，两边都必须等于它 —— 只比对两边互相一致
 * 是不够的：两处代码一起改错也会「一致」。
 */
const FIXTURES = [
  {
    slug: 'acme/dsh-gateway-20260101-000000',
    description: '',
    updatedAt: hoursAgo(100),
    expected: true,
    why: '本插件建的、很旧、没在跑 → 删',
  },
  {
    slug: 'acme/dsh-gateway-20260102-000000',
    description: '',
    updatedAt: hoursAgo(1),
    expected: false,
    why: '刚用过 → 留',
  },
  {
    slug: 'acme/dsh-gateway-20260103-000000',
    description: '',
    updatedAt: hoursAgo(100),
    running: true,
    expected: false,
    why: '还有环境在跑 → 留',
  },
  {
    slug: 'acme/real-project',
    description: '自己的项目',
    updatedAt: hoursAgo(1000),
    expected: false,
    why: '不是本插件建的 → 留',
  },
  {
    slug: 'acme/renamed-gateway',
    description: '由 dsh-cnb 自动创建：托管 CNB AI 网关代理',
    updatedAt: hoursAgo(100),
    expected: true,
    why: '改过名，但描述仍是插件写的 → 删',
  },
  {
    slug: 'acme/dsh-gateway-20260104-000000',
    description: '',
    updatedAt: null,
    expected: false,
    why: '读不到活动时间 → 留（缺失不是「很旧」）',
  },
  {
    slug: 'acme/dsh-gateway-20260105-000000',
    description: '',
    updatedAt: hoursAgo(100),
    protected: true,
    expected: false,
    why: '正在承载网关 → 留',
  },
]

const SETTINGS = normalizeCleanupSettings({
  enabled: true,
  scope: 'gateway',
  maxAgeHours: 24,
  deleteRunning: false,
})
const ACTIVE = 'acme/dsh-gateway-20260105-000000'

/**
 * 跑一遍云端脚本，返回它的判定与它真的发出的 DELETE。
 *
 * 脚本是**写到临时文件再执行**的，不是 `node -e`：生成的脚本以 `#!/usr/bin/env node`
 * 开头，而她只在文件首行合法 —— 塞进 `-e` 的字符串里直接语法错误。云端那条路径
 * 也是先 `cat > $tmp` 再 `node $tmp`，所以这样测到的就是线上真正跑的那份形状。
 * @param {Array<Record<string, any>>} fixtures
 * @param {Record<string, unknown>} settings
 * @param {{ deleteRunning?: boolean, dryRun?: boolean }} [options]
 */
function runDaemon(fixtures, settings, options = {}) {
  const script = cleanupDaemonScript({
    settings,
    activeRepo: ACTIVE,
    extraProtected: [],
    apiOrigin: 'https://api.cnb.cool',
  })
  // shebang 必须留在文件首行，所以 harness 接在它后面，而不是把它包起来。
  const shebang = script.startsWith('#!') ? script.slice(0, script.indexOf('\n')) : ''
  const body = shebang === '' ? script : script.slice(script.indexOf('\n') + 1)

  // 覆盖 fetch：仓库列表、环境列表、DELETE 全部拦在这里，一个字节都不出网。
  const harness = `${shebang}
const REAL_DELETES = []
globalThis.fetch = async (url, init) => {
  const target = String(url)
  const method = init?.method ?? 'GET'
  const send = (status, entity) => new Response(JSON.stringify(entity), { status, headers: { 'content-type': 'application/json' } })
  if (target.includes('/user/repos')) {
    return send(200, ${JSON.stringify(fixtures.map((row) => ({
      path: row.slug,
      name: row.slug.split('/')[1],
      description: row.description ?? '',
      updated_at: row.updatedAt,
    })))})
  }
  if (target.includes('/workspace/list')) {
    return send(200, { list: ${JSON.stringify(fixtures.filter((row) => row.running === true).map((row) => ({
      slug: row.slug,
      status: 'running',
    })))}, total: 1, hasMore: false })
  }
  if (method === 'DELETE') {
    REAL_DELETES.push(target.replace('https://api.cnb.cool/', ''))
    return send(200, { ok: true })
  }
  return send(404, { errcode: 5, errmsg: 'Resource not found.' })
}
process.env.CNB_CLEANUP_TOKEN = 'tok'
const lines = []
const origLog = console.log
console.log = (...args) => { lines.push(args.join(' ')) }
${body}
await new Promise((resolve) => setTimeout(resolve, 30))
console.log = origLog
origLog(JSON.stringify({ lines, deletes: REAL_DELETES }))
`
  const file = writeScript(harness)
  const result = spawnSync(process.execPath, [file], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, CNB_CLEANUP_TOKEN: '' },
  })
  rmSync(file, { force: true })
  assert.equal(result.status, 0, `the daemon script must exit cleanly:\n${result.stderr}`)
  const parsed = JSON.parse(result.stdout.trim().split('\n').pop())
  return parsed
}

/** 本机判据对同一批夹具的结论。 */
function localVerdicts(fixtures, settings) {
  const repositories = fixtures.map((row) => ({
    slug: row.slug,
    name: row.slug.split('/')[1],
    description: row.description ?? '',
    updatedAt: row.updatedAt,
    environments: row.running === true ? [{ status: 'running' }] : [],
  }))
  const plan = planRepositoryCleanup({
    repositories,
    settings,
    activeRepo: ACTIVE,
    selfRepo: null,
    now: NOW,
  })
  return new Set(plan.candidates.map((row) => row.repo))
}

// --- 1. 两边结论必须逐条一致，且都等于人读规则得出的答案 -------------
{
  const daemon = runDaemon(FIXTURES, SETTINGS)
  const deletedByDaemon = daemon.deletes
  const deletedLocally = localVerdicts(FIXTURES, SETTINGS)

  for (const fixture of FIXTURES) {
    assert.equal(
      deletedByDaemon.includes(fixture.slug),
      fixture.expected,
      `daemon: ${fixture.slug} — ${fixture.why}`,
    )
    assert.equal(
      deletedLocally.has(fixture.slug),
      fixture.expected,
      `local: ${fixture.slug} — ${fixture.why}`,
    )
  }
  assert.deepEqual(
    [...deletedByDaemon].sort(),
    [...deletedLocally].sort(),
    'the two paths must delete exactly the same set',
  )
}

// --- 2. 云端脚本走的是真删除，不是只打一行日志 ----------------------
//
// 「部署成功但什么都没发生」是这个仓库里已经踩过一次的坑（autokeep 第一版）。
{
  const daemon = runDaemon(FIXTURES, SETTINGS)
  assert.ok(daemon.lines.some((line) => line.startsWith('DSH_CLEANUP_DONE=1')), 'it reports completion')
  assert.ok(daemon.lines.some((line) => line.startsWith('DSH_CLEANUP_SCANNED=')), 'and what it scanned')
  // 夹具里有两个「该删」的（原始的 + 改过名但描述仍是插件写的），其余都该留下。
  assert.equal(FIXTURES.filter((row) => row.expected === true).length, 2, 'the fixture set itself says two')
  assert.equal(daemon.deletes.length, 2, 'exactly the eligible repositories were deleted')
  assert.ok(daemon.lines.some((line) => line.startsWith('DSH_CLEANUP_DELETED=')), 'the deletion is logged by name')
}

// --- 3. dryRun 下云端一个 DELETE 都不能发 ---------------------------
{
  const daemon = runDaemon(FIXTURES, normalizeCleanupSettings({ ...SETTINGS, dryRun: true }))
  assert.equal(daemon.deletes.length, 0, 'dryRun never deletes')
  assert.ok(daemon.lines.some((line) => line.startsWith('DSH_CLEANUP_WOULD_DELETE=')), 'but it says what it would')
}

// --- 4. 「环境还开着」没有任何开关能放开 ---------------------------
//
// 这一组曾经断言「deleteRunning 打开后运行中的也可删」——那是错的规则。
// 现在反过来钉：不管传什么设置，环境开着的仓库都不该被删，两条路径都必须收手。
{
  const liveRepo = 'acme/dsh-gateway-20260103-000000'
  for (const attempt of [{ deleteRunning: true }, { scope: 'all' }, { scope: 'prefix', prefix: 'dsh-gateway-' }]) {
    const withAttempt = normalizeCleanupSettings({ ...SETTINGS, ...attempt })
    const daemon = runDaemon(FIXTURES, withAttempt)
    const local = localVerdicts(FIXTURES, withAttempt)
    assert.deepEqual([...daemon.deletes].sort(), [...local].sort(), 'both paths agree')
    assert.ok(
      !daemon.deletes.includes(liveRepo),
      `the daemon must never delete a repo with a running environment (tried ${JSON.stringify(attempt)})`,
    )
    assert.ok(
      !local.has(liveRepo),
      `nor must the local path (tried ${JSON.stringify(attempt)})`,
    )
  }
}

// --- 5. 自建仓库永远不被自动删 -------------------------------------
//
// 自动清理的权力只到「收回它自己建出来的东西」。用户自己的仓库要删，只能手动勾选 ——
// 那是明确的意图；一个定时器猜错一次的代价是不可逆的代码丢失。
{
  for (const attempt of [{ scope: 'all' }, { scope: 'prefix', prefix: 'acme/' }]) {
    const widened = normalizeCleanupSettings({ ...SETTINGS, ...attempt })
    const daemon = runDaemon(FIXTURES, widened)
    const local = localVerdicts(FIXTURES, widened)
    assert.deepEqual([...daemon.deletes].sort(), [...local].sort(), 'both paths agree')
    assert.ok(!daemon.deletes.includes('acme/real-project'), 'a self-built repo is never auto-deleted')
    assert.ok(!local.has('acme/real-project'))
    assert.ok(!daemon.deletes.includes(ACTIVE), 'and the gateway carrier never is either')
  }
}

// --- 6. 没给令牌时什么都不做：连列表都不读 -------------------------
//
// 脚本在没有令牌时 `process.exit(0)`，所以这里看的是它自己打出的 stdout，
// 而不是 harness 收尾时的输出 —— 收尾代码根本不会被执行到，那正是要点。
{
  const script = cleanupDaemonScript({ settings: SETTINGS, activeRepo: ACTIVE, apiOrigin: 'https://api.cnb.cool' })
  const harness = `${shebangOf(script)}
let calls = 0
globalThis.fetch = async () => { calls += 1; return new Response('{}', { status: 200 }) }
delete process.env.CNB_CLEANUP_TOKEN
process.on('exit', (code) => { process.stdout.write('HARNESS_CALLS=' + calls + ' CODE=' + code + '\\n') })
${bodyOf(script)}
`
  const file = writeScript(harness)
  const result = spawnSync(process.execPath, [file], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, CNB_CLEANUP_TOKEN: '' },
  })
  rmSync(file, { force: true })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /DSH_CLEANUP_SKIP=/, 'it says why it did nothing')
  assert.match(result.stdout, /HARNESS_CALLS=0/, 'and it never touched the network')
}

// --- 7. 环境列表读不到时不动手 ------------------------------------
//
// 这是最要紧的保守默认：不知道有没有人在用，就不能删。
{
  const script = cleanupDaemonScript({ settings: SETTINGS, activeRepo: ACTIVE, apiOrigin: 'https://api.cnb.cool' })
  const harness = `${shebangOf(script)}
const DELETES = []
globalThis.fetch = async (url, init) => {
  const target = String(url)
  const send = (s, b) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })
  if (target.includes('/user/repos')) return send(200, [{ path: 'acme/dsh-gateway-20260101-000000', description: '', updated_at: ${JSON.stringify(hoursAgo(100))} }])
  if (target.includes('/workspace/list')) return send(500, { errcode: 500, errmsg: 'boom' })
  if ((init?.method ?? 'GET') === 'DELETE') { DELETES.push(target); return send(200, {}) }
  return send(404, {})
}
process.env.CNB_CLEANUP_TOKEN = 'tok'
console.log = () => {}
${bodyOf(script)}
await new Promise((r) => setTimeout(r, 30))
process.stderr.write(JSON.stringify({ deletes: DELETES }))
`
  const file = writeScript(harness)
  const result = spawnSync(process.execPath, [file], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  rmSync(file, { force: true })
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stderr.trim().split('\n').pop())
  assert.equal(parsed.deletes.length, 0, 'an unreadable workspace list means nothing is deleted')
}

console.log('cleanup-script OK · 云端脚本与本机判据逐条一致，且都等于人读规则得到的答案')

// --- 8. 环境记录那一半：云端与本机逐条一致 --------------------------
//
// 与第 1 组同样重要。云端脚本自己实现了一遍环境判据，而它的失败模式更糟：
// 云端没有面板可看，删错了只会安静地少一条记录，或者（更糟）停掉一个活环境。
// 所以这里把同一批夹具分别喂给云端脚本的 cleanWorkspaces 和本机
// planWorkspaceCleanup，断言删除集合完全相同，且都等于人读规则的结果。
{
  const envFixtures = [
    { sn: 'old-closed', slug: 'acme/x', status: 'closed', create_time: new Date(NOW.getTime() - 400 * 3_600_000).toISOString(), expected: true, why: '结束很久了 → 清' },
    { sn: 'new-closed', slug: 'acme/x', status: 'closed', create_time: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(), expected: false, why: '刚结束 → 留（还要回看日志）' },
    { sn: 'live', slug: 'acme/x', status: 'running', create_time: new Date(NOW.getTime() - 400 * 3_600_000).toISOString(), expected: false, why: '正在运行 → 永远不动' },
    { sn: 'failed-old', slug: 'acme/x', status: 'failed', create_time: new Date(NOW.getTime() - 400 * 3_600_000).toISOString(), expected: false, why: '默认只清 closed' },
    { sn: 'protected-old', slug: 'acme/gateway', status: 'closed', create_time: new Date(NOW.getTime() - 400 * 3_600_000).toISOString(), expected: false, why: '受保护仓库下 → 留' },
  ]
  const envSettings = normalizeCleanupSettings({ environments: true, envScope: 'closed', envMaxAgeHours: 168 })

  // 云端：跑脚本，抓它真的发的 /workspace/delete
  const script = cleanupDaemonScript({
    settings: envSettings,
    activeRepo: 'acme/gateway',
    extraProtected: [],
    apiOrigin: 'https://api.cnb.cool',
  })
  const harness = `${shebangOf(script)}
const ENV_DELETES = []
globalThis.fetch = async (url, init) => {
  const t = String(url)
  const m = init?.method ?? 'GET'
  const send = (s, b) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })
  if (t.includes('/user/repos')) return send(200, [])
  if (t.includes('/workspace/list')) return send(200, { list: ${JSON.stringify(envFixtures.map(({ expected, why, ...rest }) => rest))}, total: ${envFixtures.length} })
  if (t.includes('/workspace/delete')) { ENV_DELETES.push(JSON.parse(init?.body ?? '{}').sn); return send(200, { ok: true }) }
  return send(404, { errcode: 5 })
}
process.env.CNB_CLEANUP_TOKEN = 'tok'
console.log = () => {}
${bodyOf(script)}
await new Promise((r) => setTimeout(r, 50))
process.stderr.write(JSON.stringify({ deletes: ENV_DELETES }))
`
  const file = writeScript(harness)
  const run = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 20_000 })
  rmSync(file, { force: true })
  assert.equal(run.status, 0, run.stderr)
  const daemonDeletes = JSON.parse(run.stderr.trim().split('\n').pop()).deletes

  // 本机
  const localPlan = planWorkspaceCleanup({
    workspaces: envFixtures,
    settings: envSettings,
    protectedRepos: ['acme/gateway'],
    now: new Date(),
  })
  const localDeletes = localPlan.candidates.map((row) => row.sn)

  for (const fixture of envFixtures) {
    assert.equal(daemonDeletes.includes(fixture.sn), fixture.expected, `daemon env: ${fixture.sn} — ${fixture.why}`)
    assert.equal(localDeletes.includes(fixture.sn), fixture.expected, `local env: ${fixture.sn} — ${fixture.why}`)
  }
  assert.deepEqual([...daemonDeletes].sort(), [...localDeletes].sort(), 'both paths delete the same environment records')
}
