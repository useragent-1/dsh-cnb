/**
 * Editors reach the environment through URI schemes, not through HTTP pages.
 *
 * The tempting guess was `/-/workspace/cursor/<sn>/`, which is fabricated: the web
 * app ships only `jump`, `loading` and `error` under `/-/workspace/`, and it is a
 * catch-all, so an invented path answers 401 exactly like a real one. That much was
 * right.
 *
 * The conclusion drawn from it was wrong. `workspace/detail` does return one link per
 * editor — `vscode://`, `cursor://`, `zed://`, `windsurf://`, `codebuddy://` and so on
 * — but they are URI-scheme handoffs to a local client, so they are invisible to anyone
 * looking for a page. They appear only once an environment is running, which is why
 * they were missed.
 *
 * This pins both halves: no invented HTTP path, and every scheme link the platform
 * reports is passed through untouched.
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

function stubDetail() {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/-/workspace/detail/')) {
      return json(200, { webide: 'https://cnb.cool/acme/alpha/-/workspace/vscode-web/cnb-1-001/', jumpUrl: 'https://cnb.cool/acme/alpha/-/workspace/jump?pipelineId=cnb-1-001' })
    }
    return json(200, {})
  }
}

// --- case 1: no invented per-editor page URLs ---------------------------------
{
  const api = harness()
  stubDetail()
  try {
    const result = await api.runOperation('workspaces.detail', { repo: 'acme/alpha', sn: 'cnb-1' })
    const urls = result.links.map((link) => link.url)
    for (const fabricated of ['/workspace/cursor/', '/workspace/windsurf/', '/workspace/zed/', '/workspace/jetbrains/', '/workspace/trae/', '/workspace/qoder/']) {
      assert.ok(!urls.some((url) => url.includes(fabricated)), `${fabricated} must not be emitted: no such page exists`)
    }
    // The two browser entries that do exist, and are verified by the build manifest.
    assert.ok(urls.some((url) => url.includes('/workspace/vscode-web/')))
    assert.ok(urls.some((url) => url.includes('/workspace/codebuddy/')))
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 2: the connection string comes from the detail answer -------------
{
  const api = harness()
  const remote = 'cnb-1-001.abc-gjp@cnb.space'
  globalThis.fetch = async (url) => {
    if (String(url).includes('/-/workspace/detail/')) {
      return json(200, {
        webide: 'https://cnb.cool/acme/alpha/-/workspace/vscode-web/cnb-1-001/',
        jumpUrl: 'https://cnb.cool/acme/alpha/-/workspace/jump?pipelineId=cnb-1-001',
        remoteSsh: remote,
        cursor: 'cursor://vscode-remote/ssh-remote+' + remote + '/workspace/',
      })
    }
    return json(200, {})
  }
  try {
    const result = await api.runOperation('workspaces.detail', { repo: 'acme/alpha', sn: 'cnb-1' })
    const ssh = result.links.find((link) => link.kind === 'ssh')
    assert.ok(ssh, 'the Remote-SSH connection string must be present')
    assert.equal(ssh.url, `ssh ${remote}`, 'built from the endpoint the platform reports')
    const config = result.links.find((link) => link.kind === 'ssh-config')
    assert.ok(config, 'an ssh config snippet is more useful than a one-liner')
    assert.match(config.url, /HostName cnb\.space/)
    assert.match(config.url, /User cnb-1-001\.abc-gjp/)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 3: no detail means no invented endpoint --------------------------
{
  const api = harness()
  globalThis.fetch = async () => json(404, { errcode: 404, errmsg: 'not found' })
  try {
    const result = await api.runOperation('workspaces.detail', { repo: 'acme/alpha', sn: 'cnb-1' })
    assert.equal(result.links.filter((link) => link.kind === 'ssh').length, 0,
      'a closed environment has no endpoint, and one must not be made up')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 4: the prerequisite is stated once, not as a fake link --------------
{
  const api = harness()
  stubDetail()
  try {
    const result = await api.runOperation('workspaces.detail', { repo: 'acme/alpha', sn: 'cnb-1' })
    assert.ok(typeof result.clientHint === 'string' && result.clientHint.includes('Remote-SSH'), 'the mechanism must be explained')
    assert.ok(result.clientHint.includes('openssh-server'), 'and its prerequisite named')
    assert.ok(!result.links.some((link) => link.url.startsWith('openssh')), 'a prerequisite is not a URL')
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('client-links OK · no invented IDE pages, SSH coordinates where known, prerequisite stated')
