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
    '# 组装请求体。JSON 里的引号转义交给 awk 做，避免手拼出错。',
    'payload=$(printf "%s" "$question" | awk -v model="$MODEL" -v max="$MAX_TOKENS" \'',
    '  { gsub(/\\\\/, "\\\\\\\\"); gsub(/"/, "\\\\\\""); gsub(/\\t/, " ")',
    '    printf "{\\"model\\":\\"%s\\",\\"stream\\":true,\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"%s\\"}],\\"max_tokens\\":%s}", model, $0, max }',
    '\')',
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
    '  echo "DSH_ASK_ERROR=$(printf "%s" "$raw" | head -c 400 | tr "\\n" " ")"',
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
