/**
 * A mint is not a success until the token it produced can read the account.
 *
 * CNB answers "created" for a scope list that grants nothing, so an earlier build
 * reported a finished sign-in and then showed an empty repository list. These cases
 * pin the replacement: probe every candidate, keep the first usable one, and never
 * report success for a token that cannot read the account.
 *
 * The scan session is stubbed through the documented test seam; CNB's HTTP surface
 * is intercepted.
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const TOKEN = 'usable-token'
const originalFetch = globalThis.fetch

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function harness() {
  const records = new Map()
  const credentials = {
    async readRecord(key) { return records.get(key) },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next === undefined) records.delete(key)
      else records.set(key, next)
      return records.get(key)
    },
    async set() {},
    async unset() {},
  }
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    get: (name) => (name === 'credentials' ? credentials : undefined),
    inject() {},
  }
  return { api: apply(ctx, {}), records }
}

const SCOPE_TABLE = {
  config: [
    { group: 'repo', codes: [{ code: 'code', values: ['r', 'rw'], text: 'code' }] },
    { group: 'account', codes: [{ code: 'profile', values: ['r', 'rw'], text: 'profile' }] },
    { group: 'group', codes: [{ code: 'resource', values: ['r', 'rw'], text: 'resource' }] },
  ],
}

/** A session stub whose `confirmed` poll answers like a phone approval. */
function confirmedAttempt(onMint) {
  let closed = false
  return {
    get closed() { return closed },
    set closed(value) { closed = value },
    async poll() { return { confirmed: true, expired: false, nickName: 'tester', avatar: '' } },
    async createAccessToken(options) {
      return onMint(options)
    },
    async sessionUser() { return { username: 'tester', nickname: 'tester' } },
    async start() { return {} },
    describe() { return {} },
  }
}

// --- case 1: the widest mint is powerless; a narrower one works -------------------
{
  const { api, records } = harness()
  let mint = 0
  api.__test.setAttempt(confirmedAttempt(() => {
    mint += 1
    return { token: mint === 1 ? 'powerless' : TOKEN, tokenId: `t${mint}`, description: 'dsh-cnb plugin', scope: [] }
  }))
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.includes('/config/token/scope')) return json(200, SCOPE_TABLE)
    const auth = String(init?.headers?.authorization ?? '')
    if (target.includes('api.cnb.cool/user')) {
      if (auth.includes('powerless')) {
        return json(403, { errcode: 10023, errmsg: 'Missing required scopes: account-profile:r' })
      }
      return json(200, { username: 'tester', nickname: 'tester' })
    }
    return json(200, [])
  }
  try {
    const result = await api.pollLogin()
    assert.equal(result.state, 'confirmed')
    assert.equal(result.verification.ok, true, 'a usable candidate must be kept')
    assert.equal(mint, 2, 'the powerless mint must be retried with a narrower list')
    assert.equal(result.tried[0].ok, false)
    assert.equal(result.tried[1].ok, true)
    const stored = records.get('dsh-cnb/cnb-token')
    assert.equal(stored.payload.token, TOKEN, 'the usable token is what gets stored')
    assert.notEqual(stored.payload.scopeProfile, 'full')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 2: every mint is powerless; nothing may be stored as a success ---------
{
  const { api, records } = harness()
  api.__test.setAttempt(confirmedAttempt(() => ({ token: 'powerless', tokenId: 'x', description: 'dsh-cnb plugin', scope: [] })))
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/config/token/scope')) return json(200, SCOPE_TABLE)
    return json(403, { errcode: 10023, errmsg: 'Missing required scopes: account-profile:r' })
  }
  try {
    const result = await api.pollLogin()
    assert.equal(result.state, 'confirmed')
    assert.equal(result.verification.ok, false, 'an unusable token must not read as success')
    assert.ok(result.tried.length >= 2, 'every candidate must have been tried')
    assert.ok(result.tried.every((entry) => entry.ok === false))
    assert.equal(records.has('dsh-cnb/cnb-token'), false, 'nothing may be stored as working')
    assert.ok(result.scopeRequested.length > 0, 'the report states what was asked for')
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('mint-verify OK · retries a powerless mint, never stores an unusable token')
