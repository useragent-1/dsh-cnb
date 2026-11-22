/**
 * Stopping a dev environment must work with the token a user actually has.
 *
 * The account-wide endpoint needs `account-engage:rw`, which a repo-scoped token
 * may not carry. The same pipeline can be stopped through its repository under
 * `repo-cnb-trigger:rw` — the permission that starting an environment already
 * requires — so the plugin falls back to it instead of failing.
 *
 * Runs against a stub client: the live behaviour was confirmed against CNB
 * separately (200 "stop successful", and 422 for an already-ended build).
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

/** @param {(path: string, options: any) => Promise<any>} handler */
function mount(handler) {
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
  return { api, credentials }
}

const { api, credentials } = mount()
await credentials.modifyRecord('dsh-cnb/cnb-token', async () => ({
  kind: 'grant',
  payload: { token: 'stub' },
}))

// 1. Account-level stop is refused; the repo-scoped stop succeeds.
const calls = []
const original = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const target = String(url)
  calls.push(`${init?.method ?? 'GET'} ${new URL(target).pathname}`)
  if (target.includes('/workspace/stop')) return new Response(
    JSON.stringify({ errcode: 10023, errmsg: "Missing required scopes: account-engage:rw" }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  )
  if (target.includes('/-/build/stop/')) return new Response(
    JSON.stringify({ sn: 'cnb-x', message: 'stop successful' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
}
try {
  const stopped = await api.runOperation('workspaces.stop', { repo: 'acme/alpha', sn: 'cnb-x' })
  assert.equal(stopped.via, 'build', 'must fall back to the repo-scoped stop')
  assert.equal(stopped.repo, 'acme/alpha')
  assert.ok(calls.some((line) => line.includes('/workspace/stop')))
  assert.ok(calls.some((line) => line.includes('/-/build/stop/cnb-x')), 'the fallback must actually be called')
} finally {
  globalThis.fetch = original
}

// 2. An already-ended pipeline is reported as such, not as a failure.
const { api: api2, credentials: creds2 } = mount()
await creds2.modifyRecord('dsh-cnb/cnb-token', async () => ({ kind: 'grant', payload: { token: 'stub' } }))
const original2 = globalThis.fetch
globalThis.fetch = async (url) => {
  const target = String(url)
  if (target.includes('/workspace/stop')) return new Response(
    JSON.stringify({ errcode: 10023, errmsg: "Missing required scopes: account-engage:rw" }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  )
  return new Response(
    JSON.stringify({ errcode: 422, errmsg: '[STOP_FAIL_WRONG_STATUS]Current build already end: error' }),
    { status: 422, headers: { 'content-type': 'application/json' } },
  )
}
try {
  const already = await api2.runOperation('workspaces.stop', { repo: 'acme/alpha', sn: 'cnb-x' })
  assert.equal(already.alreadyStopped, true)
} finally {
  globalThis.fetch = original2
}

// 3. Without a repo the fallback cannot be aimed, and the message says so.
const { api: api3, credentials: creds3 } = mount()
await creds3.modifyRecord('dsh-cnb/cnb-token', async () => ({ kind: 'grant', payload: { token: 'stub' } }))
const original3 = globalThis.fetch
globalThis.fetch = async (url) => {
  const target = String(url)
  if (target.includes('/workspace/stop')) return new Response(
    JSON.stringify({ errcode: 10023, errmsg: 'Missing required scopes: account-engage:rw' }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  )
  if (target.includes('/workspace/list')) return new Response(
    JSON.stringify({ errcode: 10023, errmsg: 'Missing required scopes: account-engage:r' }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  )
  return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
}
try {
  await assert.rejects(
    () => api3.runOperation('workspaces.stop', { sn: 'cnb-x' }),
    /account-engage|仓库路径/,
  )
} finally {
  globalThis.fetch = original3
}

console.log('stop fallback OK · repo-scoped stop used, already-ended handled, missing repo explained')
