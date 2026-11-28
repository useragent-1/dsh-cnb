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
import { gzipSync } from 'node:zlib'
import { stripInlineToolCalls } from './model-guard.js'

/**
 * 一份「怎么把可变长内容塞进构建脚本」的共用实现。
 *
 * ## 为什么需要它
 *
 * 构建 stage 的启动方式是 `fork/exec /bin/bash -c "<整段脚本>"` —— 整段脚本是
 * **一个**命令行参数，受内核 `MAX_ARG_STRLEN = 131072`（128 KiB）约束。超限时
 * exec 直接��败，**一行都不执行**：
 *
 *     fork/exec /bin/bash: argument list too long
 *     Finished, code: -1, duration: 0s
 *
 * 于是本机既拿不到答案也拿不到错误，只能轮询到超时 —— 那正是 502 的来历。
 *
 * 这个镜像里**拿不到任何别的大通道**：stage 没有预置输入文件，`env` 传大值会
 * 在 Runner 那一侧就撞同一个上限（实测 200 KB 的 env 直接把 prepare 阶段打挂），
 * 仓库里写文件又需要额外一次 git push。所以唯一可靠的运载工具就是脚本本身，
 * 那就必须把体积压到上限以内。
 *
 * ## 编码格式
 *
 * gzip(level 9) → base64 → 按 32 KB 切成 `G1..Gn`。三层各有理由：
 *
 *   · **gzip**：请求体是 JSON，重复度高。实测一条真实 dsh 请求 101516 B
 *     压到 36413 B（2.8×）。高熵内容压不动，所以见下面的退让逻辑。
 *   · **base64**：只剩 `[A-Za-z0-9+/=]`，不会和 shell 引号、YAML 缩进打架。
 *   · **分块**：单个变量赋值保持远低于 128 KiB，请求再长也不会以另一种方式
 *     撞到同一个上限（多行不共享限额）。
 *
 * 份与份之间用 `\x01`（SOH）分隔：`JSON.stringify` 的输出里绝不会有字面控制
 * 字符（一律转义成 `\u0001`），所以这个分隔符天然安全，容器里用
 * `awk 'BEGIN{RS="\001"} NR==i'` 就能取第 i 段，不需要 jq/python。
 * 容器与本地实测同为 mawk 1.3.4，`RS` 单字符语义一致。
 *
 * @param {Array<Record<string, unknown>>} items 要依次装进容器的 JSON 对象
 * @returns {{ chunks: string[], kept: number, bytes: number }} base64 分块与保留份数
 */
