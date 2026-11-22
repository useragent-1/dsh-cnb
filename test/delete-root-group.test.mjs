/**
 * A repository in a personal organization cannot be deleted through the Open API.
 *
 * The platform answers `errcode 9`: "cannot delete this resource via Open API due to
 * root group management rules". That covers every repository under a root group —
 * which is every repository in a personal organization, including ones this plugin
 * created — so "create a repo, then delete it" failed at the second step.
 *
 * The console is not bound by that rule because it does not use the Open API: it calls
 * `/{slug}/-/repos/{name}` on the web origin with the browser session. That route
 * exists there (it answers 401 without a session, where the API answers 404), and it
 * is the fallback this pins.
 */
import assert from 'node:assert/strict'
import { CnbApi } from '../lib/cnb-client.js'

const originalFetch = globalThis.fetch
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** @param {(url: string, init: object) => Response} respond */
function withFetch(respond) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', cookie: init?.headers?.cookie ?? null })
    return respond(String(url), init)
  }
  return calls
}

// --- case 1: the API route is tried first, and works when allowed ----------
{
  const calls = withFetch(() => json(200, { ok: true }))
  try {
    const api = new CnbApi({ token: async () => 'tok', api: 'https://api.cnb.cool', web: 'https://cnb.cool', session: async () => 'csrftoken=x' })
    await api.deleteRepo('acme/alpha')
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /api\.cnb\.cool\/acme\/alpha$/)
    assert.equal(calls[0].method, 'DELETE')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 2: errcode 9 falls back to the console route with the session ----
{
  const calls = withFetch((url) => {
    if (String(url).startsWith('https://api.cnb.cool/')) {
      return json(403, { errcode: 9, errmsg: 'Cannot delete this resource via Open API due to root group management rules. Please contact the root admin.' })
    }
    return json(200, { ok: true })
  })
  try {
    const api = new CnbApi({ token: async () => 'tok', api: 'https://api.cnb.cool', web: 'https://cnb.cool', session: async () => 'csrftoken=abc; other=1' })
    const result = await api.deleteRepo('catboy98/13ff')
    assert.deepEqual(result, { ok: true }, 'the deletion must succeed')
    assert.equal(calls.length, 2, 'one API call, then one console call')
    assert.equal(calls[1].url, 'https://cnb.cool/catboy98/-/repos/13ff', 'the console route, not the API one')
    assert.equal(calls[1].method, 'DELETE')
    assert.match(calls[1].cookie, /csrftoken=abc/, 'authenticated by the session')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 3: without a session the platform error is reported, not hidden --
{
  const calls = withFetch(() => json(403, { errcode: 9, errmsg: 'Cannot delete this resource via Open API due to root group management rules.' }))
  try {
    const api = new CnbApi({ token: async () => 'tok', api: 'https://api.cnb.cool', web: 'https://cnb.cool' })
    await assert.rejects(() => api.deleteRepo('catboy98/13ff'), (error) => {
      assert.match(error.message, /root group/i, 'the real reason survives')
      return true
    })
    assert.equal(calls.length, 1, 'no pointless console attempt')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 4: an ordinary 404 is not retried on the other origin -----------
{
  const calls = withFetch(() => json(404, { errcode: 5, errmsg: 'Resource not found.' }))
  try {
    const api = new CnbApi({ token: async () => 'tok', api: 'https://api.cnb.cool', web: 'https://cnb.cool', session: async () => 'csrftoken=x' })
    await assert.rejects(() => api.deleteRepo('acme/gone'))
    assert.equal(calls.length, 1, 'a missing repo is missing on both origins')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 5: every console shape is tried, and the failures are named ----
{
  const calls = withFetch((url) => {
    if (String(url).startsWith('https://api.cnb.cool/')) return json(403, { errcode: 9, errmsg: 'root group management rules' })
    return json(403, { errcode: 16, errmsg: 'permission denied' })
  })
  try {
    const api = new CnbApi({ token: async () => 'tok', api: 'https://api.cnb.cool', web: 'https://cnb.cool', session: async () => 'csrftoken=x' })
    await assert.rejects(() => api.deleteRepo('catboy98/13ff'), (error) => {
      assert.match(error.message, /控制台路由也全部失败/, 'it says the console route failed too')
      assert.match(error.message, /DELETE api-json（403）/, 'and names each shape with its status')
      assert.equal(error.body.failures.length, 4, 'all four shapes are reported')
      return true
    })
    assert.equal(calls.length, 5, 'one API call plus four console shapes, then it stops')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 6: the first console shape that works wins -----------------
{
  const calls = withFetch((url) => {
    if (String(url).startsWith('https://api.cnb.cool/')) return json(403, { errcode: 9, errmsg: 'root group management rules' })
    // A 400 for the api-json accept, then success for plain json: the order matters,
    // because a 400 is what the real service answered and the path is right.
    if (String(url).includes('/-/repos/')) {
      const isFirst = calls.filter((call) => call.url.includes('/-/repos/')).length === 1
      return isFirst
        ? json(400, { errcode: 3, errmsg: 'Invalid argument' })
        : json(200, { ok: true })
    }
    return json(200, { ok: true })
  })
  try {
    const api = new CnbApi({ token: async () => 'tok', api: 'https://api.cnb.cool', web: 'https://cnb.cool', session: async () => 'csrftoken=x' })
    const result = await api.deleteRepo('catboy98/13ff')
    assert.deepEqual(result, { ok: true }, 'a later shape succeeding is enough')
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('delete-root-group OK · errcode 9 falls back to the console route, other errors stay put')
