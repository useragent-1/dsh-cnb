/**
 * The gateway needs its own pipeline token, kept apart from the panel's sign-in.
 *
 * The AI gateway refuses a personal access token — "[NO_RIGHT] OpenAPI only allowed in
 * pipeline" — and signing in with the panel produces exactly that kind of token. Both
 * used to write the same credential reference (`CNB_TOKEN`), so whichever came last
 * decided and the gateway broke the moment someone scanned in.
 *
 * The gateway credential is now separate and verified before it is kept: a token that
 * the gateway refuses is rejected at import with its reason, instead of being stored
 * and failing on every request afterwards.
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const originalFetch = globalThis.fetch
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const sse = () => new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
  status: 200, headers: { 'content-type': 'text/event-stream' },
})

function harness(seed) {
  const records = new Map(Object.entries(seed ?? {}))
  const values = new Map()
  const credentials = {
    async readRecord(key) { return records.get(key) },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next === void 0) return records.get(key)
      records.set(key, next)
      return next
    },
    async deleteRecord(key) { records.delete(key) },
    async set(ref, value) { values.set(ref, value) },
    async unset(ref) { values.delete(ref) },
    async listRecords() { return [] },
  }
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    get: (name) => (name === 'credentials' ? credentials : undefined),
    inject() {},
  }
  return { api: apply(ctx, {}), records, values }
}

const signedIn = (token) => ({
  'dsh-cnb/cnb-token': { kind: 'grant', payload: { token, user: { username: 'tester', nickname: 'tester' } } },
})

// --- case 1: signing in must not touch the gateway credential ------------
{
  const { api, values } = harness(signedIn('personal-token'))
  globalThis.fetch = async () => json(200, { username: 'tester' })
  try {
    await api.status()
    assert.equal(values.has('CNB_GATEWAY_TOKEN'), false, 'a sign-in must not write the gateway key')
    assert.equal(values.has('CNB_TOKEN'), false, 'nor the old shared name')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 2: importing a working pipeline token stores it and its reference --
{
  const { api, records, values } = harness(signedIn('personal-token'))
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/user/repos')) return json(200, [{ path: 'acme/alpha' }])
    if (target.includes('/-/ai/chat/completions')) return sse()
    return json(404, { errcode: 5, errmsg: 'Resource not found.' })
  }
  try {
    const result = await api.runOperation('gateway.importToken', { token: 'pipeline-token', repo: 'acme/alpha' })
    assert.equal(result.stored, true)
    assert.equal(result.repo, 'acme/alpha')
    assert.equal(records.get('dsh-cnb/gateway-token').payload.token, 'pipeline-token', 'kept in its own record')
    assert.equal(values.get('CNB_GATEWAY_TOKEN'), 'pipeline-token', 'and referenced separately')
    // The sign-in record is untouched, so the panel keeps working.
    assert.equal(records.get('dsh-cnb/cnb-token').payload.token, 'personal-token')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 3: a personal token is refused at import, with the reason ------
{
  const { api, records } = harness(signedIn('personal-token'))
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/user/repos')) return json(200, [{ path: 'acme/alpha' }])
    if (target.includes('/-/ai/chat/completions')) {
      return json(403, { errcode: 403, errmsg: '[NO_RIGHT]OpenAPI only allowed in pipeline' })
    }
    return json(404, {})
  }
  try {
    await assert.rejects(() => api.runOperation('gateway.importToken', { token: 'personal-x' }), (error) => {
      assert.match(error.message, /个人令牌/, 'it says which kind was refused')
      assert.match(error.message, /流水线令牌|云环境/, 'and how to get the right one')
      return true
    })
    assert.equal(records.has('dsh-cnb/gateway-token'), false, 'nothing may be stored')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 4: with a gateway token imported, probing uses it --------------
{
  const { api, values } = harness(signedIn('personal-token'))
  const authSeen = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.includes('/user/repos')) return json(200, [{ path: 'acme/alpha' }])
    if (target.includes('/-/ai/chat/completions')) {
      authSeen.push(init?.headers?.authorization ?? null)
      // Only the imported token is accepted here.
      return init?.headers?.authorization === 'Bearer pipeline-token' ? sse() : json(403, { errcode: 403, errmsg: '[NO_RIGHT]OpenAPI only allowed in pipeline' })
    }
    return json(404, {})
  }
  try {
    await api.runOperation('gateway.importToken', { token: 'pipeline-token', repo: 'acme/alpha' })
    assert.equal(values.get('CNB_GATEWAY_TOKEN'), 'pipeline-token')
    const picked = await api.runOperation('gateway.autopick', {})
    assert.equal(picked.found, true, 'probing must use the imported pipeline token')
    assert.equal(picked.repo, 'acme/alpha')
    assert.ok(authSeen.every((header) => header === 'Bearer pipeline-token'), 'never the personal token')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 5: the status row reports what is stored ----------------------
{
  const { api } = harness(signedIn('personal-token'))
  globalThis.fetch = async () => json(200, { username: 'tester' })
  try {
    const before = await api.runOperation('gateway.token', {})
    assert.equal(before.stored, false)
    globalThis.fetch = async (url) => {
      if (String(url).includes('/-/ai/chat/completions')) return sse()
      if (String(url).includes('/user/repos')) return json(200, [{ path: 'acme/alpha' }])
      return json(200, {})
    }
    await api.runOperation('gateway.importToken', { token: 'pipeline-token', repo: 'acme/alpha' })
    const after = await api.runOperation('gateway.token', {})
    assert.equal(after.stored, true)
    assert.equal(after.repo, 'acme/alpha')
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('gateway-token OK · own credential, verified on import, personal tokens refused')
