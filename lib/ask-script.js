/**
 * 把「借一次性容器问模型」这件事的脚本部分单独拿出来。
 *
 * 为什么值得单独一个文件：这段要在**云端容器**里跑，而容器里没有 python、
 * 没有 jq，只有 sh + awk + curl。混在 index.js 里既不好读，也没法单独做
 * shell 语法检查（`sh -n`）—— 而 YAML 里嵌 shell 出错时极难发现。
 */

/**
 * 生成容器里执行的脚本：流式调网关 → 用 awk 聚合 SSE → 打印带标记的答案。
 *
 * 两个必须遵守的约束（都实测过）：
 *   · 上游**只支持流式**，非流式答 `11101 Non-stream chat request is currently not supported`；
 *   · 容器里**没有 python**，聚合只能用 awk。
 *
 * @param {{ model: string, question: string, maxTokens?: number }} input
 * @returns {string}
 */
export function buildAskScript(input) {
  const maxTokens = input.maxTokens ?? 4_000
  /**
   * 请求体在 **Node 侧**就拼成完整 JSON，再 base64 传进容器。
   *
   * 之前是在容器的 awk 里拼的，碰到三层转义（shell 单引号 → awk 字符串 → JSON），
   * 实测拼出来是非法 JSON：`Unexpected non-whitespace character after JSON at
   * position 105`。那种错误在日志里只看到上游的 400，很难反推出是转义问题。
   *
   * 交给 `JSON.stringify` 一次就对，shell 里只需 `base64 -d`，不参与转义。
   */
  const payloadB64 = Buffer.from(JSON.stringify({
    model: input.model,
    stream: true,
    messages: [{ role: 'user', content: input.question }],
    max_tokens: maxTokens,
  }), 'utf8').toString('base64')
  return [
    'set -u',
    'API=https://api.cnb.cool',
    `MODEL="${input.model}"`,
    `MAX_TOKENS=${maxTokens}`,
    '',
    '# 问题正文由 Node 侧以 base64 传入，避免任何引号/换行的转义问题。',
    `QUESTION_B64="${Buffer.from(input.question, 'utf8').toString('base64')}"`,
    'question=$(printf "%s" "$QUESTION_B64" | base64 -d)',
    'echo "model: $MODEL"',
    'echo "question: $question"',
    '',
    '# 请求体已由 Node 侧拼好并以 base64 传入（见函数开头）。',
    `PAYLOAD_B64="${payloadB64}"`,
    'payload=$(printf "%s" "$PAYLOAD_B64" | base64 -d)',
    '',
    '# 流式调用；只取 content，跳过 reasoning_content（思考过程不该混进答案）。',
    'raw=$(curl -sS -m 240 -N -X POST "$API/$CNB_REPO_SLUG/-/ai-ide/v2/chat/completions" \\',
    '  -H "Authorization: Bearer $CNB_TOKEN" -H "Content-Type: application/json" \\',
    '  -d "$payload" 2>&1)',
    '',
    'answer=$(printf "%s" "$raw" | awk \'',
    '  /^data: / {',
    '    line = substr($0, 7)',
    '    if (line == "[DONE]") next',
    '    if (match(line, /"content":"[^"]*"/)) {',
    '      s = substr(line, RSTART + 11, RLENGTH - 12)',
    '      gsub(/\\\\n/, "\\n", s)',
    '      gsub(/\\\\"/, "\\"", s)',
    '      gsub(/\\\\t/, "\\t", s)',
    '      printf "%s", s',
    '    }',
    '  }\')',
    '',
    'if [ -z "$answer" ]; then',
    '  # 把上游原始响应带出来，否则「为什么没答案」无从查起。',
    '  # 先算到变量再输出：直接嵌在双引号里会被外层引号吃掉，',
    '  # 结果就是把 $(...) 原样当成错误文本（实测踩过）。',
    '  err=$(printf "%s" "$raw" | head -c 400 | tr "\\n" " ")',
    '  echo "DSH_ASK_ERROR=$err"',
    '  exit 1',
    'fi',
    '',
    'echo "DSH_ASK_BEGIN"',
    'printf "%s\\n" "$answer"',
    'echo "DSH_ASK_END"',
    '',
  ].join('\n')
}

/**
 * 从构建日志里摘出答案。
 *
 * 用成对标记而不是「取最后一行」：日志里混着 Runner 的彩色前缀、echo 回显、
 * 以及模型自己可能输出的换行 —— 只有标记之间的部分才是干净的。
 *
 * @param {string} text
 * @returns {string | null}
 */
export function extractAnswer(text) {
  const raw = String(text ?? '')
  // Runner 会给每行加 ANSI 颜色，先剥掉，否则标记匹配不上。
  const clean = raw.replace(/\u001b\[[0-9;]*m/g, '')
  /**
   * 必须**按行**找标记，不能 indexOf 第一次出现。
   *
   * Runner 会把脚本原文也回显进日志（`echo "DSH_ASK_BEGIN"` 那一行本身），
   * 所以第一次出现的标记其实是回显的源码，它后面跟着的是剩下的脚本文本
   * —— 实测拿回来的就是 `printf "%s\n" "$answer"` 这一行源码。
   *
   * 真标记一定独占一行（可能带 Runner 的彩色前缀），所以只认 trim 后
   * 恰好等于标记的行。
   */
  const lines = clean.split('\n').map((line) => line.replace(/^\s*Runner\[[^\]]*\]\[[^\]]*\]\s*/, '').trimEnd())
  const beginLine = lines.findIndex((line) => line.trim() === 'DSH_ASK_BEGIN')
  if (beginLine < 0) return null
  const endLine = lines.findIndex((line, index) => index > beginLine && line.trim() === 'DSH_ASK_END')
  if (endLine < 0) return null
  const answer = lines.slice(beginLine + 1, endLine).join('\n').trim()
  return answer === '' ? null : answer
}
