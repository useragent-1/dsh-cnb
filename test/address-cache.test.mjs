/**
 * Addresses must be re-openable, not a one-shot after a start.
 *
 * A start result used to be the only place the links appeared, so dismissing the
 * card or reloading the page lost them — and there was no way to ask again for an
 * environment started earlier. They are now fetched on demand per `repo/sn`,
 * cached, and persisted, with three properties worth pinning:
 *
 *  - the Host builds the same list whenever asked, not only right after a start;
 *  - a cached list survives an unreachable API, because the addresses did not
 *    become wrong just because the network failed;
 *  - ports a person used are retained, since they are not derivable from the sn.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

// --- case 1: an environment started long ago still answers with its addresses ---
{
  const api = harness()
  let detailCalls = 0
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/-/workspace/detail/')) {
      detailCalls += 1
      return json(200, {
        webide: 'https://cnb.cool/acme/alpha/-/workspace/vscode-web/cnb-old-1/',
        jumpUrl: 'https://cnb.cool/acme/alpha/-/workspace/jump?pipelineId=cnb-old-1',
      })
    }
    return json(200, {})
  }
  try {
    const first = await api.runOperation('workspaces.detail', { repo: 'acme/alpha', sn: 'cnb-old' })
    const second = await api.runOperation('workspaces.detail', { repo: 'acme/alpha', sn: 'cnb-old' })
    assert.equal(detailCalls, 2, 'the entry point must be askable again, not cached in the Host')
    assert.deepEqual(first.links.map((l) => l.url), second.links.map((l) => l.url), 'the list must be stable')
    assert.ok(first.links.some((link) => link.kind === 'ports') === false, 'no proxy domain is known outside its own environment')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 2: custom ports are carried through, not replaced by defaults --------
{
  const api = harness()
  globalThis.fetch = async () => json(200, { webide: 'https://cnb.cool/acme/alpha/-/workspace/vscode-web/cnb-1/', jumpUrl: null })
  try {
    const result = await api.runOperation('workspaces.detail', {
      repo: 'acme/alpha', sn: 'cnb-1', proxyDomain: 'p-{{port}}.cnb.run', ports: [1420, 9000],
    })
    const ports = result.links.filter((link) => link.kind === 'ports').map((link) => link.url)
    assert.ok(ports.includes('https://p-1420.cnb.run'), 'a caller-supplied port must appear')
    assert.ok(ports.includes('https://p-9000.cnb.run'))
    assert.ok(!ports.includes('https://p-3000.cnb.run'), 'defaults must not be mixed in when ports are given')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 3: the client keeps a cached list when the API is unreachable --------
{
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  // The failure branch must preserve rows rather than clearing them.
  assert.match(source, /const cached = previous\[key\]/, 'a failed refresh must read the cached entry')
  assert.match(source, /rows: cached\?\.rows \?\? \[\]/, 'a failed refresh must keep the cached rows')
  // And the render must show rows even when an error is present.
  assert.match(source, /entry\.error === null \? null : h\(Banner/, 'the error is shown alongside the list')
  assert.match(source, /rows\.length === 0[\s\S]{0,400}LinkList/, 'cached rows render even with an error set')
  console.log('address-cache OK · list is re-askable, ports retained, cache survives an outage')
}
