/**
 * One dev environment has more entry points than the WebIDE.
 *
 * `workspace/detail` answers with two of them, but a live environment also has a
 * CodeBuddy Web entry and a port-preview domain — and the port preview is the one
 * people actually need, because a service started inside the environment is
 * reachable only there with the port substituted.
 *
 * These cases pin the full set, the two sn spellings CNB insists on, and the
 * refusal to borrow this host's own proxy prefix for someone else's repository.
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

const detailBody = {
  webide: 'https://cnb.cool/acme/alpha/-/workspace/vscode-web/cnb-1-001/',
  jumpUrl: 'https://cnb.cool/acme/alpha/-/workspace/jump?pipelineId=cnb-1-001',
}

// --- case 1: every entry point is listed ---------------------------------------
{
  const api = harness()
  const asked = []
  globalThis.fetch = async (url) => {
    const target = String(url)
    asked.push(target)
    if (target.includes('/-/workspace/detail/')) return json(200, detailBody)
    return json(200, {})
  }
  try {
    const result = await api.runOperation('workspaces.detail', { repo: 'acme/alpha', sn: 'cnb-1-001' })
    const kinds = new Set(result.links.map((link) => link.kind))
    for (const kind of ['webide', 'codebuddy', 'jump', 'logs', 'repo']) {
      assert.ok(kinds.has(kind), `link kind ${kind} must be listed`)
    }
    // The pipeline form, not the short sn, is what a workspace URL needs.
    assert.ok(result.links.some((link) => link.url.includes('vscode-web/cnb-1-001/')), 'WebIDE must use the pipeline id')
    assert.ok(result.links.some((link) => link.url.includes('codebuddy/cnb-1-001/')), 'CodeBuddy must use the pipeline id')
    assert.equal(result.pipelineId, 'cnb-1-001')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 2: the short sn is what the detail API is asked for ------------------
{
  const api = harness()
  const asked = []
  globalThis.fetch = async (url) => {
    asked.push(String(url))
    return json(200, detailBody)
  }
  try {
    await api.runOperation('workspaces.detail', { repo: 'acme/alpha', sn: 'cnb-1-001' })
    const call = asked.find((target) => target.includes('/-/workspace/detail/'))
    assert.ok(call.endsWith('/cnb-1'), `detail must be asked for the short sn, got ${call}`)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 3: a foreign repo gets no port template ------------------------------
{
  const api = harness()
  globalThis.fetch = async () => json(200, detailBody)
  try {
    const foreign = await api.runOperation('workspaces.detail', { repo: 'other/repo', sn: 'cnb-2' })
    assert.equal(foreign.portTemplate, null, "this host's proxy prefix belongs to its own environment only")
    assert.equal(foreign.links.filter((link) => link.kind === 'ports').length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 4: ports are offered when a domain is known -------------------------
{
  const api = harness()
  globalThis.fetch = async () => json(200, detailBody)
  try {
    const result = await api.runOperation('workspaces.detail', {
      repo: 'acme/alpha',
      sn: 'cnb-1',
      proxyDomain: 'abc-{{port}}.cnb.run',
      ports: [3000, 8080],
    })
    const portLinks = result.links.filter((link) => link.kind === 'ports')
    assert.ok(portLinks.some((link) => link.url === 'https://abc-{{port}}.cnb.run'), 'the template itself must be offered')
    assert.ok(portLinks.some((link) => link.url === 'https://abc-3000.cnb.run'))
    assert.ok(portLinks.some((link) => link.url === 'https://abc-8080.cnb.run'))
    assert.equal(result.portTemplate, 'https://abc-{{port}}.cnb.run')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 5: a closed environment still yields links --------------------------
{
  const api = harness()
  globalThis.fetch = async () => json(404, { errcode: 404, errmsg: '[WORKSPACE_NOT_FOUND]workspace not found.' })
  try {
    const result = await api.runOperation('workspaces.detail', { repo: 'acme/alpha', sn: 'cnb-9' })
    assert.equal(result.detail, null, 'a missing environment is not an error here')
    assert.ok(result.links.length >= 4, 'the constructible links are still worth listing')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 6: duplicates collapse, trailing slash or not -----------------------
{
  const api = harness()
  globalThis.fetch = async () => json(200, detailBody)
  try {
    const result = await api.runOperation('workspaces.detail', { repo: 'acme/alpha', sn: 'cnb-1' })
    const webides = result.links.filter((link) => link.kind === 'webide')
    assert.equal(webides.length, 1, 'the detail answer and the constructed form are the same address')
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('environment-links OK · all entry points, both sn spellings, no borrowed proxy domain')
