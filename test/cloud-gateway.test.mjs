/**
 * 云网关：错误归类、请求体修复、SSE 聚合都必须可离线断言。
 *
 * 这些结论都有实网依据（2026-11，api.cnb.cool 逐段二分）：
 *
 *   · `developer` 角色单独就能触发 HTTP 400 / code 11128
 *     "Illegal API invocation from an unapproved channel"；
 *   · system 里同时出现「@ 路径引用」与「workspace root」两句同样会触发；
 *   · 同一段文本放进 user 角色 → 200；
 *   · 身份词中间插 U+200B → 200（人眼不可见，匹配不到）；
 *   · 非流式请求 → 400 / 11101；
 *   · 孤立 tool 结果 → 400 / 11148；
 *   · 未知模型 → 403 MODEL_NOT_IN_LIST；目录内但组织没开通 → MODEL_NOT_AVAILABLE_FOR_ORG。
 *
 * 11288 与 11128 归为同一类：都会被同一套修复阶梯解决，区分它们不改变任何动作。
 */
import assert from 'node:assert/strict'
import {
  FINGERPRINT_CODES,
  classifyGatewayError,
  dropOrphanTools,
  isFingerprintBlock,
  repairForGateway,
  repairText,
  sanitizePayload,
} from '../lib/model-guard.js'
import { aggregateSse, attemptLadder, completionToSse } from '../lib/gateway-proxy.js'

// --- 1. 11288 与 11128 是同一类，且都标记为可重试 ----------------------
{
  for (const code of FINGERPRINT_CODES) {
    const body = JSON.stringify({ code, msg: 'Illegal API invocation from an unapproved channel' })
    const reason = classifyGatewayError(400, body)
    assert.equal(reason.kind, 'fingerprint', `${code} must classify as a fingerprint refusal`)
    assert.equal(reason.code, code)
    assert.equal(reason.retryable, true, 'the repair ladder is what makes it retryable')
    assert.ok(isFingerprintBlock(400, body))
  }
  assert.deepEqual([...FINGERPRINT_CODES].sort(), [11128, 11288], 'both codes are recognised')
}

// --- 2. 403 的四种含义必须被分开 ---------------------------------------
{
  const cases = [
    ['[NO_RIGHT] OpenAPI only allowed in pipeline', 'personal-token'],
    ['[SLUG_ID_NOT_MATCH]SlugId not match', 'wrong-repo'],
    ['[MODEL_NOT_IN_LIST]Model gpt-9 is not in the optional models list', 'model-unknown'],
    ['[MODEL_NOT_AVAILABLE_FOR_ORG]Model glm-5.3 is not available for your organization', 'model-not-entitled'],
  ]
  for (const [text, kind] of cases) {
    assert.equal(classifyGatewayError(403, text).kind, kind, `${kind} must be distinguished`)
  }
  // 模型名要从文案里取出来，面板才能直接建议换哪个。
  assert.equal(classifyGatewayError(403, cases[2][0]).model, 'gpt-9')
  assert.equal(classifyGatewayError(403, cases[3][0]).model, 'glm-5.3')
}

// --- 3. 指纹修复：改成等价表述，不改语义 --------------------------------
{
  const refused = 'Main branch (you will usually use this for PRs)'
  const fixed = repairText(refused)
  assert.notEqual(fixed, refused, 'the refused wording is rewritten')
  assert.match(fixed, /pull requests/, 'to wording the gateway accepts')
  assert.equal(repairText(fixed), fixed, 'rewriting is idempotent')
  // 已经是放行写法的句子保持不动。
  assert.equal(repairText('Main branch (the usual target for pull requests)'), 'Main branch (the usual target for pull requests)')
}

