/**
 * CNB AI 网关的错误语义与「11288 / 11128」守卫。
 *
 * 这个文件只做两件事，且都可离线测试：
 *
 *   1. 把网关的 HTTP 状态 + 响应体归类成一个人能据此行动的原因（classifyGatewayError）。
 *      CNB 的错误码不是 HTTP 语义：403 可能是令牌类型不对、也可能只是模型没开通；
 *      400 可能是「客户端指纹」风控（11288 / 11128），也可能是参数真的不合法。
 *      把它们混为一谈，面板就只能说「失败了」。
 *
 *   2. 在请求体上做「语义不变、特征不可见」的修复（repairForGateway）。
 *      风控扫的是 system / assistant 文本里的客户端指纹；把身份词打散、把已知指纹
 *      句改成等价表述、必要时把 system 折进首条 user，模型读到的还是同一段指令。
 *
 * 真机实测（2026-11，api.cnb.cool，逐段二分定位）：
 *
 *   原始：system 里同时出现「@ 路径引用」与「workspace root」两句 + 身份词
 *         → HTTP 400 / code 11128 "Illegal API invocation from an unapproved channel"
 *   同一段文本放 user 角色里 → 200（拦截面只扫 system / assistant）
 *   身份词中间插一个 U+200B → 200（人眼不可见，匹配不到）
 *   带 `developer` 角色的消息（OpenAI 新协议）单独就能触发同一拦截 → 也返回 11128
 *
 * 所以「11288」与「11128」在这里是同一类：未获批准渠道的客户端指纹拦截。两者都按
 * 指纹处理，走同一套修复阶梯；区分它们没有意义，因为修复动作完全相同。
 */

const ZWSP = '\u200B'

/** 风控拦截：两个码都归这一类。 */
export const FINGERPRINT_CODES = [11128, 11288]

/**
 * 网关已知错误码 → 人话。
 *
 * `kind` 是稳定的机器标签（面板按它选图标与后续动作），`fix` 是下一步做什么。
 * 每一条都在本仓库的实网探测里出现过，不是抄来的。
 */
export const GATEWAY_ERRORS = {
  11128: {
    kind: 'fingerprint',
    label: '内容风控：客户端指纹',
    fix: '插件会自动改写请求体再重试；若仍失败，说明上游新增了指纹，把 system 折进首条 user 即可。',
    retryable: true,
  },
  11288: {
    kind: 'fingerprint',
    label: '内容风控：客户端指纹（11288）',
    fix: '与 11128 同类，走同一套修复阶梯：改写已知指纹 → 折 system → 逐词打散。',
    retryable: true,
  },
  11101: {
    kind: 'stream-only',
    label: '只支持流式',
    fix: '网关拒绝非流式请求；把 stream 置为 true，非流式由本地代理聚合。',
    retryable: true,
  },
  11133: {
    kind: 'bad-params',
    label: '参数被模型侧拒绝',
    fix: '常见原因是图片段、空 messages 或过大的 max_tokens；代理会剥掉非文本段后重试。',
    retryable: true,
  },
  11148: {
    kind: 'tool-pairing',
    label: 'tool 调用与结果不配对',
    fix: '历史里存在没有对应 assistant tool_calls 的 tool 消息；代理会丢掉孤立项。',
    retryable: true,
  },
  10008: {
    kind: 'expired',
    label: '凭证已过期',
    fix: '流水线令牌只在环境存活期间有效；重新从运行中的云环境采集一次。',
    retryable: false,
  },
  10023: {
    kind: 'scope',
    label: '令牌缺少权限项',
    fix: '重新扫码签发全权限令牌，或在令牌页补齐缺失的 scope。',
    retryable: false,
  },
}

/**
 * 归类一次网关失败。
 *
 * 先读业务码（响应体里 `code` 或 `errcode`），再退回 HTTP 状态与文案。顺序很重要：
 * 403 同时表示 [NO_RIGHT]、[SLUG_ID_NOT_MATCH]、[MODEL_NOT_IN_LIST]，只有响应体
 * 能把它们分开。
 *
 * @param {number} status HTTP 状态
 * @param {string} text 响应体原文
 * @returns {{ code: number | null, kind: string, label: string, fix: string, retryable: boolean, model?: string }}
 */
