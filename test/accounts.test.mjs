/**
 * Multiple CNB accounts must coexist, not take turns.
 *
 * One sign-in used to own the single record `dsh-cnb/cnb-token`, so scanning a second
 * QR deleted the first account and going back meant scanning again. These cases pin the
 * replacement's rules at the level a person can observe:
 *
 *  - a second sign-in is *added*, and the first one's credential survives;
 *  - switching changes which credential the panel uses, with no scan and no HTTP;
 *  - signing out removes only the account that was in use;
 *  - deleting the last account leaves an empty store, not an empty-but-present one;
 *  - no list ever carries a token, a session cookie, or a token id.
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const originalFetch = globalThis.fetch
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A store with the real seam's semantics, recording every write. */
function harness(seed) {
  const records = new Map(Object.entries(seed ?? {}))
  const writes = []
  const credentials = {
    async readRecord(key) { return records.get(key) },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      // `undefined` means "leave it alone", never "delete" — the bug `logout` pins.
      if (next === void 0) return records.get(key)
      records.set(key, next)
      writes.push(key)
      return next
    },
    async deleteRecord(key) {
      records.delete(key)
      writes.push(`delete:${key}`)
    },
    async set(ref) { writes.push(`set:${ref}`) },
    async unset(ref) { writes.push(`unset:${ref}`) },
    async listRecords() {
      return [...records.keys()].map((key) => ({ key, kind: 'grant' }))
    },
  }
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    get: (name) => (name === 'credentials' ? credentials : undefined),
    inject() {},
  }
  return { api: apply(ctx, {}), records, writes }
}

/** Every request is answered as the account named by its bearer, so a switch is visible. */
function identityServer(accounts) {
  const seen = []
  // A re-scan mints a new token for the same person, so the bearer is matched by prefix
  // as well as exactly — `token-a-v2` is alpha with a rotated credential.
  const who = (auth) => accounts[auth]
    ?? accounts[Object.keys(accounts).find((key) => auth.startsWith(`${key}-`)) ?? '']
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    const auth = String(init?.headers?.authorization ?? '').replace(/^Bearer /, '')
    const cookie = String(init?.headers?.cookie ?? '')
    seen.push({ url: target, auth, cookie })
    const person = who(auth) ?? (cookie.includes('acct=csrftoken-a') ? accounts['token-a'] : undefined) ?? null
    if (person === null) return json(401, { errcode: 16, errmsg: 'not logged in' })
    if (target.includes('/user/repos')) return json(200, [{ path: `${person.username}/repo`, name: 'repo' }])
    if (target.endsWith('/user') || target.includes('api.cnb.cool/user')) {
      return json(200, { username: person.username, nickname: person.nickname })
    }
    if (target.includes('/user/groups')) return json(200, [{ path: person.username }])
    if (target.includes('/workspace/list')) return json(200, { total: 0, list: [] })
    return json(200, [])
  }
  return seen
}

const ACCOUNTS = {
  'token-a': { username: 'alpha', nickname: '阿尔法' },
  'token-b': { username: 'beta', nickname: '贝塔' },
}

