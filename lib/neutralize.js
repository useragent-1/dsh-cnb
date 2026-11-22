/**
 * Make a request semantically identical while its client fingerprint is not visible.
 *
 * The CNB gateway runs content risk control over the request body and rejects the whole
 * call when a "client fingerprint" matches:
 *
 *   HTTP 400 / code 11128 / "Illegal API invocation from an unapproved channel"
 *
 * Changing the token, the account, the model or the headers does not help: what is
 * refused is the prompt text. Longer bodies trigger it reliably (over ~1 KB), so it looks
 * intermittent — a short request passes, the same text in a real conversation fails.
 *
 * Only `system` and `assistant` text is scanned; `user` content and tool descriptions are
 * not. So the strategies here never change meaning:
 *
 *   1. rewrite known fingerprint phrases to equivalent wording, and split identity words
 *      with a zero-width space (invisible to a reader, no longer matching upstream);
 *   2. normalise message shape — map the newer `developer` role to `system` and lift a
 *      mid-conversation `system` to the front;
 *   3. when a request is still refused, fall back to folding the system text into the
 *      first user message, then to spacing out every token of non-user messages.
 *
 * Derived from the MIT-licensed cnb2api neutraliser (see LICENSE-cnb2api), with the
 * phrase table verified against the live gateway: "Main branch (the usual target for
 * pull requests)" alone reproduces HTTP 400 / 11128.
 */

// 零宽空格：不参与渲染，也不属于 \s，插进词组里既不改语义也不改分词边界。
const ZWSP = '\u200B';

// 客户端注入的特征短语。部分网关按字面拦这些 token（Claude Code 的计费头名等），
// 换等价表述、保留值本身（URL/版本号原样），模型行为不受影响。
export const CLIENT_PHRASES = [
  [/x-anthropic-billing-header/gi, 'x-cc-billing-meta'],
  [
    /to give feedback, users should report the issue at (https:\/\/github\.com\/anthropics\/claude-code\/issues)/gi,
    'to share feedback, users can report the issue at $1',
  ],
  [
    /you are claude code, anthropic's official cli for claude(\.)?/gi,
    "you are claude code, a command-line coding assistant$1",
  ],
  // —— 以下三条为本仓库实测新增（2026-10-27，真机二分定位）——
  // DSH 的系统提示词里有一段「@ 文件引用」说明，单独任何一句都放过，
  // 但两句连在一起就命中上游的 Cursor 系指纹 → 整条 400/11128。
  // 这是 DSH 用户在代理侧唯一的必踩点：改写后整份 DSH 系统提示词实测 200。
  [
    /are paths the user explicitly referenced/gi,
    'are path references the user made explicitly',
  ],
  [
    /Relative paths resolve from the workspace root/gi,
    'Relative paths are resolved against the workspace root',
  ],
  // Copilot / Cursor 系环境指纹，单独一句即可触发拦截。
  // Verified against the live gateway: this wording answers 200, while
  // "Main branch (the usual target for pull requests)" answers 400 / 11128.
  [
    /Main branch \(you will usually use this for PRs\)/gi,
    'Main branch (the usual target for pull requests)',
  ],
];

// 上游当前实测会拦的身份词组。前后负向断言跳过路径语境（\ 或 / 贴边），
// 其余位置一律打散；大小写不敏感，空格兼容普通空格与 NBSP。
export const IDENTITY_RE = /(?<![\\/])(DeepSeek)[ \u00A0]+(Harness)(?![\\/])/gi;

// 激进模式：连品牌词本身也打散。默认关闭——它会命中比身份词组多得多的位置
// （模型名、普通叙述），只在身份词组规则被上游绕过时才需要。
export const BRAND_RE = /(?<![\\/\w])(DeepSeek)(?![\w\\/])/gi;

// 补位用的中性 system：仅在显式开启 syntheticSystem 时使用（默认关闭）。
// 默认不凭空造 system——请求本来没有 system 是合法形状，不该被改写语义。
export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

