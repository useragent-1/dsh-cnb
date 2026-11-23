/**
 * 续命闭环：停掉再启动能不能继续用。
 *
 * 实测结论（2026-11-23）：
 *   停止当前环境（sn=SN_A，前缀 PRE_A）
 *   → 重启得到新环境（sn=SN_B，前缀 PRE_B）
 *   → 旧地址 302 跳 error 页，新地址 200
 *
 * 所以「杀死再启动」确实能拿到新的 18 小时。但**地址会变**，不同步配置的话
 * 用户看到的是「保活成功，模型全挂」。这些测试钉住那条闭环。
 */
import assert from 'node:assert/strict'
import {
  RESTART_BEFORE_MS,
  RESTART_COOLDOWN_MS,
  immortalConfig,
  planRestart,
  readMarkersFromLines,
  restartScript,
} from '../lib/immortal.js'

const now = new Date('2026-11-23T17:00:00+08:00')
/** 已运行 h 小时的环境。 */
const env = (h) => ({ status: 'running', create_time: new Date(now.getTime() - h * 3_600_000).toISOString() })

// --- 1. 剩余充足：不重启 --------------------------------------
{
  const plan = planRestart({ ...env(8), isGateway: true, now })
  assert.equal(plan.restart, false)
  assert.equal(plan.action, 'none')
  assert.match(plan.reason, /剩余 10\.00 小时/)
}

// --- 2. 剩余不足：重启换新的 18 小时 --------------------------
{
  const plan = planRestart({ ...env(17.5), isGateway: true, now })
  assert.equal(plan.restart, true)
  assert.equal(plan.action, 'restart')
  assert.match(plan.reason, /重启/)
}

// --- 3. 冷却期：刚重启过就不要再动 ----------------------------
//
// 否则启动失败时每个 tick 都重试，环境被反复停启，比不动更糟。
{
  const justNow = new Date(now.getTime() - 5 * 60_000).toISOString()
  const plan = planRestart({ ...env(17.5), isGateway: true, now, lastRestartAt: justNow })
  assert.equal(plan.restart, false, `${RESTART_COOLDOWN_MS / 60_000} min cooldown must win`)
  assert.equal(plan.action, 'wait')
  assert.match(plan.reason, /冷却/)
  // 过了冷却就能重启。
  const old = new Date(now.getTime() - RESTART_COOLDOWN_MS - 60_000).toISOString()
  assert.equal(planRestart({ ...env(17.5), isGateway: true, now, lastRestartAt: old }).restart, true)
}

// --- 4. 已停止：网关直接拉起，普通环境不动 --------------------
{
  assert.equal(planRestart({ status: 'closed', isGateway: true, now }).action, 'revive')
  assert.equal(planRestart({ status: 'closed', isGateway: false, now }).restart, false)
}

// --- 5. 普通环境永不重启 --------------------------------------
{
  const plan = planRestart({ ...env(17.9), isGateway: false, now })
  assert.equal(plan.restart, false, 'restarting a plain dev environment loses uncommitted work')
  assert.match(plan.reason, /不自动重启/)
}

// --- 6. 阈值语义 ----------------------------------------------
{
  assert.equal(RESTART_BEFORE_MS, 3_600_000, 'one hour of runway')
  // 刚好在阈值上要触发。
  const atEdge = planRestart({ ...env(17), isGateway: true, now })
  assert.equal(atEdge.restart, true)
}

// --- 7. stage 日志里的标记能被读回 ----------------------------
//
// 这是闭环的另一半：新环境起来时会打这些行，本机读它才知道新地址。
{
  const markers = readMarkersFromLines([
    '\u001b[37mecho "DSH_GW_URL=..."\u001b[39m',
    'nohup node serve.mjs &',
    'DSH_GW_URL=https://abc-8794.cnb.run/v1',
    'DSH_GW_KEY=dshgw_secret',
    'DSH_GW_READY=1',
  ])
  assert.equal(markers.ready, true)
  assert.equal(markers.url, 'https://abc-8794.cnb.run/v1')
  assert.equal(markers.key, 'dshgw_secret')
  // 没有 READY 就说明没起来，不能当成可用。
  assert.equal(readMarkersFromLines(['DSH_GW_URL=https://x/v1']).ready, false)
}

// --- 8. 重启脚本：必须等旧的真停下来 --------------------------
//
// 实测：对 running 环境调 workspace/start 返回的是**同一个 sn**，计时不重置。
// 所以必须先 stop、再轮询到非 running，然后才 start。
{
  const script = restartScript({ repo: 'acme/gw', gatewayPort: 8794 })
  assert.match(script, /build\/stop/)
  assert.match(script, /workspace\/start/)
  // 等它停下来的轮询。
  assert.match(script, /for i in \$\(seq 1 20\)/)
  // 从新环境的 stage 日志取地址。
  assert.match(script, /build\/logs\/stage/)
  assert.match(script, /DSH_GW_URL/)
  // 不依赖 python（镜像里没有）。
  const executable = script.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
  assert.ok(!/\bpython[0-9]?\b/.test(executable))
}

// --- 9. 完整配置是 crontab，且注释说清代价 --------------------
{
  const { yml, cron } = immortalConfig({ repo: 'acme/gw' })
  assert.match(cron, /^\*\/\d+ \* \* \* \*$/)
  assert.match(yml, /crontab:/)
  // 必须写明不可用窗口，读者才知道「无限续期」不是免费的。
  assert.match(yml, /不可用|代价/)
}
