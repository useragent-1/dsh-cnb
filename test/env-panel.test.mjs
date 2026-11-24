/**
 * 「开发环境」页的多选、全选、手动清理必须真的渲染出来，而且**运行中的环境不可勾选**。
 *
 * 为什么单独测这一页：环境记录清理和批量操作都搬到了这里（之前散在「仓库」页），
 * 而这一页是 hooks 树 —— 把某个 hook 的值取错会得到一片空白区块，所有字符串断言
 * 照样通过。所以这里渲染真实的 `client.js`，断言一个人真会看到什么。
 *
 * 最要紧的一条是「运行中不可勾」：给一个勾得上、却永远删不掉的框比不给更糟；
 * 而给一个勾得上、真能删掉的环境框更糟 —— 那会丢未提交的工作。所以这条要看
 * **元素的 disabled 属性**，不能只看文字。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let factory = null
globalThis.window = {
  __ModuleLoader__: { load({ factory: registered }) { factory = registered } },
  localStorage: { getItem: () => null, setItem() {} },
  confirm: () => true,
}

function createElement(type, props, ...children) {
  const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
  const merged = { ...(props ?? {}) }
  if (flat.length === 1) merged.children = flat[0]
  else if (flat.length > 1) merged.children = flat
  return { type, props: merged, children: flat }
}

const STATUS = {
  loggedIn: true,
  user: { username: 'cnb.test', nickname: 'ren' },
  account: { loginAt: '2026-11-24T03:00:00.000Z' },
  health: 'ok',
  vault: { count: 1, accounts: [] },
  ambientToken: false,
  overriddenBy: [],
}

/** 一个运行中、两个已结束 —— 已结束的才可勾选。 */
const WORKSPACES = {
  total: 3,
  items: [
    { sn: 'cnb-live-001', pipeline_id: 'cnb-live-001', slug: 'acme/real', branch: 'main', status: 'running', duration: 18951 },
    { sn: 'cnb-old-002', pipeline_id: 'cnb-old-002', slug: 'acme/real', branch: 'main', status: 'closed', duration: 3600 },
    { sn: 'cnb-old-003', pipeline_id: 'cnb-old-003', slug: 'acme/other', branch: 'main', status: 'closed', duration: 7200 },
  ],
}

const CLEANUP = {
  settings: {
    enabled: false,
    scope: 'gateway',
    prefix: '',
    maxAgeHours: 24,
    keep: [],
    intervalMinutes: 30,
    deleteRunning: false,
    dryRun: false,
    environments: true,
    envScope: 'closed',
    envMaxAgeHours: 2,
  },
  source: 'credentials',
  timer: null,
  lastRun: null,
  lastBulk: null,
  protectedRepos: [],
  activeRepo: null,
  environmentCleanup: { enabled: true, scope: 'closed', maxAgeHours: 168 },
  limits: { maxPerRun: 50 },
  defaults: {},
  note: '',
}

/** 按形状喂数据：useApiState 的 state 初始值一定含 'status' 键。 */
const API_DATA = [STATUS, WORKSPACES, null, CLEANUP]
let apiIndex = 0

const React = {
  createElement,
  Fragment: 'fragment',
  useState(initial) {
    if (initial !== null && typeof initial === 'object' && !Array.isArray(initial) && 'status' in initial) {
      const data = API_DATA[Math.min(apiIndex, API_DATA.length - 1)]
      apiIndex += 1
      return [{ status: 'ready', data, error: null }, () => {}]
    }
    if (initial === 0) return [0, () => {}]
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
}

new Function('window', 'console', readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(globalThis.window, console)
assert.ok(typeof factory === 'function', 'client.js must register a factory')

/** 把默认 tab 掰到「开发环境」：tab 的初始值是一个字符串，形状唯一。 */
const TABS = {
  ...React,
  useState(initial) {
    if (initial === 'account') return ['envs', () => {}]
    return React.useState(initial)
  },
}
const client = factory((id) => (id === 'react' ? TABS : {}))

const nodes = []
const elements = []
function walk(node) {
  if (node === null || node === undefined || node === false || node === true) return
  if (typeof node === 'string' || typeof node === 'number') { nodes.push(String(node)); return }
  if (Array.isArray(node)) { node.forEach(walk); return }
  if (node.type === 'fragment') { node.children.forEach(walk); return }
  if (typeof node.type === 'function') { walk(node.type(node.props ?? {})); return }
  elements.push(node)
  node.children.forEach(walk)
}

walk(createElement(client.Panel, {}))
const rendered = nodes.join(' | ')

// --- 1. 列表与三种状态都在 ------------------------------------------
{
  assert.ok(rendered.includes('我的开发环境 (3)'), 'the environment list renders with its count')
  assert.ok(rendered.includes('acme/real'), 'the repo is named')
  assert.ok(rendered.includes('运行中'), 'a live one says so')
  assert.ok(rendered.includes('已关闭'), 'a finished one says so')
  assert.ok(rendered.includes('cnb-live-001'), 'and each row carries its sn')
}

// --- 2. 全选与手动清理按钮都在这页 ----------------------------------
{
  assert.ok(rendered.includes('全选（2）'), 'select-all counts only the selectable ones')
  assert.ok(rendered.includes('预览旧记录'), 'a preview button exists')
  assert.ok(rendered.includes('清理已结束的'), 'and a real cleanup button')
}

// --- 3. 自动清理开关也在这页，并说明了窗口 ------------------------
{
  assert.ok(rendered.includes('自动清理已结束的记录'), 'the auto-clean switch lives with the list it governs')
  assert.ok(rendered.includes('2 小时'), 'and the window is spelled out')
  assert.ok(rendered.includes('运行中的永远不动'), 'with the guarantee stated in words')
}

// --- 4. 复选框：运行中的禁用，其余可用 ------------------------------
//
// 这一条必须看元素属性，不能看文字：一个 disabled 写错的框，界面上看起来完全正常。
{
  // 环境行的 title 是「选中以批量…」或「运行中的环境不参与…」；自动清理开关没有 title。
  const rowBoxes = elements
    .filter((node) => node.type === 'input' && node.props.type === 'checkbox')
    .filter((node) => /批量|运行中的环境不参与/.test(String(node.props.title ?? '')))
  assert.equal(rowBoxes.length, 3, 'one box per environment row')
  assert.deepEqual(
    rowBoxes.map((box) => box.props.disabled === true),
    [true, false, false],
    'only the running environment is disabled',
  )
  const live = rowBoxes.find((box) => box.props.disabled === true)
  assert.match(String(live.props.title), /运行中|不参与批量/)
}

// --- 5. 没有勾选时不摆批量操作条 ------------------------------------
{
  assert.ok(!rendered.includes('删除选中的'), 'no bulk bar without a selection')
  assert.ok(!rendered.includes('停止选中的'), 'nor a stop bar')
}

// --- 6. 渲染是实质性的 --------------------------------------------
{
  assert.ok(rendered.length > 1200, `the tab must render its body (saw ${rendered.length} chars)`)
  assert.ok(!rendered.includes('请先在「账号」页扫码登录 CNB'), 'the logged-in branch was taken')
}

console.log('env-panel OK · 多选/全选/手动清理都在环境页，且运行中的环境不可勾选')
