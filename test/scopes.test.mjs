/**
 * The minted token must carry every scope the plugin's own calls need.
 *
 * Two failure modes are easy to ship and invisible until a user clicks:
 *  - a scope the console does not recognize (the mint simply omits it), and
 *  - a scope that exists but names the wrong permission group.
 *
 * The console's own `GET /config/token/scope` is the authority; this suite reads
 * it live and asserts every requested scope is in it, plus a table of the exact
 * scope each endpoint demands. Needs no token: the scope table is public.
 */
import assert from 'node:assert/strict'
import { DEFAULT_TOKEN_SCOPES, extractMissingScopes } from '../lib/cnb-client.js'

const response = await fetch('https://cnb.cool/config/token/scope', { headers: { accept: 'application/json' } })
assert.equal(response.ok, true, 'the public scope table must be readable')
const table = await response.json()
const valid = new Set()
for (const group of table.config ?? []) {
  for (const code of group.codes ?? []) valid.add(`${group.group}-${code.code}`)
}
assert.ok(valid.size > 10, 'the scope table must enumerate permissions')

for (const scope of DEFAULT_TOKEN_SCOPES) {
  assert.ok(valid.has(scope), `requested scope "${scope}" is not a permission the console can grant`)
}

// Endpoint → the scope CNB actually enforces, taken from the OpenAPI security
// notes and confirmed against live 10023 responses.
const required = new Map([
  ['GET /{repo}', 'repo-basic-info'],
  ['GET /{repo}/-/git/contents/{file_path}', 'repo-code'],
  ['POST /{repo}/-/ai/chat/completions', 'repo-code'],
  ['GET /{repo}/-/build/logs', 'repo-cnb-history'],
  ['GET /{repo}/-/workspace/detail/{sn}', 'repo-cnb-detail'],
  ['POST /{repo}/-/workspace/start', 'repo-cnb-trigger'],
  ['DELETE /{repo}', 'repo-delete'],
  ['POST /{slug}/-/repos', 'group-resource'],
  ['GET /{slug}/-/charge/volume', 'group-resource'],
  ['GET /user', 'account-profile'],
  ['POST /workspace/stop', 'account-engage'],
  ['POST /workspace/delete', 'account-engage'],
])
for (const [endpoint, scope] of required) {
  assert.ok(DEFAULT_TOKEN_SCOPES.includes(scope), `${endpoint} needs "${scope}", which the mint must request`)
}

// A 10023 message must surface the scope it names.
assert.deepEqual(
  extractMissingScopes("The token's authorization scope does not match this request. Missing required scopes: account-engage:rw"),
  ['account-engage:rw'],
)
assert.deepEqual(extractMissingScopes('some other failure'), [])
// The plugin wraps the service text with its own errcode suffix; the scope must
// still come out clean.
assert.deepEqual(
  extractMissingScopes('Missing required scopes: group-resource:rw (errcode 10023)'),
  ['group-resource:rw'],
)
assert.deepEqual(
  extractMissingScopes('Missing required scopes: a-b:r, c-d:rw'),
  ['a-b:r', 'c-d:rw'],
)

console.log(`scopes OK · ${DEFAULT_TOKEN_SCOPES.length} requested · ${valid.size} grantable · ${required.size} endpoints mapped`)
