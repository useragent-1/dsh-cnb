/**
 * 云环境保活：算得准、不谎报、不掉进「假保活」。
 *
 * 平台规则（官方文档 /zh/workspaces/workspace-recycling.md）：
 *   1. 创建后 10 分钟没进 VS Code → 回收
 *   2. 打开后关闭、超 10 分钟无操作 → 回收
 *   3. 最大 18 小时，**持续心跳可维持**
 *   4. 使用超 8 小时且处于凌晨 4–6 点 → 强制回收（不过夜）
 *
 * 这些测试钉住三件事：
 *   · 倒计时按平台字段算（duration 优先于本地减法）；
 *   · 凌晨规则算得对 —— 它**不是**靠活跃度，保活挡不住，界面必须照实说；
 *   · 生成的心跳配置是**外部 Runner** 的形状，不是容器内定时器。
 */
import assert from 'node:assert/strict'
import {
  MAX_KEEP_MS,
  OVERNIGHT_USED_MS,
  ageMs,
  adviceFor,
  heartbeatConfig,
  inspectAll,
  inspectWorkspace,
  overnightDeadline,
  remainingMs,
} from '../lib/keepalive.js'
import { importFromDsh } from './resolve-dsh.mjs'

const yamlLib = await importFromDsh('yaml', 'dist/index.js')

/** 一个运行中环境，指定已运行小时数。 */
function ws(hours, extra = {}, base = Date.now()) {
  // 只用 create_time 推导时长；duration 是平台里语义不明的计数，不用它。
  return {
    sn: `cnb-${hours}`,
    slug: 'acme/gw',
    status: 'running',
    create_time: new Date(base - hours * 3_600_000).toISOString(),
    business_id: 'abc123',
    ...extra,
  }
}

// --- 1. 时长与剩余：只认 create_time ------------------------------
{
  const now = new Date('2026-11-23T12:00:00Z')
  const target = ws(5, {}, now.getTime())
  assert.equal(Math.round(ageMs(target, now) / 3_600_000), 5, 'age comes from create_time')
  assert.equal(Math.round(remainingMs(target, now) / 3_600_000), 13, '18h minus 5h')
  // duration 字段即使很大也不能被当成时长：实测它会让 0.5 小时显示成 90 小时。
  assert.equal(
    Math.round(ageMs({ create_time: target.create_time, duration: 325661 }, now) / 3_600_000), 5,
    'duration is ignored',
  )
  // 没有 create_time：0，不是 NaN。
  assert.equal(ageMs({}, now), 0)
  // 超上限：剩余不为负。
  assert.equal(remainingMs(ws(20, {}, now.getTime()), now), 0, 'remaining never goes negative')
}

// --- 2. 「环境不过夜」算得对 -----------------------------------
//
// 两个条件要同时成立：到 4 点时累计超 8 小时，且那时还没越过 18 小时硬上限。
// 漏掉第二个会误报：一个已经跑了 9 小时的环境，到次日 4 点前早就因上限被收了，
// 「凌晨回收」轮不到它。
{
  const afternoon = new Date("2026-11-23T15:00:00+08:00")

  // 用满 9 小时、下午：到次日 4 点前已超 18h 上限 → 不算凌晨风险。
  const old = overnightDeadline(ws(9, {}, afternoon.getTime()), afternoon)
  assert.equal(old.active, false, "it hits the 18h ceiling long before 4am")
  assert.match(old.reason, /18 小时上限/)

  // 跑了 2 小时、下午：到次日 4 点时 15 小时，超 8 小时且未到上限 → 会被凌晨收。
  const young = overnightDeadline(ws(2, {}, afternoon.getTime()), afternoon)
  assert.equal(young.active, true, "2h now becomes 15h at 4am: over 8h, under 18h")
  assert.match(young.reason, /8 小时/)
  assert.ok(young.ageAtDeadlineHours > 8 && young.ageAtDeadlineHours < 18)

  // 刚启动 0.5 小时：到 4 点 13.5 小时，同样会被收 —— 这条规则比直觉更早生效。
  assert.equal(overnightDeadline(ws(0.5, {}, afternoon.getTime()), afternoon).active, true)

  // 已经在 4–6 点窗口内且超 8 小时：立刻有风险。
  const inside = new Date("2026-11-23T04:30:00+08:00")
  assert.equal(overnightDeadline(ws(9, {}, inside.getTime()), inside).active, true, 'past 8h inside the window is at risk')

  assert.equal(OVERNIGHT_USED_MS, 8 * 3_600_000)
}

