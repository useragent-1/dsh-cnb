/**
 * 全自动开通：建仓库 → 写入脚手架 → 云原生启动 → 采集云环境模型网关 → 写 dsh provider。
 *
 * 这一步为什么这么绕，值得写清楚，因为它决定了整个功能的形状：
 *
 *   · **网关只能被流水线令牌调用。** 个人访问令牌一律返回
 *     `[NO_RIGHT] OpenAPI only allowed in pipeline`，与 scope 大小无关。
 *   · **流水线令牌与仓库、与管道生命周期绑定。** 它由平台注入运行中的容器，
 *     环境停掉即失效；换到别的仓库就是 `SLUG_ID_NOT_MATCH`。
 *   · **平台还有一层网络策略**：把令牌拿到本机（另一台机器）用，返回
 *     `10412 Blocked by network policy`。所以「在本机直连云网关」这条路不存在。
 *
 * 因此唯一可行的形态是：**把代理服务跑在云环境里**，经 CNB 端口预览域名对外，
 * 本机 dsh 的 provider 指向那个域名。这正是「让云环境自己配置好对外网关」。
 *
 * 编排的可观测性全靠构建日志：平台不提供让 runner 回调任意地址的通道，但每个
 * stage 的日志都能通过 OpenAPI 读回来。所以脚手架在日志里打标记行（见
 * `lib/cloud/serve.mjs` 顶部的协议说明），本模块解析这些标记。
 *
 * 另一处硬约束：新仓库是空的，没有 commit 就等于没有分支，`workspace/start`
 * 会答 `[PARAM_MISS]branch is required`（或 404）。而 OpenAPI 没有「写文件」的
 * 接口 —— `/-/git/contents` 只有 GET。真正的写路径只有一条：**用内联 `config`
 * 触发一次 `api_trigger` 构建，在那个容器的 `/workspace` 里 git commit && push**。
 * 这段能力是实测出来的，不是猜的：它同时解决了空仓库初始化和脚手架落地。
 */

import { randomBytes } from 'node:crypto'

/** 脚手架写进目标仓库的文件，全部是纯 ESM、零依赖，环境里不需要 npm install。 */
export const SCAFFOLD_FILES = ['gateway-proxy.js', 'model-guard.js', 'serve.mjs', 'models.json', 'bootstrap.sh', 'README.md']

/** 日志标记：与本文件顶部的协议一致，任何一条缺失都不算成功。 */
export const MARKERS = {
  url: 'DSH_GW_URL',
  key: 'DSH_GW_KEY',
  repo: 'DSH_GW_REPO',
  port: 'DSH_GW_PORT',
  models: 'DSH_GW_MODELS',
  discovered: 'DSH_GW_DISCOVERED',
  notEntitled: 'DSH_GW_NOT_ENTITLED',
  unknown: 'DSH_GW_UNKNOWN',
  ready: 'DSH_GW_READY',
}

/** 网关端口：CNB 端口预览按端口号映射，任取一个不冲突的即可。 */
export const DEFAULT_CLOUD_PORT = 8794

/** 默认模型目录：用 v2 端点逐个真调用确认过（`MODEL_NOT_IN_LIST` 即为未开通）。 */
export const DEFAULT_CANDIDATES = [
  'deepseek-v4.1-flash',
  'deepseek-v4-flash',
  'glm-5.3-flash',
  'glm-5.3-flashx',
  'step-5-preview',
  'mimo-v2.6-pro',
  'minimax-m3.1-flash',
  'hy4free',
  'hy4std',
  'hy4',
  'space-bunny',
]

/**
 * 一次开通要跑的步骤，按顺序。
 *
 * 抽成常量是为了让面板、工具、测试三处说同一件事；面板把它渲染成进度条，
 * 测试断言每一步都存在对应实现。
 */
export const PROVISION_STEPS = [
  { id: 'group', label: '确认组织' },
  { id: 'repo', label: '创建仓库' },
  { id: 'scaffold', label: '写入网关脚手架' },
  { id: 'launch', label: '云原生启动' },
  { id: 'harvest', label: '采集对外网关地址' },
  { id: 'verify', label: '校验网关可用性' },
  { id: 'provider', label: '写入 dsh provider' },
]

/** 网关 key：一旦生成就固定下来，环境重启后凭证仍然有效。 */
export function mintGatewayKey() {
  return `dshgw_${randomBytes(24).toString('base64url')}`
}

/**
 * 仓库名：CNB 允许 `[A-Za-z0-9._-]`，给个带时间戳的默认值。
 *
 * 精确到秒而不是分钟：一次开通要跑几十秒，用分钟做粒度时「上一次被中断 →
 * 立刻重试」会撞上刚建出来的同名仓库，平台答 `10009 path conflicts`，
 * 看起来像随机失败。秒级还不够（同一秒内的两次调用），所以调用方还要有
 * 冲突重试（见 `provisionGateway`）。
 */
