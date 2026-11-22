/**
 * The gateway serves ten models; the plugin used to advertise one.
 *
 * Offering a single model made the panel look like the gateway had nothing usable, and
 * the selector showed one entry against a service that answered for ten.
 *
 * The gateway exposes no model list — `/v1/models`, `/models` and `/model/list` all
 * answer 404 — so the catalogue has to be carried. Each id below was confirmed with a
 * real streaming call against the gateway (all answered 200), which is the only evidence
 * worth trusting for a list that cannot be queried.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

/** The ids the live gateway answered for. */
const VERIFIED = [
  'deepseek-v4.1-flash',
  'deepseek-v4-flash',
  'glm-5.3-flash',
  'glm-5.3-flashx',
  'step-5-preview',
  'mimo-v2.6-pro',
  'minimax-m3.1-flash',
  'hy4free',
  'hy4std',
  'space-bunny',
]

// --- case 1: every verified model is in the catalogue -------------------
{
  const block = source.slice(source.indexOf('const FALLBACK_MODELS = ['), source.indexOf('/** @param {unknown} value */'))
  const declared = [...block.matchAll(/id: '([^']+)'/g)].map((match) => match[1])
  assert.ok(declared.length >= VERIFIED.length, `the catalogue must carry all of them (has ${declared.length})`)
  for (const id of VERIFIED) {
    assert.ok(declared.includes(id), `${id} must be offered: it answers 200 on the gateway`)
  }
  assert.ok(!/FALLBACK_MODELS = \[\s*\{\s*id: '[^']+',[^}]*\},?\s*\]/.test(source), 'a one-entry catalogue is the bug being fixed')
}

// --- case 2: each entry carries the metadata the provider schema needs --
{
  const block = source.slice(source.indexOf('const FALLBACK_MODELS = ['), source.indexOf('/** @param {unknown} value */'))
  const entries = block.split('{ id:').slice(1)
  for (const entry of entries) {
    assert.match(entry, /contextWindow: \d+/, 'a context window is required by llm-pi-ai')
    assert.match(entry, /maxTokens: \d+/, 'and a maxTokens')
    assert.match(entry, /name: '/, 'and a display name')
  }
}

// --- case 3: an unknown model is still usable --------------------------
{
  // The catalogue is a convenience, not a gate: a model added upstream must work without
  // a plugin release, so the probe and the panel accept an arbitrary id.
  assert.match(source, /asString\(input\.model\) \?\? FALLBACK_MODELS\[0\]\.id/, 'the model id is caller-supplied')
}

console.log('model-catalog OK · ten verified models offered, metadata complete, ids not gated')
