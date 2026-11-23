/**
 * `--patch` 挡住 configEditor 时，插件要自己落地，而不是把片段丢回给用户。
 *
 * 这条路径的存在理由是实测出来的层级关系：
 *
 *   `--patch` overlay  >  profile 的 cordis.patch.yml  >  各 bundle 的 patch
 *
 * `configEditor` 拒绝写在更高优先级层之下（这是对的：写进去也改不了行为）。
 * 但 profile 自己的 patch 层**由 HMR 监听**，一改就 recompose —— 所以插件可以
 * 写那一层，让云网关立即生效，不需要重启进程，也不需要用户手工合并片段。
 *
 * 两个必须钉住的细节：
 *   1. overlay 如果**已经**定义了这个路由，就不要抢 —— 那多半是有人特意配的；
 *   2. 写出来的 YAML 缩进必须对。provider 字段比路由名深一级，浅一格 YAML 仍能
 *      解析成「路由是 null」，热加载后模型选择器里什么都没有。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { importFromDsh } from './resolve-dsh.mjs'

const yaml = await importFromDsh('yaml', 'dist/index.js')
const OVERLAY = 'Configuration for "llm-pi-ai" is overridden by a home patch or command-line overlay'

/**
 * 一个写不动的 configEditor（模拟 --patch 接管），加一个临时 profile 目录。
 * @param {{ overlayFile?: string }} [options]
 */
const BASE_ARGV = [...process.argv]

function harness(options = {}) {
  process.argv = [...BASE_ARGV]
  const home = mkdtempSync(join(tmpdir(), 'dsh-cnb-profile-'))
  const dir = join(home, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  const patchFile = join(dir, 'cordis.patch.yml')
  writeFileSync(patchFile, [
    '# existing user layer',
    '- id: ui-settings-general',
    '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
    '  config:',
    '    welcomeNoticeVersion: 2026-09-28.1',
    '',
  ].join('\n'))
  const records = new Map([['dsh-cnb/cnb-token', { kind: 'grant', payload: { token: 'tok' } }]])
  const values = new Map()
  const credentials = {
    async readRecord(key) { return records.get(key) },
    async modifyRecord(key, mutate) { const next = await mutate(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key) },
    async deleteRecord(key) { records.delete(key) },
    async set(ref, value) { values.set(ref, value) },
    async unset(ref) { values.delete(ref) },
    async resolve(ref) { return values.has(ref) ? { value: values.get(ref) } : undefined },
  }
  const entries = [
    { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: {} } },
    { options: { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: {} } },
  ]
  const editor = {
    entries: () => entries,
    async edit() { throw new Error(OVERLAY) },
  }
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    get: (name) => {
      if (name === 'credentials') return credentials
      if (name === 'configEditor') return editor
      if (name === 'profileContext') return { dir }
      return undefined
    },
    inject() {},
    on() {},
  }
  // argv 是进程级的，测试之间不还原就会串味：这里记录并复原。
  // `process.argv` 是进程级的：一个测试往里 push 了 `--patch`，后面的测试都会被
  // 误判成「overlay 拥有这个路由」，于是 hotPath 直接短路。这里记录原值并在
  // 每个 harness 开头复原，保证测试之间不串味。
  if (options.overlayFile !== undefined) process.argv.push('--patch', options.overlayFile)
  return { api: apply(ctx, {}), patchFile, values }
}

// --- 1. overlay 挡住时，写进 profile patch 层并报告 hot ---------------
{
  const { api, patchFile, values } = harness()
  const result = await api.wireCloudProvider({
    repo: 'acme/gateway',
    baseURL: 'https://abc-8794.cnb.run/v1',
    key: 'dshgw_key_value',
    models: ['deepseek-v4.1-flash', 'glm-5.3-flash'],
    route: 'cnb-gateway',
    makeDefault: true,
  })
  assert.equal(result.written, true, 'the fallback counts as written')
  assert.equal(result.overridden, false, 'and it is not reported as blocked')
  assert.equal(result.hotPath.written, true)
  assert.match(result.hotPath.file, /profiles\/web\/cordis\.patch\.yml$/)
  assert.equal(values.get('DSH_CLOUD_GW_KEY'), 'dshgw_key_value', 'the key went to the credential store')
  assert.deepEqual(result.defaultModel, { provider: 'cnb-gateway', model: 'deepseek-v4.1-flash' })

  // 写出来的文件必须仍是合法 YAML，且原有条目没被破坏。
  const parsed = yaml.parse(readFileSync(patchFile, 'utf8'))
  assert.ok(Array.isArray(parsed), 'the patch layer stays a YAML list')
  const ids = parsed.map((row) => row.id)
  assert.ok(ids.includes('ui-settings-general'), 'the user own entry survives')
  assert.ok(ids.includes('llm-pi-ai'), 'the gateway route landed')
  assert.ok(ids.includes('agent-default-model'))

  // 缩进：provider 字段必须比路由名深一级，否则 YAML 会把路由解析成 null。
  const pi = parsed.find((row) => row.id === 'llm-pi-ai')
  const provider = pi.config.providers['cnb-gateway']
  assert.notEqual(provider, null, 'the route is a mapping, not null')
  assert.equal(provider.baseURL, 'https://abc-8794.cnb.run/v1')
  assert.equal(provider.apiKeyEnv, 'DSH_CLOUD_GW_KEY')
  assert.equal(provider.models.length, 2)
  assert.equal(provider.models[0].id, 'deepseek-v4.1-flash')
  // deepseek 家族按 256k 记：describeModel 对未知家族保守取 128k，已知家族给准值。
  assert.equal(provider.models[0].contextWindow, 256_000)

  const def = parsed.find((row) => row.id === 'agent-default-model')
  assert.equal(def.config.provider, 'cnb-gateway')
  assert.equal(def.config.model, 'deepseek-v4.1-flash')
}

