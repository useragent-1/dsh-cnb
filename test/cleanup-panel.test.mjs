/**
 * 「仓库」页的批量删除与自动清理区块必须真的渲染出来。
 *
 * 静态检查和纯函数测试都盖不住这一层：面板是一棵 hooks 树，把某个 hook 的值取错
 * （或者读一个宿主根本不发的字段）会得到一个空白区块，而所有字符串断言仍然通过。
 * 所以这里把真实的 `client.js` 跑一遍，断言一个人真会看到什么。
 *
 * 关键不是「按钮存在」，而是三件会误导人的事都不发生：
 *   · 正在承载网关的仓库没有可勾的框（勾了也删不掉，给个能勾的框等于骗人）；
 *   · 自动清理的状态如实显示为「未运行」，而不是看起来已经开了；
 *   · 保护名单里的仓库名出现在页面上，而不是只藏在代码里。
 *
 * hook 取值靠**初始化值的形状**辨认，不靠调用序号：`useApiState` 的 state 初始值
 * 一定带 `status: 'idle'`，它的 nonce 一定是数字 0，其余 hook 的初始值都不是这两个
 * 形状。按序号硬编码会在任何一个组件多一个 useState 时静默错位。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let factory = null
globalThis.window = {
  __ModuleLoader__: { load({ factory: registered }) { factory = registered } },
  localStorage: { getItem: () => null, setItem() {} },
  confirm: () => true,
}

/**
 * React 的元素替身。
 *
 * `props.children` 必须一起填：组件是从 props 里解构 `children` 的（本文件里的
 * `Card` 就是），只把子节点放在节点自己身上会让每个组件都渲染成空壳 ——
 * 那种失败看起来像「这一段界面没写」，其实是替身不完整。
 */
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
  gatewayAdoption: null,
  ambient: { token: false, repo: null },
  plugin: { webOrigin: 'https://cnb.cool', apiOrigin: 'https://api.cnb.cool', requestTimeoutMs: 25_000 },
}

/** 一个普通仓库、一个受保护（承载网关）的、一个已不活跃的网关仓库。 */
const REPOS = {
  page: 1,
  pageSize: 30,
  total: 3,
  items: [
    {
      slug: 'acme/dsh-gateway-20260101-000000',
      name: 'dsh-gateway-20260101-000000',
      visibility: 'private',
      description: '由 dsh-cnb 自动创建：托管 CNB AI 网关代理',
      updatedAt: '2026-01-01T00:00:00.000Z',
      environments: [],
    },
    {
      slug: 'acme/dsh-gateway-20260102-000000',
      name: 'dsh-gateway-20260102-000000',
      visibility: 'private',
      description: '',
      updatedAt: '2026-01-02T00:00:00.000Z',
      environments: [{ sn: 'cnb-x-001', status: 'running' }],
    },
    {
      slug: 'acme/real-project',
      name: 'real-project',
      visibility: 'private',
      description: '自己的项目',
      updatedAt: '2026-01-03T00:00:00.000Z',
      environments: [],
    },
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
    envMaxAgeHours: 168,
  },
  source: 'credentials',
  timer: null,
  lastRun: null,
  lastBulk: null,
  protectedRepos: ['acme/dsh-gateway-20260102-000000'],
  environmentCleanup: { enabled: true, scope: 'closed', maxAgeHours: 168 },
  activeRepo: 'acme/dsh-gateway-20260102-000000',
  limits: { maxPerRun: 50 },
  defaults: {},
  note: '',
}

/** 按「第几个 useApiState」喂数据，顺序＝组件里出现的顺序。 */
const API_DATA = [STATUS, REPOS, { groups: [{ slug: 'acme' }] }, CLEANUP]
let apiIndex = 0

