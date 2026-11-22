/**
 * The gateway works for exactly one repository per credential, so pick by probing.
 *
 * CNB's AI gateway refuses a personal access token outright — "[NO_RIGHT] OpenAPI only
 * allowed in pipeline" — and a pipeline token answers only for the repository whose
 * environment minted it. "Choose any repository, they all work" is therefore false, and
 * writing a provider for the wrong one produces a base URL that answers 403 forever.
 *
 * autopick probes until one answers and returns it; when none does it reports the cause
 * and the fix, because three failures need three different replies.
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const originalFetch = globalThis.fetch
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function harness() {
  const records = new Map([['dsh-cnb/cnb-token', { kind: 'grant', payload: { token: 'tok' } }]])
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
  }
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    get: (name) => (name === 'credentials' ? credentials : undefined),
    inject() {},
  }
  return apply(ctx, {})
}

const repoList = [
  { path: 'acme/alpha' },
  { path: 'acme/beta' },
  { path: 'acme/gamma' },
]

/** @param {(repo: string) => Response} verdict */
function stubGateway(verdict) {
  const hits = []
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/user/repos')) return json(200, repoList)
    const match = /api\.cnb\.cool\/([^/]+\/[^/]+)\/-\/ai/.exec(target)
    if (match) {
      hits.push(match[1])
      return verdict(match[1])
    }
    return json(404, { errcode: 5, errmsg: 'Resource not found.' })
  }
  return hits
}

const okBody = () => new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
  status: 200, headers: { 'content-type': 'text/event-stream' },
})
const noRight = () => json(403, { errcode: 403, errmsg: '[NO_RIGHT]OpenAPI only allowed in pipeline' })
const wrongRepo = () => json(403, { errcode: 403, errmsg: '[SLUG_ID_NOT_MATCH]SlugId not match' })
const noAi = () => json(404, { errcode: 5, errmsg: 'Resource not found.' })

// --- case 1: the first repository that answers is chosen ----------------
{
  const hits = stubGateway((repo) => (repo === 'acme/beta' ? okBody() : wrongRepo()))
  try {
    const result = await harness().runOperation('gateway.autopick', {})
    assert.equal(result.found, true)
    assert.equal(result.repo, 'acme/beta', 'the one that answered, not the first listed')
    assert.equal(result.checked, 2, 'and it stops probing once one works')
    assert.deepEqual(hits, ['acme/alpha', 'acme/beta'])
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 2: a previously working repository is tried first ------------
{
  stubGateway((repo) => (repo === 'acme/gamma' ? okBody() : wrongRepo()))
  try {
    const result = await harness().runOperation('gateway.autopick', { preferred: 'acme/gamma' })
    assert.equal(result.repo, 'acme/gamma')
    assert.equal(result.checked, 1, 'a remembered choice costs one probe, not three')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 3: a personal token is reported as such, with its own fix ----
{
  stubGateway(() => noRight())
  try {
    const result = await harness().runOperation('gateway.autopick', {})
    assert.equal(result.found, false)
    assert.equal(result.repo, null)
    assert.match(result.reason, /个人访问令牌|个人令牌/, 'names the token type as the cause')
    assert.match(result.fix, /云环境|流水线/, 'and says what to obtain instead')
    assert.equal(result.counts['personal-token'], 3, 'every repository refused the same way')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 4: a token bound elsewhere says so --------------------------
{
  stubGateway(() => wrongRepo())
  try {
    const result = await harness().runOperation('gateway.autopick', {})
    assert.equal(result.found, false)
    assert.match(result.fix, /签发它的仓库|目标仓库/, 'the fix is about which environment minted it')
    assert.equal(result.counts['wrong-repo'], 3)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 5: a repository without AI is distinguished from a refusal --
{
  stubGateway(() => noAi())
  try {
    const result = await harness().runOperation('gateway.autopick', {})
    assert.equal(result.found, false)
    assert.match(result.reason, /没有开通|AI/i)
    assert.equal(result.counts['no-ai'], 3)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 6: configure refuses an explicitly named unusable repository --
{
  stubGateway(() => noRight())
  try {
    const api = harness()
    await assert.rejects(() => api.runOperation('gateway.configure', { repo: 'acme/alpha' }), (error) => {
      assert.match(error.message, /无法为 acme\/alpha 配置网关/, 'it names the repository')
      assert.match(error.message, /个人/, 'and the reason')
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('gateway-autopick OK · picks the one that answers, explains why none do')
