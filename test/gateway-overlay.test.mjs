/**
 * Offline test: when the profile's `llm-pi-ai` row is owned by a higher layer
 * (home patch or `--patch` overlay), the config editor refuses the write. The
 * plugin must not fail there — it must answer with the exact overlay snippet.
 *
 * The snippet is validated against the real pi-ai Config schema, so a copy-paste
 * that would be rejected at boot cannot ship.
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { importFromDsh } from './resolve-dsh.mjs'

// Both packages belong to the running dsh installation, not to this repo.
const { Config: PiAiConfig } = await importFromDsh('@deepseek-ai/dsh-llm-pi-ai', 'lib/index.js')
const yaml = await importFromDsh('yaml', 'dist/index.js')

// This suite never touches the network: configureGateway probes before writing, and the
// stub below answers it. A fixed placeholder keeps the suite runnable without a token.
const token = 'offline-probe-token'
const store = new Map()
const values = new Map()

const credentials = {
  async readRecord(key) { return store.get(key) },
  async modifyRecord(key, mutate) {
    const next = await mutate(store.get(key))
    if (next === undefined) store.delete(key)
    else store.set(key, next)
    return store.get(key)
  },
  async set(ref, value) { values.set(ref, value) },
  async unset(ref) { values.delete(ref) },
}

const OVERLAY = 'Configuration for "llm-pi-ai" is overridden by a home patch or command-line overlay'
const entries = [
  { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: {} } },
  { options: { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: {} } },
]
const editor = {
  entries: () => entries,
  async edit() { throw new Error(OVERLAY) },
}

const ctx = {
  effect: (fn) => { fn(); return () => {} },
  get(name) {
    if (name === 'credentials') return credentials
    if (name === 'configEditor') return editor
    return undefined
  },
  inject() {},
}

// configureGateway probes before writing, so the gateway must answer here. The point
// of this file is the overlay handling, not reachability.
const originalFetch = globalThis.fetch
globalThis.fetch = async () => new Response(
  'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
)

const api = apply(ctx, {})
await credentials.modifyRecord('dsh-cnb/cnb-token', async () => ({
  kind: 'grant',
  payload: { token, description: 'test', loginAt: new Date().toISOString(), user: null },
}))

const result = await api.runOperation('gateway.configure', { repo: 'acme/alpha', route: 'cnb-gateway', makeDefault: true })
assert.equal(result.written, false, 'nothing may be written under an overlay')
assert.deepEqual(result.overlay.rows, ['llm-pi-ai', 'agent-default-model'])
assert.match(result.overlay.hint, /overlay/)

// The snippet must be valid YAML for the loader and must satisfy pi-ai's schema.

const rows = yaml.parse(result.overlay.snippet)
assert.equal(rows.length, 2)
const piAiRow = rows.find((row) => row.id === 'llm-pi-ai')
const parsed = PiAiConfig(piAiRow.config)
assert.ok(parsed, 'snippet llm-pi-ai config must pass the real schema')
assert.equal(piAiRow.config.providers['cnb-gateway'].baseURL, 'https://api.cnb.cool/acme/alpha/-/ai')
assert.equal(piAiRow.config.providers['cnb-gateway'].apiKeyEnv, 'CNB_TOKEN')

const defaultRow = rows.find((row) => row.id === 'agent-default-model')
assert.deepEqual(defaultRow.config, { provider: 'cnb-gateway', model: 'deepseek-v4.1-flash' })

console.log('overlay fallback OK; snippet validated by the real llm-pi-ai schema')
console.log('---- snippet ----')
console.log(result.overlay.snippet)
