/**
 * 脚手架清单必须覆盖整张 import 图。
 *
 * ## 这条为什么值得单独测
 *
 * 云环境跑的不是 `lib/`，而是 `buildScaffold` 复制过去的那几个文件。所以
 * `RUNTIME_SOURCES` 少一个模块的后果是：
 *
 *   · 本机：完全没有症状 —— `lib/` 就在旁边，`import './image-guard.js'` 正常解析；
 *   · 云端：`ERR_MODULE_NOT_FOUND`，网关进程直接退出，环境起不来。
 *
 * 这个失败模式极难在开发时发现，因为它要求你「在只有脚手架的目录里」跑一次。
 * 这里改成静态扫描：从入口出发走一遍相对 import，任何一个文件不在清单里就失败。
 * 以后新增模块忘了登记，跑测试就会红。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, posix, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNTIME_SOURCES, SCAFFOLD_DIR, buildScaffold } from '../lib/scaffold.js'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'lib')

/**
 * 从一个源文件里取出**相对** import 的目标（`node:` 与包名不算）。
 *
 * ## 为什么不能按 `dirname(source)` 解析
 *
 * `lib/cloud/serve.mjs` 写的是 `./gateway-proxy.js`，但那个文件在 `lib/` 而不是
 * `lib/cloud/` —— 因为脚手架把它**摊平**到同一目录（`.dsh-gateway/serve.mjs` 与
 * `.dsh-gateway/gateway-proxy.js` 并排）。所以本机源码树的布局与云端布局不同，
 * 按源码目录解析会找错地方。
 *
 * 规则因此是：相对 import 一律在当前文件所在层解析，找不到就退回 `lib/` 根 —— 
 * 正好对应「摊平后同目录」这个事实。
 *
 * @param {string} source 相对 lib/ 的路径
 * @returns {string[]} 相对 lib/ 的路径
 */
function relativeImportsOf(source) {
  const text = readFileSync(join(libDir, source), 'utf8')
  const found = new Set()
  // 只认静态 import / export-from；动态 import() 与 require() 不在这套脚手架的用法里。
  const re = /^\s*(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/gm
  let match
  while ((match = re.exec(text)) !== null) {
    const spec = match[1]
    if (!spec.startsWith('.')) continue
    // 先按同目录解析；不存在则按 lib/ 根解析（摊平布局）。
    const sameDir = posix.normalize(posix.join(posix.dirname(source), spec))
    const flattened = posix.normalize(spec.replace(/^\.\//, ''))
    found.add(existsSync(join(libDir, sameDir)) ? sameDir : flattened)
  }
  return [...found]
}

/** 从入口开始遍历整张相对 import 图。 */
function reachableFrom(entry) {
  const seen = new Set()
  const queue = [entry]
  while (queue.length > 0) {
    const source = queue.shift()
    if (seen.has(source)) continue
    seen.add(source)
    for (const next of relativeImportsOf(source)) if (!seen.has(next)) queue.push(next)
  }
  return seen
}

// --- 1. 入口 + 全部可达模块都在 RUNTIME_SOURCES 里 ----------------------
{
  const entry = 'cloud/serve.mjs'
  const reachable = reachableFrom(entry)
  const declared = new Set(RUNTIME_SOURCES)
  assert.ok(declared.has(entry), 'the entry itself must be scaffolded')
  for (const source of reachable) {
    assert.ok(
      declared.has(source),
      `lib/${source} is imported (directly or transitively) from ${entry} but missing from RUNTIME_SOURCES — the cloud gateway would crash with ERR_MODULE_NOT_FOUND`,
    )
  }
  // 反过来：清单里不该有从不被 import 的死文件，那只会让脚手架多带无用的东西。
  for (const source of declared) {
    assert.ok(
      reachable.has(source),
      `${source} is scaffolded but nothing imports it; drop it from RUNTIME_SOURCES`,
    )
  }
}

// --- 2. 生成的脚手架里真的带着那些文件 ---------------------------------
{
  const files = buildScaffold({ key: 'k', port: 8794, models: ['deepseek-v4.1-flash'], repo: 'acme/gw' })
  const paths = files.map((file) => file.path)
  for (const source of RUNTIME_SOURCES) {
    const scaffoldPath = `${SCAFFOLD_DIR}/${source.replace(/^cloud\//, '')}`
    assert.ok(paths.includes(scaffoldPath), `${scaffoldPath} is written into the target repo`)
  }
  // 每个被复制过去的模块，它的相对 import 也必须在同一目录里存在 —— 否则云端
  // 依旧找不到。这条是上一条的「落地版」：清单对了，文件也得真写出去。
  for (const source of RUNTIME_SOURCES) {
    for (const dependency of relativeImportsOf(source)) {
      const needed = `${SCAFFOLD_DIR}/${dependency.replace(/^cloud\//, '')}`
      assert.ok(
        paths.includes(needed),
        `${source} imports ./${posix.basename(dependency)} but ${needed} is not written`,
      )
    }
  }
}

// --- 3. 复制的是本机同一份源码，不是重写 ------------------------------
{
  const files = buildScaffold({ key: 'k', port: 8794, models: ['m'], repo: 'a/b' })
  const guard = files.find((file) => file.path === `${SCAFFOLD_DIR}/image-guard.js`)
  assert.ok(guard !== undefined, 'image-guard.js is part of the scaffold')
  const onDisk = readFileSync(join(libDir, 'image-guard.js'), 'utf8')
  assert.equal(guard.content, onDisk, 'the cloud copy is byte-identical to the tested source')
  assert.ok(guard.content.includes('prepareImages'), 'and it is the module with the image entry point')
}
