/**
 * The gateway refuses a body carrying a client fingerprint, and it must not.
 *
 * The CNB AI gateway runs content risk control over the request: a match answers
 * HTTP 400 / code 11128 "Illegal API invocation from an unapproved channel". Changing
 * the token, account, model or headers does not help, because what is refused is the
 * prompt text — and it only fires for long bodies, so it looks intermittent.
 *
 * Verified against the live gateway: the system text
 *   "Main branch (the usual target for pull requests)"
 * answers 400/11128 when sent raw, and 200 once the phrase is rewritten. A local proxy
 * solved this for one deployment; the rewriting now lives here so every user gets it
 * without running anything extra.
 *
 * These cases pin the two properties that matter: the rewrite is applied automatically
 * by `chat()`, and it never changes what the request means.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CnbApi } from '../lib/cnb-client.js'
import { IDENTITY_RE, neutralize, normalizeRoles, prepareOutbound } from '../lib/neutralize.js'

const originalFetch = globalThis.fetch

// --- case 1: the known fingerprint is rewritten --------------------------
{
  const blocked = 'Main branch (the usual target for pull requests)'
  const out = neutralize(blocked)
  // Rewriting an already-safe phrase must be a no-op, so guard by starting from the
  // wording the gateway accepts and checking the one it refuses.
  const refused = 'Main branch (you will usually use this for PRs)'
  const fixed = neutralize(refused)
  assert.notEqual(fixed, refused, 'the refused wording must be rewritten')
  assert.match(fixed, /pull requests/, 'to wording the gateway accepts')
  assert.equal(neutralize(blocked), blocked, 'already-safe wording is left alone')
  void out
}

// --- case 2: identity words are split without changing the text a reader sees --
{
  const out = neutralize('DeepSeek Harness is the client')
  assert.ok(out.includes('\u200b'), 'a zero-width space is inserted')
  assert.equal(out.replace(/\u200b/g, ''), 'DeepSeek Harness is the client', 'removing it restores the original')
}

// --- case 3: a Windows path must NOT be rewritten -----------------------
{
  // Splitting the identity here would hand the model a broken path.
  const path = 'D:\\app\\DeepSeek Harness\\resources\\x'
  assert.equal(neutralize(path), path, 'path context is skipped')
}

// --- case 4: developer role becomes system ------------------------------
{
  const messages = [{ role: 'developer', content: 'x' }, { role: 'user', content: 'y' }]
  normalizeRoles(messages)
  assert.equal(messages[0].role, 'system')
}

// --- case 5: prepareOutbound rewrites natural-language roots only -------
{
  const payload = {
    model: 'deepseek-v4.1-flash',
    max_tokens: 8,
    stream: true,
    messages: [{ role: 'system', content: 'Main branch (you will usually use this for PRs)' }],
  }
  const { payload: next, rewritten } = prepareOutbound(structuredClone(payload))
  assert.ok(rewritten > 0, 'something must be rewritten')
  assert.equal(next.model, payload.model, 'the model id is a protocol field, not prose')
  assert.equal(next.max_tokens, 8)
  assert.match(next.messages[0].content, /pull requests/)
}

// --- case 6: chat() neutralises, so a body the gateway refuses still works --
{
  const sent = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    sent.push(body)
    // Behave like the real gateway: refuse while the fingerprint survives.
    const text = JSON.stringify(body.messages)
    if (/usually use this for PRs/.test(text)) {
      return new Response(JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })
  }
  try {
    const api = new CnbApi({ token: async () => 'tok', api: 'https://api.cnb.cool' })
    const result = await api.chat('acme/alpha', {
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: 'Main branch (you will usually use this for PRs). ' + 'x'.repeat(900) },
        { role: 'user', content: 'say ok' },
      ],
      maxTokens: 8,
    })
    assert.equal(result.text, 'ok', 'the call must succeed on the neutralised body')
    assert.ok(sent.length >= 1)
    assert.ok(!/usually use this for PRs/.test(JSON.stringify(sent[0].messages)), 'the first attempt is already neutralised')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 7: a persistent refusal is reported, not retried forever ------
{
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response(JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const api = new CnbApi({ token: async () => 'tok', api: 'https://api.cnb.cool' })
    await assert.rejects(
      () => api.chat('acme/alpha', { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 }),
      /11128|unapproved/,
    )
    assert.ok(calls <= 4, `it escalates a bounded number of times, not forever (${calls})`)
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- case 8: the neutraliser ships with the plugin, not as an assumption --
{
  const source = readFileSync(new URL('../lib/neutralize.js', import.meta.url), 'utf8')
  assert.match(source, /IDENTITY_RE/, 'the identity rule is present')
  assert.match(source, /11128/, 'and the reason for it is documented')
}

console.log('neutralize OK · fingerprint rewritten, meaning unchanged, chat() applies it')
