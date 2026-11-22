/**
 * Host smoke test against the real CNB OpenAPI.
 *
 * Mounts `apply()` on a stub Cordis context and exercises every read path plus
 * the gateway probe. Writes are not performed against CNB.
 *
 *   CNB_TOKEN=<token> node test/host-smoke.mjs
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const token = process.env.CNB_TOKEN
if (token === undefined || token === '') {
  console.error('CNB_TOKEN is required')
  process.exit(2)
}

/** Minimal stand-ins for the three services the plugin reaches for. */
const records = new Map()
const values = new Map()
const credentials = {
  async readRecord(key) { return records.get(key) },
  async modifyRecord(key, mutate) {
    const next = await mutate(records.get(key))
    if (next === undefined) records.delete(key)
    else records.set(key, next)
    return records.get(key)
  },
  async set(ref, value) { values.set(ref, value) },
  async unset(ref) { values.delete(ref) },
}

const tools = new Map()
const routes = new Map()
const entries = [
  { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: {} } },
  { options: { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: {} } },
]
const editor = {
  entries: () => entries,
  async edit(entry, change) { entry.options.config = change(entry.options.config, {}) },
}

const ctx = {
  effect(fn) { fn(); return () => {} },
  get(service) {
    if (service === 'credentials') return credentials
    if (service === 'configEditor') return editor
    if (service === 'tools') return { register(definition) { tools.set(definition.name, definition); return () => {} } }
    return undefined
  },
  inject(names, fn) {
    if (!names.includes('webServer')) return
    fn({ effect: (run) => run(), webServer: { register(route) { routes.set(route.path, route); return () => {} } } })
  },
}

const api = apply(ctx, {})

// Seed the record exactly as a completed QR sign-in would.
await credentials.modifyRecord('dsh-cnb/cnb-token', async () => ({
  kind: 'grant',
  payload: { token, description: 'smoke', loginAt: new Date().toISOString(), user: null },
}))
await credentials.set('CNB_TOKEN', token)

const status = await api.runOperation('status', {})
assert.equal(status.loggedIn, true)
assert.ok(status.user?.username, 'identity must resolve from the token')

const repos = await api.runOperation('repos.list', { pageSize: 10 })
assert.ok(Array.isArray(repos.items))
assert.equal(typeof repos.total, 'number')
assert.ok(repos.items.length > 0, 'the account must own at least one repository')
assert.ok(repos.items.every((repo) => Array.isArray(repo.environments)), 'every repo carries its environments')

const target = repos.items.find((repo) => repo.environments.length > 0) ?? repos.items[0]
const detail = await api.runOperation('repos.status', { repo: target.slug })
assert.equal(typeof detail.info.name, 'string')
assert.ok(Array.isArray(detail.environments))
assert.ok(detail.builds.items.length >= 0)

const usage = await api.runOperation('usage.list', {})
assert.ok(usage.groups.length > 0, 'the account must belong to at least one organization')
for (const group of usage.groups) {
  assert.ok(Array.isArray(group.metrics))
  assert.equal(group.metrics.length, 7)
}

const probe = await api.runOperation('gateway.probe', { repo: target.slug, prompt: '回复 OK' })
assert.equal(probe.reachable, true, `gateway must answer: ${probe.reason ?? ''}`)
assert.ok(typeof probe.baseURL === 'string' && probe.baseURL.endsWith('/-/ai'))

const configured = await api.runOperation('gateway.configure', { repo: target.slug, makeDefault: true })
assert.equal(configured.written, true)
const provider = entries[0].options.config.providers['cnb-gateway']
assert.equal(provider.api, 'openai-completions')
assert.equal(provider.apiKeyEnv, 'CNB_TOKEN')
assert.deepEqual(entries[1].options.config, { provider: 'cnb-gateway', model: 'deepseek-v4.1-flash' })

assert.equal(tools.size, 13, 'every documented tool must register')
assert.ok(routes.has('/dsh-cnb/api'))

console.log(`smoke OK · ${repos.total} repos · ${usage.groups.length} orgs · gateway ${probe.model} answered`)