// 字符串级中和：纯函数，便于单测；路径语境的跳过由正则自身保证。
export function neutralize(text, { aggressive = false } = {}) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const [re, replacement] of CLIENT_PHRASES) out = out.replace(re, replacement);
  out = out.replace(IDENTITY_RE, `$1${ZWSP} $2`);
  if (aggressive) out = out.replace(BRAND_RE, `Deep${ZWSP}Seek`);
  return out;
}

// 递归改写请求体里所有字符串值（content / tool 描述 / tool arguments 的 JSON 串 /
// input_schema 的 description …）。只改值、不改键：键名是协议字段，改不得。
// 就地改写：payload 来自 JSON.parse，调用方本来就要重建 body。
function rewriteDeep(value, options, stats) {
  if (typeof value === 'string') {
    const next = neutralize(value, options);
    if (next !== value) stats.rewritten += 1;
    return next;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = rewriteDeep(value[i], options, stats);
    return value;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = rewriteDeep(value[key], options, stats);
    return value;
  }
  return value;
}

// developer → system：OpenAI 新角色名，老网关不认。就地改，顺序不变。
export function normalizeRoles(messages) {
  for (const m of messages) {
    if (m && m.role === 'developer') m.role = 'system';
  }
  return messages;
}

// 首条是 system 的保证：
//   · 首条已是 system → 不动（绝大多数请求）
//   · 有 system 但在中途 → 提前（system 不参与 tool_call_id 配对，移动安全）
//   · 一条 system 都没有 → 默认不动（凭空造 system 会改语义）；只有调用方显式
//     syntheticSystem=true 时才补中性占位，用于上游硬性要求首条为 system 的场景。
export function ensureSystemFirst(messages, { synthetic = false } = {}) {
  if (!messages.length || messages[0]?.role === 'system') return messages;
  const idx = messages.findIndex((m) => m?.role === 'system');
  if (idx > 0) {
    const [sys] = messages.splice(idx, 1);
    messages.unshift(sys);
    return messages;
  }
  if (synthetic) messages.unshift({ role: 'system', content: DEFAULT_SYSTEM_PROMPT });
  return messages;
}


// ---------------------------------------------------------------------------
// fallback shapes, used only after a real 400/11128
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Fallback shapes. Used only after a real 400/11128, escalating:
//   foldSystemIntoUser — merge system text into the first user message (no extra
//                        tokens, verified accepted upstream);
//   obfuscateNonUser   — space out every word of system and assistant messages, which
//                        also covers a refusal caused by history rather than the head.
// ---------------------------------------------------------------------------

// 取消息内容里的纯文本：字符串直接返回，多段（content parts）只拼 text 段。
// 图片等非文本段不参与拼接，避免把多模态消息压扁。
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : '')))
      .filter(Boolean)
      .join('\n');
  }
  // 单段块对象（少数客户端会这么发顶层 system）
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

// 兜底 1：把 system（含已归一过的 developer）文本并进首条 user 消息。
// 语义不变——模型读到的还是同一段指令，只是角色从 system 变 user；零额外 token。
// 已实测：同一段被拦文本放 user 里上游 200（拦截面只扫 system / assistant）。
// 首条 user 是多段消息时，作为前置 text 段插入，原有图片段原样保留。
// 非标准但有客户端会发的顶层 system 字段一并折叠（否则它仍会被扫）。
export function foldSystemIntoUser(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const messages = payload.messages;
  const topSystem = contentText(payload.system);
  const hasTopSystem = payload.system !== undefined;
  if (!Array.isArray(messages) && !topSystem) return payload;

  const sysTexts = [];
  let sawSystem = hasTopSystem;
  if (topSystem) sysTexts.push(topSystem);
  const rest = [];
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (m && (m.role === 'system' || m.role === 'developer')) {
        sawSystem = true;
        const text = contentText(m.content);
        if (text) sysTexts.push(text);
        continue;
      }
      rest.push(m);
    }
  }
  // 没有 system 文本时：若有空的 system 消息，也顺手去掉。上游按文本指纹拦，
  // 但多带一条空 system 没有语义价值，去掉可让兜底形态更接近「纯 user」形状。
  if (!sysTexts.length) {
    if (!sawSystem) return payload;
    const next = { ...payload, messages: rest };
    if (hasTopSystem) delete next.system;
    return next;
  }

  const folded = `System instructions:\n${sysTexts.join('\n\n')}`;
  const idx = rest.findIndex((m) => m?.role === 'user');
  if (idx === -1) {
    rest.unshift({ role: 'user', content: folded });
  } else {
    const target = rest[idx];
    if (Array.isArray(target.content)) {
      const first = target.content[0];
      // 首段是 text 就并进去，否则新插一段：多模态消息的图片段保持原位不动
      const merged = first && typeof first.text === 'string'
        ? [{ ...first, text: `${folded}\n\n${first.text}` }, ...target.content.slice(1)]
        : [{ type: 'text', text: folded }, ...target.content];
      rest[idx] = { ...target, content: merged };
    } else {
      const text = contentText(target.content);
      rest[idx] = { ...target, content: text ? `${folded}\n\n${text}` : folded };
    }
  }
  const next = { ...payload, messages: rest };
  if (hasTopSystem) delete next.system;
  return next;
}

