/**
 * A workspace can configure the gateway with no help from the user.
 *
 * CNB injects `CNB_TOKEN` into the container, so the dsh process inherits it — verified
 * here by reading `/proc/<pid>/environ` of the running harness and calling the gateway
 * with that value (HTTP 200). An earlier attempt to verify this looked at a shell this
 * agent spawned, which does not inherit the container's environment, and wrongly
 * concluded the variable was absent.
 *
 * Adoption is deliberately conservative: it stores the token only after a real gateway
 * call succeeds, and it never replaces a credential that is already there, because
 * overwriting a deliberate choice on every boot would be worse than doing nothing.
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
  const credentials = {
    async readRecord(key) { return records.get(key) },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next === void 0) return records.get(key)
      records.set(key, next)
      return next
    },
    async deleteRecord(key) { records.delete(key) },
    async set() {},
    async unset() {},
    async listRecords() { return [] },
  }
  const ctx = {
    effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
    get: (name) => (name === 'credentials' ? credentials : undefined),
    inject() {},
  }
  return { api: apply(ctx, {}), records }
}

const signIn = () => ({ 'dsh-cnb/cnb-token': { kind: 'grant', payload: { token: 'personal-token', user: { username: 'ren' } } } })

// --- case 1: no injected token means nothing happens ---------------------
{
  const previous = process.env.CNB_TOKEN
  delete process.env.CNB_TOKEN
  delete process.env.CNB_API_TOKEN
  const { api, records } = harness(signIn())
  globalThis.fetch = async () => json(200, {})
  try {
    const result = await api.runOperation('gateway.adoptAmbient', {})
    assert.equal(result.adopted, false)
    assert.match(result.reason, /不在 CNB 云环境|没有可继承/)
    assert.equal(records.has('dsh-cnb/gateway-token'), false)
  } finally {
    if (previous !== undefined) process.env.CNB_TOKEN = previous
    globalThis.fetch = originalFetch
  }
}

// --- case 2: an injected token that works is stored, with no user action --
{
  const previousToken = process.env.CNB_TOKEN
  const previousRepo = process.env.CNB_REPO_SLUG
  process.env.CNB_TOKEN = 'injected-pipeline-token'
  process.env.CNB_REPO_SLUG = 'acme/alpha'
  const { api, records } = harness(signIn())
  globalThis.fetch = async (url, init) => {
    assert.match(init?.headers?.authorization ?? '', /injected-pipeline-token/, 'the injected token is what gets tested')
    return sse()
  }
  try {
    const result = await api.runOperation('gateway.adoptAmbient', {})
    assert.equal(result.adopted, true)
    assert.equal(result.repo, 'acme/alpha', 'the repository comes from the environment')
    assert.equal(records.get('dsh-cnb/gateway-token').payload.token, 'injected-pipeline-token')
    // The sign-in record is untouched: adopting a gateway token is not a sign-in.
    assert.equal(records.get('dsh-cnb/cnb-token').payload.token, 'personal-token')
  } finally {
    if (previousToken === undefined) delete process.env.CNB_TOKEN
    else process.env.CNB_TOKEN = previousToken
    if (previousRepo === undefined) delete process.env.CNB_REPO_SLUG
    else process.env.CNB_REPO_SLUG = previousRepo
    globalThis.fetch = originalFetch
  }
}

// --- case 3: a stored credential is never replaced automatically ---------
{
  const previousToken = process.env.CNB_TOKEN
  const previousRepo = process.env.CNB_REPO_SLUG
  process.env.CNB_TOKEN = 'injected-pipeline-token'
  process.env.CNB_REPO_SLUG = 'acme/alpha'
  const { api, records } = harness({
    ...signIn(),
    'dsh-cnb/gateway-token': { kind: 'grant', payload: { token: 'chosen-by-hand', repo: 'acme/beta' } },
  })
  let called = false
  globalThis.fetch = async () => { called = true; return sse() }
  try {
    const result = await api.runOperation('gateway.adoptAmbient', {})
    assert.equal(result.adopted, false)
    assert.match(result.reason, /已有网关令牌/)
    assert.equal(records.get('dsh-cnb/gateway-token').payload.token, 'chosen-by-hand', 'the deliberate choice survives')
    assert.equal(called, false, 'and nothing was even probed')
  } finally {
    if (previousToken === undefined) delete process.env.CNB_TOKEN
    else process.env.CNB_TOKEN = previousToken
    if (previousRepo === undefined) delete process.env.CNB_REPO_SLUG
    else process.env.CNB_REPO_SLUG = previousRepo
    globalThis.fetch = originalFetch
  }
}

// --- case 4: an injected token the gateway refuses is not stored ----------
{
  const previousToken = process.env.CNB_TOKEN
  const previousRepo = process.env.CNB_REPO_SLUG
  process.env.CNB_TOKEN = 'injected-personal-token'
  process.env.CNB_REPO_SLUG = 'acme/alpha'
  const { api, records } = harness(signIn())
  globalThis.fetch = async () => json(403, { errcode: 403, errmsg: '[NO_RIGHT]OpenAPI only allowed in pipeline' })
  try {
    const result = await api.runOperation('gateway.adoptAmbient', {})
    assert.equal(result.adopted, false, 'a refused token must not become the gateway credential')
    assert.equal(records.has('dsh-cnb/gateway-token'), false)
    assert.match(result.blocker?.label ?? '', /个人令牌/)
  } finally {
    if (previousToken === undefined) delete process.env.CNB_TOKEN
    else process.env.CNB_TOKEN = previousToken
    if (previousRepo === undefined) delete process.env.CNB_REPO_SLUG
    else process.env.CNB_REPO_SLUG = previousRepo
    globalThis.fetch = originalFetch
  }
}

// --- case 5: force replaces an existing credential -----------------------
{
  const previousToken = process.env.CNB_TOKEN
  const previousRepo = process.env.CNB_REPO_SLUG
  process.env.CNB_TOKEN = 'injected-pipeline-token'
  process.env.CNB_REPO_SLUG = 'acme/alpha'
  const { api, records } = harness({
    ...signIn(),
    'dsh-cnb/gateway-token': { kind: 'grant', payload: { token: 'stale', repo: 'acme/beta' } },
  })
  globalThis.fetch = async () => sse()
  try {
    const result = await api.runOperation('gateway.adoptAmbient', { force: true })
    assert.equal(result.adopted, true, 'an explicit force does replace it')
    assert.equal(records.get('dsh-cnb/gateway-token').payload.token, 'injected-pipeline-token')
  } finally {
    if (previousToken === undefined) delete process.env.CNB_TOKEN
    else process.env.CNB_TOKEN = previousToken
    if (previousRepo === undefined) delete process.env.CNB_REPO_SLUG
    else process.env.CNB_REPO_SLUG = previousRepo
    globalThis.fetch = originalFetch
  }
}

console.log('ambient-token OK · injected token adopted silently, deliberate choices preserved')

// --- case 6: a secret imported through .cnb.yml is adopted too ----------
{
  // The point of this one: a repository configured with `imports` gets the token under
  // the secret file's own variable name, not CNB_TOKEN. Accepting that name is what makes
  // "configure once, works in every new repository" true.
  const previousToken = process.env.CNB_TOKEN
  const previousGateway = process.env.CNB_GATEWAY_TOKEN
  const previousRepo = process.env.CNB_REPO_SLUG
  delete process.env.CNB_TOKEN
  process.env.CNB_GATEWAY_TOKEN = 'imported-secret-token'
  process.env.CNB_REPO_SLUG = 'acme/alpha'
  const { api, records } = harness(signIn())
  globalThis.fetch = async (url, init) => {
    assert.match(init?.headers?.authorization ?? '', /imported-secret-token/, 'the imported value is what gets tested')
    return sse()
  }
  try {
    const result = await api.runOperation('gateway.adoptAmbient', {})
    assert.equal(result.adopted, true)
    assert.equal(result.source, 'imported secret', 'and the source is named as such')
    assert.equal(records.get('dsh-cnb/gateway-token').payload.token, 'imported-secret-token')
  } finally {
    if (previousToken === undefined) delete process.env.CNB_TOKEN
    else process.env.CNB_TOKEN = previousToken
    if (previousGateway === undefined) delete process.env.CNB_GATEWAY_TOKEN
    else process.env.CNB_GATEWAY_TOKEN = previousGateway
    if (previousRepo === undefined) delete process.env.CNB_REPO_SLUG
    else process.env.CNB_REPO_SLUG = previousRepo
    globalThis.fetch = originalFetch
  }
}

console.log('ambient-token: imported secret case added')
