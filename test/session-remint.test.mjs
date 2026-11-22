/**
 * A stored web session makes token problems self-healing.
 *
 * Scanning a QR is the only interactive step a person should ever perform. Once
 * the session is kept, a token that expired or lacks a scope can be replaced by
 * replaying that session — so this pins three properties:
 *
 *  - the session that minted a token is stored with it;
 *  - a failing call re-mints and retries once, invisibly to the caller;
 *  - a session that is no longer signed in is reported, not retried forever.
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const originalFetch = globalThis.fetch
const SCOPE_TABLE = {
  config: [
    { group: 'repo', codes: [{ code: 'code', values: ['r', 'rw'], text: 'code' }] },
    { group: 'account', codes: [{ code: 'profile', values: ['r', 'rw'], text: 'profile' }] },
  ],
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function harness(seed) {
  const records = new Map()
  for (const [key, value] of Object.entries(seed ?? {})) records.set(key, value)
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

const sessionRecord = {
  kind: 'grant',
  payload: { token: 'stale', scope: 'repo-code', scopeProfile: 'full', session: 'csrftoken=abc; SESSIONID=xyz', sessionSavedAt: new Date().toISOString() },
}

// --- case 1: an expired token is replaced automatically, then the call succeeds --
{
  const { api, records } = harness({ 'dsh-cnb/cnb-token': sessionRecord })
  let minted = 0
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.includes('/config/token/scope')) return json(200, SCOPE_TABLE)
    if (target.includes('/user/personal_access_tokens')) {
      minted += 1
      return json(201, { result: { token: 'fresh', token_id: 'n1' } })
    }
    // `/user/repos` also starts with `/user`, so the narrower route is matched first.
    if (target === 'https://cnb.cool/user' || target.startsWith('https://cnb.cool/user?')) {
      return json(200, { username: 'tester', nickname: 'tester' })
    }
    if (target.includes('api.cnb.cool/user/repos') || target.startsWith('https://cnb.cool/user/repos')) {
      // The stale token fails; the fresh one works. The session retry must also
      // fail here, or it would mask the re-mint this case is about.
      const auth = String(init?.headers?.authorization ?? '')
      if (target.startsWith('https://cnb.cool/')) {
        return json(403, { errcode: 10023, errmsg: 'Missing required scopes: repo-basic-info:r' })
      }
      return auth.includes('fresh')
        ? json(200, [{ path: 'acme/alpha', name: 'alpha' }])
        : json(403, { errcode: 10023, errmsg: 'Missing required scopes: repo-basic-info:r' })
    }
    if (target.includes('api.cnb.cool/user')) return json(200, { username: 'tester', nickname: 'tester' })
    if (target.includes('/workspace/list')) return json(200, { total: 0, list: [] })
    return json(200, [])
  }
  try {
    const repos = await api.runOperation('repos.list', {})
    assert.equal(minted, 1, 'exactly one automatic mint')
    assert.equal(repos.items.length, 1, 'the retried call must succeed')
    assert.equal(records.get('dsh-cnb/cnb-token').payload.token, 'fresh')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 2: no session stored means no automatic repair, and the error surfaces --
{
  const { api } = harness({
    'dsh-cnb/cnb-token': { kind: 'grant', payload: { token: 'stale', scope: null } },
  })
  globalThis.fetch = async (url) => {
    if (url.includes('/config/token/scope')) return json(200, SCOPE_TABLE)
    return json(403, { errcode: 10023, errmsg: 'Missing required scopes: repo-basic-info:r' })
  }
  try {
    await assert.rejects(() => api.runOperation('repos.list', {}), /缺少权限|重新扫码/)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 3: an expired session is reported as such, once ------------------------
{
  const { api } = harness({
    'dsh-cnb/cnb-token': { kind: 'grant', payload: { token: 'stale', session: 'csrftoken=gone' } },
  })
  let mintAttempts = 0
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('cnb.cool/user')) return json(401, { errcode: 16, errmsg: 'not logged in' })
    if (target.includes('/user/personal_access_tokens')) { mintAttempts += 1; return json(201, {}) }
    return json(401, { errcode: 16, errmsg: 'not logged in' })
  }
  try {
    const result = await api.runOperation('token.remint', {})
    assert.equal(result.ok, false)
    assert.match(result.reason, /会话已失效|重新扫码/)
    assert.equal(mintAttempts, 0, 'an expired session must not be used to mint')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 4: the session travels with the token it produced ---------------------
{
  const { api, records } = harness({})
  globalThis.fetch = async (url) => {
    if (url.includes('/config/token/scope')) return json(200, SCOPE_TABLE)
    if (url.includes('/user/personal_access_tokens')) return json(201, { result: { token: 'fresh', token_id: 'n1' } })
    if (url.includes('api.cnb.cool/user')) return json(200, { username: 'tester', nickname: 'tester' })
    return json(200, [])
  }
  try {
    api.__test.setAttempt({
      closed: false,
      session: 'csrftoken=keepme; SESSIONID=keepsme',
      async poll() { return { confirmed: true, expired: false, nickName: 'tester' } },
      async createAccessToken() { return { token: 'fresh', tokenId: 'n1', description: 'dsh-cnb plugin', scope: [] } },
      async sessionUser() { return { username: 'tester' } },
      describe() { return {} },
    })
    const result = await api.pollLogin()
    assert.equal(result.state, 'confirmed')
    const stored = records.get('dsh-cnb/cnb-token')
    assert.match(stored.payload.session, /csrftoken=keepme/, 'the session must be kept for later re-mints')
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('session-remint OK · session stored, auto-heal once, expiry reported')
