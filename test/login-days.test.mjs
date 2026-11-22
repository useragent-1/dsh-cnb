/**
 * The browser session's lifetime is a choice, and the panel must show it.
 *
 * CNB's confirmation step takes the lifetime as `login_days` — its own console does
 * exactly that when it confirms a scan (`…/login/wx/do-confirm?…&login_days=2`) —
 * and its default is 7 days, published as `WECHAT_DEFAULT_LOGIN_DAYS`. Sending the
 * bare permission name at sign-in produced a token with no rights in an earlier
 * round; sending no lifetime here would silently cap the session at a week.
 *
 * These cases pin: the value rides on the ticket URL, an invalid choice is refused
 * rather than silently defaulted, and the status reports the lifetime and expiry.
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { DEFAULT_LOGIN_DAYS, LOGIN_DAY_CHOICES, LoginAttempt, resolveLoginDays } from '../lib/cnb-client.js'

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

// --- case 1: the choices and the default match what CNB publishes -------------
{
  assert.equal(DEFAULT_LOGIN_DAYS, 7, 'CNB publishes WECHAT_DEFAULT_LOGIN_DAYS = 7')
  assert.deepEqual(LOGIN_DAY_CHOICES, [1, 7, 30, 90])
  assert.equal(resolveLoginDays(30), 30)
  assert.equal(resolveLoginDays('30'), 30)
  assert.throws(() => resolveLoginDays(0), /不合法|只能/)
  assert.throws(() => resolveLoginDays(365), /只能/)
  assert.throws(() => resolveLoginDays('abc'), /不合法|只能/)
}

// --- case 2: the lifetime rides on the ticket URL -----------------------------
{
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.endsWith('/login')) return json(200, {})
    if (target.includes('/login/state') && !target.includes('/login/state/')) {
      return json(200, { state: 'ticket-1', uuid: 'uuid-1' })
    }
    return json(200, {})
  }
  try {
    const long = new LoginAttempt({ loginDays: 30 })
    await long.start()
    assert.match(long.ticketUrl, /login_days=30$/, 'a non-default lifetime must be explicit')

    const standard = new LoginAttempt({})
    await standard.start()
    assert.ok(!standard.ticketUrl.includes('login_days'), "the default needs no override; CNB's own default applies")
    assert.equal(standard.loginDays, DEFAULT_LOGIN_DAYS)
    assert.equal(standard.describe().loginDays, DEFAULT_LOGIN_DAYS)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 3: beginLogin honours the choice and reports it --------------------
{
  const { api } = harness()
  // Each /login/state call must mint a distinct ticket, or "a new QR" is unprovable.
  let issued = 0
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.endsWith('/login')) return json(200, {})
    if (target.includes('/login/state') && !target.includes('/login/state/')) {
      issued += 1
      return json(200, { state: `ticket-${issued}`, uuid: `uuid-${issued}` })
    }
    return json(200, {})
  }
  try {
    const view = await api.runOperation('login.begin', { loginDays: 90 })
    assert.equal(view.loginDays, 90)
    assert.match(view.ticketUrl, /login_days=90/)
    // A different lifetime must start a fresh QR: the scanned page already carries
    // the old one, so reusing it would contradict what the user chose.
    const again = await api.runOperation('login.begin', { loginDays: 1 })
    assert.equal(again.loginDays, 1)
    assert.notEqual(again.state, view.state)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 4: status reports the lifetime and a derived expiry ----------------
{
  const savedAt = new Date(Date.now() - 2 * 86_400_000).toISOString()
  const { api } = harness({
    'dsh-cnb/cnb-token': {
      kind: 'grant',
      payload: { token: 'tok', session: 'csrftoken=x', sessionSavedAt: savedAt, loginDays: 30 },
    },
  })
  globalThis.fetch = async () => json(401, { errcode: 16, errmsg: 'not logged in' })
  try {
    const status = await api.status()
    assert.equal(status.cookie.stored, true)
    assert.equal(status.cookie.loginDays, 30, 'the chosen lifetime must be reported back')
    const expected = new Date(new Date(savedAt).getTime() + 30 * 86_400_000).toISOString()
    assert.equal(status.cookie.expiresAt, expected)
    assert.ok(status.cookie.remainingMs > 27 * 86_400_000, '28 days in, roughly 28 remain')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 5: a session-less record reports nothing rather than a fake date ---
{
  const { api } = harness({
    'dsh-cnb/cnb-token': { kind: 'grant', payload: { token: 'tok' } },
  })
  globalThis.fetch = async () => json(200, { username: 'tester' })
  try {
    const status = await api.status()
    assert.deepEqual(status.cookie, { stored: false, loginDays: null, savedAt: null, expiresAt: null, remainingMs: null })
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('login-days OK · lifetime rides the ticket, invalid values refused, status reports expiry')
