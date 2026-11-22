/**
 * The session lifetime is the server's decision and must be read, not chosen.
 *
 * An earlier build offered 1/7/30/90 days in the panel. That was wrong twice over:
 * the lifetime is not the user's to configure, and the value it sent (`login_days`)
 * is only honoured by a confirmation route our flow never calls — the plugin has no
 * WeChat code, so it confirms through the jump page, which sets the cookie itself.
 *
 * The honest source is the `Set-Cookie` the confirmation returns. These cases pin
 * that: expiry comes from Max-Age (or Expires), Max-Age wins, and a session with no
 * server-issued lifetime is reported as an estimate rather than a fact.
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { DEFAULT_LOGIN_DAYS, LoginAttempt } from '../lib/cnb-client.js'

const originalFetch = globalThis.fetch
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function harness(seed) {
  const records = new Map(Object.entries(seed ?? {}))
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

/** A fetch that answers the login state machine and sets session cookies. */
function stubLogin(setCookies) {
  let issued = 0
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.endsWith('/login')) {
      return new Response('', { status: 200, headers: { 'set-cookie': 'csrfkey=a; Path=/' } })
    }
    if (target.includes('/login/state') && !target.includes('/login/state/')) {
      issued += 1
      return json(200, { state: `t-${issued}`, uuid: `u-${issued}` })
    }
    const headers = new Headers({ 'content-type': 'application/json' })
    for (const cookie of setCookies ?? []) headers.append('set-cookie', cookie)
    return new Response(JSON.stringify({ nickName: '', confirmed: false, isExpired: false }), { status: 200, headers })
  }
}

// --- case 1: Max-Age is the authority, and Max-Age beats Expires ---------------
{
  stubLogin([
    'csrfkey=a; Path=/; HTTPOnly',
    'session=abc; Path=/; Max-Age=2592000; Expires=Wed, 21 Oct 2015 07:28:00 GMT',
  ])
  try {
    const attempt = new LoginAttempt({})
    await attempt.start()
    await attempt.poll()
    assert.ok(attempt.sessionExpiry, 'the poll must have observed a lifetime')
    assert.equal(attempt.sessionExpiry.name, 'session')
    assert.equal(attempt.sessionExpiry.maxAgeSeconds, 2_592_000, 'Max-Age wins over the stale Expires')
    const expected = Date.now() + 2_592_000_000
    assert.ok(Math.abs(new Date(attempt.sessionExpiry.expiresAt).getTime() - expected) < 5000)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 2: a cookie with no lifetime yields no claim -------------------------
{
  stubLogin(['csrfkey=a; Path=/; HTTPOnly', 'csrftoken=b; Path=/'])
  try {
    const attempt = new LoginAttempt({})
    await attempt.start()
    await attempt.poll()
    assert.equal(attempt.sessionExpiry, null, 'a session cookie with no Max-Age says nothing about duration')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 3: status reports the server expiry and labels its source ------------
{
  const expires = new Date(Date.now() + 21 * 86_400_000).toISOString()
  const { api } = harness({
    'dsh-cnb/cnb-token': {
      kind: 'grant',
      payload: { token: 'tok', session: 'csrftoken=x', sessionSavedAt: new Date().toISOString(), sessionExpiresAt: expires, cookieName: 'session' },
    },
  })
  globalThis.fetch = async () => json(401, { errcode: 16, errmsg: 'not logged in' })
  try {
    const status = await api.status()
    assert.equal(status.cookie.source, 'server', 'a server-issued expiry must be labelled as such')
    assert.equal(status.cookie.expiresAt, expires)
    assert.ok(status.cookie.remainingMs > 20 * 86_400_000)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 4: without one, the answer is an estimate, not a fact ---------------
{
  const savedAt = new Date().toISOString()
  const { api } = harness({
    'dsh-cnb/cnb-token': {
      kind: 'grant',
      payload: { token: 'tok', session: 'csrftoken=x', sessionSavedAt: savedAt },
    },
  })
  globalThis.fetch = async () => json(401, { errcode: 16, errmsg: 'not logged in' })
  try {
    const status = await api.status()
    assert.equal(status.cookie.source, 'estimated', 'no server lifetime means the reported date is a guess and says so')
    const expected = new Date(new Date(savedAt).getTime() + DEFAULT_LOGIN_DAYS * 86_400_000).toISOString()
    assert.equal(status.cookie.expiresAt, expected)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 5: no session at all reports nothing -------------------------------
{
  const { api } = harness({ 'dsh-cnb/cnb-token': { kind: 'grant', payload: { token: 'tok' } } })
  globalThis.fetch = async () => json(200, { username: 'tester' })
  try {
    const status = await api.status()
    assert.deepEqual(status.cookie, { stored: false, savedAt: null, expiresAt: null, remainingMs: null, source: null, cookieName: null })
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 6: the panel must not offer a lifetime control ---------------------
{
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(!source.includes('LoginDaysPicker'), 'the lifetime picker was removed: it is not the user’s to set')
  assert.ok(!/login_days[=:]/.test(source), 'and the panel no longer sends a lifetime')
  assert.ok(!source.includes("login.begin', { loginDays"), 'begin takes no lifetime')
}

console.log('login-days OK · expiry read from Set-Cookie, Max-Age preferred, estimates labelled')
