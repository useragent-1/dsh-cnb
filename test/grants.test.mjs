/**
 * Every missing scope must come with the place to grant it.
 *
 * The two scopes this plugin cannot work around — account-engage (delete a dev
 * environment) and group-resource (create a repository) — can only be granted on
 * CNB's token page. A user who is told "missing group-resource:rw" and nothing
 * else has to guess which checkbox that is, so the doctor answers with a label,
 * the effect, and the URL.
 */
import assert from 'node:assert/strict'
import { consoleGrantHint, fetchScopeTable } from '../lib/scopes.js'

const table = await fetchScopeTable()
const byName = new Set(table.map((entry) => entry.scope))

for (const scope of ['account-engage', 'group-resource']) {
  assert.ok(byName.has(scope), `${scope} must exist in the service table`)
  const hint = consoleGrantHint(scope)
  assert.ok(hint, `${scope} must produce a hint`)
  assert.equal(hint.scope, scope)
  assert.equal(hint.url, 'https://cnb.cool/profile/token')
  assert.ok(hint.label.length > 0)
  assert.ok(hint.meaning !== null && hint.meaning.length > 0, `${scope} needs a plain-language meaning`)
  assert.match(hint.group, /^(account|group|repo|registry|mission)$/)
}

// The wording has to be the thing the user sees on that page, not the code name.
assert.match(consoleGrantHint('group-resource').meaning, /仓库/)
assert.match(consoleGrantHint('account-engage').meaning, /环境/)

// An unknown permission yields no hint rather than a broken one.
assert.equal(consoleGrantHint('nope'), undefined)

console.log('grants OK · both blocking scopes carry a label, meaning and URL')
