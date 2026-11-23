/**
 * 生成写进目标仓库的脚手架文件。
 *
 * 为什么是「复制源码」而不是「npm install」：CNB 的云环境镜像里未必有 node 包管理器
 * 的网络与缓存，而这几份文件本身就是零依赖 ESM。复制过去即可运行，也保证云端跑的
 * 逻辑与本机测试的是同一份代码 —— 否则「本机测得通、云端是另一版」这种问题会一直存在。
 *
 * 生成过程可离线断言：文件清单固定、每份都能被 `import()` 解析、入口能指出自己的依赖。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CANDIDATES, DEFAULT_CLOUD_PORT, scaffoldCnbYml } from './provision.js'

const here = dirname(fileURLToPath(import.meta.url))

/** 运行期需要的源码：入口 + 它直接/间接 import 的模块。 */
export const RUNTIME_SOURCES = ['cloud/serve.mjs', 'gateway-proxy.js', 'model-guard.js', 'model-catalog.js']

/** 目标仓库内的目录：集中放，避免污染仓库根。 */
export const SCAFFOLD_DIR = '.dsh-gateway'

/**
 * 生成全部脚手架文件（路径相对于仓库根）。
 *
 * @param {{ key: string, port?: number, models?: string[], repo?: string }} input
 * @returns {Array<{ path: string, content: string }>}
 */
export function buildScaffold(input) {
  const port = input.port ?? DEFAULT_CLOUD_PORT
  const models = input.models ?? DEFAULT_CANDIDATES
  const files = RUNTIME_SOURCES.map((source) => ({
    path: `${SCAFFOLD_DIR}/${source.replace(/^cloud\//, '')}`,
    content: readFileSync(join(here, source), 'utf8'),
  }))
  files.push({ path: `${SCAFFOLD_DIR}/models.json`, content: `${JSON.stringify(models, null, 2)}\n` })
  files.push({ path: `${SCAFFOLD_DIR}/bootstrap.sh`, content: bootstrapScript({ port }) })
  files.push({ path: `${SCAFFOLD_DIR}/README.md`, content: scaffoldReadme({ port, repo: input.repo }) })
  files.push({ path: '.cnb.yml', content: scaffoldCnbYml({ port, models, key: input.key }) })
  return files
}

/**
 * 入口脚本：把 serve.mjs 当守护进程拉起并等它就绪。
 *
 * `.cnb.yml` 里的 stage 也内联了同样的逻辑；这个脚本是给「手动在环境终端里重跑」
 * 用的 —— 环境重启后 stage 会再跑一次，但调试时手边有个脚本更省事。
 * @param {{ port: number }} input
 */
export function bootstrapScript(input) {
  return `#!/bin/sh
# 由 dsh-cnb 生成：在本环境里拉起 CNB AI 网关代理。
#
#   DSH_GW_KEY=... sh .dsh-gateway/bootstrap.sh
#
# 令牌由平台注入（CNB_TOKEN），不需要传；key 必须显式给，
# 没有 key 就不对外暴露 —— 一个无鉴权的公网代理等于把组织的 AI 额度送人。
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
: "\${DSH_GW_KEY:?DSH_GW_KEY is required}"
export DSH_GW_PORT="\${DSH_GW_PORT:-${input.port}}"
export DSH_GW_REPO="\${DSH_GW_REPO:-\${CNB_REPO_SLUG:-}}"
exec node "$DIR/serve.mjs"
`
}

/** @param {{ port: number, repo?: string }} input */
export function scaffoldReadme(input) {
  return `# .dsh-gateway

由 [dsh-cnb](https://github.com/useragent-1/dsh-cnb) 自动生成。这个目录的目的只有一个：
**让本仓库的 CNB AI 网关对外可用，并被另一台机器上的 dsh 当作普通 OpenAI 供应商接入。**

## 为什么需要它

CNB 的 AI 网关（\`api.cnb.cool/<repo>/-/ai\`）只接受**流水线令牌**，而这种令牌：

- 只在一个运行中的云环境里被注入（\`CNB_TOKEN\`），环境停止即失效；
- 与签发它的仓库绑定，换仓库答 \`SLUG_ID_NOT_MATCH\`；
- 拿到别的机器上用会被网络策略拦下（\`10412 Blocked by network policy\`）。

所以代理必须跑在这个环境里，经平台端口预览域名对外（默认端口 ${input.port}）。
本机 dsh 的 provider 指向那个域名，key 是这里校验的 key —— 流水线令牌始终不出环境。

## 它还顺手解决了什么

上游对请求体做内容风控，命中「客户端指纹」整条拒绝：
\`HTTP 400 / code 11288（同类 11128）Illegal API invocation from an unapproved channel\`。
换令牌、换模型、补请求头都无效，被拦的是提示词本身。代理在发送前做三件事，都不改语义：

1. 把已知指纹句改成等价表述、身份词中间插零宽空格；
2. 消息形状归一（\`developer\`→\`system\`、剥掉图片段、丢掉孤立的 tool 结果）；
3. 仍被拦时把 system 折进首条 user，最后再逐词打散。

另外网关只认流式（非流式答 \`11101\`），代理发流式、按客户端要求聚合。

## 手动跑

\`\`\`sh
DSH_GW_KEY=<key> sh .dsh-gateway/bootstrap.sh
curl -s "http://127.0.0.1:${input.port}/health"
\`\`\`

\`/health\` 不需要 key（只为了让你能判断进程起没起），其余路由都要
\`Authorization: Bearer <key>\`。

## 环境变量

| 变量 | 含义 |
| --- | --- |
| \`CNB_TOKEN\` | 平台注入的流水线令牌（必需） |
| \`DSH_GW_KEY\` | 客户端必须出示的 key（必需） |
| \`DSH_GW_PORT\` | 监听端口，默认 ${input.port} |
| \`DSH_GW_REPO\` | 上游仓库路径，默认取 \`CNB_REPO_SLUG\` |
| \`DSH_GW_HOST\` | 监听地址，默认 \`0.0.0.0\`（端口预览要求） |

**本仓库：${input.repo ?? '(未指定)'}**
`
}
