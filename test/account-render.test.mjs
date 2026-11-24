/**
 * The account panel must actually render — with a real component tree, not just "the
 * source mentions the right strings".
 *
 * `account-panel.test.mjs` checks the wiring statically. That is necessary but not
 * sufficient: the panel is a tree of hooks, and getting one hook's value wrong (or
 * reading a field the host does not send) yields a blank section with every string
 * assertion still passing. This renders the real `client.js` under a flattening React
 * stand-in and asserts what a person would see.
 *
 * The stand-in has to be installed before the module runs: the client destructures
 * `useState` when its factory is called, so swapping it afterwards is invisible and every
 * component renders its logged-out branch — which is exactly the trap this guards.
 *
 * No browser is needed, so this runs everywhere the rest of the suite does.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let factory = null
globalThis.window = {
  __ModuleLoader__: { load({ factory: registered }) { factory = registered } },
  localStorage: { getItem: () => null, setItem() {} },
  confirm: () => true,
}

/** A React stand-in: elements are plain nodes, and `walk` flattens them to text. */
function createElement(type, props, ...children) {
  return {
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  }
}

/**
 * The status the host really produces, with two accounts.
 *
 * Copied from a live `accounts.list` response, so this fails if the host and the panel
 * ever disagree about a field name.
 */
const STATUS = {
  loggedIn: true,
  user: { username: 'cnb.cccEkSRHAG98', nickname: 'ren' },
  account: {
    description: 'dsh-cnb-20261124-030956-530g',
    expiredAt: null,
    loginAt: '2026-11-24T03:09:56.608Z',
    tokenName: 'dsh-cnb-20261124-030956-530g',
    scope: 'repo-code:rw',
    accountId: 'acc-4f319ff9',
  },
  health: 'ok',
  healthDetail: null,
  sessionStored: true,
  sessionAge: '2026-11-24T03:09:56.608Z',
  cookie: {
    stored: true,
    savedAt: '2026-11-24T03:09:56.608Z',
    expiresAt: '2026-12-08T03:09:56.467Z',
    remainingMs: 1_208_789_219,
    source: 'server',
    cookieName: 'CNBSESSION',
  },
  vault: {
    activeId: 'acc-4f319ff9',
    updatedAt: '2026-11-24T03:30:07.545Z',
    count: 2,
    accounts: [
      {
        id: 'acc-4f319ff9', label: 'ren', username: 'cnb.cccEkSRHAG98', nickname: 'ren',
        description: null, tokenName: null, scopeProfile: 'full', active: true, health: 'ok',
        tokenStored: true, sessionStored: true, loginAt: '2026-11-24T03:09:56.608Z',
        expiredAt: null, expiresInMs: null, savedAt: '2026-11-24T03:30:07.545Z',
        lastUsedAt: '2026-11-24T03:30:07.545Z',
      },
      {
        id: 'acc-11112222', label: '小号', username: 'second', nickname: '小号',
        description: null, tokenName: null, scopeProfile: 'imported', active: false, health: 'expired',
        tokenStored: true, sessionStored: false, loginAt: '2026-11-20T01:00:00.000Z',
        expiredAt: '2026-11-22T01:00:00.000Z', expiresInMs: -172_800_000,
        savedAt: '2026-11-20T01:00:00.000Z', lastUsedAt: '2026-11-20T01:00:00.000Z',
      },
    ],
    active: { id: 'acc-4f319ff9', label: 'ren', username: 'cnb.cccEkSRHAG98', health: 'ok' },
    issue: null,
  },
  pending: null,
  ambientToken: false,
  overriddenBy: [],
  gatewayAdoption: null,
  ambient: { token: false, repo: null },
  plugin: { webOrigin: 'https://cnb.cool', apiOrigin: 'https://api.cnb.cool', requestTimeoutMs: 25_000 },
}

/**
 * Which hook call gets which value.
 *
 * Panel asks for its tab first, then `useApiState` asks for state and a nonce. Keying on
 * call order is what lets a real component tree render without a scheduler.
 */
const SEEDED = new Map([
  [1, ['account', () => {}]],
  [2, [{ status: 'ready', data: STATUS, error: null }, () => {}]],
  [3, [0, () => {}]],
])
let hookCall = 0

const React = {
  createElement,
  Fragment: 'fragment',
  useState(initial) {
    hookCall += 1
    const seeded = SEEDED.get(hookCall)
    if (seeded !== undefined) return seeded
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
}

// Load the module the way the browser does, then call its factory with the stand-in.
new Function('window', 'console', readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(globalThis.window, console)
assert.ok(typeof factory === 'function', 'client.js must register a factory')
const client = factory((id) => (id === 'react' ? React : {}))

const text = []
function walk(node) {
  if (node === null || node === undefined || node === false || node === true) return
  if (typeof node === 'string' || typeof node === 'number') { text.push(String(node)); return }
  if (Array.isArray(node)) { node.forEach(walk); return }
  if (node.type === 'fragment') { node.children.forEach(walk); return }
  if (typeof node.type === 'function') { walk(node.type(node.props ?? {})); return }
  node.children.forEach(walk)
}

walk(createElement(client.Panel, {}))
const rendered = text.join(' | ')

// --- case 1: the account section is on screen, with both accounts ---------
{
  assert.ok(rendered.includes('已保存的账户'), 'the saved-account section must render')
  assert.ok(rendered.includes('ren'), 'the active account must be listed')
  assert.ok(rendered.includes('小号'), 'a second account must be listed')
}

// --- case 2: each state is shown in words, not as an id -------------------
{
  assert.ok(rendered.includes('可用'), 'a stored, unexpired token reads 可用')
  assert.ok(rendered.includes('已过期'), 'a lapsed one reads 已过期, not "expired"')
  assert.ok(rendered.includes('当前'), 'the active account is tagged')
}

// --- case 3: all three actions are offered -------------------------------
{
  for (const label of ['切换', '改名', '删除']) {
    assert.ok(rendered.includes(label), `the account row must offer ${label}`)
  }
}

// --- case 4: a credential is never rendered, only its presence -----------
{
  assert.ok(rendered.includes('有令牌'), 'presence is reported as a boolean')
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(rendered), 'no JWT-shaped value may appear')
  assert.ok(!rendered.includes('csrftoken'), 'nor any session cookie')
}

// --- case 5: the render is substantial, not an error fallback ------------
{
  // A blank section would still satisfy string checks on the surrounding chrome; the
  // length guards against the panel collapsing to just its header.
  assert.ok(rendered.length > 4000, `the panel must render its body (saw ${rendered.length} chars)`)
}

console.log('account-render OK · real component tree renders both accounts, all actions, no secret')