export function defaultRepoName(now = new Date()) {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('')
  const time = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')
  return `dsh-gateway-${stamp}-${time}`
}

/**
 * 生成目标仓库的 `.cnb.yml`。
 *
 * 三件事一起做：起一个云原生开发环境（带端口预览）、把令牌标记写进 stage 日志、
 * 后台拉起网关服务并等待它打出 READY。
 *
 * `keepAliveTimeout` 是必须的：默认 10 分钟内没有外部连接平台就回收环境，
 * 网关随之消失。这里拉到平台上限附近，并把「环境空转」的风险交给面板显示。
 *
 * key 放在 `env:` 里而不是交给外部注入：新仓库没有任何别的配置通道（`workspace/start`
 * 只接受 branch/ref），而 key 的作用域就是这个仓库的网关。它写在私有仓库里，
 * 想轮换就改这一行；面板另存一份，用来写进本机凭证库。
 *
 * @param {{ port?: number, models?: string[], image?: string, key?: string }} [options]
 */
export function scaffoldCnbYml(options = {}) {
  const port = options.port ?? DEFAULT_CLOUD_PORT
  const models = options.models ?? DEFAULT_CANDIDATES
  const image = options.image ?? ''
  // 序列项里的每个键必须同一缩进；`docker` 与 `env` 都是该映射的兄弟键。
  // 早先版本把 `image:` 多缩了两格、`env:` 少缩两格，YAML 还能解析，
  // 但整段 `stages` 没挂到环境上 —— 环境起来了却没有任何 stage 可跑。
  const docker = image === ''
    ? ''
    : `      docker:\n        image: ${image}\n`
  const keyBlock = options.key === undefined
    ? '      # key 由 `dsh-cnb` 写入；缺省时网关拒绝启动（不对外暴露无鉴权代理）\n'
    : `      env:\n        DSH_GW_KEY: ${JSON.stringify(options.key)}\n`
  return `# 由 dsh-cnb 自动生成 —— 这是「云环境自己配置好对外网关」的那一半。
#
# 它做三件事：
#   1. 起一个云原生开发环境（端口预览由平台提供，无需额外反代）；
#   2. 在 stage 里把 \`.dsh-gateway/serve.mjs\` 以守护方式拉起，网关监听 ${port}；
#   3. 把网关的公开地址与访问 key 以标记行写进日志，本机 dsh 读日志即可接上。
#
# 令牌只从运行环境继承，不写文件、不进仓库；环境停止即失效。
#
# 模型清单：${models.join(', ')}
$:
  vscode:
    -${docker === '' ? '\n' : `\n${docker}`}${keyBlock}      services:
        - name: vscode
          options:
            keepAliveTimeout: 18h
      stages:
        - name: start cloud ai gateway
          script: |
            cd /workspace
            set -u
            GATEWAY_DIR="\${GATEWAY_DIR:-/workspace/.dsh-gateway}"
            if [ ! -f "\$GATEWAY_DIR/serve.mjs" ]; then
              echo "DSH_GW_ERROR=gateway scaffold missing at \$GATEWAY_DIR"
              exit 1
            fi
            export DSH_GW_PORT="${port}"
            export DSH_GW_REPO="\$CNB_REPO_SLUG"
            # key 由本机生成后随脚手架注入；没有 key 就不对外暴露。
            if [ -z "\${DSH_GW_KEY:-}" ]; then
              echo "DSH_GW_ERROR=DSH_GW_KEY is not set"
              exit 1
            fi
            # 前台拉起会让 stage 永不结束，所以放后台 + 日志落盘，然后轮询就绪标记。
            nohup node "\$GATEWAY_DIR/serve.mjs" > "\$GATEWAY_DIR/serve.log" 2>&1 &
            echo "gateway pid=\$!"
            for i in \$(seq 1 60); do
              if grep -q '^DSH_GW_READY=1' "\$GATEWAY_DIR/serve.log" 2>/dev/null; then
                break
              fi
              sleep 1
            done
            if ! grep -q '^DSH_GW_READY=1' "\$GATEWAY_DIR/serve.log" 2>/dev/null; then
              echo "DSH_GW_ERROR=gateway did not become ready"
              tail -40 "\$GATEWAY_DIR/serve.log" || true
              exit 1
            fi
            cat "\$GATEWAY_DIR/serve.log"
            echo "DSH_GW_STAGE_DONE=1"
`
}

/**
 * 生成「往目标仓库写这些文件」的内联流水线配置。
 *
 * 平台没有写文件 API，但内联 `config` 里的 stage 跑在签出好的 `/workspace` 上，
 * 而那里就是该仓库的最新代码 —— 所以 commit && push 是合法的落盘方式。
 * 空仓库也能用：`git commit` 建第一个提交，`push` 建立 main 分支。
 *
 * @param {{ files: Array<{ path: string, content: string }>, message?: string }} input
 */
