/**
 * The token name is a unique key, and a fixed one broke every sign-in after the first.
 *
 * The panel reported: 扫码成功（ren）… 失败原因：full: Token name already exists (errcode 6).
 * The plugin had been creating every token as "dsh-cnb plugin", so the account held
 * that name and CNB refused the second one — the sign-in looked like a permission
 * problem when it was a string.
 *
 * These cases pin a unique name per mint, and a retry that resolves a collision
 * instead of failing the whole sign-in over it.
 */
import assert from 'node:assert/strict'
import { LoginAttempt, defaultTokenName } from '../lib/cnb-client.js'

const originalFetch = globalThis.fetch

/** A login session plus a mint endpoint whose behaviour the test controls. */
function stubMint(onPost) {
  const names = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.endsWith('/login')) return new Response('', { status: 200, headers: { 'set-cookie': 'csrftoken=abc; Path=/' } })
    if (target.includes('/login/state') && !target.includes('/login/state/')) {
      return new Response(JSON.stringify({ state: 't', uuid: 'u' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const body = JSON.parse(init.body)
    names.push(body.description)
    return onPost(body, names.length)
  }
  return names
}

const ok = (body) => new Response(JSON.stringify({ result: { token: 'TOK', token_id: 7, description: body.description } }), {
  status: 200, headers: { 'content-type': 'application/json' },
})
const taken = () => new Response(JSON.stringify({ errcode: 6, errmsg: 'Token name already exists' }), {
  status: 400, headers: { 'content-type': 'application/json' },
})

// --- case 1: the generated name is unique per call --------------------------
{
  const names = new Set()
  for (let i = 0; i < 25; i += 1) names.add(defaultTokenName())
  assert.equal(names.size, 25, 'two mints in the same second must still differ')
  assert.match(defaultTokenName(), /^dsh-cnb-\d{8}-\d{6}-[a-z0-9]{4}$/, 'and the name says what it is')
}

// --- case 2: a mint sends a unique name, not a constant --------------------
{
  const names = stubMint((body) => ok(body))
  try {
    const attempt = new LoginAttempt({})
    await attempt.start()
    await attempt.createAccessToken({ scope: ['repo-code:rw'] })
    await attempt.createAccessToken({ scope: ['repo-code:rw'] })
    assert.equal(names.length, 2)
    assert.notEqual(names[0], names[1], 'the second call must not reuse the first name')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 3: errcode 6 is resolved by retrying, not reported as a failure --
{
  const names = stubMint((body, call) => (call === 1 ? taken() : ok(body)))
  try {
    const attempt = new LoginAttempt({})
    await attempt.start()
    const minted = await attempt.createAccessToken({ scope: ['repo-code:rw'] })
    assert.equal(minted.token, 'TOK', 'the sign-in must still succeed')
    assert.equal(names.length, 2, 'exactly one retry')
    assert.notEqual(names[0], names[1], 'with a different name')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 4: two collisions still surface the real error -----------------
{
  const names = stubMint(() => taken())
  try {
    const attempt = new LoginAttempt({})
    await attempt.start()
    await assert.rejects(() => attempt.createAccessToken({ scope: ['repo-code:rw'] }), (error) => {
      assert.match(error.message, /already exists/i, 'the platform message survives')
      return true
    })
    assert.equal(names.length, 2, 'it tries twice, then stops rather than looping')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 5: a different error is not retried ----------------------------
{
  const names = stubMint(() => new Response(JSON.stringify({ errcode: 10023, errmsg: 'Missing required scopes: repo-code:rw' }), {
    status: 403, headers: { 'content-type': 'application/json' },
  }))
  try {
    const attempt = new LoginAttempt({})
    await attempt.start()
    await assert.rejects(() => attempt.createAccessToken({ scope: ['repo-code:rw'] }), /repo-code:rw/)
    assert.equal(names.length, 1, 'a scope refusal is a real answer, not a name clash')
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('token-name OK · unique per mint, errcode 6 retried once, other errors surfaced')