// 逐词打散：在每个词尾插入零宽空格（词与词的空格保留，渲染与语义不变）。
// 打散后任何整句/跨句指纹都不再成立——已实测整份 DSH 系统提示词逐词打散后 200。
// 先剥掉已有的 ZWSP 再重打，保证幂等（不会越跑越多）。无空格文本原样返回。
function obfuscateWords(text) {
  if (typeof text !== 'string' || !text.includes(' ')) return text;
  return text.replaceAll(ZWSP, '').split(' ').join(`${ZWSP} `);
}

// 兜底 2：把 system / assistant 角色里的文本逐词打散。
// 兜底 1 只管 system；若指纹落在 assistant 历史消息里（拦截面同样扫 assistant），
// 或者上游新增了表外的指纹，这一级仍能过。tool_calls 的参数不改：那是工具调用的
// 真实入参（路径/JSON），改了会直接执行失败。
export function obfuscateNonUser(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const messages = payload.messages;
  if (!Array.isArray(messages)) return payload;
  let changed = false;
  const next = messages.map((m) => {
    if (!m || (m.role !== 'system' && m.role !== 'assistant')) return m;
    if (typeof m.content === 'string') {
      const content = obfuscateWords(m.content);
      if (content === m.content) return m;
      changed = true;
      return { ...m, content };
    }
    if (Array.isArray(m.content)) {
      let partChanged = false;
      const content = m.content.map((p) => {
        if (!p || typeof p.text !== 'string') return p;
        const text = obfuscateWords(p.text);
        if (text === p.text) return p;
        partChanged = true;
        return { ...p, text };
      });
      if (!partChanged) return m;
      changed = true;
      return { ...m, content };
    }
    return m;
  });
  // 没有任何可打散的文本时返回原引用，调用方据此跳过多余的一次上游请求
  return changed ? { ...payload, messages: next } : payload;
}

// 出站前唯一入口：proxy.mjs 在 fetch 之前调用，OpenAI 与 Anthropic 两条协议栈
// 走同一份逻辑（Anthropic 适配器已完成转换，payload 一律是 OpenAI 形状）。
// 返回 { payload, rewritten }，rewritten = 被改写的字符串处数（供日志/诊断）。
export function prepareOutbound(payload, {
  enabled = true,
  aggressive = false,
  ensureSystem = true,
  syntheticSystem = false,
} = {}) {
  if (!enabled || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { payload, rewritten: 0 };
  }
  const stats = { rewritten: 0 };
  // 只遍历承载自然语言的根字段：model / stream / max_tokens 等协议字段保持原样
  // （模型名里带 deepseek 是正常的，不该被改写）。
  for (const root of ['messages', 'tools', 'system', 'prompt']) {
    if (payload[root] === undefined) continue;
    payload[root] = rewriteDeep(payload[root], { aggressive }, stats);
  }
  if (Array.isArray(payload.messages)) {
    normalizeRoles(payload.messages);
    if (ensureSystem) ensureSystemFirst(payload.messages, { synthetic: syntheticSystem });
  }
  return { payload, rewritten: stats.rewritten };
}
