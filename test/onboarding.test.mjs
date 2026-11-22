/**
 * What a first-time user must be able to do, and what the plugin must not pretend.
 *
 * The gateway accepts only a pipeline token, and that token exists solely inside a
 * running environment. A personal access token cannot read it — verified: it has no
 * access to the environment's injected variables, and both AI paths answer
 * "[NO_RIGHT] OpenAPI only allowed in pipeline". So the token cannot be fetched on the
 * user's behalf; what can be removed is the guesswork about where to get it.
 *
 * `gateway.guide` starts an environment on a repository the account owns and returns the
 * exact command to run there. These cases pin that the guide names real coordinates and
 * that the plugin never claims a personal token will work.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apply } from '../lib/index.js'

const originalFetch = globalThis.fetch
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function harness() {
  const records = new Map([['dsh-cnb/cnb-token', { kind: 'grant', payload: { token: 'tok', user: { username: 'newbie' } } }]])
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
    effect: (fn) => { fn(); return () => {} },
    get: (name) => (name === 'credentials' ? credentials : undefined),
    inject() {},
  }
  return { api: apply(ctx, {}), records }
}

// --- case 1: the guide starts an environment and names the command ------
{
  const { api } = harness()
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/-/git/branches')) return json(200, [])
    if (target.includes('/-/workspace/start')) {
      return json(200, { sn: 'cnb-new', url: 'https://cnb.cool/acme/fresh/-/workspace/loading?branch=main&sn=cnb-new' })
    }
    return json(200, {})
  }
  try {
    const guide = await api.runOperation('gateway.guide', { repo: 'acme/fresh' })
    assert.equal(guide.repo, 'acme/fresh')
    assert.equal(guide.branch, 'main', 'a brand-new repository still starts')
    assert.equal(guide.sn, 'cnb-new')
    assert.ok(Array.isArray(guide.steps) && guide.steps.length >= 2)
    assert.ok(guide.steps.some((step) => step.includes('echo $CNB_TOKEN')), 'the exact command is named')
    assert.match(guide.note, /流水线令牌/, 'and why a personal token will not do')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 2: the guide reuses a running environment instead of piling up --
{
  const { api } = harness()
  let starts = 0
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/-/git/branches')) return json(200, [{ name: 'main' }])
    if (target.includes('/-/workspace/start')) {
      starts += 1
      return json(200, { url: 'https://cnb.cool/acme/alpha/-/workspace/vscode-web/cnb-run-1-001/' })
    }
    return json(200, { webide: 'https://cnb.cool/acme/alpha/-/workspace/vscode-web/cnb-run-1-001/' })
  }
  try {
    const guide = await api.runOperation('gateway.guide', { repo: 'acme/alpha' })
    assert.equal(starts, 1, 'one start call; the platform itself reuses a running environment')
    assert.equal(guide.sn, 'cnb-run-1', 'and the sn is recovered from the path form')
    assert.ok(guide.webideUrl, 'the WebIDE link is returned so the user can go straight there')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 3: a personal token is never described as sufficient ----------
{
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const panel = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  // The refusal is about the credential type, so the wording must say so.
  assert.match(source, /个人访问令牌无法调用网关|个人令牌/, 'the limitation is stated')
  // The panel must state the limitation where the input is, but the wording now depends
  // on what actually happened: adopted, blocked by an overlay, or absent.
  assert.match(panel, /AI 网关只接受流水线令牌|流水线令牌/, 'the requirement is stated at the input')
  assert.match(panel, /describeGatewayState/, 'and the state is described from the real result, not a fixed line')
  // No code path may store a personal token as the gateway key.
  assert.ok(!/writeGatewayToken\([^)]*personal/i.test(source))
}

// --- case 4: the guide is reachable from the operation table ------------
{
  const { api } = harness()
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/user/repos')) return json(200, [{ path: 'acme/alpha' }])
    if (target.includes('/-/git/branches')) return json(200, [{ name: 'main' }])
    if (target.includes('/-/workspace/start')) return json(200, { sn: 'cnb-auto', url: 'https://cnb.cool/acme/alpha/-/workspace/loading?sn=cnb-auto' })
    return json(200, {})
  }
  try {
    // An empty repo means "pick one for me"; it must not throw a shape error.
    const guide = await api.runOperation('gateway.guide', {})
    assert.ok(guide.repo, 'a repository is resolved')
    assert.ok(Array.isArray(guide.steps))
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('onboarding OK · guide starts an environment, names the command, never promises a PAT')
