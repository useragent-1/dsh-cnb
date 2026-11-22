/**
 * Scope handling, checked against CNB's own permission table.
 *
 * The bug this suite exists for: a scope is `"<group>-<code>:<level>"`. Sending
 * the bare name is accepted by the mint and yields a token with no permissions,
 * so the panel shows "logged in" over an empty repository list. Every assertion
 * here is about the level being present and valid.
 */
import assert from 'node:assert/strict'
import {
  fetchScopeTable,
  fullScopes,
  normalizeScopes,
  pluginScopes,
  resolveScopes,
  resetScopeTableCache,
  PLUGIN_SCOPES,
} from '../lib/scopes.js'

resetScopeTableCache()
const table = await fetchScopeTable({ force: true })
assert.ok(table.length >= 20, 'the scope table must enumerate the platform permissions')
for (const entry of table) {
  assert.match(entry.scope, /^[a-z][a-z0-9]*-[a-z][a-z0-9-]*$/, `bad scope name ${entry.scope}`)
  assert.ok(entry.levels.length > 0, `${entry.scope} must publish at least one level`)
}

// Full profile: every permission, each at its strongest published level.
const full = fullScopes(table)
assert.equal(full.length, table.length)
for (const scope of full) {
  const at = scope.lastIndexOf(':')
  assert.notEqual(at, -1, `${scope} must carry a level`)
  const name = scope.slice(0, at)
  const level = scope.slice(at + 1)
  const entry = table.find((row) => row.scope === name)
  assert.ok(entry, `${name} must come from the table`)
  assert.ok(entry.levels.includes(level), `${name} does not publish level ${level}`)
  if (entry.levels.includes('rw')) assert.equal(level, 'rw', `${name} must be requested at rw`)
}

// The level-less list that caused the outage must not survive normalization.
const repaired = normalizeScopes(PLUGIN_SCOPES, table)
assert.deepEqual(repaired.dropped, [], 'every plugin permission must exist')
for (const scope of repaired.scopes) assert.match(scope, /:[a-z]+$/)
assert.ok(repaired.scopes.includes('repo-code:rw'))
assert.ok(repaired.scopes.includes('account-engage:rw'), 'workspace stop/delete need this')
assert.ok(repaired.scopes.includes('repo-cnb-trigger:rw'), 'workspace start needs this')
assert.ok(repaired.scopes.includes('group-resource:rw'), 'repo create and usage need this')

// An explicit level is respected when the code publishes it, upgraded otherwise.
assert.deepEqual(normalizeScopes(['repo-code:r'], table).scopes, ['repo-code:r'])
assert.deepEqual(normalizeScopes(['repo-code:bogus'], table).scopes, ['repo-code:rw'])
// An unknown permission is dropped rather than sent as a powerless grant.
const unknown = normalizeScopes(['repo-code:r', 'repo-nonsense:rw'], table)
assert.deepEqual(unknown.scopes, ['repo-code:r'])
assert.deepEqual(unknown.dropped, ['repo-nonsense:rw'])

// Plugin profile is a strict subset of the full one.
const plugin = pluginScopes(table)
assert.ok(plugin.length > 0)
for (const scope of plugin) assert.ok(full.includes(scope), `${scope} must also be in the full profile`)

// resolveScopes is the entry point the mint uses.
assert.deepEqual(await resolveScopes({ profile: 'full' }), full)
assert.deepEqual(await resolveScopes({ profile: 'plugin' }), plugin)

console.log(`scopes OK · ${table.length} permissions · full=${full.length} · plugin=${plugin.length}`)
