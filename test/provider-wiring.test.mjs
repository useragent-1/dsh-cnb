/**
 * A stored gateway token is not a working gateway.
 *
 * Importing the credential makes it available; it does not make the model selectable.
 * The provider has to exist in `llm-pi-ai`, or DSH's config has no gateway at all — which
 * is exactly the state that reads as "the token is imported but nothing shows up".
 *
 * A deployment booting with `--patch` already owns `llm-pi-ai`, and DSH refuses a write
 * from below. That is not a failure to hide: it means someone already decided how this
 * provider is configured, and the panel must say so rather than appearing to have done
 * nothing.
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const originalFetch = globalThis.fetch
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const sse = () => new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
  status: 200, headers: { 'content-type': 'text/event-stream' },
})

const OVERLAY = 'Configuration for "llm-pi-ai" is overridden by a home patch or command-line overlay'

/** @param {{ throwOverlay?: boolean, providers?: object }} [options] */
function harness(options = {}) {
  const records = new Map([['dsh-cnb/cnb-token', { kind: 'grant', payload: { token: 'personal', user: { username: 'ren' } } }]])
  const entries = [{ options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: options.providers === undefined ? {} : { providers: options.providers } } }]
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
    async listRecords() { return [] },
  }
  const editor = {
    entries: () => entries,
    async edit(entry, mutate) {
      if (options.throwOverlay === true) throw new Error(OVERLAY)
      entry.options.config = await mutate(entry.options.config ?? {})
      return entry
    },
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
  return { api: apply(ctx, {}), entries, records }
}

function stubGateway() {
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/user/repos')) return json(200, [{ path: 'acme/alpha' }])
    if (target.includes('/-/ai/chat/completions')) return sse()
    return json(200, {})
  }
}

// --- case 1: importing registers the provider too ----------------------
{
  const { api, entries } = harness()
  stubGateway()
  try {
    const result = await api.runOperation('gateway.importToken', { token: 'pipeline-token', repo: 'acme/alpha' })
    assert.equal(result.stored, true)
    assert.equal(result.provider.written, true, 'the provider must be registered, not just the credential')
    const providers = entries[0].options.config.providers
    assert.ok(providers['cnb-gateway'], 'under the plugin route')
    assert.equal(providers['cnb-gateway'].baseURL, 'https://api.cnb.cool/acme/alpha/-/ai')
    assert.equal(providers['cnb-gateway'].apiKeyEnv, 'CNB_GATEWAY_TOKEN', 'reading the gateway credential, not the sign-in one')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 2: an overlay refusal is reported, not swallowed ------------
{
  const { api } = harness({ throwOverlay: true })
  stubGateway()
  try {
    const result = await api.runOperation('gateway.importToken', { token: 'pipeline-token', repo: 'acme/alpha' })
    assert.equal(result.stored, true, 'the credential is still worth keeping')
    assert.equal(result.provider.written, false)
    assert.equal(result.provider.overridden, true, 'and it says why the provider is missing')
    assert.match(result.provider.reason, /--patch|更高优先级/)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 3: an existing provider is not overwritten -----------------
{
  const { api, entries } = harness({ providers: { 'cnb-gateway': { displayName: 'mine', baseURL: 'https://example.test' } } })
  stubGateway()
  try {
    const result = await api.runOperation('gateway.importToken', { token: 'pipeline-token', repo: 'acme/alpha' })
    assert.equal(result.provider.written, false)
    assert.match(result.provider.reason, /已存在/)
    assert.equal(entries[0].options.config.providers['cnb-gateway'].baseURL, 'https://example.test', 'the existing provider survives')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 4: adoption also wires the provider -----------------------
{
  const previousToken = process.env.CNB_TOKEN
  const previousRepo = process.env.CNB_REPO_SLUG
  process.env.CNB_TOKEN = 'injected-pipeline-token'
  process.env.CNB_REPO_SLUG = 'acme/alpha'
  const { api, entries } = harness()
  stubGateway()
  try {
    const result = await api.runOperation('gateway.adoptAmbient', {})
    assert.equal(result.adopted, true)
    assert.ok(entries[0].options.config.providers?.['cnb-gateway'], 'adopting a token also makes the model visible')
  } finally {
    if (previousToken === undefined) delete process.env.CNB_TOKEN
    else process.env.CNB_TOKEN = previousToken
    if (previousRepo === undefined) delete process.env.CNB_REPO_SLUG
    else process.env.CNB_REPO_SLUG = previousRepo
    globalThis.fetch = originalFetch
  }
}

console.log('provider-wiring OK · credential and provider registered together, overlay refusal reported')