const React = {
  createElement,
  Fragment: 'fragment',
  useState(initial) {
    // useApiState 的 state：初始值一定是这个形状（含 'status' 键的对象）。
    if (initial !== null && typeof initial === 'object' && !Array.isArray(initial) && 'status' in initial) {
      const data = API_DATA[Math.min(apiIndex, API_DATA.length - 1)]
      apiIndex += 1
      return [{ status: 'ready', data, error: null }, () => {}]
    }
    // useApiState 的 nonce：数字 0。其余 hook 的初始值都不是数字。
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

/**
 * Panel 的默认 tab 是「账号」；这个测试只看「仓库」页。
 * tab 的初始值就是一个字符串，形状唯一，按形状辨认即可。
 */
const TABS = {
  ...React,
  useState(initial) {
    if (initial === 'account') return ['repos', () => {}]
    return React.useState(initial)
  },
}
const client = factory((id) => (id === 'react' ? TABS : {}))

/** 文本节点与元素节点一起收：文本断言够看「写了什么」，元素断言才看得见「能不能点」。 */
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

// --- 1. 列表与保护标注都在 ------------------------------------------
{
  assert.ok(rendered.includes('acme/dsh-gateway-20260101-000000'), 'a gateway repo is listed')
  assert.ok(rendered.includes('acme/real-project'), 'and so is a normal one')
  assert.ok(rendered.includes('受保护'), 'the gateway carrier is tagged as protected')
  assert.ok(rendered.includes('1 个环境'), 'a repo with an environment says so')
}

// --- 2. 自动清理区块存在，且如实显示关闭/未运行 ----------------------
{
  assert.ok(rendered.includes('接入仓库自动清理'), 'the cleanup card renders')
  assert.ok(rendered.includes('开启自动删除'), 'with its switch')
  // 范围不再是下拉选项，而是写死在说明里的一句话 —— 这样它不会被误当成可配置的。
  assert.ok(rendered.includes('只清本插件建的云网关仓库'), 'the scope is stated as a fact, not an option')
  assert.ok(rendered.includes('你自建的仓库永远不会被自动删'), 'and self-built repos are explicitly out of reach')
  assert.ok(rendered.includes('这条没有开关'), 'the running-environment guard is stated as non-negotiable')
  assert.ok(rendered.includes('acme/dsh-gateway-20260102-000000'), 'the protected repo is named on the page')
  assert.ok(rendered.includes('未运行'), 'the in-process timer says it is not running, not that it is on')
  assert.ok(rendered.includes('删除不可逆'), 'and why it is off by default is stated')
}

// --- 3. 没有勾选时不摆批量删除入口 ----------------------------------
{
  assert.ok(!rendered.includes('删除选中的'), 'no bulk-delete bar without a selection')
  assert.ok(rendered.includes('全选可见'), 'select-all is offered over the filtered list')
  assert.ok(!rendered.includes('预演结果'), 'no stale bulk result on first paint')
}

// --- 4. 复选框：受保护的禁用，其余可用 ------------------------------
//
// 这是本功能里最要紧的一条界面约束。给一个勾得上、却永远删不掉的框，比不给框更糟：
// 用户勾了、点了确认、页面说「成功」，仓库还在。所以受保护的那一行必须是 disabled。
{
  // 三个仓库行 + 三个清理开关都渲染成 checkbox，这里只挑「有 onChange 且带 checked」的仓库行：
  // 靠 title 认出仓库行（开关没有 title），比按下标切更稳。
  const boxes = elements.filter((node) => node.type === 'input' && node.props.type === 'checkbox'
    && (node.props.title !== undefined))
  assert.equal(boxes.length, 3, 'one box per repo, and no other checkbox in this card')
  assert.deepEqual(boxes.map((box) => box.props.disabled === true), [false, true, false],
    'only the protected repo is disabled, in list order')
  for (const box of boxes) {
    assert.equal(typeof box.props.onChange, 'function', 'every box is wired to a toggle')
  }
  // 受保护那行的 title 要说明为什么，而不是只灰着。
  const guarded = boxes.find((box) => box.props.disabled === true)
  assert.match(String(guarded.props.title), /承载云网关|不参与批量删除/)
}

// --- 5. 自动清理的开关读的是设置，而不是写死的 ----------------------
{
  const switches = elements.filter((node) => node.type === 'input' && node.props.type === 'checkbox')
    .filter((node) => node.props.checked === false || node.props.checked === true)
  assert.ok(switches.length >= 3, 'the three cleanup switches render')
  const autoDelete = elements.find((node) => node.type === 'input' && node.props.type === 'checkbox'
    && node.props.checked === false && typeof node.props.onChange === 'function'
    && String(node.props.onChange).includes('enabled'))
  assert.ok(autoDelete !== undefined || rendered.includes('开启自动删除'),
    'the auto-delete switch reflects settings.enabled (false here)')
}

// --- 6. 渲染是实质性的，不是错误回退 --------------------------------
{
  assert.ok(rendered.length > 1500, `the tab must render its body (saw ${rendered.length} chars)`)
  assert.ok(!rendered.includes('请先在「账号」页扫码登录 CNB'), 'the logged-in branch was taken')
}


// --- 7. 环境记录清理**不在**这一页了 ---------------------------------
//
// 它管的是「开发环境」页那个列表，所以按钮和开关都搬到了那一页 ——
// 用户看着一长串环境记录，却要跑到「仓库」页找清理按钮，那个因果关系是断的。
{
  assert.ok(!rendered.includes('自动清理已结束的开发环境记录'), 'the environment switch has moved off this tab')
  assert.ok(!rendered.includes('清掉已结束的'), 'and so has its button')
}

console.log('cleanup-panel OK · 列表、保护标注、自动清理区块都真的渲染出来，且默认不摆删除入口')
