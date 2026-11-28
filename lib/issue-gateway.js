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

/**
 * 模型档与**平台标价**。顺序即推荐顺序。
 *
 * ## 价格从哪来
 *
 * 取自 CNB 平台的模型选择面板（Issue 编辑器里 @npc/CodeBuddy 弹出的那份清单），
 * 那也是唯一的权威价目表 —— 上游 API 不回单价，只回 `usage.credit`，而那个字段
 * 在小请求上会取整成 0，据此判断「免费」是错的。
 *
 * ## 「免费」必须看单价，不能看 credit 读数
 *
 * 面板上标 `~¥0.00/MTok` 的两个才是真免费档：
 *
 *   hy4-flash            ~¥0.00/MTok
 *   deepseek-v4.1-flash  ~¥0.00/MTok
 *
 * 其余按标价计费（hy4 ~¥0.78、step-5-preview ~¥0.90、glm-5.3 ~¥2.82 …）。
 * 早先 `hy4` 的 label 写着「免费档」是错的 —— 它 ¥0.78 一档，真正免费的是
 * `hy4-flash`（注意是另一个模型，不是 hy4 的别名）。
 *
 * `pricePerMTok` 单位人民币元/百万 token，`null` 表示平台价目表未列出（VIP 或未开通）。
 * `tps` / `contextNote` 也照抄面板，方便选择时权衡速度与预算。
 */
export const FREE_MODELS = [
  {
    id: 'hy4-flash',
    label: '混元 hy4-flash（真免费档）',
    note: '平台标价 ~¥0.00/MTok；带 tools 时工具参数偶有截断，代理会修',
    pricePerMTok: 0,
    tps: 196,
    free: true,
  },
  {
    id: 'hy4',
    label: '混元 hy4',
    note: '实测可用；hy4free 那个名字不存在（hy4 与 hy4-flash 是两个模型）',
    pricePerMTok: 0.78,
    tps: 128,
    free: false,
  },
  {
    id: 'hy4std',
    label: '混元 hy4 标准档',
    note: '与 hy4 同源',
    pricePerMTok: 0.78,
    tps: 128,
    free: false,
  },
  {
    id: 'deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash（真免费档）',
    note: '上下文 1M；平台标价 ~¥0.00/MTok',
    pricePerMTok: 0,
    tps: 218,
    free: true,
  },
  {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    note: '输出预算较小（50k）；同族，按 flash 档计费',
    pricePerMTok: 0,
    tps: 218,
    free: true,
  },
  {
    id: 'glm-5.3-flash',
    label: 'GLM 5.3 Flash',
    note: '实测可用',
    pricePerMTok: 0.27,
    tps: 59,
    free: false,
  },
  {
    id: 'glm-5.3-flashx',
    label: 'GLM 5.3 FlashX（VIP）',
    note: 'VIP 档；组织未开通时答 MODEL_NOT_AVAILABLE_FOR_ORG',
    pricePerMTok: 0.68,
    tps: 122,
    free: false,
    vip: true,
  },
  {
    id: 'glm-5.4',
    label: 'GLM 5.4（VIP）',
    note: 'VIP 档，价目表列 ~¥2.73/MTok',
    pricePerMTok: 2.73,
    tps: 83,
    free: false,
    vip: true,
  },
  {
    id: 'glm-5.3',
    label: 'GLM 5.3（VIP）',
    note: 'VIP 档，价目表列 ~¥2.82/MTok',
    pricePerMTok: 2.82,
    tps: 87,
    free: false,
    vip: true,
  },
  {
    id: 'space-bunny',
    label: 'Space Bunny',
    note: '支持到 xhigh 档',
    pricePerMTok: 0.36,
    tps: 177,
    free: false,
  },
  {
    id: 'step-5-preview',
    label: 'Step 5 Preview',
    note: '推理较长，预算要给足',
    pricePerMTok: 0.9,
    tps: 89,
    free: false,
  },
  {
    id: 'mimo-v2.6-pro',
    label: 'MiMo V2.6 Pro',
    note: '小米',
    pricePerMTok: 0.27,
    tps: 69,
    free: false,
  },
  {
    id: 'minimax-m3.1-flash',
    label: 'MiniMax M3.1 Flash',
    note: '实测可用',
    pricePerMTok: null,
    tps: null,
    free: false,
  },
]

/** 真正免费的档（平台的 `~¥0.00/MTok`）。面板据此加绿色标记。 */
export const FREE_TIER_IDS = FREE_MODELS.filter((entry) => entry.free === true).map((entry) => entry.id)

/**
 * 单价 → 人话。面板直接显示这一行。
 *
 * 单价为 0 就明说「免费」，别用「便宜」含糊；`null` 要说清是「价目表未列出」，
 * 而不是 0 —— 把未知当免费是最坏的误导。
 * @param {{ pricePerMTok?: number | null, vip?: boolean }} entry
 * @returns {string}
 */
export function billingLabel(entry) {
  const price = entry?.pricePerMTok
  if (price === 0) return '免费（~¥0.00/MTok）'
  if (price === null || price === undefined) return '计费（价目表未列出单价）'
  const text = `计费 ~¥${price.toFixed(2)}/MTok`
  return entry?.vip === true ? `${text}，VIP 档` : text
}

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