// --- 2. 重写是幂等的：不会越写越长 --------------------------------
{
  const { api, patchFile } = harness()
  const input = {
    repo: 'acme/gateway',
    baseURL: 'https://abc-8794.cnb.run/v1',
    key: 'k',
    models: ['m1'],
    route: 'cnb-gateway',
    makeDefault: true,
  }
  await api.wireCloudProvider(input)
  const first = readFileSync(patchFile, 'utf8')
  await api.wireCloudProvider(input)
  const second = readFileSync(patchFile, 'utf8')
  assert.equal(second, first, 'a second run rewrites the managed block instead of appending')
  const occurrences = second.split('- id: llm-pi-ai').length - 1
  assert.equal(occurrences, 1, 'exactly one llm-pi-ai row')
}

// --- 3. overlay 已经定义了这个路由时不抢 ----------------------------
{
  const overlayFile = join(mkdtempSync(join(tmpdir(), 'dsh-overlay-')), 'cloud.yml')
  writeFileSync(overlayFile, '- id: llm-pi-ai\n  config:\n    providers:\n      cnb-gateway:\n        api: openai-completions\n')
  const { api, patchFile } = harness({ overlayFile })
  const before = readFileSync(patchFile, 'utf8')
  const result = await api.wireCloudProvider({
    repo: 'acme/gateway',
    baseURL: 'https://abc-8794.cnb.run/v1',
    key: 'k',
    models: ['m1'],
    route: 'cnb-gateway',
    makeDefault: true,
  })
  assert.equal(result.written, false, 'an overlay-owned route is left alone')
  assert.equal(result.hotPath.overlayOwnsRoute, true)
  assert.equal(readFileSync(patchFile, 'utf8'), before, 'nothing was written')
  assert.ok(typeof result.snippet === 'string' && result.snippet.includes('cnb-gateway'), 'the snippet is still offered')
}

// --- 4. 写新路由时，已有的兄弟 provider 必须保留 ---------------------
//
// patch 层对 `config` 是**整体赋值**（`target[key] = value`），不做深度合并。
// 所以只写 `providers: { cnb-gateway: … }` 会把同一层里原本的 `cnb` 整个抹掉。
// 实测踩过：部署里 overlay 定义 `cnb`、profile patch 只写 `cnb-gateway`，最终
// 组合里只剩后者，用户看到「我配的那个供应商不见了」。
{
  const { api, patchFile } = harness()
  // 先写一个别的路由（模拟上一次/用户自己加的）。
  await api.wireCloudProvider({
    repo: 'acme/one', baseURL: 'https://one.cnb.run/v1', key: 'k1',
    models: ['m1'], route: 'cnb-other', makeDefault: false,
  })
  // 再写云网关。
  const result = await api.wireCloudProvider({
    repo: 'acme/two', baseURL: 'https://two.cnb.run/v1', key: 'k2',
    models: ['m1'], route: 'cnb-gateway', makeDefault: true,
  })
  assert.equal(result.hotPath.written, true)
  assert.deepEqual(result.hotPath.preserved, ['cnb-other'], 'the sibling route is reported as preserved')

  const parsed = yaml.parse(readFileSync(patchFile, 'utf8'))
  const providers = parsed.find((row) => row.id === 'llm-pi-ai').config.providers
  assert.deepEqual(Object.keys(providers).sort(), ['cnb-gateway', 'cnb-other'], 'both routes survive')
  assert.equal(providers['cnb-other'].baseURL, 'https://one.cnb.run/v1', 'and the sibling keeps its own settings')
  assert.equal(providers['cnb-gateway'].baseURL, 'https://two.cnb.run/v1')
}