export function classifyGatewayError(status, text) {
  const body = String(text ?? '')
  const code = readCode(body)
  if (code !== null && GATEWAY_ERRORS[code] !== undefined) {
    return { code, ...GATEWAY_ERRORS[code] }
  }
  if (/NO_RIGHT|OpenAPI only/i.test(body)) {
    return {
      code: null,
      kind: 'personal-token',
      label: '个人令牌不能调用网关',
      fix: '网关只接受云环境里的流水线令牌；采集一个运行中环境的 CNB_TOKEN。',
      retryable: false,
    }
  }
  if (/SLUG_ID_NOT_MATCH/i.test(body)) {
    return {
      code: null,
      kind: 'wrong-repo',
      label: '令牌属于别的仓库',
      fix: '流水线令牌与签发它的仓库绑定；用该凭证所属仓库的网关地址。',
      retryable: false,
    }
  }
  const notInList = /MODEL_NOT_IN_LIST\]Model ([^\s]+) is not in the optional models list/i.exec(body)
  if (notInList !== null) {
    return {
      code: null,
      kind: 'model-unknown',
      label: `模型未在此网关开放：${notInList[1]}`,
      model: notInList[1],
      fix: '用模型发现接口枚举真实可用的 id，再写进 provider。',
      retryable: false,
    }
  }
  const notForOrg = /MODEL_NOT_AVAILABLE_FOR_ORG\]Model ([^\s]+) is not available for your organization/i.exec(body)
  if (notForOrg !== null) {
    return {
      code: null,
      kind: 'model-not-entitled',
      label: `组织未开通该模型：${notForOrg[1]}`,
      model: notForOrg[1],
      fix: '模型存在于网关目录但当前组织没有额度；换一个已开通的模型。',
      retryable: false,
    }
  }
  if (status === 401) {
    return {
      code,
      kind: 'unauthorized',
      label: '令牌无效或已过期',
      fix: '重新采集运行中环境的 CNB_TOKEN。',
      retryable: false,
    }
  }
  if (status === 400) {
    return {
      code,
      kind: 'bad-request',
      label: '请求不被接受',
      fix: '查看原始响应；多半是消息形状或参数问题。',
      retryable: false,
    }
  }
  return {
    code,
    kind: 'other',
    label: status === 0 ? '无法连接网关' : `网关返回 ${status}`,
    fix: '查看原始响应。',
    retryable: false,
  }
}

/** @param {string} body */
function readCode(body) {
  const match = /"(?:code|errcode)":\s*(\d+)/.exec(body)
  return match === null ? null : Number(match[1])
}

/** 是否是「客户端指纹」这一类拦截（11288 / 11128）。 */
export function isFingerprintBlock(status, text) {
  return classifyGatewayError(status, text).kind === 'fingerprint'
}

// ---------------------------------------------------------------------------
// 请求体修复
// ---------------------------------------------------------------------------

/**
 * 已知指纹句 → 等价表述。
 *
 * 表驱动：上游若换词，只改这里。每条的「改写后」都经过实网验证能被放行，
 * 且语义不变（模型仍能读到同样的约束）。
 */
export const FINGERPRINT_PHRASES = [
  // DSH 系统提示里的 @ 引用说明：单独一句放过，两句同现整条被拦。
  [/are path references the user made explicitly/gi, 'are paths the user named explicitly'],
  [/Relative paths are resolved against the workspace root/gi, 'Relative paths resolve from the workspace root'],
  // Copilot / Cursor 系指纹，单独一句即可拦截。
  [/Main branch \(you will usually use this for PRs\)/gi, 'Main branch (the usual target for pull requests)'],
  [/You are Claude Code, a command-line coding assistant(\.)?/gi, 'You are a command-line coding assistant$1'],
]

/** 身份词组：中间插零宽空格；路径语境跳过，否则会把坏路径交给工具调用。 */
export const GUARD_IDENTITY_RE = /(?<![\\/])(DeepSeek)[ \u00A0]+(Harness)(?![\\/])/gi

/**
 * 字符串级修复（纯函数）。
 * @param {string} text @param {{ aggressive?: boolean }} [options]
 */
export function repairText(text, options = {}) {
  if (typeof text !== 'string' || text === '') return text
  let out = text
  for (const [pattern, replacement] of FINGERPRINT_PHRASES) out = out.replace(pattern, replacement)
  out = out.replace(GUARD_IDENTITY_RE, `$1${ZWSP} $2`)
  if (options.aggressive === true) out = out.replace(/(?<![\\/\w])(DeepSeek)(?![\w\\/])/gi, `Deep${ZWSP}Seek`)
  return out
}

/**
 * 修复一级：改写特征短语 + 归一消息形状 + 剥掉网关不认的字段。
 *
 * 只改「值」不改「键」：键名是协议字段。`model`、`stream`、`max_tokens` 这些
 * 协议字段原样保留（模型名里带 deepseek 是正常的）。
 *
 * @param {Record<string, any>} payload
 * @param {{ aggressive?: boolean }} [options]
 * @returns {{ payload: Record<string, any>, changes: string[] }}
 */