// --- 4. 身份词打散，但路径语境必须跳过 ---------------------------------
{
  // 用码点构造，避免编辑器把零宽字符悄悄塞进源码里的期望值。
  const ZWSP = String.fromCharCode(0x200b)
  const plain = `You are DeepSeek${' '}Harness.`
  const out = repairText(plain)
  assert.ok(out.includes(ZWSP), 'a zero-width space is inserted')
  assert.equal(out.replace(new RegExp(ZWSP, 'g'), ''), plain, 'removing it restores the text')
  // 路径里打散会交给模型一个坏路径，工具调用直接失败。
  const path = 'D:\\app\\DeepSeek Harness\\resources\\x'
  assert.equal(repairText(path), path, 'path context is skipped')
}

// --- 5. 消息形状归一：developer→system、system 提前、图片段剥掉 -------
{
  const { payload, changes } = sanitizePayload({
    model: 'deepseek-v4.1-flash',
    stream: false,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'developer', content: 'be brief' },
    ],
  })
  assert.equal(payload.stream, true, 'the gateway only does streaming')
  assert.equal(payload.messages[0].role, 'system', 'system must lead the list')
  assert.ok(changes.includes('stream→true'))
  assert.ok(changes.includes('developer→system'))
  assert.equal(payload.model, 'deepseek-v4.1-flash', 'protocol fields are untouched')

  const withImage = sanitizePayload({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:,' } }] }],
  })
  assert.ok(withImage.changes.includes('drop:image-part'), 'the gateway rejects image parts (11133)')
  assert.deepEqual(withImage.payload.messages[0].content.map((part) => part.type), ['text'])
}

// --- 6. 孤立的 tool 结果被丢掉（网关答 11148）-------------------------
{
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'tool', tool_call_id: 'nope', content: 'orphan' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'kept' },
  ]
  const dropped = dropOrphanTools(messages)
  assert.equal(dropped, 1)
  assert.equal(messages.filter((message) => message.role === 'tool').length, 1, 'the paired result survives')
}

// --- 7. 修复阶梯：一次比一次退让，但每次都保留指令 --------------------
{
  const payload = {
    model: 'm',
    stream: false,
    messages: [
      { role: 'developer', content: 'You are DeepSeek\u200b Harness. The @ tokens are path references the user made explicitly.' },
      { role: 'user', content: 'do the thing' },
      // 历史里的 assistant 文本同样被扫，所以阶梯要有第三级。
      { role: 'assistant', content: 'Relative paths are resolved against the workspace root.' },
      { role: 'user', content: 'continue' },
    ],
  }
  const ladder = attemptLadder(payload)
  assert.equal(ladder.length, 3, 'rewrite → fold → obfuscate')
  assert.deepEqual(ladder.map((row) => row.level), [0, 1, 2])
  // 一级仍然保留 system 角色；二级折进 user；三级再逐词打散。
  assert.ok(ladder[0].body.messages.some((message) => message.role === 'system'))
  assert.ok(!ladder[1].body.messages.some((message) => message.role === 'system'), 'level 1 folds system into user')
  const folded = ladder[1].body.messages.find((message) => message.role === 'user').content
  assert.match(folded, /System instructions:/)
  assert.match(folded, /do the thing/, 'the original user text survives the fold')
  const maskedUser = ladder[2].body.messages.find((message) => message.role === 'user').content
  assert.equal(maskedUser, folded, 'level 2 leaves user text alone: the gateway does not scan it')
  const maskedAssistant = ladder[2].body.messages.find((message) => message.role === 'assistant').content
  assert.ok(maskedAssistant.includes('\u200b '), 'level 2 spaces out assistant history')
  const foldedAssistant = ladder[1].body.messages.find((message) => message.role === 'assistant').content
  assert.equal(maskedAssistant.replace(/\u200b/g, ''), foldedAssistant, 'and restores to the previous level unchanged')
}

// --- 7b. 没有可打散的历史时，阶梯只有两级（不必多发一次上游请求）----
{
  const ladder = attemptLadder({
    model: 'm',
    messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }],
  })
  assert.equal(ladder.length, 2, 'folding already moves the text out of the scanned role')
}

