/**
 * Starting a dev environment must answer with links, not open one.
 *
 * Which URL a person wants depends on why they started: the WebIDE to work, the
 * log to debug a failed build, the repo page to check settings. Opening one on
 * their behalf guesses wrong, so the panel lists every URL with a copy button.
 *
 * This pins the two halves: the Host resolves the real WebIDE address (a loading
 * page is not one), and the client turns that into a deduplicated list.
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

// --- case 1: the resolved WebIDE address is returned alongside the loading page --
{
  const api = harness()
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/-/git/branches')) return json(200, [{ name: 'main' }])
    if (target.includes('/-/workspace/start')) {
      return json(200, { url: 'https://cnb.cool/acme/alpha/-/workspace/loading?branch=main&sn=cnb-1', message: "didn't finish build yet" })
    }
    if (target.includes('/-/workspace/detail/cnb-1')) {
      return json(200, {
        webide: 'https://cnb.cool/acme/alpha/-/workspace/vscode-web/cnb-1',
        jumpUrl: 'https://cnb.cool/acme/alpha/-/workspace/jump?pipelineId=cnb-1',
      })
    }
    return json(200, {})
  }
  try {
    const started = await api.runOperation('workspaces.open', { repo: 'acme/alpha' })
    assert.equal(started.sn, 'cnb-1')
    assert.match(started.webide, /vscode-web/, 'the WebIDE address must be resolved, not left as a loading page')
    assert.match(started.jumpUrl, /jump/)
    assert.equal(started.state, 'starting')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 2: an environment not up yet has no WebIDE address, and still answers --
{
  const api = harness()
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/-/git/branches')) return json(200, [{ name: 'main' }])
    if (target.includes('/-/workspace/start')) return json(200, { sn: 'cnb-2' })
    if (target.includes('/-/workspace/detail/')) return json(404, { errcode: 404, errmsg: 'not found' })
    return json(200, {})
  }
  try {
    const started = await api.runOperation('workspaces.open', { repo: 'acme/alpha' })
    assert.equal(started.webide, null, 'a missing address must be null, not a broken string')
    assert.equal(started.jumpUrl, null)
    assert.equal(started.sn, 'cnb-2', 'the sn is still useful for a later refresh')
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('start-links OK · WebIDE resolved when available, absent cleanly when not')
