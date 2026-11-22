/**
 * The token doctor, and the scope level rule it depends on.
 *
 * Two properties matter and both were violated in an earlier build:
 *  - a token that exists but grants nothing must be reported as broken, not as
 *    "logged in", and
 *  - the doctor must name the missing scope, because that string is the only
 *    actionable fact a user has.
 *
 * Runs offline against a stub client; the live probe lives in host-smoke.
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { normalizeScopes, fetchScopeTable } from '../lib/scopes.js'

const records = new Map()
const values = new Map()
const credentials = {
  async readRecord(key) { return records.get(key) },
  async modifyRecord(key, mutate) {
    const next = await mutate(records.get(key))
    if (next === undefined) records.delete(key)
    else records.set(key, next)
    return records.get(key)
  },
  async set(ref, value) { values.set(ref, value) },
  async unset(ref) { values.delete(ref) },
}
const ctx = {
  effect: (fn) => { fn(); return () => {} },
  get: (name) => (name === 'credentials' ? credentials : undefined),
  inject() {},
}

// A scope list with no level suffixes is what produced a powerless token.
const table = await fetchScopeTable()
const levelLess = ['repo-code', 'account-profile', 'account-engage']
assert.deepEqual(normalizeScopes(levelLess, table).scopes, [
  'repo-code:rw',
  'account-profile:rw',
  'account-engage:rw',
])
// And the mint must never be handed a level-less name by the plugin's own lists.
const bare = normalizeScopes(levelLess, table).scopes
for (const scope of bare) assert.match(scope, /:[a-z]+$/)

// Doctor: signed out answers plainly.
const signedOut = apply(ctx, {})
const none = await signedOut.diagnoseToken()
assert.equal(none.signedIn, false)
assert.match(none.hint, /扫码|令牌/)

// Doctor: a stored but useless token must be classified, not trusted.
await credentials.modifyRecord('dsh-cnb/cnb-token', async () => ({
  kind: 'grant',
  payload: { token: 'not-a-real-token', scope: 'repo-code', loginAt: new Date().toISOString() },
}))
const signedIn = apply(ctx, {})
const report = await signedIn.diagnoseToken()
assert.equal(report.signedIn, true)
assert.equal(report.healthy, false, 'a powerless token must not read as healthy')
assert.equal(report.checks.length, 8, 'reads and writes are both probed')
assert.ok(report.checks.every((check) => check.ok === false))
// A token CNB rejects outright is a different diagnosis from a scoped one.
assert.equal(report.rejected, true)
assert.match(report.hint, /不接受|重新扫码|粘贴/)

console.log(`doctor OK · rejected=${report.rejected} · checked ${report.checks.length} interfaces`)
