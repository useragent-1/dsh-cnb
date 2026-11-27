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
import { stripInlineToolCalls } from './model-guard.js'

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
  const raw_answer = lines.slice(beginLine + 1, endLine).join('\n').trim()
  if (raw_answer === '') return null
  /**
   * 和 gateway-proxy 一样：上游有时把工具调用写成内联标记塞进正文。
   * 这条路径没有 tools 定义，但模型仍可能模仿训练时的格式输出它，
   * 那对调用方来说是噪音，清掉。
   */
  return stripInlineToolCalls(raw_answer)
}

/**
 * 从构建日志里摘出容器报的错误。
 *
 * 和 `extractAnswer` 一样的坑：Runner 会把脚本原文回显进日志，
 * `echo "DSH_ASK_ERROR=$err"` 这一行本身也在里面。用正则找第一个
 * `DSH_ASK_ERROR=` 会命中回显，把字面量 `$err` 当成错误信息报给用户
 * —— 实测就是这样，界面显示 `容器里调用网关失败：$err"`，完全无法定位。
 *
 * 所以只认「行首是标记、且后面不是 `$` 开头的 shell 变量」的那一行。
 *
 * @param {string} text
 * @returns {string | null}
 */
export function extractAskError(text) {
  const clean = String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '')
  const lines = clean.split('\n').map((line) => line.replace(/^\s*Runner\[[^\]]*\]\[[^\]]*\]\s*/, '').trimEnd())
  for (const line of lines) {
    const at = line.indexOf('DSH_ASK_ERROR=')
    if (at < 0) continue
    const value = line.slice(at + 'DSH_ASK_ERROR='.length).trim().replace(/"$/, '')
    // 回显的那行是 `echo "DSH_ASK_ERROR=$err"` → 取值成 `$err"`，以 $ 开头就是它。
    if (value === '' || value.startsWith('$')) continue
    return value
  }
  return null
}

/** ---------------------------------------------------------------------------
 * 中继模式：把**整个 OpenAI 请求**送进容器，再把**原始 SSE**原样带回本机
 * ------------------------------------------------------------------------- */

/**
 * 日志里的分块标记。
 *
 * 为什么要分块 + base64：容器只留下构建日志这一条回传通道，而日志会被 Runner
 * 加颜色前缀、会被换行、还可能被中间层当成文本处理。base64 之后只剩 `[A-Za-z0-9+/=]`，
 * 怎么折行都不影响，解回来是字节级的原样。
 */
export const RELAY_BEGIN = 'DSH_RELAY_BEGIN'
export const RELAY_END = 'DSH_RELAY_END'
export const RELAY_ERROR_PREFIX = 'DSH_RELAY_ERROR='

/**
 * 生成「中继容器」脚本：curl 打上游 → 把原始 SSE 以 base64 吐进日志。
 *
 * 和 {@link buildAskScript} 的区别是**不在容器里解析**：
 *
 *   · 旧脚本用 awk 从 SSE 里抠 `"content":"…"`，于是 `tool_calls`、`usage`、
 *     `finish_reason` 全部被丢掉 —— 这就是「不能调工具、不能连续」的根；
 *   · 这里只搬字节，解析交给本机的 `aggregateSse`（它认得 tool_calls 分片、
 *     认得 DSML 内联调用、认得 usage）。容器里没有 python/jq，本来就不该它解析。
 *
 * 请求体在 Node 侧 `JSON.stringify` 一次成 JSON 再 base64，容器里只 `base64 -d`，
 * 不参与任何引号转义（早年 awk 拼 JSON 拼出过非法请求体，见 buildAskScript 注释）。
 *
 * @param {{ payload: Record<string, unknown>, timeoutSeconds?: number }} input
 * @returns {string}
 */
export function buildRelayScript(input) {
  const timeoutSeconds = input.timeoutSeconds ?? 360
  const payloadB64 = Buffer.from(JSON.stringify(input.payload), 'utf8').toString('base64')
  return [
    'set -u',
    'API=https://api.cnb.cool',
    '',
    '# 请求体由 Node 侧拼好（含 messages/tools/tool_choice）再 base64，容器只解码。',
    `PAYLOAD_B64='${payloadB64}'`,
    'payload=$(printf %s "$PAYLOAD_B64" | base64 -d)',
    '',
    '# -N：不要缓冲，SSE 逐行到达（-m 是硬上限，比本机轮询窗口小一点）。',
    'raw=$(curl -sS -m ' + timeoutSeconds + ' -N -X POST "$API/$CNB_REPO_SLUG/-/ai-ide/v2/chat/completions" \\',
    '  -H "Authorization: Bearer $CNB_TOKEN" -H "Content-Type: application/json" \\',
    '  -d "$payload" 2>&1)',
    '',
    'if [ -z "$raw" ]; then',
    '  echo "DSH_RELAY_ERROR=上游没有返回任何字节（curl 失败或超时）"',
    '  exit 1',
    'fi',
    '',
    '# 把原始 SSE 原样回传：base64 之后只剩字母数字，折行不影响还原。',
    'echo ' + RELAY_BEGIN,
    'printf %s "$raw" | base64',
    'echo ' + RELAY_END,
    '',
  ].join('\n')
}

/**
 * 从构建日志里取出原始 SSE。
 *
 * 两个必须绕开的坑（都在真机上踩过）：
 *   · Runner 会给每行加 ANSI 颜色与 `Runner[...]` 前缀；
 *   · 日志里**有脚本回显**，所以 `echo DSH_RELAY_BEGIN` 这一行本身也在，
 *     它的 trim 结果不是裸标记 —— 只认 trim 后恰好等于标记的行。
 *
 * @param {string} text
 * @returns {string | null} 原始 SSE 文本；没有标记时 null
 */
export function extractRelaySse(text) {
  const clean = String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '')
  const lines = clean
    .split('\n')
    .map((line) => line.replace(/^\s*Runner\[[^\]]*\]\[[^\]]*\]\s*/, '').trim())
  const from = lines.findIndex((line) => line === RELAY_BEGIN)
  if (from < 0) return null
  const to = lines.findIndex((line, index) => index > from && line === RELAY_END)
  if (to < 0) return null
  const encoded = lines.slice(from + 1, to).join('')
  if (encoded === '') return null
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8')
    return decoded === '' ? null : decoded
  } catch {
    return null
  }
}

/**
 * 从中继日志里取出容器报的错误。
 *
 * 和 `extractAskError` 同一套规则：日志里有 `echo "DSH_RELAY_ERROR=$x"` 的回显，
 * 那种行的取值以 `$` 开头，跳过。
 *
 * @param {string} text
 * @returns {string | null}
 */
export function extractRelayError(text) {
  const clean = String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '')
  for (const raw of clean.split('\n')) {
    const line = raw.replace(/^\s*Runner\[[^\]]*\]\[[^\]]*\]\s*/, '').trim()
    const at = line.indexOf(RELAY_ERROR_PREFIX)
    if (at < 0) continue
    const value = line.slice(at + RELAY_ERROR_PREFIX.length).trim().replace(/"$/, '')
    if (value === '' || value.startsWith('$')) continue
    return value
  }
  return null
}