// --- 3. 体检给出可执行的结论，而不是只报状态 -------------------
{
  // 4:30 且只跑 2h：未超 8 小时，凌晨规则不适用 → 判定应为纯 running。
  const now = new Date('2026-11-23T04:30:00+08:00')
  const row = inspectWorkspace(ws(2, {}, now.getTime()), { now })
  assert.equal(row.verdict, 'running')
  // 非网关环境默认探它自己的服务端口（3080）—— 探 8794 会得到「connection refused」，
  // 把健康环境误判成心跳失效（实测踩过）。
  assert.equal(row.previewUrl, 'https://abc123-3080.cnb.run', 'non-gateway environments probe their own service port')
  // 标明是网关环境才用 8794。
  const asGateway = inspectWorkspace(ws(2, {}, now.getTime()), { now, gateway: true })
  assert.equal(asGateway.previewUrl, 'https://abc123-8794.cnb.run', 'the gateway environment probes the gateway port')
  assert.equal(asGateway.probePort, 8794)
  assert.equal(row.heartbeat.reachable, null, 'reachability is unknown until we actually probe')
  assert.match(row.advice, /心跳可维持|持续心跳/, 'advice says heartbeats help')

  // 快到 18 小时：必须给出「即将到期」。用下午的时点，避免与凌晨规则叠加
  // （凌晨风险优先级更高，那是刻意的：半夜被收更紧迫）。
  const near = inspectWorkspace(ws(17.5, {}, new Date('2026-11-23T08:00:00+08:00').getTime()), { now: new Date('2026-11-23T08:00:00+08:00') })
  assert.equal(near.verdict, 'expiring')
  assert.match(near.advice, /不足 1 小时|18 小时/)

  // 已停止：不编造倒计时。
  const stopped = inspectWorkspace({ sn: 'x', status: 'closed' }, { now })
  assert.equal(stopped.verdict, 'stopped')
  assert.equal(stopped.expiresAt, null)
  assert.match(stopped.advice, /已停止/)
}

// --- 4. 凌晨风险优先级最高，且明确说「心跳挡不住」 -------------
{
  const now = new Date('2026-11-23T04:30:00+08:00')
  const row = inspectWorkspace(ws(9, {}, now.getTime()), { now })
  assert.equal(row.verdict, 'overnight-risk')
  assert.match(row.advice, /挡不住|任何心跳/)
}

// --- 5. 汇总：危险的排在前面，云网关单独标出 -------------------
{
  const now = new Date('2026-11-23T04:30:00+08:00')
  const created = (hours) => new Date(now.getTime() - hours * 3_600_000).toISOString()
  const list = inspectAll(
    [
      // 跑 1 小时：没超 8 小时，凌晨规则不适用 → 普通运行中。
      { sn: 'a', slug: 'acme/plain', status: 'running', create_time: created(1), business_id: 'p1' },
      // 跑 9 小时且此刻在 4–6 点窗口：凌晨风险，必须排最前。
      { sn: 'b', slug: 'acme/gw', status: 'running', create_time: created(9), business_id: 'g1' },
      { sn: 'c', slug: 'acme/old', status: 'closed' },
    ],
    { now, routeRepo: 'acme/gw' },
  )
  assert.equal(list.total, 3)
  assert.equal(list.running, 2)
  assert.equal(list.overnightRisk, 1)
  assert.equal(list.rows[0].sn, 'b', 'the at-risk environment is listed first')
  assert.equal(list.gateway.sn, 'b', 'the gateway-bearing environment is identified')
  assert.equal(list.gateway.gateway, true)
}

// --- 6. 心跳配置必须是「外部 Runner」的形状 ---------------------
//
// 关键：它跑在另一个容器里（crontab 触发），请求经 CNB 网关进入环境。
// 如果生成的是容器内定时器，那就是假保活 —— 平台按「进入环境的连接」判定。
{
  const { yml, cron } = heartbeatConfig({ repo: 'acme/gw', port: 8794 })
  assert.equal(cron, '*/5 * * * *')

  const doc = yamlLib.parse(yml)
  const key = Object.keys(doc.$)[0]
  assert.equal(key, 'crontab: */5 * * * *', 'it is a crontab trigger, not an in-container timer')
  const task = doc.$[key][0]
  assert.equal(task.name, 'keep-alive heartbeat')
  const script = task.stages[0].script
  // 它去查 running 环境，然后打端口预览域名 —— 请求从外部进来。
  assert.match(script, /workspace\/list/)
  assert.match(script, /business_id/)
  assert.match(script, /-8794\.cnb\.run/)
  // 401 也算到达：脚本不能把「要鉴权」当成失败而跳过心跳。
  assert.match(yml, /401/)
}

// --- 7. 带镜像与不带镜像都能被 YAML 解析 ----------------------
{
  for (const image of ['', 'docker.cnb.cool/a/b:1']) {
    const { yml } = heartbeatConfig({ repo: 'acme/gw', image })
    const doc = yamlLib.parse(yml)
    const key = Object.keys(doc.$)[0]
    const task = doc.$[key][0]
    assert.equal(task.name, 'keep-alive heartbeat', `image=${image || '(none)'} keeps the task`)
    if (image === '') assert.equal(task.docker, undefined)
    else assert.equal(task.docker.image, image)
  }
}

// --- 8. adviceFor 不吹牛 ---------------------------------------
{
  assert.match(adviceFor({ running: false, remaining: 0, overnight: { active: false } }), /已停止/)
  assert.match(
    adviceFor({ running: true, remaining: 1000, overnight: { active: false } }),
    /不足 1 小时|即将回收/,
    'near the hard limit it says so instead of promising heartbeats will help',
  )
  assert.match(
    adviceFor({ running: true, remaining: MAX_KEEP_MS, overnight: { active: true } }),
    /挡不住|任何心跳/,
    'the overnight rule is stated as unbeatable',
  )
}