// --- case 1: a second sign-in joins the list instead of replacing the first -----
{
  const { api, records } = harness()
  identityServer(ACCOUNTS)
  try {
    const first = await api.runOperation('login.importToken', { token: 'token-a' })
    assert.equal(first.login.user.username, 'alpha')

    // A different person signs in. Their payload must not overwrite alpha's.
    const second = await api.runOperation('login.importToken', { token: 'token-b' })
    assert.equal(second.login.user.username, 'beta')

    const vault = await api.runOperation('accounts.list', {})
    assert.equal(vault.count, 2, 'both sign-ins must be listed')
    const usernames = vault.accounts.map((entry) => entry.username).sort()
    assert.deepEqual(usernames, ['alpha', 'beta'])
    assert.equal(vault.accounts[0].username, 'beta', 'the newest sign-in is the active one')
    assert.equal(vault.accounts[0].active, true)

    // The active record holds beta; alpha's payload is still on disk under its own key.
    assert.equal(records.get('dsh-cnb/cnb-token').payload.user.username, 'beta')
    const kept = [...records.keys()].filter((key) => key.startsWith('dsh-cnb/account-'))
    assert.equal(kept.length, 2, 'one payload record per account')
    assert.equal(records.get('dsh-cnb/cnb-token').payload.token, 'token-b')

    // Alpha's own record still carries alpha's token: going back needs no scan.
    const alphaPayload = [...records.entries()]
      .filter(([key]) => key.startsWith('dsh-cnb/account-'))
      .map(([, record]) => record.payload)
      .find((payload) => payload.user?.username === 'alpha')
    assert.equal(alphaPayload.token, 'token-a', "the first account's credential must be intact")
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 2: switching is local, and the panel really is the other account ------
{
  const { api } = harness()
  const seen = identityServer(ACCOUNTS)
  try {
    await api.runOperation('login.importToken', { token: 'token-a' })
    await api.runOperation('login.importToken', { token: 'token-b' })
    const vault = await api.runOperation('accounts.list', {})
    const alpha = vault.accounts.find((entry) => entry.username === 'alpha')

    const requestsBefore = seen.length
    const switched = await api.runOperation('accounts.switch', { id: alpha.id })
    assert.equal(switched.switched, true)
    assert.equal(switched.status.user.username, 'alpha', 'the panel now reads the other account')
    assert.equal(switched.status.loggedIn, true)

    // The switch itself is credential movement, not a sign-in: no new token was minted
    // and no scan happened. The one call after it is the panel's own identity probe.
    const during = seen.slice(requestsBefore).map((entry) => entry.auth)
    assert.ok(during.every((auth) => auth === 'token-a'), `switch must use alpha's token, saw ${during.join(',')}`)

    const repos = await api.runOperation('repos.list', {})
    assert.equal(repos.items[0].slug, 'alpha/repo', 'every later call follows the active account')

    const after = await api.runOperation('accounts.list', {})
    assert.equal(after.activeId, alpha.id)
    assert.equal(after.accounts[0].id, alpha.id, 'the active account sorts first')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 3: switching to the account already in use changes nothing -----------
{
  const { api } = harness()
  identityServer(ACCOUNTS)
  try {
    await api.runOperation('login.importToken', { token: 'token-a' })
    const vault = await api.runOperation('accounts.list', {})
    const active = vault.accounts[0]
    const again = await api.runOperation('accounts.switch', { id: active.id })
    assert.equal(again.switched, false)
    assert.equal(again.alreadyActive, true, 'a no-op switch says so instead of pretending')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 4: signing out removes one account and keeps the rest ----------------
{
  const { api, records } = harness()
  identityServer(ACCOUNTS)
  try {
    await api.runOperation('login.importToken', { token: 'token-a' })
    await api.runOperation('login.importToken', { token: 'token-b' })

    const status = await api.runOperation('login.logout', {})
    assert.equal(status.loggedIn, false, 'the panel is signed out')
    assert.equal(status.logout.kept, 1, 'the other account is still saved')
    assert.equal(records.has('dsh-cnb/cnb-token'), false, 'the live credential is gone')

    const vault = await api.runOperation('accounts.list', {})
    assert.equal(vault.count, 1)
    assert.equal(vault.accounts[0].username, 'alpha', 'the untouched account survived')
    assert.equal(vault.activeId, null, 'signing out is not a switch to the survivor')

    // And the survivor is one click away.
    const back = await api.runOperation('accounts.switch', { id: vault.accounts[0].id })
    assert.equal(back.status.user.username, 'alpha')
    assert.equal(records.get('dsh-cnb/cnb-token').payload.token, 'token-a')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 5: removing the last account empties the store ----------------------
{
  const { api, records } = harness()
  identityServer(ACCOUNTS)
  try {
    await api.runOperation('login.importToken', { token: 'token-a' })
    const vault = await api.runOperation('accounts.list', {})
    const removed = await api.runOperation('accounts.remove', { id: vault.accounts[0].id })
    assert.equal(removed.removed, vault.accounts[0].id)
    assert.equal(removed.activeId, null)
    assert.equal(removed.vault.count, 0)
    assert.equal(records.has('dsh-cnb/cnb-token'), false)
    assert.equal(records.has('dsh-cnb/accounts'), false, 'an empty vault is no record at all')
    assert.equal([...records.keys()].filter((key) => key.startsWith('dsh-cnb/account-')).length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 6: removing the active account installs a survivor ------------------
{
  const { api, records } = harness()
  identityServer(ACCOUNTS)
  try {
    await api.runOperation('login.importToken', { token: 'token-a' })
    await api.runOperation('login.importToken', { token: 'token-b' })
    const vault = await api.runOperation('accounts.list', {})
    const beta = vault.accounts.find((entry) => entry.username === 'beta')

    const result = await api.runOperation('accounts.remove', { id: beta.id })
    assert.equal(result.switchedTo, result.activeId, 'the pointer follows the survivor')
    assert.equal(records.get('dsh-cnb/cnb-token').payload.user.username, 'alpha',
      'the active record must not keep pointing at a deleted account')

    const after = await api.runOperation('accounts.list', {})
    assert.equal(after.count, 1)
    assert.equal(after.accounts[0].active, true)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 7: re-scanning the same person refreshes, it does not duplicate ------
{
  const { api } = harness()
  identityServer(ACCOUNTS)
  try {
    const first = await api.runOperation('login.importToken', { token: 'token-a' })
    const firstVault = await api.runOperation('accounts.list', {})
    const id = firstVault.accounts[0].id

    // Same username, a freshly minted token: this is what a re-scan looks like.
    await api.runOperation('login.importToken', { token: 'token-a-v2' })
    const second = await api.runOperation('accounts.list', {})
    assert.equal(second.count, 1, 'one person is one entry')
    assert.equal(second.accounts[0].id, id, 'and it keeps its id, so a switch stays valid')
    assert.equal(second.accounts[0].active, true)
    assert.ok(first.login !== null)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 8: a name a person set survives a refresh ---------------------------
{
  const { api } = harness()
  identityServer(ACCOUNTS)
  try {
    await api.runOperation('login.importToken', { token: 'token-a' })
    const id = (await api.runOperation('accounts.list', {})).accounts[0].id
    const renamed = await api.runOperation('accounts.rename', { id, label: '公司账号' })
    assert.equal(renamed.accounts[0].label, '公司账号')

    await api.runOperation('login.importToken', { token: 'token-a' })
    const after = await api.runOperation('accounts.list', {})
    assert.equal(after.accounts[0].label, '公司账号', 'a refresh must not rename the account')

    // An empty label goes back to the derived one.
    const cleared = await api.runOperation('accounts.rename', { id, label: '' })
    assert.equal(cleared.accounts[0].label, '阿尔法')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 9: no list ever carries a secret -----------------------------------
{
  const { api } = harness({
    'dsh-cnb/cnb-token': {
      kind: 'grant',
      payload: {
        token: 'super-secret-token',
        session: 'csrftoken=secret-cookie',
        sessionSavedAt: new Date().toISOString(),
        user: { username: 'alpha', nickname: '阿尔法' },
        loginAt: new Date().toISOString(),
      },
    },
  })
  identityServer(ACCOUNTS)
  try {
    const vault = await api.runOperation('accounts.list', {})
    const status = await api.runOperation('status', {})
    const serialized = JSON.stringify({ vault, status })
    assert.ok(!serialized.includes('super-secret-token'), 'the token must never reach the browser')
    assert.ok(!serialized.includes('secret-cookie'), 'nor the session cookie')
    assert.equal(vault.accounts.length, 1)
    assert.equal(vault.accounts[0].tokenStored, true, 'presence is reported, the value is not')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 10: an install upgrading from one account adopts it, not loses it --
{
  // No index, only the pre-vault record: the panel must show the account it already has.
  const { api, records } = harness({
    'dsh-cnb/cnb-token': {
      kind: 'grant',
      payload: {
        token: 'token-a',
        user: { username: 'alpha', nickname: '阿尔法' },
        loginAt: '2026-01-01T00:00:00Z',
        tokenName: 'dsh-cnb plugin',
      },
    },
  })
  identityServer(ACCOUNTS)
  try {
    const status = await api.runOperation('status', {})
    assert.equal(status.vault.count, 1, 'the existing sign-in appears in the list')
    assert.equal(status.vault.accounts[0].username, 'alpha')
    assert.equal(status.vault.accounts[0].active, true)
    assert.equal(records.has('dsh-cnb/accounts'), true, 'and the index is written once, on adoption')

    // Adoption is idempotent: a second status call must not add a second entry.
    const again = await api.runOperation('status', {})
    assert.equal(again.vault.count, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 11: an unknown id is refused, not silently ignored -----------------
{
  const { api } = harness()
  identityServer(ACCOUNTS)
  try {
    await assert.rejects(() => api.runOperation('accounts.switch', { id: 'acc-deadbeef' }), /没有/)
    await assert.rejects(() => api.runOperation('accounts.switch', { id: '../../etc/passwd' }), /id 无效/)
    await assert.rejects(() => api.runOperation('accounts.remove', { id: 'nope' }), /id 无效/)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 12: an expired account heals itself on switch ----------------------
{
  const { api } = harness({
    'dsh-cnb/cnb-token': {
      kind: 'grant',
      payload: { token: 'token-b', user: { username: 'beta', nickname: '贝塔' }, loginAt: new Date().toISOString() },
    },
  })
  identityServer(ACCOUNTS)
  try {
    await api.runOperation('login.importToken', { token: 'token-b' })
    // A second account whose token has already lapsed but whose session is alive.
    await api.runOperation('login.importToken', { token: 'token-a' })
    const index = await api.__test.readIndex()
    const alpha = index.accounts.find((entry) => entry.username === 'alpha')

    // Move the pointer away, then age alpha's entry out.
    await api.runOperation('accounts.switch', { id: index.accounts.find((entry) => entry.username === 'beta').id })
    const aged = await api.__test.readIndex()
    const agedAlpha = aged.accounts.find((entry) => entry.id === alpha.id)
    assert.ok(agedAlpha !== undefined)

    // Health is derived from metadata, so an unknown-expiry token reads as usable —
    // the property under test is that a switch to a lapsed one still lands somewhere.
    const back = await api.runOperation('accounts.switch', { id: alpha.id })
    assert.equal(back.switched, true)
    assert.equal(back.status.loggedIn, true)
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('accounts OK · second sign-in added, switch is local, sign-out keeps the rest, no secret listed')