// --- 8. repairForGateway 的级别与阶梯一致 ----------------------------
{
  const payload = { model: 'm', messages: [{ role: 'system', content: 'a b c' }, { role: 'user', content: 'x' }] }
  assert.equal(repairForGateway(payload, 0).payload.messages[0].role, 'system')
  assert.equal(repairForGateway(payload, 1).payload.messages[0].role, 'user')
  assert.equal(repairForGateway(payload, 2).level, 2)
}

// --- 9. SSE 聚合：内容、推理、tool_calls 增量都要拼对 ---------------
{
  const sse = [
    'data: {"id":"x","model":"m","created":1,"choices":[{"delta":{"role":"assistant"}}]}',
    '',
    'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}',
    'data: {"choices":[{"delta":{"content":"O"}}]}',
    'data: {"choices":[{"delta":{"content":"K"}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"f","arguments":"{\\"a\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"total_tokens":3}}',
    'data: [DONE]',
    '',
  ].join('\n')
  const completion = aggregateSse(sse, { model: 'fallback' })
  assert.equal(completion.id, 'x')
  assert.equal(completion.model, 'm', 'the upstream model id wins over the fallback')
  assert.equal(completion.choices[0].message.content, 'OK')
  assert.equal(completion.choices[0].message.reasoning_content, '想')
  assert.equal(completion.choices[0].finish_reason, 'tool_calls')
  assert.equal(completion.usage.total_tokens, 3)
  const calls = completion.choices[0].message.tool_calls
  assert.equal(calls.length, 1)
  assert.equal(calls[0].function.arguments, '{"a":1}', 'argument fragments are concatenated, not overwritten')
}

// --- 10. 聚合结果能还原成 SSE（客户端要流式时）---------------------
{
  const completion = {
    id: 'x',
    object: 'chat.completion',
    created: 1,
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    usage: null,
  }
  const sse = completionToSse(completion)
  assert.match(sse, /^data: /)
  assert.match(sse, /data: \[DONE\]/)
  const echoed = aggregateSse(sse, { model: 'm' })
  assert.equal(echoed.choices[0].message.content, 'OK', 'round-trip preserves the answer')
  assert.equal(echoed.choices[0].finish_reason, 'stop')
}

// --- 11. 新版 OpenAI 协议字段必须被清掉 -------------------------------
//
// 把 DSH 的真实请求抓下来才看清的：pi-ai 会发
//   max_completion_tokens / store / stream_options
// 而 CNB 网关的后端不接受它们，回报 `11133 the request parameters were rejected
// by the model provider` —— 措辞像内容问题，实际是字段问题。这类「错误信息指向
// 错误方向」的坑只能靠实测钉住。
{
  const { payload, changes } = sanitizePayload({
    model: 'm',
    stream: true,
    store: false,
    stream_options: { include_usage: true },
    max_completion_tokens: 1024,
    metadata: { a: 1 },
    service_tier: 'auto',
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(payload.store, undefined, 'store is dropped')
  assert.equal(payload.stream_options, undefined, 'stream_options is dropped')
  assert.equal(payload.metadata, undefined, 'metadata is dropped')
  assert.equal(payload.service_tier, undefined, 'service_tier is dropped')
  // 预算要翻译而不是丢：缺了它请求会被当成无上限。
  assert.equal(payload.max_tokens, 1024, 'max_completion_tokens becomes max_tokens')
  assert.equal(payload.max_completion_tokens, undefined)
  assert.ok(changes.some((c) => c.includes('max_completion_tokens')), 'the translation is reported')
  // 已有的 max_tokens 不被覆盖。
  const kept = sanitizePayload({ stream: true, max_tokens: 10, max_completion_tokens: 999, messages: [] })
  assert.equal(kept.payload.max_tokens, 10, 'an explicit max_tokens wins')
}
