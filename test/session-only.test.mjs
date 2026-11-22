/**
 * A scan can succeed while no minted token passes verification.
 *
 * That is what the panel reported: 已登录 ren, but every token profile failed. The
 * old code threw the session away at that point and told the user their account role
 * was the problem — forcing another scan for nothing, since the cookie alone still
 * authorizes calls.
 *
 * Now the session is kept as a `session-only` record: reads work through it, the
 * panel says plainly that the token is the part that failed, and the fix (create a
 * token by hand, or check the role) is named.
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { CnbApi } from '../lib/cnb-client.js'

const originalFetch = globalThis.fetch
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

function harness(seed) {
  const records = new Map(Object.entries(seed ?? {}))
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
  return { api: apply(ctx, {}), records }
}

// --- case 1: an empty bearer with a session skips the doomed request ---------
{
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: init?.headers?.authorization ?? null, cookie: init?.headers?.cookie ?? null })
    return json(200, [{ path: 'acme/alpha' }])
  }
  try {
    const api = new CnbApi({ token: async () => '', api: 'https://api.cnb.cool', web: 'https://cnb.cool', session: async () => 'csrftoken=x' })
    const repos = await api.myRepos({ pageSize: 1 })
    assert.equal(repos.items.length, 1, 'the body is the item list')
    assert.equal(seen.length, 1, 'one request, not a refused bearer followed by a retry')
    assert.equal(seen[0].auth, null, 'no empty Bearer header is sent')
    assert.equal(seen[0].cookie, 'csrftoken=x', 'the session is the credential')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 2: with neither token nor session the error is specific -----------
{
  globalThis.fetch = async () => json(200, {})
  try {
    const api = new CnbApi({ token: async () => '', api: 'https://api.cnb.cool', web: 'https://cnb.cool' })
    await assert.rejects(() => api.myRepos({ pageSize: 1 }), /登录/)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 3: a session-only record is readable, and reported as such --------
{
  const { api } = harness({
    'dsh-cnb/cnb-token': {
      kind: 'grant',
      payload: { token: '', session: 'csrftoken=x', sessionSavedAt: new Date().toISOString(), scopeProfile: 'session-only', user: { username: 'ren', nickname: 'ren' } },
    },
  })
  globalThis.fetch = async () => json(200, { username: 'ren', nickname: 'ren' })
  try {
    const status = await api.status()
    assert.equal(status.loggedIn, true, 'the account is signed in')
    assert.equal(status.sessionStored, true, 'and the session is what carries it')
    assert.equal(status.health, 'session-only', 'but it must not claim a working token')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 4: a record with neither token nor session is not a sign-in ------
{
  const { api } = harness({ 'dsh-cnb/cnb-token': { kind: 'grant', payload: { token: '' } } })
  globalThis.fetch = async () => json(401, { errcode: 16, errmsg: 'not logged in' })
  try {
    const status = await api.status()
    assert.equal(status.loggedIn, false, 'an empty record is signed out, not broken')
    assert.equal(status.health, 'signed-out')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 5: the panel names the fix instead of blaming the role ----------
{
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /session-only/, 'the panel has a distinct state for it')
  assert.match(source, /手动创建一个令牌/, 'and names the concrete next step')
  assert.ok(!/这说明账号角色限制了可授予的权限，不是令牌格式问题/.test(source),
    'the old "your role is the problem" verdict was a guess and is gone')
}

console.log('session-only OK · session kept, empty bearer skipped, state reported honestly')
