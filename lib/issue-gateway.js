/**
 * Issue 网关：用仓库的 Issue 驱动模型，再把结果反代成 OpenAI 兼容接口。
 *
 * ## 为什么要这一层
 *
 * CNB 的 AI 网关只接受**流水线令牌**，而流水线令牌只在一次构建/开发环境里被注入。
 * 之前的「云网关」是靠常驻一个云原生开发环境拿到它 —— 那要一直占着一台环境。
 *
 * 还有一条更省的路：**Issue 事件本身就是流水线触发器**。仓库里开一个 Issue，
 * 平台立刻起一个一次性容器跑 stage，那个容器里就有 `CNB_TOKEN`，它能直连
 * `/-/ai-ide/v2/chat/completions`。实测确认（2026-11-23）：
 *
 *   token len: 27
 *   data: {"model":"deepseek-v4.1-flash",...,"content":"","finish_reason":"stop"}
 *
 * 也就是说：**不需要常驻环境，也能拿到模型访问权**，代价是每次调用要等一次
 * 容器调度（数十秒级）。
 *
 * ## 这个模块负责什么
 *
 * 它不是「让 Issue 变快」——那做不到，容器冷启动就是慢。它负责把这条慢路径
 * 包装成**说得清、能验、可复用**的东西：
 *
 *   1. 生成 issue 触发器的 `.cnb.yml` 段（含免费模型白名单）；
 *   2. 把一次问答落成 Issue（标题=问题，正文=占位），并给出轮询协议；
 *   3. 定义结果回写格式，让本机能把答案读回来。
 *
 * ## 免费模型
 *
 * 实测上游真实可用（`/-/ai-ide/v2` 逐个探测）：
 *
 *   ✓ hy4          ← 免费档（腾讯混元），实测可用
 *   ✓ deepseek-v4.1-flash
 *   ✓ deepseek-v4-flash
 *   ✓ glm-5.3-flash / step-5-preview / space-bunny / mimo-v2.6-pro / minimax-m3.1-flash
 *   ✗ hy4free      ← **不存在**，上游答 `model-unknown`
 *   ✗ hy3 / hy3free / deepseek-v3.2
 *
 * 所以「hy4free」这个名字是错的，正确的是 `hy4`。这一点值得单独写出来，
 * 因为照着错名字配只会得到一堆 `model-unknown`。
 */

