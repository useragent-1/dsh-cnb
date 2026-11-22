/**
 * A freshly created repository must be able to start an environment.
 *
 * It has no commits, so `/-/git/branches` answers `[]` — and `workspace/start`
 * requires a branch anyway. Refusing early ("no usable branch") blocked exactly the
 * case a new repository is, and blocked it for a reason CNB itself does not enforce:
 * given `main` it starts the environment fine.
 *
 * Reusing a running environment also answers with a path-form URL
 * (`/workspace/vscode-web/<id>/`) rather than `?sn=`, so a query-only reader lost the
 * sn of the environment it had just opened.
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

// --- case 1: an empty repository starts with the conventional branch --------
{
  const api = harness()
  const starts = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.includes('/-/git/branches')) return json(200, [])
    if (target.includes('/-/workspace/start')) {
      starts.push(JSON.parse(init.body))
      return json(200, {
        sn: 'cnb-new',
        buildLogUrl: 'https://cnb.cool/acme/fresh/-/build/logs/cnb-new',
        url: 'https://cnb.cool/acme/fresh/-/workspace/loading?branch=main&sn=cnb-new',
        message: "didn't finish build yet",
      })
    }
    return json(404, { errcode: 404, errmsg: 'not found' })
  }
  try {
    const started = await api.runOperation('workspaces.open', { repo: 'acme/fresh' })
    assert.equal(starts.length, 1, 'the start must actually be attempted')
    assert.equal(starts[0].branch, 'main', 'a branchless repo falls back to main')
    assert.equal(started.branch, 'main')
    assert.equal(started.sn, 'cnb-new')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 2: an existing main/master is still preferred --------------------
{
  const api = harness()
  const starts = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.includes('/-/git/branches')) return json(200, [{ name: 'dev' }, { name: 'master' }])
    if (target.includes('/-/workspace/start')) {
      starts.push(JSON.parse(init.body))
      return json(200, { sn: 'cnb-b' })
    }
    return json(404, {})
  }
  try {
    await api.runOperation('workspaces.open', { repo: 'acme/alpha' })
    assert.equal(starts[0].branch, 'master', 'a real default beats the guess')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 3: reusing an environment recovers the sn from the path form ----
{
  const api = harness()
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/-/git/branches')) return json(200, [{ name: 'main' }])
    if (target.includes('/-/workspace/start')) {
      // The reuse shape: no sn field, the id lives in the path.
      return json(200, { url: 'https://cnb.cool/acme/alpha/-/workspace/vscode-web/cnb-run-1-001/' })
    }
    if (target.includes('/-/workspace/detail/cnb-run-1')) {
      return json(200, { webide: 'https://cnb.cool/acme/alpha/-/workspace/vscode-web/cnb-run-1-001' })
    }
    return json(404, {})
  }
  try {
    const started = await api.runOperation('workspaces.open', { repo: 'acme/alpha' })
    assert.equal(started.sn, 'cnb-run-1', 'the sn must survive a path-form answer')
    assert.match(started.webide, /vscode-web/, 'and the WebIDE address is resolved from it')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 4: a jump URL also yields its pipeline id ----------------------
{
  const api = harness()
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/-/git/branches')) return json(200, [{ name: 'main' }])
    if (target.includes('/-/workspace/start')) {
      return json(200, { url: 'https://cnb.cool/acme/alpha/-/workspace/jump?pipelineId=cnb-j-1-001' })
    }
    return json(200, {})
  }
  try {
    const started = await api.runOperation('workspaces.open', { repo: 'acme/alpha' })
    assert.equal(started.sn, 'cnb-j-1')
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('new-repo-start OK · empty repo starts, real default preferred, sn recovered from every form')
