/**
 * 全自动开通的编排逻辑：脚手架内容、日志标记协议、provider 画像。
 *
 * 这一组测试的意义在于把「为什么必须这么绕」钉住 —— 每一条都对应一个实测约束：
 *
 *   · OpenAPI 只能读文件（`/-/git/contents` 是 GET），写只能靠内联 `config` 的构建；
 *   · 事件名必须是 `api_trigger`，否则 400 `[API_BUILD_START_FAIL]`；
 *   · 网关的公开地址只能从 stage 日志里带回来，所以标记协议必须稳定且可解析；
 *   · 没拿到 READY 就不能写 provider，否则 dsh 里会出现一条永远 404 的路由。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_CANDIDATES,
  DEFAULT_CLOUD_PORT,
  MARKERS,
  PROVISION_STEPS,
  cloudProviderProfile,
  defaultRepoName,
  markersComplete,
  mintGatewayKey,
  modelEntry,
  parseGatewayMarkers,
  scaffoldCnbYml,
  scaffoldCommitConfig,
  splitModels,
  wrapInlineStage,
} from '../lib/provision.js'
import { RUNTIME_SOURCES, SCAFFOLD_DIR, buildScaffold } from '../lib/scaffold.js'
import { apply } from '../lib/index.js'
import { importFromDsh } from './resolve-dsh.mjs'

// --- 1. 步骤表覆盖整条链路，且顺序就是执行顺序 ------------------------
{
  const ids = PROVISION_STEPS.map((step) => step.id)
  assert.deepEqual(ids, ['group', 'repo', 'scaffold', 'launch', 'harvest', 'verify', 'provider'])
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const provision = source.slice(source.indexOf('async function provisionGateway'), source.indexOf('async function harvestGatewayFromLogs'))
  let cursor = -1
  for (const id of ids) {
    const at = provision.indexOf(`record('${id}'`)
    assert.ok(at > cursor, `${id} must be recorded in order`)
    cursor = at
  }
}

// --- 2. key 与仓库名都可用，且不重复 ----------------------------------
{
  const a = mintGatewayKey()
  const b = mintGatewayKey()
  assert.match(a, /^dshgw_[A-Za-z0-9_-]{20,}$/)
  assert.notEqual(a, b)
  // 精确到秒：分钟粒度时「上一次被中断 → 立刻重试」会撞上刚建出来的同名仓库，
  // 平台答 10009，看起来像随机失败。
  assert.match(defaultRepoName(new Date('2026-11-23T10:54:07')), /^dsh-gateway-20261123-105407$/)
  assert.notEqual(
    defaultRepoName(new Date('2026-11-23T10:54:07')),
    defaultRepoName(new Date('2026-11-23T10:54:42')),
    'two runs in the same minute must not collide',
  )
}

// --- 2b. 名字冲突要自己消化，不能当成失败 ----------------------------
//
// 实测踩过：一次 curl 在客户端超时但服务端已经建好仓库，立刻重试就答
// 409 / `10009 conflicts with an existing resource`。用户的意图是「再开一个」，
// 不是「必须叫这个名字」，所以自动名要换后缀重试。
{
  const conflicts = []
  const originalFetch = globalThis.fetch
  const created = []
  const records = new Map([['dsh-cnb/cnb-token', { kind: 'grant', payload: { token: 'tok' } }]])
  const credentials = {
    async readRecord(key) { return records.get(key) },
    async modifyRecord(key, mutate) { const next = await mutate(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key) },
    async deleteRecord(key) { records.delete(key) },
    async set() {},
    async unset() {},
    async resolve() { return undefined },
  }
  const entries = [
    { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: {} } },
    { options: { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: {} } },
  ]
  const editor = { entries: () => entries, async edit(entry, change) { entry.options.config = await change(entry.options.config ?? {}) } }
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    get: (name) => (name === 'credentials' ? credentials : name === 'configEditor' ? editor : undefined),
    inject() {},
    on() {},
  }
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.endsWith('/user/groups')) return new Response(JSON.stringify([{ path: 'acme' }]), { status: 200 })
    if (target.includes('/-/repos') && init?.method === 'POST') {
      const body = JSON.parse(init.body)
      created.push(body.name)
      if (created.length === 1) {
        conflicts.push(body.name)
        return new Response(JSON.stringify({ errcode: 10009, errmsg: 'The target path conflicts with an existing resource. Please try a different path.' }), { status: 409 })
      }
      return new Response(JSON.stringify({ id: '1', name: body.name, path: `acme/${body.name}` }), { status: 201 })
    }
    return new Response(JSON.stringify({ errcode: 5, errmsg: 'Resource not found.' }), { status: 404 })
  }
  try {
    const api = apply(ctx, {})
    // 只验证到「仓库建成功」这一步：后面的步骤依赖真实环境，这组测试不碰网络之外的东西，
    // 所以让脚手架那一步抛错也无妨 —— 关键是两次 POST 与最终的名字。
    await api.provisionGateway({ org: 'acme', name: undefined }).catch(() => {})
    assert.equal(created.length, 2, 'a name conflict is retried once, then succeeds')
    assert.notEqual(created[0], created[1], 'the retry uses a different name')
    assert.match(created[1], /^dsh-gateway-\d{8}-\d{6}-[a-z0-9]{4}$/, 'the automatic name gains a short suffix')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- 2c. 显式指定的名字冲突是真的冲突，必须报错 ----------------------
{
  const originalFetch = globalThis.fetch
  let posts = 0
  const records = new Map([['dsh-cnb/cnb-token', { kind: 'grant', payload: { token: 'tok' } }]])
  const credentials = {
    async readRecord(key) { return records.get(key) },
    async modifyRecord(key, mutate) { const next = await mutate(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key) },
    async deleteRecord(key) { records.delete(key) },
    async set() {}, async unset() {}, async resolve() { return undefined },
  }
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    get: (name) => (name === 'credentials' ? credentials : undefined),
    inject() {},
    on() {},
  }
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.endsWith('/user/groups')) return new Response(JSON.stringify([{ path: 'acme' }]), { status: 200 })
    if (target.includes('/-/repos') && init?.method === 'POST') {
      posts += 1
      return new Response(JSON.stringify({ errcode: 10009, errmsg: 'The target path conflicts with an existing resource. Please try a different path.' }), { status: 409 })
    }
    return new Response(JSON.stringify({ errcode: 5, errmsg: 'Resource not found.' }), { status: 404 })
  }
  try {
    const api = apply(ctx, {})
    await assert.rejects(
      () => api.provisionGateway({ org: 'acme', name: 'taken-name' }),
      /已经存在|10009/,
      'an explicitly requested name is not silently changed',
    )
    assert.equal(posts, 1, 'and it is not retried under another name')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// --- 3. .cnb.yml 必须：带 key、带端口、把就绪标记打到日志 -------------
{
  const key = 'dshgw_test_key'
  const yml = scaffoldCnbYml({ key, port: 9001, models: ['m1', 'm2'] })
  assert.match(yml, /DSH_GW_KEY: "dshgw_test_key"/, 'the key ships with the repo so the env needs no extra channel')
  assert.match(yml, /DSH_GW_PORT="9001"/, 'the port the proxy binds')
  assert.match(yml, /keepAliveTimeout: 18h/, 'the platform recycles an idle environment after 10 minutes by default')
  assert.match(yml, /nohup node "\$GATEWAY_DIR\/serve.mjs"/, 'the stage must not block on a foreground server')
  assert.match(yml, /^ {2}vscode:/m, 'a dev environment, so the port preview exists')
  // 没有 key 时不允许静默起一个无鉴权代理。
  const keyless = scaffoldCnbYml({ port: 9001 })
  assert.ok(!keyless.includes('DSH_GW_KEY: "'), 'no key is invented out of thin air')
  assert.match(keyless, /缺省时网关拒绝启动/)
}

// --- 3b. YAML 结构必须真的把 stage 挂到环境上 ------------------------
//
// 早先版本里 `image:` 多缩两格、`env:` 少缩两格：YAML 仍能解析，但 `stages` 根本没
// 进 vscode 的映射 —— 环境起来了，却一个 stage 都没跑，留下的只是「没有就绪标记」。
// 这类错误肉眼看不出来，必须用真实解析器断言结构。
{
  const yaml = await importFromDsh('yaml', 'dist/index.js')
  for (const options of [
    { key: 'dshgw_k', port: 8794, image: 'docker.cnb.cool/a/b:1' },
    { key: 'dshgw_k', port: 8794 },
    { key: 'dshgw_k', port: 9999, image: 'x/y:2' },
  ]) {
    const doc = yaml.parse(scaffoldCnbYml(options))
    const entries = doc.$?.vscode
    assert.ok(Array.isArray(entries) && entries.length === 1, 'exactly one dev-environment entry')
    const entry = entries[0]
    assert.equal(entry.stages?.length, 1, 'the stage is attached to the environment, not floating')
    assert.equal(entry.stages[0].name, 'start cloud ai gateway')
    assert.match(entry.stages[0].script, /serve\.mjs/, 'and it is the script that starts the proxy')
    assert.equal(entry.env?.DSH_GW_KEY, 'dshgw_k')
    if (options.image !== undefined) assert.equal(entry.docker?.image, options.image)
    else assert.equal(entry.docker, undefined)
  }
}

// --- 4. 写文件走内联构建：事件名必须是 api_trigger --------------------
{
  const config = scaffoldCommitConfig({ files: [{ path: 'a.txt', content: 'hello' }] })
  assert.match(config, /^\$:/m)
  assert.match(config, /api_trigger:/, 'any other event answers [API_BUILD_START_FAIL]')
  assert.match(config, /git push origin HEAD:main/, 'writing files is only possible through a checkout')
  assert.match(config, /SCAFFOLD_WRITTEN=1/, 'and the caller needs a marker to verify it happened')
  assert.match(config, /cat > 'a.txt' <<'DSH_SCAFFOLD_EOF'/)
  // 带目录的文件要先建目录，否则重定向失败。
  const nested = scaffoldCommitConfig({ files: [{ path: '.dsh-gateway/serve.mjs', content: 'x' }] })
  assert.match(nested, /mkdir -p '.dsh-gateway'/)
  // 空仓库：先建分支再提交，否则 commit 无处落脚。
  assert.match(nested, /git rev-parse --verify HEAD/)
}

// --- 5. 标记协议：解析器必须忽略 shell 回显行 -------------------------
{
  const lines = [
    '\u001b[37mprintf \'DSH_GW_URL=%s\\n\' "$url"\u001b[39m',
    'nohup node serve.mjs > log 2>&1 &',
    'DSH_GW_REPO=acme/gateway',
    'DSH_GW_PORT=8794',
    'DSH_GW_URL=https://abc-8794.cnb.run/v1',
    'DSH_GW_KEY=dshgw_secret_value',
    'DSH_GW_MODELS=deepseek-v4.1-flash,glm-5.3-flash',
    'DSH_GW_READY=1',
  ]
  const markers = parseGatewayMarkers(lines)
  assert.equal(markers.url, 'https://abc-8794.cnb.run/v1')
  assert.equal(markers.key, 'dshgw_secret_value')
  assert.equal(markers.repo, 'acme/gateway')
  assert.equal(markers.port, '8794')
  assert.equal(markers.ready, '1')
  assert.equal(markers.error, undefined)
  assert.ok(markersComplete(markers), 'a complete harvest is usable')
  // 回显行以 `printf '` 开头，绝不会被当成标记。
  assert.equal(parseGatewayMarkers([lines[0]]).url, undefined)
  // 缺 READY 就不算成功：宁可报「还没起来」，也不要写一条坏路由。
  assert.equal(markersComplete({ ...markers, ready: undefined }), false)
  assert.equal(markersComplete({ ...markers, url: '' }), false)
}

// --- 6. 明确的错误标记要带出来，比「没就绪」有用 ---------------------
{
  const markers = parseGatewayMarkers(['gateway pid=1', 'DSH_GW_ERROR=DSH_GW_KEY is not set'])
  assert.equal(markers.error, 'DSH_GW_KEY is not set')
  assert.equal(markersComplete(markers), false)
}

// --- 7. 模型清单解析：去重、保序、忽略空白 ---------------------------
{
  assert.deepEqual(splitModels('a, b ,a,,c '), ['a', 'b', 'c'])
  assert.deepEqual(splitModels(undefined), [])
  assert.deepEqual(splitModels('  '), [])
  assert.deepEqual(DEFAULT_CANDIDATES.slice(0, 2), ['deepseek-v4.1-flash', 'deepseek-v4-flash'])
}

// --- 8. provider 画像：baseURL 是云网关，key 走具名引用 -------------
{
  const profile = cloudProviderProfile({
    repo: 'acme/gateway',
    baseURL: 'https://abc-8794.cnb.run/v1/',
    apiKeyEnv: 'DSH_CLOUD_GW_KEY',
    models: [modelEntry('deepseek-v4.1-flash')],
  })
  assert.equal(profile.baseURL, 'https://abc-8794.cnb.run/v1', 'trailing slash is normalised away')
  assert.equal(profile.api, 'openai-completions')
  assert.equal(profile.apiKeyEnv, 'DSH_CLOUD_GW_KEY', 'no plaintext key in any config file')
  assert.match(profile.displayName, /acme\/gateway/)
  assert.equal(profile.models[0].id, 'deepseek-v4.1-flash')
  assert.equal(profile.models[0].input[0], 'text')
}

// --- 9. 脚手架：文件清单固定，源码与本机是同一份 ---------------------
{
  const files = buildScaffold({ key: 'k', port: 8794, models: ['m'], repo: 'a/b' })
  const paths = files.map((file) => file.path).sort()
  assert.deepEqual(paths, [
    '.cnb.yml',
    `${SCAFFOLD_DIR}/README.md`,
    `${SCAFFOLD_DIR}/bootstrap.sh`,
    `${SCAFFOLD_DIR}/gateway-proxy.js`,
    `${SCAFFOLD_DIR}/model-catalog.js`,
    `${SCAFFOLD_DIR}/model-guard.js`,
    `${SCAFFOLD_DIR}/models.json`,
    `${SCAFFOLD_DIR}/serve.mjs`,
  ].sort())
  // 云端跑的就是本机测试的那份代码，否则「本机通过、云端是另一版」会一直存在。
  for (const source of RUNTIME_SOURCES) {
    const target = `${SCAFFOLD_DIR}/${source.replace(/^cloud\//, '')}`
    const shipped = files.find((file) => file.path === target)
    assert.ok(shipped !== undefined, `${target} is shipped`)
    assert.equal(shipped.content, readFileSync(new URL(`../lib/${source}`, import.meta.url), 'utf8'))
  }
  // 零依赖：脚手架不能引入任何包。
  for (const file of files.filter((entry) => entry.path.endsWith('.mjs') || entry.path.endsWith('.js'))) {
    const imports = [...file.content.matchAll(/from '([^']+)'/g)].map((match) => match[1])
    for (const specifier of imports) {
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('./'), `${file.path} must not import ${specifier}`)
    }
  }
  assert.deepEqual(JSON.parse(files.find((file) => file.path.endsWith('models.json')).content), ['m'])
  assert.equal(DEFAULT_CLOUD_PORT, 8794)
}

// --- 10. wrapInlineStage 产出合法 YAML 形状（缩进与块标量）-----------
{
  const yaml = wrapInlineStage('x', ['echo one', '', 'echo two'])
  const lines = yaml.split('\n')
  assert.equal(lines[0], '$:')
  assert.equal(lines[1], '  api_trigger:')
  assert.equal(lines[2], '    - stages:')
  assert.equal(lines[3], '        - name: x')
  assert.equal(lines[4], '          script: |')
  assert.ok(lines.slice(5).every((line) => line === '' || line.startsWith('            ')), 'every body line is indented')
}

// --- 11. 标记名与 serve.mjs 里真正打印的一致 ------------------------
{
  const serve = readFileSync(new URL('../lib/cloud/serve.mjs', import.meta.url), 'utf8')
  for (const name of Object.values(MARKERS)) {
    assert.ok(serve.includes(`marker('${name}'`), `serve.mjs prints ${name}`)
  }
}