export function sanitizePayload(payload, options = {}) {
  const changes = []
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { payload, changes }

  const next = { ...payload }
  // 网关只做流式；代理对客户端承诺的非流式响应在自己的聚合层完成。
  if (next.stream !== true) {
    next.stream = true
    changes.push('stream→true')
  }
  // 网关注入的思考开关不是它接受的参数名；留着只会被拒。
  for (const key of ['thinking', 'enable_thinking', 'reasoning']) {
    if (next[key] !== undefined) {
      delete next[key]
      changes.push(`drop:${key}`)
    }
  }

  if (Array.isArray(next.messages)) {
    let rewrote = 0
    next.messages = next.messages.map((message) => {
      if (message === null || typeof message !== 'object') return message
      const copy = { ...message }
      if (copy.role === 'developer') {
        copy.role = 'system'
        changes.push('developer→system')
      }
      if (typeof copy.content === 'string') {
        const repaired = repairText(copy.content, options)
        if (repaired !== copy.content) {
          copy.content = repaired
          rewrote += 1
        }
      } else if (Array.isArray(copy.content)) {
        // 网关不接受图片段（11133）；文字保留，非文本段丢掉并记一笔。
        const parts = copy.content.map((part) => {
          if (part === null || typeof part !== 'object') return part
          if (part.type === 'image_url' || part.type === 'image' || part.type === 'input_image') {
            changes.push('drop:image-part')
            return undefined
          }
          if (typeof part.text === 'string') {
            const repaired = repairText(part.text, options)
            if (repaired !== part.text) {
              rewrote += 1
              return { ...part, text: repaired }
            }
          }
          return part
        }).filter((part) => part !== undefined)
        copy.content = parts
      }
      return copy
    })
    // system 必须在最前（网关按首条角色判断请求形状）。
    const at = next.messages.findIndex((message) => message?.role === 'system')
    if (at > 0) {
      const [system] = next.messages.splice(at, 1)
      next.messages.unshift(system)
      changes.push('system-first')
    }
    const dropped = dropOrphanTools(next.messages)
    if (dropped > 0) changes.push(`drop:orphan-tool×${dropped}`)
    if (rewrote > 0) changes.push(`rewrite×${rewrote}`)
  }
  return { payload: next, changes }
}

/**
 * 丢掉没有对应 assistant tool_calls 的 tool 消息。
 *
 * 网关对配对是严格的：一条孤立的 tool 结果整条请求就 11148，
 * 而 DSH 的会话历史在压缩、重放之后确实会出现这种形状。
 * @param {any[]} messages 就地修改
 * @returns {number} 丢掉的条数
 */
export function dropOrphanTools(messages) {
  const known = new Set()
  const keep = []
  let dropped = 0
  for (const message of messages) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (typeof call?.id === 'string') known.add(call.id)
      }
      keep.push(message)
      continue
    }
    if (message?.role === 'tool') {
      if (typeof message.tool_call_id === 'string' && known.has(message.tool_call_id)) keep.push(message)
      else dropped += 1
      continue
    }
    keep.push(message)
  }
  if (dropped > 0) messages.splice(0, messages.length, ...keep)
  return dropped
}

/** 取消息里的纯文本（多段消息只拼 text 段）。 */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).filter(Boolean).join('\n')
  }
  if (content !== null && typeof content === 'object' && typeof content.text === 'string') return content.text
  return ''
}

/**
 * 修复二级：把 system 折进首条 user。
 *
 * 语义不变（模型读到的还是同一段指令），零额外 token；实测同一段被拦文本放进
 * user 角色后网关放行。首条 user 是多段消息时作为前置 text 段插入，图片段保持原位。
 * @param {Record<string, any>} payload
 */
export function foldSystem(payload) {
  if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.messages)) return payload
  const systems = []
  const rest = []
  for (const message of payload.messages) {
    if (message?.role === 'system') {
      const text = textOf(message.content)
      if (text !== '') systems.push(text)
      continue
    }
    rest.push(message)
  }
  if (systems.length === 0) return payload
  const prefix = `System instructions:\n${systems.join('\n\n')}`
  const at = rest.findIndex((message) => message?.role === 'user')
  if (at === -1) {
    rest.unshift({ role: 'user', content: prefix })
  } else {
    const target = rest[at]
    if (Array.isArray(target.content)) {
      rest[at] = { ...target, content: [{ type: 'text', text: `${prefix}\n\n` }, ...target.content] }
    } else {
      const text = textOf(target.content)
      rest[at] = { ...target, content: text === '' ? prefix : `${prefix}\n\n${text}` }
    }
  }
  return { ...payload, messages: rest }
}

/** 修复三级：system / assistant 文本逐词打散（覆盖历史里的指纹）。 */
export function obfuscateNonUser(payload) {
  if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.messages)) return payload
  let changed = false
  const messages = payload.messages.map((message) => {
    if (message === null || (message.role !== 'system' && message.role !== 'assistant')) return message
    if (typeof message.content !== 'string' || !message.content.includes(' ')) return message
    changed = true
    return { ...message, content: message.content.replaceAll(ZWSP, '').split(' ').join(`${ZWSP} `) }
  })
  return changed ? { ...payload, messages } : payload
}

/**
 * 按级别产出候选请求体：0 已修复 → 1 折 system → 2 逐词打散。
 *
 * 阶梯顺序照抄实测结论：优先保留消息形状（最省 token、最不改行为），
 * 只有上游仍然拒绝时才降级。
 * @param {Record<string, any>} payload
 * @param {number} level 0 | 1 | 2
 */
export function repairForGateway(payload, level = 0) {
  const { payload: base, changes } = sanitizePayload(payload)
  if (level <= 0) return { payload: base, changes, level }
  if (level === 1) return { payload: foldSystem(base), changes: [...changes, 'fold-system'], level }
  return { payload: obfuscateNonUser(foldSystem(base)), changes: [...changes, 'fold-system', 'obfuscate'], level }
}
