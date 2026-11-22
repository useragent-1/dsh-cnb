/**
 * A scope refusal must be retried as the signed-in person before it is reported.
 *
 * CNB has two authorization models. A bearer token carries the scopes it was
 * minted with, and an imported token may lack `group-resource:rw` (create a
 * repository) or `account-engage:rw` (delete an environment). The web session is
 * the signed-in person rather than a scoped token, and the web origin serves the
 * same JSON API — so the same call can succeed there.
 *
 * These cases pin: the retry happens, it carries the session and csrf token, its
 * answer is preferred, and a genuine refusal still reports the missing scope.
 */
import assert from 'node:assert/strict'
import { CnbApi } from '../lib/cnb-client.js'

const originalFetch = globalThis.fetch
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// --- case 1: refused on the API origin, accepted by the session ---------------
{
  const calls = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    calls.push({ target, headers: init?.headers ?? {} })
    if (target.startsWith('https://api.cnb.cool/')) {
      return json(403, { errcode: 10023, errmsg: 'Missing required scopes: group-resource:rw' })
    }
    return json(200, { id: 'r1', name: 'created-via-session' })
  }
  try {
    const api = new CnbApi({
      token: async () => 'tok',
      web: 'https://cnb.cool',
      session: async () => 'csrftoken=abc123; OTHER=xyz',
    })
    const result = await api.createRepo('acme', { name: 'demo' })
    assert.equal(result.name, 'created-via-session', 'the session answer must be used')
    assert.equal(calls.length, 2, 'exactly one retry')
    const retry = calls[1]
    assert.ok(retry.target.startsWith('https://cnb.cool/'), 'the retry goes to the web origin')
    assert.equal(retry.headers.cookie, 'csrftoken=abc123; OTHER=xyz', 'the session cookie must be sent')
    assert.equal(retry.headers.csrftoken, 'abc123', 'the csrf token must be echoed')
    assert.equal(retry.headers.origin, 'https://cnb.cool')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 2: no session means no retry, and the scope is named ------------------
{
  let attempts = 0
  globalThis.fetch = async (url) => {
    attempts += 1
    return json(403, { errcode: 10023, errmsg: 'Missing required scopes: group-resource:rw' })
  }
  try {
    const api = new CnbApi({ token: async () => 'tok', web: 'https://cnb.cool' })
    await assert.rejects(() => api.createRepo('acme', { name: 'demo' }), /group-resource/)
    assert.equal(attempts, 1, 'without a session there is nothing to retry with')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 3: the session is authenticated but genuinely lacks the right --------
{
  let attempts = 0
  globalThis.fetch = async () => {
    attempts += 1
    return json(403, { errcode: 10023, errmsg: 'Missing required scopes: group-resource:rw' })
  }
  try {
    const api = new CnbApi({
      token: async () => 'tok',
      web: 'https://cnb.cool',
      session: async () => 'csrftoken=abc123',
    })
    await assert.rejects(() => api.createRepo('acme', { name: 'demo' }), /group-resource/)
    assert.equal(attempts, 2, 'the session must have been tried')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 4: a failure that is not a scope problem must not be retried --------
{
  let attempts = 0
  globalThis.fetch = async () => {
    attempts += 1
    return json(500, { errcode: 500, errmsg: 'boom' })
  }
  try {
    const api = new CnbApi({
      token: async () => 'tok',
      web: 'https://cnb.cool',
      session: async () => 'csrftoken=abc123',
    })
    await assert.rejects(() => api.createRepo('acme', { name: 'demo' }))
    assert.equal(attempts, 1, 'only a scope refusal warrants the session retry')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 5: the retry carries an empty body for a body-less call -------------
{
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ target: String(url), body: init?.body })
    if (String(url).startsWith('https://api.cnb.cool/')) {
      return json(403, { errcode: 10023, errmsg: 'Missing required scopes: account-engage:rw' })
    }
    return json(200, { code: 0, message: 'ok' })
  }
  try {
    const api = new CnbApi({
      token: async () => 'tok',
      web: 'https://cnb.cool',
      session: async () => 'csrftoken=z',
    })
    await api.deleteWorkspace({ sn: 'cnb-1' })
    assert.equal(seen.length, 2)
    assert.equal(seen[1].body, JSON.stringify({ sn: 'cnb-1' }), 'the body must survive the retry')
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('session-fallback OK · scope refusal retried as the session, other failures not')