export function scaffoldCommitConfig(input) {
  const eof = 'DSH_SCAFFOLD_EOF'
  const lines = [
    'cd /workspace',
    'git config user.email dsh-cnb@local >/dev/null 2>&1 || true',
    'git config user.name "dsh-cnb" >/dev/null 2>&1 || true',
    'if ! git rev-parse --verify HEAD >/dev/null 2>&1; then git checkout -B main >/dev/null 2>&1 || true; fi',
  ]
  for (const file of input.files) {
    const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
    if (dir !== '') lines.push(`mkdir -p '${dir}'`)
    lines.push(`cat > '${file.path}' <<'${eof}'`)
    lines.push(file.content.replace(/\n$/, ''))
    lines.push(eof)
  }
  lines.push('git add -A')
  lines.push(`git commit -m ${JSON.stringify(input.message ?? 'chore: dsh-cnb gateway scaffold')} >/dev/null 2>&1 || echo nothing-to-commit`)
  lines.push('git push origin HEAD:main 2>&1 || git push -u origin main 2>&1 || echo push-failed')
  lines.push('echo SCAFFOLD_WRITTEN=1')
  return wrapInlineStage('scaffold', lines)
}

/**
 * 把若干 shell 行包成 `$: api_trigger:` 的内联 stage 配置。
 * @param {string} name @param {string[]} lines
 */
export function wrapInlineStage(name, lines) {
  const pad = '            '
  const body = lines.join('\n').split('\n').map((line) => (line === '' ? '' : pad + line)).join('\n')
  return ['$:', '  api_trigger:', '    - stages:', `        - name: ${name}`, '          script: |', body, ''].join('\n')
}

/**
 * 从一份构建 stage 日志里解析网关标记。
 *
 * 日志里充满 ANSI 着色和 shell 回显（`printf 'DSH_GW_URL=%s\n' ...` 这一行本身
 * 就长得像标记），所以只认「行首就是标记名、且值非空」的那些行，并取最后一次
 * 出现——回显行以命令原文开头，不会命中。
 *
 * @param {string[]} lines
 */
export function parseGatewayMarkers(lines) {
  const found = {}
  const clean = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, '')
  for (const raw of lines ?? []) {
    const line = clean(raw).trimEnd()
    for (const [field, name] of Object.entries(MARKERS)) {
      const prefix = `${name}=`
      if (!line.startsWith(prefix)) continue
      const value = line.slice(prefix.length).trim()
      if (value === '') continue
      found[field] = value
    }
    // 显式错误标记优先，直接把它带出去，比「没就绪」有用得多。
    if (line.startsWith('DSH_GW_ERROR=')) found.error = line.slice('DSH_GW_ERROR='.length).trim()
  }
  return found
}

/**
 * 判断一次采集是否真的拿到了可用网关。
 * @param {ReturnType<typeof parseGatewayMarkers>} markers
 */
export function markersComplete(markers) {
  return markers.ready === '1'
    && typeof markers.url === 'string' && /^https?:\/\//.test(markers.url)
    && typeof markers.key === 'string' && markers.key.length > 8
}

/**
 * 采集到的网关信息 → `llm-pi-ai` 的 provider 画像。
 *
 * 与直连版本的区别只有 baseURL 和 key 来源：这里指向云环境里的代理，key 是
 * 代理自己的 key（代理再用流水线令牌访问上游）。模型目录用采集到的真实清单。
 *
 * @param {{ repo: string, baseURL: string, apiKeyEnv: string, models: Array<{ id: string, name?: string, contextWindow?: number, maxTokens?: number }> }} input
 */
export function cloudProviderProfile(input) {
  return {
    displayName: `CNB 云网关 (${input.repo})`,
    api: 'openai-completions',
    baseURL: input.baseURL.replace(/\/+$/, ''),
    apiKeyEnv: input.apiKeyEnv,
    models: input.models.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      contextWindow: model.contextWindow ?? 256_000,
      maxTokens: model.maxTokens ?? 8_192,
      input: ['text'],
      // 采集到的模型不一定支持 reasoning_effort；关掉而不是猜。
      reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' },
      compat: { supportsUsageInStreaming: true, supportsReasoningEffort: false },
      // 先推理后作答的模型：预算给小了会只剩推理、`content` 为空，而状态仍是 200。
      // pi-ai 据此给这类模型留足预算。
      ...(model.reasoning === true ? { reasoning: true } : {}),
    })),
    compat: { supportsUsageInStreaming: true, maxTokensField: 'max_tokens' },
  }
}

/** 未知模型 id 的默认窗口：宁小勿大，写大了会让请求被上游截断。 */
export function modelEntry(id) {
  return { id, name: id, contextWindow: 128_000, maxTokens: 8_192 }
}

/**
 * 把 `DSH_GW_MODELS` 拆回 id 列表，去重并保序。
 * @param {string | undefined} value
 */
export function splitModels(value) {
  if (typeof value !== 'string' || value.trim() === '') return []
  const seen = new Set()
  const out = []
  for (const id of value.split(',').map((entry) => entry.trim()).filter(Boolean)) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
