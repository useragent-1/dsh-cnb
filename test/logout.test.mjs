/**
 * Logging out must actually remove the account.
 *
 * `modifyRecord` is not a delete: the real store returns the current record when the
 * mutator yields `undefined` ("leave it as it is"), and offers `deleteRecord` for
 * removal. Writing `modifyRecord(key, () => undefined)` therefore kept the account
 * while the panel reported 已退出登录 — the reported bug.
 *
 * These cases pin the real store's semantics, so the bug cannot come back silently.
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const originalFetch = globalThis.fetch
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A store that behaves like @deepseek-ai/dsh-credentials-local. */
function faithfulStore(seed) {
  const records = new Map(Object.entries(seed ?? {}))
  const calls = []
  const credentials = {
    async readRecord(key) { return records.get(key) },
    async modifyRecord(key, mutate) {
      calls.push(`modify:${key}`)
      const next = await mutate(records.get(key))
      // The real implementation: `undefined` means "unchanged", never "delete".
      if (next === void 0) return records.get(key)
      records.set(key, next)
      return next
    },
    async deleteRecord(key) {
      calls.push(`delete:${key}`)
      if (!records.has(key)) return
      records.delete(key)
    },
    async set(key) { calls.push(`set:${key}`) },
    async unset(key) { calls.push(`unset:${key}`) },
    async listRecords() { return [] },
  }
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    get: (name) => (name === 'credentials' ? credentials : undefined),
    inject() {},
  }
  return { api: apply(ctx, {}), records, calls }
}

const seeded = () => ({
  'dsh-cnb/cnb-token': {
    kind: 'grant',
    payload: { token: 'tok-old', user: { username: 'old-account', nickname: 'old' }, loginAt: '2026-01-01T00:00:00Z' },
  },
})

// --- case 1: logout removes the record and reports the truth ------------------
{
  const { api, records, calls } = faithfulStore(seeded())
  globalThis.fetch = async () => json(401, { errcode: 16, errmsg: 'not logged in' })
  try {
    const status = await api.runOperation('login.logout', {})
    assert.equal(records.has('dsh-cnb/cnb-token'), false, 'the account must be gone from the store')
    assert.equal(status.loggedIn, false, 'and the panel must be told so')
    assert.equal(status.user, null)
    assert.equal(status.account, null)
    assert.ok(calls.some((call) => call.startsWith('delete:')), 'removal must go through deleteRecord')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 2: logging out must not disturb the gateway credential ------------
{
  // The gateway token is a separate credential with its own reference; signing out of
  // the panel has nothing to say about it.
  const { api, calls } = faithfulStore({
    ...seeded(),
    'dsh-cnb/gateway-token': { kind: 'grant', payload: { token: 'pipeline-token', savedAt: new Date().toISOString() } },
  })
  globalThis.fetch = async () => json(401, { errcode: 16, errmsg: 'not logged in' })
  try {
    await api.runOperation('login.logout', {})
    assert.ok(!calls.some((call) => call.includes('gateway-token')), 'the gateway credential must survive a logout')
    assert.ok(!calls.includes('unset:CNB_GATEWAY_TOKEN'), 'and so must its reference')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 3: a second logout is harmless -------------------------------------
{
  const { api, records } = faithfulStore({})
  globalThis.fetch = async () => json(401, { errcode: 16, errmsg: 'not logged in' })
  try {
    const status = await api.runOperation('login.logout', {})
    assert.equal(status.loggedIn, false)
    assert.equal(records.size, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 4: importing then logging out does not leave the old account -------
{
  const { api, records } = faithfulStore(seeded())
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/user/repos')) return json(200, [{ path: 'new/repo' }])
    if (target.endsWith('/user')) return json(200, { username: 'new-account', nickname: 'new' })
    return json(200, {})
  }
  try {
    await api.runOperation('login.importToken', { token: 'tok-new' })
    assert.equal(records.get('dsh-cnb/cnb-token').payload.user.username, 'new-account')
    const status = await api.runOperation('login.logout', {})
    assert.equal(records.has('dsh-cnb/cnb-token'), false, 'the replacement account must also be removable')
    assert.equal(status.loggedIn, false)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 5: status never resurrects a deleted account ----------------------
{
  const { api } = faithfulStore(seeded())
  globalThis.fetch = async () => json(401, { errcode: 16, errmsg: 'not logged in' })
  try {
    await api.runOperation('login.logout', {})
    const status = await api.status()
    assert.equal(status.loggedIn, false, 'a cleared account must stay cleared')
    assert.equal(status.health, 'signed-out')
    assert.equal(status.cookie.stored, false)
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('logout OK · deleteRecord used, account cleared, gateway credential preserved')
