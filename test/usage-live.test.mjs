/**
 * The usage tab must show consumption, and keep it current.
 *
 * Two things were wrong before. The numbers looked dead because the tab read them once
 * at mount and never again, so a finished build or a running environment never showed
 * up. And it was easy to miss that consumption itself was being fetched at all: the
 * quota endpoint returns `{total, free}`, while actual use lives on
 * `/-/charge/volume` — verified live, where dev reads 943083 seconds against a total of
 * 5760000. A dashboard that shows only the quota looks like it reports zero usage.
 *
 * These cases pin that consumption is read, that the panel refreshes on a timer, and
 * that the refresh can be switched off.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apply } from '../lib/index.js'

const originalFetch = globalThis.fetch
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function harness() {
  const records = new Map([['dsh-cnb/cnb-token', { kind: 'grant', payload: { token: 'tok', user: { username: 'ren' } } }]])
  const credentials = {
    async readRecord(key) { return records.get(key) },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next === void 0) return records.get(key)
      records.set(key, next)
      return next
    },
    async deleteRecord(key) { records.delete(key) },
    async set() {},
    async unset() {},
    async listRecords() { return [] },
  }
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    get: (name) => (name === 'credentials' ? credentials : undefined),
    inject() {},
  }
  return apply(ctx, {})
}

// --- case 1: consumption comes from the volume endpoint, not the quota ----
{
  const api = harness()
  const paths = []
  globalThis.fetch = async (url) => {
    const target = String(url)
    paths.push(target.replace('https://api.cnb.cool', ''))
    if (target.includes('/user/groups')) return json(200, [{ path: 'acme', name: 'acme' }])
    if (target.includes('/charge/quota')) {
      return json(200, { dev_in_sec: { total: 5_760_000, free: 4_816_917 }, ci_in_sec: { total: 576_000, free: 576_000 } })
    }
    if (target.includes('/charge/volume')) {
      return json(200, { dev_in_sec: 943_083, ci_in_sec: 0, git_in_byte: 440_864_768, object_in_byte: 648_145_761 })
    }
    return json(200, {})
  }
  try {
    const result = await api.runOperation('usage.list', { slug: 'acme' })
    const group = result.groups[0]
    const dev = group.metrics.find((metric) => metric.id === 'charge_type_dev')
    assert.equal(dev.total, 5_760_000, 'the total is the quota')
    assert.equal(dev.used, 943_083, 'and the used figure is the real consumption')
    assert.ok(dev.ratio > 0.16 && dev.ratio < 0.17, `a non-zero ratio is what makes the bar move (${dev.ratio})`)
    // The volume route is what carries consumption; without it everything reads zero.
    assert.ok(paths.some((path) => path.includes('/charge/volume')), 'the volume endpoint must be called')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 2: a byte metric uses *_in_byte, not *_in_sec -----------------
{
  const api = harness()
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/user/groups')) return json(200, [{ path: 'acme' }])
    if (target.includes('/charge/quota')) return json(200, { git_in_byte: { total: 107_374_182_400, free: 106_933_317_632 } })
    if (target.includes('/charge/volume')) return json(200, { git_in_byte: 440_864_768 })
    return json(200, {})
  }
  try {
    const result = await api.runOperation('usage.list', { slug: 'acme' })
    const git = result.groups[0].metrics.find((metric) => metric.id === 'charge_type_git')
    assert.equal(git.unit, 'byte')
    assert.equal(git.used, 440_864_768)
    assert.equal(git.total, 107_374_182_400)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 3: the panel refreshes on a timer, and the timer can be paused --
{
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /setInterval\(\(\) => \{[\s\S]{0,120}usage\.reload\(\)/, 'the tab re-reads the numbers on an interval')
  assert.match(source, /30_000/, 'and the interval is a relaxed one, not a busy loop')
  assert.match(source, /visibilitychange/, 'a background tab stops polling')
  assert.match(source, /每 30 秒自动刷新/, 'the state is visible')
  assert.match(source, /已暂停刷新/, 'and can be switched off')
}

console.log('usage-live OK · consumption read from volume, refreshed on a timer, pausable')
