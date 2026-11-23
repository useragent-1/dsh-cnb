/**
 * 云环境里的网关服务入口（脚手架生成后放进目标仓库）。
 *
 * 它做四件事，全部只依赖本文件与同目录的模块，不装任何 npm 包：
 *
 *   1. **发现模型**：上游没有清单接口，所以拿 `models.json` 里的候选逐个真调用，
 *      按错误码分类（`MODEL_NOT_IN_LIST` / `MODEL_NOT_AVAILABLE_FOR_ORG` / 200）。
 *      这一步在环境启动时做一次，结果随标记回传 —— 于是「有哪些模型」是从这台
 *      机器实测出来的，不是写死在插件里的表；
 *   2. 在本机端口上起一个 OpenAI 兼容代理（`gateway-proxy.js`），把 CNB 网关的
 *      11288 / 11128 指纹拦截、只认流式、错误码翻译这些脾气磨平；
 *   3. 把端口经 CNB 端口预览域名对外暴露（平台自动映射，无需额外配置）；
 *   4. 用**约定好的标记行**把公开地址、访问 key 与真实模型清单写进构建日志。
 *
 * 标记协议（远端按行解析，任何一个缺失都不算成功）：
 *
 *   DSH_GW_URL=<https://...-PORT.cnb.run/v1>
 *   DSH_GW_KEY=<随机 key>
 *   DSH_GW_REPO=<group/name>
 *   DSH_GW_PORT=<port>
 *   DSH_GW_MODELS=<以逗号分隔、实测可用的模型 id>
 *   DSH_GW_READY=1
 *
 * 令牌只从环境变量读，不落盘、不进日志。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GatewayProxy } from './gateway-proxy.js'
import { discoverModels, resolveModelCatalog } from './model-catalog.js'

const here = dirname(fileURLToPath(import.meta.url))
const env = process.env
const port = Number(env.DSH_GW_PORT ?? 8794)
const host = env.DSH_GW_HOST ?? '0.0.0.0'
const token = (env.CNB_TOKEN ?? env.CNB_API_TOKEN ?? env.CNB_GATEWAY_TOKEN ?? '').trim()
const repo = env.DSH_GW_REPO || env.CNB_REPO_SLUG || env.CNB_REPO_PATH || ''
const key = (env.DSH_GW_KEY ?? '').trim()
/**
 * 探测开关：`DSH_GW_DISCOVER=off` 时直接用候选表。
 *
 * 保留它是因为探测会对每个候选发一次真实调用 —— 极端情况下（组织额度紧张、
 * 或只想让网关立刻可用）可以关掉，代价是清单可能包含不可用的模型。
 */
const discover = (env.DSH_GW_DISCOVER ?? 'on').toLowerCase() !== 'off'
const modelFile = join(here, 'models.json')
const marker = (name, value) => console.log(`${name}=${value}`)

if (token === '') {
  console.error('[dsh-gateway] CNB_TOKEN is missing: this must run inside a CNB cloud environment')
  process.exit(1)
}
if (key === '') {
  console.error('[dsh-gateway] DSH_GW_KEY is missing: refusing to expose an unauthenticated proxy')
  process.exit(1)
}
if (repo === '') {
  console.error('[dsh-gateway] DSH_GW_REPO is missing: the gateway is always repository-scoped')
  process.exit(1)
}

/** 候选模型 id：探测的输入，不是「可用清单」。 */
let candidates = []
try {
  const parsed = JSON.parse(readFileSync(modelFile, 'utf8'))
  if (Array.isArray(parsed)) candidates = parsed.map((id) => String(id).trim()).filter(Boolean)
} catch {
  candidates = []
}

const proxy = new GatewayProxy({
  port,
  host,
  apiKey: key,
  resolve: async () => ({ token, repo }),
  log: (line) => console.error(`[dsh-gateway] ${line}`),
})
proxy.setModels(candidates)

const publicBase = (() => {
  const template = env.CNB_VSCODE_PROXY_URI ?? ''
  if (!template.includes('{{port}}')) return ''
  return template.replace('{{port}}', String(port)).replace(/\/+$/, '')
})()

/**
 * 先在「端口已监听」这个事实之后才探测：外壳能连上时，日志里的地址就已经可用了。
 * 探测失败不阻塞启动 —— 网关仍然要能服务用户手动点名的模型。
 */
await proxy.start()

let catalog = candidates
let discovery = null
if (discover && candidates.length > 0) {
  try {
    const result = await discoverModels({ token, repo, ids: candidates, concurrency: 8 })
    discovery = {
      available: result.available.length,
      notEntitled: result.notEntitled,
      unknown: result.unknown,
      probed: result.probed,
    }
    // 点名的候选优先，实测可用的补齐；一个都探不通时退回候选表，让网关至少可用。
    catalog = resolveModelCatalog({ requested: candidates, discovered: result.available, fallback: candidates })
    // 上游对「目录里但没有额度」的模型也返回 403，写进 provider 只会得到必然失败的
    // 选项；把它们从对外清单里剔掉，但保留在日志里以便解释。
    const denied = new Set([...result.notEntitled, ...result.unknown])
    catalog = catalog.filter((id) => !denied.has(id))
    if (catalog.length === 0) catalog = candidates
    proxy.setModels(catalog)
    console.error(`[dsh-gateway] discovery: ${result.available.length}/${result.probed} available`
      + (result.notEntitled.length > 0 ? `, not-entitled: ${result.notEntitled.join(',')}` : '')
      + (result.unknown.length > 0 ? `, unknown: ${result.unknown.join(',')}` : ''))
  } catch (error) {
    console.error(`[dsh-gateway] discovery failed, falling back to the candidate list: ${error?.message ?? error}`)
  }
}

marker('DSH_GW_REPO', repo)
marker('DSH_GW_PORT', String(port))
marker('DSH_GW_URL', publicBase === '' ? `http://127.0.0.1:${port}` : `${publicBase}/v1`)
marker('DSH_GW_KEY', key)
marker('DSH_GW_MODELS', catalog.join(','))
// 探测结论单独一行：远端想解释「为什么少了某个模型」时不必去翻日志。
if (discovery !== null) {
  marker('DSH_GW_DISCOVERED', `${discovery.available}/${discovery.probed}`)
  if (discovery.notEntitled.length > 0) marker('DSH_GW_NOT_ENTITLED', discovery.notEntitled.join(','))
  if (discovery.unknown.length > 0) marker('DSH_GW_UNKNOWN', discovery.unknown.join(','))
}
marker('DSH_GW_READY', '1')

// 让 stage 不退出：容器里前台进程结束，环境就被回收，反代也就没了。
const keepAlive = setInterval(() => {}, 1 << 30)
const shutdown = () => {
  clearInterval(keepAlive)
  void proxy.stop().then(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
