/**
 * Starting a dev environment must work from one click.
 *
 * Two things were wrong and both are pinned here:
 *  - CNB demands `branch`; an empty body answers [PARAM_MISS]branch is required,
 *    so an omitted branch has to be resolved rather than dropped. A repository
 *    has no default_branch field, so the branch list is the only source.
 *  - reopening an existing environment answers with just a URL, with the pipeline
 *    sn buried in its query string; the caller still needs an sn to stop it later.
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const originalFetch = globalThis.fetch
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function harness() {
  const records = new Map()
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
  const api = apply(ctx, {})
  records.set('dsh-cnb/cnb-token', { kind: 'grant', payload: { token: 'tok' } })
  return { api, records }
}

// --- case 1: no branch given; the repo's own default is used ---------------------
{
  const { api } = harness()
  let sentBody = null
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.includes('/-/git/branches')) return json(200, [{ name: 'release' }, { name: 'main' }])
    if (target.includes('/-/workspace/start')) {
      sentBody = JSON.parse(String(init?.body ?? '{}'))
      return json(200, { sn: 'cnb-new-1', buildLogUrl: 'https://cnb.cool/x/-/build/logs/cnb-new-1', message: "cnb received, but didn't finish build yet" })
    }
    return json(200, {})
  }
  try {
    const started = await api.runOperation('workspaces.open', { repo: 'acme/alpha' })
    assert.equal(sentBody.branch, 'main', 'a branch must always be sent, preferring main')
    assert.equal(started.branch, 'main')
    assert.equal(started.sn, 'cnb-new-1')
    assert.equal(started.state, 'starting')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 2: master is preferred when there is no main --------------------------
{
  const { api } = harness()
  let sentBody = null
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.includes('/-/git/branches')) return json(200, [{ name: 'dev' }, { name: 'master' }])
    if (target.includes('/-/workspace/start')) {
      sentBody = JSON.parse(String(init?.body ?? '{}'))
      return json(200, { url: 'https://cnb.cool/acme/alpha/-/workspace/vscode-web/cnb-old-1' })
    }
    return json(200, {})
  }
  try {
    const started = await api.runOperation('workspaces.open', { repo: 'acme/alpha' })
    assert.equal(sentBody.branch, 'master')
    assert.equal(started.state, 'running', 'no message means an existing environment was reopened')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 3: an existing environment's sn is recovered from its URL -------------
{
  const { api } = harness()
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/-/git/branches')) return json(200, [{ name: 'main' }])
    if (target.includes('/-/workspace/start')) {
      return json(200, { url: 'https://cnb.cool/acme/alpha/-/workspace/loading?branch=main&sn=cnb-reused-9' })
    }
    return json(200, {})
  }
  try {
    const started = await api.runOperation('workspaces.open', { repo: 'acme/alpha' })
    assert.equal(started.sn, 'cnb-reused-9', 'the sn must be recovered so the environment can be stopped later')
    assert.equal(started.branch, 'main')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 4: an explicit branch wins, and no lookup happens ---------------------
{
  const { api } = harness()
  let branchLookups = 0
  let sentBody = null
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.includes('/-/git/branches')) { branchLookups += 1; return json(200, [{ name: 'main' }]) }
    if (target.includes('/-/workspace/start')) {
      sentBody = JSON.parse(String(init?.body ?? '{}'))
      return json(200, { sn: 'cnb-x' })
    }
    return json(200, {})
  }
  try {
    const started = await api.runOperation('workspaces.open', { repo: 'acme/alpha', branch: 'feature/x' })
    assert.equal(sentBody.branch, 'feature/x')
    assert.equal(branchLookups, 0, 'an explicit branch must not trigger a lookup')
    assert.equal(started.branch, 'feature/x')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 5: a repository with no branches is refused clearly -------------------
{
  const { api } = harness()
  globalThis.fetch = async (url) => {
    if (String(url).includes('/-/git/branches')) return json(200, [])
    return json(400, { errcode: 400, errmsg: '[PARAM_MISS]branch is required.' })
  }
  try {
    await assert.rejects(
      () => api.runOperation('workspaces.open', { repo: 'acme/empty' }),
      /没有可用的分支|branch/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('workspace-open OK · branch resolved, sn recovered, explicit branch respected')