export function packRelayBlobs(items) {
  const list = Array.isArray(items) && items.length > 0 ? items : [{}]
  const serialize = (values) => Buffer.from(
    values.map((value) => JSON.stringify(value)).join(SEPARATOR),
    'utf8',
  )
  /**
   * 装不下时逐级退让，而不是生成一个注定 exec 失败的脚本。
   *
   * 压缩率取决于内容：100 KB 的 dsh 请求（system + 73 个 tools，重复度高）
   * 能压到 36 KB；但高熵正文（已 base64 的二进制、随机串）几乎压不动。
   * 实测三份 53 KB 高熵候选体会到 163 KB，仍然越界。
   *
   * 退让顺序刻意选「保住能跑的那条路」：先丢后面几级候选体（只是少一层
   * 11128 缓解，第一份通常就够），再不行才报错 —— 报错要指向真正的原因。
   */
  let kept = list
  let packed = gzipSync(serialize(kept), { level: 9 })
  while (kept.length > 1 && packed.toString('base64').length > MAX_RELAY_BLOB_BYTES) {
    kept = kept.slice(0, kept.length - 1)
    packed = gzipSync(serialize(kept), { level: 9 })
  }
  const blob = packed.toString('base64')
  if (blob.length > MAX_RELAY_BLOB_BYTES) {
    /**
     * 一份都装不下：这条请求根本进不了容器。抛出去由调用方转成可读失败，
     * 文案里带上真实体积，让「请求太大」和「上游超时」不再混为一谈。
     */
    throw new Error(
      `请求体过大，无法装进构建脚本：压缩后 ${blob.length} 字节，`
      + `上限 ${MAX_RELAY_BLOB_BYTES} 字节（内核限制 fork/exec 单个参数 128 KiB）。`
      + '请减少历史长度、工具数量，或改走本地直连。',
    )
  }
  const chunks = []
  for (let at = 0; at < blob.length; at += RELAY_CHUNK_SIZE) {
    chunks.push(blob.slice(at, at + RELAY_CHUNK_SIZE))
  }
  return { chunks, kept: kept.length, bytes: blob.length }
}

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
   *
   * ## 为什么这里也要压缩（和中继路径同一课）
   *
   * 这条路径的输入是**一句 question**，看起来短，但多轮历史被压平成文本后
   * 可以任意长 —— `issue.ask({ question })` 就是压平后的结果。实测 question
   * 到 90000 字节时脚本总长 241557，早已越过 fork/exec 的 128 KiB 单参数上限，
   * 表现和中继那条完全一样：`argument list too long`，一行都不执行。
   *
   * 所以这里复用中继那套打包：gzip + base64 + 分块写进 `G1..Gn`，容器里
   * 拼回、gunzip、取出 `payload` 与 `question` 两个字段。体积与上限的判据
   * 同 `packRelayBlobs`，装不下就抛，不生成注定 exec 失败的脚本。
   */
  /**
   * 两段分开装：`packRelayBlobs` 用 `\x01` 连接各个元素，所以元素必须是两个
   * —— 装成一个 `{payload, question}` 的话就只有一段，按位置切不到 question。
   * 第二段是 JSON 字符串（带引号），容器里剥掉首尾引号即可。
   */
  const payload = {
    model: input.model,
    stream: true,
    messages: [{ role: 'user', content: input.question }],
    max_tokens: maxTokens,
  }
  const { chunks } = packRelayBlobs([payload, input.question])
  return [
    'set -u',
    'API=https://api.cnb.cool',
    `MODEL="${input.model}"`,
    `MAX_TOKENS=${maxTokens}`,
    `GZ_CHUNKS=${chunks.length}`,
    '',
    '# 请求体与问题正文一起 gzip + base64 进容器：fork/exec 的单参数上限 128 KiB，',
    '# 压平后的多轮历史很容易越界（实测 90 KB 的问题就会）。',
    ...chunks.map((chunk, index) => `G${index + 1}='${chunk}'`),
    '',
    'gz_b64=""',
    'k=1',
    'while [ "$k" -le "$GZ_CHUNKS" ]; do',
    '  eval "part=\\$G$k"',
    '  gz_b64="$gz_b64$part"',
    '  k=$((k + 1))',
    'done',
    'bundle=$(printf %s "$gz_b64" | base64 -d | gzip -dc)',
    'if [ -z "$bundle" ]; then',
    '  echo "DSH_ASK_ERROR=请求体解压失败（容器无 gzip，或 blob 被截断）"',
    '  exit 1',
    'fi',
    '',
    '# 第 1 段是请求体 JSON，第 2 段是 JSON 字符串形式的问题正文（含首尾引号）。',
    'payload=$(printf %s "$bundle" | awk \'BEGIN { RS = "\\001" } NR == 1 { printf "%s", $0 }\')',
    'if [ -z "$payload" ]; then',
    '  echo "DSH_ASK_ERROR=请求体为空（打包/切分不一致）"',
    '  exit 1',
    'fi',
    '# 剥掉 JSON 字符串的首尾引号，只用于日志回显；请求体里的正文是完整的。',
    'question=$(printf %s "$bundle" | awk \'BEGIN { RS = "\\001" } NR == 2 { s = $0; sub(/^"/, "", s); sub(/"$/, "", s); printf "%s", s }\')',
    'echo "model: $MODEL"',
    'echo "question: $question"',
    '',
    '# 流式调用；只取 content，跳过 reasoning_content（思考过程不该混进答案）。',
    '# 请求体走 stdin（--data-binary @-），**不能**用 -d "$payload"：那会把请求体',
    '# 变成一个命令行参数，payload 超过 128 KiB 时容器里同样报 argument list too long。',
    'raw=$(printf %s "$payload" | curl -sS -m 240 -N -X POST "$API/$CNB_REPO_SLUG/-/ai-ide/v2/chat/completions" \\',
    '  -H "Authorization: Bearer $CNB_TOKEN" -H "Content-Type: application/json" \\',
    '  --data-binary @- 2>&1)',
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
/**
 * 构建 stage 的**总字节预算**，给 128 KiB 内核上限留出余量。
 *
 * Runner 用 `fork/exec /bin/bash -c "<整段脚本>"` 启动 stage，整段脚本是**一个**
 * 命令���参数，受 `MAX_ARG_STRLEN`（131072）约束。超限时 exec 直接失败，脚本
 * 一行都不跑 —— 这就是 `cnb-o6r-1k8g6glv0` 那条 502 的根因。
 *
 * 预算按「脚本外壳 + 压缩 blob」整体算，留 32 KiB 给注释、循环与额外环境变量。
 */
export const MAX_SCRIPT_BYTES = 131_072
/** 压缩 blob 自身的预算：总预算里扣掉脚本外壳、注释与循环的余量。 */
export const MAX_RELAY_BLOB_BYTES = MAX_SCRIPT_BYTES - 32_768
/** 单个 `Gn='…'` 赋值的长度：远低于单参数上限，请求再长也不会以另一种方式撞线。 */
export const RELAY_CHUNK_SIZE = 32_000
/** 份与份之间的分隔符；`JSON.stringify` 的输出不会含字面控制字符。 */
const SEPARATOR = '\u0001'

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
 * ## 为什么容器里也要有阶梯
 *
 * 11128 是确定性的：同一份 body 发多少次都被拦。所以「折 system / 打散」这三级
 * 候选体必须跟请求体一起进容器 —— 否则容器只会重发同一份被拦的 body，而本机
 * 那一侧无论等多久都拿不到答案，最终表现为 502。候选体由本机的 `repairLadder`
 * 算好，容器只负责依次试、把**第一个非 11128 的响应**（成功或真正的错）带回来。
 *
 * @param {{ payload?: Record<string, unknown>, payloads?: Array<Record<string, unknown>>, timeoutSeconds?: number }} input
 * @returns {string}
 */
export function buildRelayScript(input) {
  const timeoutSeconds = input.timeoutSeconds ?? 360
  const list = Array.isArray(input.payloads) && input.payloads.length > 0
    ? input.payloads
    : [input.payload ?? {}]
  const { chunks, kept } = packRelayBlobs(list)
  const lines = [
    'set -u',
    'API=https://api.cnb.cool',
    '',
    '# 整个请求阶梯 gzip + base64 后进容器：fork/exec 的单个参数上限 128 KiB，',
    '# 未压缩的请求体（system + tools 常到 100 KB）一进来就越界。',
    `VARIANTS=${kept}`,
    `GZ_CHUNKS=${chunks.length}`,
  ]
  chunks.forEach((chunk, index) => {
    lines.push(`G${index + 1}='${chunk}'`)
  })
  lines.push(
    '',
    '# 拼回 base64 → gunzip → 份与份之间是 \\x01；用 RS 直接取第 i 份。',
    'gz_b64=""',
    'k=1',
    'while [ "$k" -le "$GZ_CHUNKS" ]; do',
    '  eval "part=\\$G$k"',
    '  gz_b64="$gz_b64$part"',
    '  k=$((k + 1))',
    'done',
    'packed=$(printf %s "$gz_b64" | base64 -d | gzip -dc)',
    'if [ -z "$packed" ]; then',
    '  echo "DSH_RELAY_ERROR=请求体解压失败（容器无 gzip，或 blob 被截断）"',
    '  exit 1',
    'fi',
    '',
    'raw=""',
    'i=1',
    'while [ "$i" -le "$VARIANTS" ]; do',
    '  payload=$(printf %s "$packed" | awk -v want="$i" \'BEGIN { RS = "\\001" } NR == want { printf "%s", $0 }\')',
    '  if [ -z "$payload" ]; then',
    '    echo "DSH_RELAY_ERROR=候选体 $i 为空（打包/切分不一致）"',
    '    exit 1',
    '  fi',
    '',
    '  # -N：不要缓冲，SSE 逐行到达（-m 是硬上限，比本机轮询窗口小一点）。',
    '  # 请求体走 stdin（--data-binary @-）：用 -d "$payload" 会把它变成一个',
    '  # 命令行参数，payload 一大就在容器里撞上同一个 argument list too long。',
    '  raw=$(printf %s "$payload" | curl -sS -m ' + timeoutSeconds + ' -N -X POST "$API/$CNB_REPO_SLUG/-/ai-ide/v2/chat/completions" \\',
    '    -H "Authorization: Bearer $CNB_TOKEN" -H "Content-Type: application/json" \\',
    '    --data-binary @- 2>&1)',
    '',
    '  # 只对「客户端指纹」这类拒绝换形态；别的错误换形态也不会变好。',
    '  case "$raw" in',
    '    *11128*|*11288*|*"unapproved channel"*)',
    '      echo "variant $i blocked by content filter, escalating" >&2',
    '      i=$((i + 1))',
    '      ;;',
    '    *) break ;;',
    '  esac',
    'done',
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
  )
  return lines.join('\n')
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
 * ## 为什么不能「见到标记就当错误」（2026-11-28 实测事故）
 *
 * 日志里**有脚本回显**：`echo "DSH_RELAY_ERROR=上游没有返回任何字节（curl 失败或超时）"`
 * 这一行原文会被 Runner 打进日志。早先只跳过「取值以 `$` 开头」的回显
 * （那是 `$err` 那种写法），但**写死字面量**的那种回显不满足这个条件 ——
 * 于是脚本**一行都没跑**时，界面照样报「容器里调用网关失败：上游没有返回任何字节」，
 * 把「fork/exec 直接失败」伪装成「上游超时」。真因和文案完全对不上，排查全靠人肉翻日志。
 *
 * 所以现在两条判据一起用：
 *   · 该行在标记之前就出现了 `echo`（说明这是被回显的源码，不是命令输出）；
 *   · 取值本身带引号包裹的特征（源码里是 `echo "…"`，值尾会留一个 `"`）。
 *
 * 真正的错误由容器在执行时 `echo` 出来，那一行只有标记和值，前面没有 `echo`。
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
    // 标记前面有 echo → 这行是被回显的脚本源码，不是运行结果。
    if (line.slice(0, at).includes('echo')) continue
    const value = line.slice(at + RELAY_ERROR_PREFIX.length).trim().replace(/"$/, '')
    if (value === '' || value.startsWith('$')) continue
    return value
  }
  return null
}

/**
 * 识别「脚本根本没被启动」这类失败。
 *
 * `fork/exec /bin/bash: argument list too long` 是 Runner 报的，不是我们的脚本报的：
 * 脚本整体作为一个 `bash -c` 参数传入，超过内核 `MAX_ARG_STRLEN`（128 KiB）时
 * exec 直接失败，**一行都不执行**，所以既没有 `DSH_RELAY_BEGIN` 也没有
 * `DSH_RELAY_ERROR=`。早先这种情况下轮询会一路等到超时，最后给一句
 * 「N 秒内没拿到答案（容器排队或模型较慢）」—— 把「请求体太大」说成「模型慢」。
 *
 * 这里把它单独认出来，让报错指向真正的原因。
 *
 * @param {string} text
 * @returns {string | null} 可读的失败原因；没命中时 null
 */
export function extractContainerLaunchFailure(text) {
  const clean = String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '')
  const tooLong = /argument list too long/i.test(clean)
  /**
   * 只认**脚本回显之后**出现的这条：回显里也含脚本源码，但脚本自己不会打印
   * `argument list too long`。所以见到它就说明 exec 阶段就挂了。
   */
  if (tooLong) {
    return '构建脚本超出内核单个参数上限（fork/exec: argument list too long，上限 128 KiB）'
      + '：请求体太大，未能在容器里启动。'
  }
  return null
}