/** 实测可用的免费/低成本档。顺序即推荐顺序。 */
export const FREE_MODELS = [
  { id: 'hy4', label: '混元 hy4（免费档）', note: '实测可用，非流式被拒所以必须 stream' },
  { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', note: '上下文 1M，性价比档' },
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', note: '输出预算较小（50k）' },
]

/** 实测**不存在**的名字，配了只会得到 model-unknown。 */
export const NONEXISTENT_MODELS = ['hy4free', 'hy3', 'hy3free', 'deepseek-v3.2']

/** Issue 里的结果标记：本机靠它从正文里识别答案。 */
export const RESULT_MARKER = '<!-- dsh-issue-gateway:result -->'
/** 处理中标记，避免重复消费同一个 Issue。 */
export const PENDING_MARKER = '<!-- dsh-issue-gateway:pending -->'

/**
 * 生成 issue 触发器的 `.cnb.yml` 片段。
 *
 * 关键点：
 *   · 必须挂在 `$` 下（平台要求，挂在别处不会触发）；
 *   · 上游只支持流式，所以脚本里要聚合 SSE；
 *   · 结果回写成 Issue 评论，用 `RESULT_MARKER` 包住，本机据此摘取。
 *
 * 容器里没有 python（实测），所以聚合只用 awk。
 *
 * @param {{ models?: string[], maxTokens?: number, image?: string, defaultModel?: string }} [input]
 * @returns {{ yml: string, models: string[] }}
 */
export function issueGatewayConfig(input = {}) {
  const models = input.models !== undefined && input.models.length > 0
    ? input.models
    : FREE_MODELS.map((model) => model.id)
  const maxTokens = input.maxTokens ?? 4_000
  const defaultModel = input.defaultModel ?? models[0]
  const image = input.image ?? ''

  const script = [
    'set -u',
    'API=https://api.cnb.cool',
    `DEFAULT_MODEL="${defaultModel}"`,
    `MAX_TOKENS=${maxTokens}`,
    '',
    '# 从 Issue 标题取问题；没有就用正文首行。',
    'question="${CNB_ISSUE_TITLE:-}"',
    '[ -z "$question" ] && question="${CNB_ISSUE_BODY:-}"',
    'echo "question: $question"',
    '',
    '# 允许 Issue 里用 [model=xxx] 指定模型，但只接受白名单内的。',
    'model="$DEFAULT_MODEL"',
    'want=$(printf "%s" "$question" | sed -n "s/.*\\[model=\\([a-zA-Z0-9._-]*\\)\\].*/\\1/p")',
    `for allowed in ${models.join(' ')}; do`,
    '  [ "$want" = "$allowed" ] && model="$allowed"',
    'done',
    'echo "model: $model"',
    '',
    '# 上游只支持流式（非流式答 11101），所以这里发 stream:true 再把 delta 拼起来。',
    '# 只用 awk 聚合 —— 镜像里没有 python，用 python 会让整段静默失效。',
    'req=$(printf \'{"model":"%s","stream":true,"messages":[{"role":"user","content":%s}],"max_tokens":%s}\' \\',
    '  "$model" "$(printf "%s" "$question" | awk \'{gsub(/\\\\/,"\\\\\\\\");gsub(/"/,"\\\\\\"");printf "\\"%s\\"",$0}\')" "$MAX_TOKENS")',
    '',
    'answer=$(curl -sS -m 300 -N -X POST "$API/$CNB_REPO_SLUG/-/ai-ide/v2/chat/completions" \\',
    '  -H "Authorization: Bearer $CNB_TOKEN" -H "Content-Type: application/json" \\',
    '  -d "$req" \\',
    '  | awk \'',
    '      /^data: / {',
    '        line = substr($0, 7)',
    '        if (line == "[DONE]") next',
    '        # 只取 content 字段，跳过 reasoning_content。',
    '        if (match(line, /"content":"[^"]*"/)) {',
    '          s = substr(line, RSTART + 11, RLENGTH - 12)',
    '          gsub(/\\\\n/, "\\n", s)',
    '          gsub(/\\\\"/, "\\"", s)',
    '          printf "%s", s',
    '        }',
    '      }\')',
    '',
    'if [ -z "$answer" ]; then',
    '  answer="(网关没有返回内容；可能是模型名不在白名单，或上游拒绝。见 stage 日志。)"',
    'fi',
    'echo "--- answer ---"',
    'printf "%s\\n" "$answer"',
    '',
    '# 回写成评论，本机在轮询时按 marker 摘取。',
    `body=$(printf "%s\\n\\n%s\\n\\n%s" "${RESULT_MARKER}" "$answer" "model: $model")`,
    'curl -sS -m 60 -X POST "$API/$CNB_REPO_SLUG/-/issues/$CNB_ISSUE_NUMBER/comments" \\',
    '  -H "Authorization: Bearer $CNB_TOKEN" -H "Content-Type: application/json" \\',
    '  --data-binary "$(printf \'{"body":%s}\' "$(printf "%s" "$body" | awk \'{gsub(/\\\\/,"\\\\\\\\");gsub(/"/,"\\\\\\"");printf "\\"%s\\"",$0}\')")" \\',
    '  > /dev/null && echo "comment posted" || echo "comment failed" >&2',
    '',
  ].join('\n')

  const lines = [
    '# 由 dsh-cnb 生成：Issue 驱动模型（issue 事件触发一次性容器，用完即走）。',
    '#',
    '# 为什么这样做：AI 网关只接受流水线令牌，而流水线令牌只在容器里被注入。',
    '# Issue 事件本身就能起容器，所以「开个 Issue」等价于「借一个能用模型的容器」，',
    '# 不需要常驻云环境。代价是每次要等一次容器调度（数十秒）。',
    '#',
    '# 免费档实测可用：hy4、deepseek-v4.1-flash、deepseek-v4-flash。',
    '# 注意 hy4free 并不存在（上游答 model-unknown），正确的是 hy4。',
    '$:',
    '  issue.open:',
    '    - name: issue gateway (open)',
  ]
  if (image !== '') lines.push('      docker:', `        image: ${image}`)
  lines.push('      stages:', '        - name: answer via ai gateway', '          script: |')
  for (const line of script.split('\n')) lines.push(line === '' ? '' : `            ${line}`)
  lines.push(
    '  issue.comment:',
    '    - name: issue gateway (comment)',
  )
  if (image !== '') lines.push('      docker:', `        image: ${image}`)
  lines.push('      stages:', '        - name: answer via ai gateway', '          script: |')
  for (const line of script.split('\n')) lines.push(line === '' ? '' : `            ${line}`)
  return { yml: `${lines.join('\n')}\n`, models }
}

/**
 * 从 Issue 评论里摘出答案。
 *
 * @param {Array<{ body?: string, created_at?: string }>} comments
 * @returns {{ found: boolean, answer: string | null, model: string | null }}
 */
export function readIssueAnswer(comments) {
  const list = Array.isArray(comments) ? comments : []
  // 取**最后一条**带标记的：同一个 Issue 可能被评论多次，最新的才有意义。
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const body = typeof list[i]?.body === 'string' ? list[i].body : ''
    const at = body.indexOf(RESULT_MARKER)
    if (at < 0) continue
    const rest = body.slice(at + RESULT_MARKER.length).trim()
    const modelMatch = /\nmodel:\s*(\S+)\s*$/.exec(rest)
    const answer = (modelMatch === null ? rest : rest.slice(0, modelMatch.index)).trim()
    return { found: true, answer: answer === '' ? null : answer, model: modelMatch === null ? null : modelMatch[1] }
  }
  return { found: false, answer: null, model: null }
}
