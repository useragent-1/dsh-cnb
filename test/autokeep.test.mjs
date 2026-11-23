/**
 * 全自动守护：决策要准，生成的脚本要真能跑。
 *
 * 这里钉住三件事，都是实测踩过或必须守住的：
 *
 *   1. **普通环境绝不自动重建**。重启一个正在用的开发环境会丢未提交的工作 ——
 *      那种「自动化」比不动更糟。只有云网关承载环境例外。
 *   2. **不依赖 python**。第一版用 python3 解析 JSON，在真实云环境里直接
 *      `parse failed` 而整个守护静默失效。镜像里只有 awk/sed/date。
 *   3. **它是 crontab，不是容器内定时器**。平台按「进入环境的连接」判定活跃。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { RENEW_BEFORE_MS, autoKeepaliveConfig, daemonScript, planAction } from '../lib/autokeep.js'
import { importFromDsh } from './resolve-dsh.mjs'

const yaml = await importFromDsh('yaml', 'dist/index.js')

/** 一个已运行 h 小时的环境。 */
function ws(hours, now) {
  return {
    status: 'running',
    create_time: new Date(now.getTime() - hours * 3_600_000).toISOString(),
  }
}

// --- 1. 剩余充足：只发心跳 -------------------------------------
{
  const now = new Date('2026-11-23T16:00:00+08:00')
  const plan = planAction({ ...ws(6, now), isGateway: true, now })
  assert.equal(plan.action, 'heartbeat')
  assert.equal(plan.urgent, false)
  assert.match(plan.reason, /剩余 12\.0 小时/)
}

// --- 2. 网关环境快到期：滚动重建 -------------------------------
{
  const now = new Date('2026-11-23T16:00:00+08:00')
  const plan = planAction({ ...ws(17, now), isGateway: true, now })
  assert.equal(plan.action, 'renew')
  assert.equal(plan.urgent, true)
  // 边界：正好 RENEW_BEFORE_MS 时应触发。
  const edge = planAction({ ...ws(18 - RENEW_BEFORE_MS / 3_600_000, now), isGateway: true, now })
  assert.equal(edge.action, 'renew', 'exactly at the threshold still renews')
}

// --- 3. 普通环境快到期：只报告，绝不重建 -----------------------
{
  const now = new Date('2026-11-23T16:00:00+08:00')
  const plan = planAction({ ...ws(17, now), isGateway: false, now })
  assert.equal(plan.action, 'report', 'a plain dev environment is never restarted automatically')
  assert.match(plan.reason, /不擅自|自行/)
}

// --- 4. 已停止：网关自动拉起，普通只报告 -----------------------
{
  const now = new Date('2026-11-23T16:00:00+08:00')
  assert.equal(planAction({ status: 'closed', isGateway: true, now }).action, 'revive')
  const plain = planAction({ status: 'closed', isGateway: false, now })
  assert.equal(plain.action, 'report')
  assert.match(plain.reason, /未提交/)
}

// --- 5. 缺失 create_time 不能算出负数或 NaN --------------------
{
  const now = new Date('2026-11-23T16:00:00+08:00')
  const plan = planAction({ status: 'running', isGateway: true, now })
  assert.equal(plan.action, 'heartbeat', 'unknown age means plenty of time left, not urgent')
  assert.ok(Number.isFinite(Number(plan.reason.match(/\d+\.\d+/)?.[0] ?? 'NaN')))
}

// --- 6. 生成的脚本只用镜像里有的工具 ---------------------------
{
  const script = daemonScript({
    repos: ['acme/gw'], gatewayRepo: 'acme/gw', gatewayPort: 8794, servicePort: 3080,
  })
  // 只看可执行行：注释里提到「不依赖 python」是允许的（也是应该写的）。
  const executable = script.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
  assert.ok(!/\bpython[0-9]?\b/.test(executable), 'the image has no python; using it makes the daemon silently fail')
  // 只用 POSIX 工具：awk / sed / date / curl / mktemp。
  assert.match(script, /awk -v key=/)
  assert.match(script, /date -u -d/)
  assert.match(script, /workspace\/list/)
  assert.match(script, /workspace\/start/, 'it must be able to revive')
  // 只对网关环境重建。
  assert.match(script, /\[ "\$gw" = "1" \] && \[ "\$remain" -lt "\$RENEW_BEFORE" \]/)
  // 18 小时上限写进脚本。
  assert.match(script, /64800 - age/)
}

// --- 7. 生成的 YAML 合法，且是 crontab --------------------------
{
  for (const image of ['', 'docker.cnb.cool/a/b:1']) {
    const { yml, cron } = autoKeepaliveConfig({ repo: 'acme/gw', gatewayRepo: 'acme/gw', image })
    assert.equal(cron, '*/5 * * * *')
    const doc = yaml.parse(yml)
    const key = Object.keys(doc.$)[0]
    assert.equal(key, 'crontab: */5 * * * *', 'it must be a crontab trigger, not an in-container timer')
    const task = doc.$[key][0]
    assert.equal(task.name, 'cloud keepalive daemon')
    if (image === '') assert.equal(task.docker, undefined)
    else assert.equal(task.docker.image, image)
    // 注释里必须写明它挡不住什么，否则读者会以为能无限续命。
    assert.match(yml, /做不到|无法延长/)
  }
}

// --- 8. 多个仓库都要被覆盖 -------------------------------------
{
  const { yml, repos } = autoKeepaliveConfig({ repo: 'acme/a', gatewayRepo: 'acme/b' })
  assert.deepEqual(repos, ['acme/a', 'acme/b'])
  const script = yml.slice(yml.indexOf('script: |'))
  assert.match(script, /for repo in acme\/a acme\/b; do/)
  assert.match(script, /GW_REPO="acme\/b"/)
}
