/**
 * The account list must be visible, and it must never render a credential.
 *
 * The host half is covered by `accounts.test.mjs`; this checks the client, which cannot
 * be rendered here (no react, no jsdom). Two properties are asserted against the source
 * instead, because both are the kind of thing that silently rots:
 *
 *  - the list is actually mounted inside the account tab, with the three actions wired
 *    to real API operations;
 *  - every value it displays comes from a field the host sends without a secret in it —
 *    a `token` or `session` reference inside the component would be a leak, since the
 *    browser is the one place the token must never reach.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** The AccountList component's own source, so assertions cannot match another component. */
const componentStart = source.indexOf('function AccountList(')
assert.ok(componentStart > 0, 'the account list must be its own component')
const componentEnd = source.indexOf('const CHECK_META', componentStart)
assert.ok(componentEnd > componentStart, 'the component must end before the next constant')
const component = source.slice(componentStart, componentEnd)

// --- case 1: the list is mounted in the account tab -------------------------
{
  assert.match(source, /h\(AccountList,\s*\{/, 'the account tab must render the list')
  assert.match(source, /vault: status\?\.vault/, 'and feed it the vault the host sends')
  assert.match(source, /onSwitch: switchAccount/, 'switch is wired')
  assert.match(source, /onRename: renameAccount/, 'rename is wired')
  assert.match(source, /onRemove: removeAccount/, 'delete is wired')
}

// --- case 2: each action calls the API operation that exists ---------------
{
  for (const op of ['accounts.switch', 'accounts.rename', 'accounts.remove']) {
    assert.ok(source.includes(`callApi('${op}'`), `${op} must be called`)
  }
}

// --- case 3: no credential field reaches the component ---------------------
{
  // A bare `entry.token`/`entry.session` read is the leak; the `…Stored` booleans the
  // host sends are the safe way to say the same thing, so the pattern demands a
  // non-identifier character after the field name.
  for (const field of ['token', 'session', 'sessionSavedAt', 'tokenName']) {
    const leak = new RegExp(`entry\\.${field}(?![A-Za-z])`)
    assert.ok(!leak.test(component), `the account list must not read entry.${field}`)
  }
  assert.ok(!component.includes('tokenValue'), 'and no local token state either')
  // Presence is reported as booleans by the host; the component may read those.
  assert.match(component, /entry\.tokenStored/, 'token presence is shown')
  assert.match(component, /entry\.sessionStored/, 'session presence is shown')
}

// --- case 4: every state the host can report has a label -------------------
{
  for (const state of ['ok', 'session-only', 'expired-session', 'expired', 'unknown']) {
    assert.ok(
      new RegExp(`(^|\\s)'?${state.replace(/-/g, '\\-')}'?:\\s*\\{`, 'm').test(source),
      `health state "${state}" needs a label, or the list shows a raw id`,
    )
  }
  assert.match(source, /ACCOUNT_HEALTH\[entry\.health\]/, 'and the label is what gets rendered')
}

// --- case 5: deleting asks first -------------------------------------------
{
  assert.match(source, /window\.confirm\(`从本机删除账户/, 'destroying a token must be confirmed')
}

// --- case 6: switching an account is offered only for the inactive ones ----
{
  const switchButton = /entry\.active[\s\S]{0,80}?\?\s*null\s*:\s*h\('button'/.test(component)
  assert.ok(switchButton, 'the active account must not offer "切换" to itself')
}

console.log('account-panel OK · list mounted, actions wired, no credential rendered')
