/**
 * Desktop editors do not get their own CNB URL.
 *
 * The tempting guess is `/-/workspace/cursor/<sn>/` and friends. Testing showed
 * that is fabricated: the frontend build ships only `jump`, `loading` and `error`
 * under `/-/workspace/`, and the app is a catch-all, so an invented path answers
 * 401 exactly like a real one. Shipping it would hand someone a link that looks
 * right and fails.
 *
 * The documented mechanism is one thing, not thirteen: every desktop editor
 * attaches over SSH (Remote-SSH), JetBrains over Gateway, and both need
 * `openssh-server` in the image. So this pins that the plugin never emits a
 * per-editor page URL, and does emit the connection coordinates when it knows them.
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

// --- case 2: the SSH coordinates are given when the host is known --------------
{
  const previous = process.env.CNB_WORKSPACE_SSH_HOST
  process.env.CNB_WORKSPACE_SSH_HOST = 'ssh.example.test'
  const api = harness()
  stubDetail()
  try {
    const result = await api.runOperation('workspaces.detail', { repo: 'acme/alpha', sn: 'cnb-1' })
    const ssh = result.links.find((link) => link.kind === 'ssh')
    assert.ok(ssh, 'the Remote-SSH connection string must be present')
    assert.match(ssh.url, /^ssh cnb-1-001@ssh\.example\.test$/)
    const config = result.links.find((link) => link.kind === 'ssh-config')
    assert.ok(config, 'an ssh config snippet is more useful than a one-liner')
    assert.match(config.url, /HostName ssh\.example\.test/)
    assert.match(config.url, /User cnb-1-001/)
  } finally {
    if (previous === undefined) delete process.env.CNB_WORKSPACE_SSH_HOST
    else process.env.CNB_WORKSPACE_SSH_HOST = previous
    globalThis.fetch = originalFetch
  }
}

// --- case 3: without a known host, no guessed SSH endpoint ---------------------
{
  const previous = process.env.CNB_WORKSPACE_SSH_HOST
  const previousAlt = process.env.CNB_SSH_HOST
  delete process.env.CNB_WORKSPACE_SSH_HOST
  delete process.env.CNB_SSH_HOST
  const api = harness()
  stubDetail()
  try {
    const result = await api.runOperation('workspaces.detail', { repo: 'acme/alpha', sn: 'cnb-1' })
    assert.equal(result.links.filter((link) => link.kind === 'ssh').length, 0, 'a guessed host would fail silently')
  } finally {
    if (previous !== undefined) process.env.CNB_WORKSPACE_SSH_HOST = previous
    if (previousAlt !== undefined) process.env.CNB_SSH_HOST = previousAlt
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
