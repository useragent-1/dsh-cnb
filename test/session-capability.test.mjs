/**
 * The self-check must not paint a working capability red.
 *
 * A scope refusal is retried as the signed-in session, so a call the token cannot
 * authorize may still succeed. The probe client used to be built without the
 * session, which meant it reported that capability as 受限 — a red row for
 * something the panel can actually do.
 *
 * These cases pin: the probe carries the session, a session-backed success is
 * flagged rather than failed, and a genuine refusal still reports the scope.
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const originalFetch = globalThis.fetch
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function harness(payload) {
  const records = new Map([['dsh-cnb/cnb-token', { kind: 'grant', payload }]])
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
  return apply(ctx, {})
}

/** Reads succeed on the token; writes are refused there and accepted by the session. */
function installFetch({ sessionWorks }) {
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    const cookie = String(init?.headers?.cookie ?? '')
    const onWeb = target.startsWith('https://cnb.cool/')
    if (!onWeb) {
      if (target.includes('/user/repos')) return json(200, [{ path: 'acme/alpha' }])
      if (target.includes('/user/groups')) return json(200, [{ path: 'acme' }])
      if (target.includes('/charge/')) return json(200, { ci_in_sec: { total: 1 } })
      if (target.includes('/workspace/list')) return json(200, { total: 3, list: [] })
      if (target.endsWith('/user')) return json(200, { username: 'tester', nickname: 'tester' })
      return json(403, { errcode: 10023, errmsg: 'Missing required scopes: group-resource:rw' })
    }
    if (!sessionWorks || cookie === '') {
      return json(403, { errcode: 10023, errmsg: 'Missing required scopes: group-resource:rw' })
    }
    // The session is past the scope check: the target is bogus, the permission is not.
    return json(400, { errcode: 400, errmsg: 'bad input' })
  }
}

// --- case 1: a write the session carries is available, not 受限 -----------------
{
  const api = harness({ token: 'tok', session: 'csrftoken=abc' })
  installFetch({ sessionWorks: true })
  try {
    const doctor = await api.runOperation('token.doctor', {})
    const create = doctor.checks.find((check) => check.name === 'repo-create')
    assert.equal(create.ok, true, 'the session carried this call, so the capability works')
    assert.equal(create.viaSession, true, 'and it must be flagged as session-backed')
    assert.equal(doctor.healthy, true)
    assert.deepEqual(doctor.missingScopes, [], 'nothing is missing once the session covers it')
    assert.ok(doctor.viaSession.includes('repo-create'), 'the summary must name it')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 2: without a session the same write is genuinely missing --------------
{
  const api = harness({ token: 'tok' })
  installFetch({ sessionWorks: false })
  try {
    const doctor = await api.runOperation('token.doctor', {})
    const create = doctor.checks.find((check) => check.name === 'repo-create')
    assert.equal(create.ok, false)
    assert.deepEqual(create.missingScopes, ['group-resource:rw'])
    assert.deepEqual(doctor.missingScopes, ['group-resource:rw'])
    assert.equal(doctor.healthy, false)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 3: a session that is also refused must not be reported as working -----
{
  const api = harness({ token: 'tok', session: 'csrftoken=stale' })
  installFetch({ sessionWorks: false })
  try {
    const doctor = await api.runOperation('token.doctor', {})
    const create = doctor.checks.find((check) => check.name === 'repo-create')
    assert.equal(create.ok, false, 'a refused session cannot make the capability available')
    assert.deepEqual(doctor.viaSession, [])
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 4: reads never need the session, so they stay unmarked ---------------
{
  const api = harness({ token: 'tok', session: 'csrftoken=abc' })
  installFetch({ sessionWorks: true })
  try {
    const doctor = await api.runOperation('token.doctor', {})
    const repos = doctor.checks.find((check) => check.name === 'repositories')
    assert.equal(repos.ok, true)
    assert.equal(repos.viaSession, false, 'a token-authorized call must not claim the session')
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('session-capability OK · session-backed writes counted as available, genuine gaps still named')