// --- 5. 重写同一个路由不会把它自己当兄弟保留（避免重复定义）---------
{
  const { api, patchFile } = harness()
  const input = { repo: 'a/b', baseURL: 'https://x/v1', key: 'k', models: ['m1'], route: 'cnb-gateway', makeDefault: false }
  await api.wireCloudProvider(input)
  const second = await api.wireCloudProvider({ ...input, baseURL: 'https://y/v1' })
  assert.deepEqual(second.hotPath.preserved, [], 'the route being rewritten is not duplicated')
  const parsed = yaml.parse(readFileSync(patchFile, 'utf8'))
  const providers = parsed.find((row) => row.id === 'llm-pi-ai').config.providers
  assert.deepEqual(Object.keys(providers), ['cnb-gateway'], 'exactly one route remains')
  assert.equal(providers['cnb-gateway'].baseURL, 'https://y/v1', 'and it holds the new value')
}

// --- 6. 模型条目只能用 pi-ai schema 认识的键 -------------------------
//
// pi-ai 的 `modelProfile` 只接受 id / name / contextWindow / maxTokens / input /
// reasoningEfforts / compat。写别的键（比如 `reasoning: true`）不会报错 ——
// schema 静默忽略 —— 于是「我明明标了推理模型」变成一句空话。实测踩过。
{
  const { api, patchFile } = harness()
  await api.wireCloudProvider({
    repo: 'a/b',
    baseURL: 'https://x/v1',
    key: 'k',
    // 一个普通模型 + 一个推理模型（describeModel 会给 reasoning: true）
    models: ['deepseek-v4.1-flash', 'hy4'],
    route: 'cnb-gateway',
    makeDefault: false,
  })
  const parsed = yaml.parse(readFileSync(patchFile, 'utf8'))
  const models = parsed.find((row) => row.id === 'llm-pi-ai').config.providers['cnb-gateway'].models
  const ALLOWED = new Set(['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat'])
  for (const model of models) {
    const unknown = Object.keys(model).filter((key) => !ALLOWED.has(key))
    assert.deepEqual(unknown, [], `${model.id} must not carry keys pi-ai silently drops`)
  }
  // 推理能力要真的落到 reasoningEfforts 上。
  const hy4 = models.find((model) => model.id === 'hy4')
  assert.ok(hy4.reasoningEfforts !== undefined, 'a reasoning model declares its efforts')
  assert.equal(hy4.reasoningEfforts.low, 'low')
  assert.equal(hy4.reasoningEfforts.high, 'high')
  assert.equal(hy4.reasoning, undefined, 'and not a field nobody reads')
}

// --- 7. overlay 里的 provider 必须被带进 profile patch ----------------
//
// patch 层对 `config` 是整体赋值：profile patch 一旦定义 `llm-pi-ai.providers`，
// overlay 那棵树就被替换。所以只写自己那一个路由，会让「装了插件以后我原来的
// 供应商不见了」。这里把 overlay 的 provider 一起写过去，保证是「加一个」。
//
// 这条是给**所有**下载本插件的人兜底的：他们的部署里大概率已经有一个
// 由自己的启动脚本生成的 `--patch`，其中定义着他们原来能用的 provider。
{
  const overlayDir = mkdtempSync(join(tmpdir(), 'dsh-overlay7-'))
  const overlayFile = join(overlayDir, 'deploy-model.yml')
  writeFileSync(overlayFile, [
    '- id: agent-default-model',
    '  config:',
    '    provider: local',
    '    model: "m"',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      local:',
    '        displayName: Local Proxy',
    '        api: openai-completions',
    '        baseURL: http://127.0.0.1:9999/v1',
    '        apiKeyEnv: LOCAL_KEY',
    '        compat:',
    '          thinkingFormat: openai',
    '          supportsReasoningEffort: true',
    '          maxTokensField: max_tokens',
    '        models:',
    '          - id: "m"',
    '            name: "M"',
    '            contextWindow: 1000000',
    '            maxTokens: 128000',
    '            reasoningEfforts:',
    '              low: low',
    '              high: high',
    '',
  ].join('\n'))
  const { api, patchFile } = harness({ overlayFile })
  const result = await api.wireCloudProvider({
    repo: 'acme/gw',
    baseURL: 'https://gw.cnb.run/v1',
    key: 'k',
    models: ['deepseek-v4.1-flash'],
    route: 'cnb-gateway',
    makeDefault: false,
  })
  assert.equal(result.written, true)
  assert.ok(result.hotPath.preserved.includes('local'), 'the deployment provider is reported as preserved')

  const parsed = yaml.parse(readFileSync(patchFile, 'utf8'))
  const providers = parsed.find((row) => row.id === 'llm-pi-ai').config.providers
  assert.ok(providers.local !== undefined, 'the deployment own provider survives')
  assert.equal(providers.local.baseURL, 'http://127.0.0.1:9999/v1')
  assert.equal(providers.local.apiKeyEnv, 'LOCAL_KEY')
  assert.equal(providers.local.models[0].id, 'm', 'including its model list')
  assert.equal(providers.local.models[0].contextWindow, 1000000, 'and its per-model metadata')
  assert.ok(providers.local.models[0].reasoningEfforts !== undefined, 'and its reasoning efforts')
  assert.ok(providers['cnb-gateway'] !== undefined, 'and the new route is added besides it')
}
