/**
 * Issue 网关「真 API」契约：工具调用与多轮必须在**两种后端**上都成立。
 *
 * 这条路由有两条后端：
 *   1. 本地桥 —— dsh 进程里就有 CNB_TOKEN，直连上游；
 *   2. 容器回落 —— 借一个一次性容器转发。
 *
 * 早先只有桥接那条能调工具：容器那条把 messages 压成一句 question，容器里的
 * awk 又只抠 `"content":"…"`，于是 `tools`、`assistant.tool_calls`、`tool` 结果
 * 全部消失。表现就是「换个部署位置，工具就不灵了 / 聊两轮就断」。
 *
 * 这个套件钉住的是**搬运契约**本身（离线，不碰网络）：
 *   · 请求侧：messages/tools/tool_choice 原样变成上游 payload；
 *   · 回传侧：容器日志里的 base64 能还原成原始 SSE，再聚合成 tool_calls；
 *   · 响应侧：finish_reason 是 `tool_calls`，SSE 分片里带完整 tool_calls。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_MAX_TOKENS,
  ISSUE_PROXY_CONCURRENCY,
  ISSUE_PROXY_POLL_MS,
  completionResponse,
  openAiChunk,
  openAiFinalChunk,
  partsFromCompletion,
  upstreamPayloadFromBody,
} from '../lib/issue-proxy.js'
import { streamLocal } from '../lib/local-gateway.js'
import { repairLadder } from '../lib/model-guard.js'
import http from 'node:http'
import {
  RELAY_BEGIN,
  RELAY_END,
  buildRelayScript,
  extractRelayError,
  extractRelaySse,
} from '../lib/ask-script.js'
import { aggregateSse, completionToSse } from '../lib/gateway-proxy.js'

const SCRATCH = mkdtempSync(join(tmpdir(), 'dsh-cnb-relay-'))
process.on('exit', () => rmSync(SCRATCH, { recursive: true, force: true }))

const TOOLS = [{
  type: 'function',
  function: {
    name: 'bash',
    description: '跑 shell 命令',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
}]

const HISTORY = [
  { role: 'system', content: '你是运维助手。' },
  { role: 'user', content: '看看当前目录' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } }],
    reasoning_content: '（思考过程，不该出现在历史里）',
  },
  { role: 'tool', tool_call_id: 'call_1', content: '/workspace' },
  { role: 'user', content: '继续，路径是什么？' },
]

// --- 1. 请求侧：整段历史与工具定义原样上去 --------------------------------
{
  const payload = upstreamPayloadFromBody(
    { messages: HISTORY, tools: TOOLS, tool_choice: 'auto', temperature: 0.2, max_tokens: 1234, stream: false, store: true },
    { model: 'deepseek-v4.1-flash', maxTokens: 4000 },
  )

  assert.equal(payload.model, 'deepseek-v4.1-flash')
  assert.equal(payload.stream, true, '上游只接受流式，必须强制 stream:true')
  assert.equal(payload.max_tokens, 1234, '调用方的 max_tokens 要保留')
  assert.equal(payload.temperature, 0.2)
  assert.equal(payload.tool_choice, 'auto')
  assert.deepEqual(payload.tools, TOOLS, 'tools 定义必须一字不改地送上去')

  // 多轮的关键：assistant.tool_calls 与 tool 结果都要在。
  const roles = payload.messages.map((message) => message.role)
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'user'])
  const assistant = payload.messages[2]
  assert.equal(assistant.tool_calls[0].id, 'call_1')
  assert.equal(assistant.reasoning_content, undefined, '思考过程不该被带回上游')
  assert.equal(payload.messages[3].tool_call_id, 'call_1', 'tool 结果必须带 id 才能配对')

  // 孤立的 tool 结果（没有对应调用）会让整条请求 11148，直接丢。
  const orphan = upstreamPayloadFromBody(
    { messages: [{ role: 'tool', content: '没有 id 的结果' }, { role: 'user', content: 'hi' }] },
    { model: 'hy4' },
  )
  assert.deepEqual(orphan.messages.map((message) => message.role), ['user'])

  // 空消息不该占位。
  const empty = upstreamPayloadFromBody(
    { messages: [{ role: 'assistant', content: null }, { role: 'user', content: 'hi' }] },
    { model: 'hy4' },
  )
  assert.deepEqual(empty.messages.map((message) => message.role), ['user'])
}

// --- 2. 容器脚本：只搬字节，payload 以 base64 内嵌 -------------------------
{
  const payload = upstreamPayloadFromBody({ messages: HISTORY, tools: TOOLS }, { model: 'hy4' })
  const script = buildRelayScript({ payload })
  const file = join(SCRATCH, 'relay.sh')
  writeFileSync(file, script, 'utf8')
  // 语法必须过：这段脚本在容器里执行，语法错只会表现为「没有输出」。
  execFileSync('sh', ['-n', file])

  assert.match(script, /curl -sS -m 360 -N/)
  assert.match(script, new RegExp(`echo ${RELAY_BEGIN}`))
  assert.match(script, new RegExp(`echo ${RELAY_END}`))
  assert.match(script, /base64 -d/)

  const encoded = /P1='([^']+)'/.exec(script)[1]
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')), payload, 'payload 解回来必须一致（含 tools 与 tool 结果）')

  // 容器里不该再做解析：awk 抠不出 tool_calls，这正是旧实现丢工具的原因。
  assert.doesNotMatch(script, /awk/, '容器脚本不该解析 JSON —— 交给本机的 aggregateSse')

  // --- 2b. 阶梯也要进容器 ------------------------------------------------
  // 11128 是确定性的：容器里重发同一份 body 只会再被拦一次，所以候选体
  // 必须与请求体一起进容器，逐级换形态。这里钉住「全部级别都在」。
  const ladder = repairLadder(payload)
  const multi = buildRelayScript({ payloads: ladder.map((row) => row.body) })
  const multiFile = join(SCRATCH, 'relay-multi.sh')
  writeFileSync(multiFile, multi, 'utf8')
  execFileSync('sh', ['-n', multiFile])
  assert.match(multi, new RegExp(`VARIANTS=${ladder.length}`))
  for (let index = 0; index < ladder.length; index += 1) {
    const b64 = new RegExp(`P${index + 1}='([^']+)'`).exec(multi)[1]
    assert.deepEqual(
      JSON.parse(Buffer.from(b64, 'base64').toString('utf8')),
      ladder[index].body,
      `第 ${index} 级候选体必须完整进容器`,
    )
  }
  // 只有指纹类拒绝才升级：别的错误换形态也不会变好，多试一次就是白花一次容器。
  assert.match(multi, /\*11128\*\|\*11288\*\|\*"unapproved channel"\*/)
}

// --- 3. 回传侧：日志 → base64 → 原始 SSE ----------------------------------
{
  const sse = [
    'data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,"model":"hy4","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl-x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"bash","arguments":"{\\"comm"}}]},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl-x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"and\\":\\"pwd\\"}"}}]},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl-x","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')

  const b64 = Buffer.from(sse, 'utf8').toString('base64')
  // 按 base64 的 76 列折行，模拟真实 `base64` 的输出。
  const folded = b64.replace(/(.{76})/g, '$1\n')
  // Runner 会给每行加颜色和前缀；日志里还有脚本回显。
  const log = [
    'Runner[1][stage-0] echo DSH_RELAY_BEGIN',
    `\u001b[32mRunner[1][stage-0] ${RELAY_BEGIN}\u001b[0m`,
    ...folded.split('\n').map((line) => `Runner[1][stage-0] ${line}`),
    `Runner[1][stage-0] ${RELAY_END}\u001b[0m`,
    'Runner[1][stage-0] echo DSH_RELAY_END',
  ].join('\n')

  const decoded = extractRelaySse(log)
  assert.equal(decoded, sse, 'base64 折行 + Runner 前缀都不该影响还原')

  const completion = aggregateSse(decoded, { model: 'hy4' })
  const parts = partsFromCompletion(completion)
  assert.equal(parts.toolCalls.length, 1)
  assert.equal(parts.toolCalls[0].id, 'call_9')
  assert.equal(parts.toolCalls[0].function.name, 'bash')
  assert.deepEqual(JSON.parse(parts.toolCalls[0].function.arguments), { command: 'pwd' }, 'arguments 分片必须拼回合法 JSON')
  assert.equal(parts.finishReason, 'tool_calls')
  assert.equal(parts.usage.total_tokens, 18)

  // 没有标记（脚本根本没跑到）时必须是 null，而不是"空字符串当答案"。
  assert.equal(extractRelaySse('Runner[1][stage-0] 什么都没有'), null)

  // 容器报错行：回显的 `$err` 不许当成错误文本。
  const withError = [
    'Runner[1][stage-0] echo "DSH_RELAY_ERROR=$err"',
    'Runner[1][stage-0] DSH_RELAY_ERROR=上游没有返回任何字节（curl 失败或超时）',
  ].join('\n')
  assert.match(extractRelayError(withError), /上游没有返回任何字节/)
}

// --- 4. 响应侧：finish_reason 与 SSE 分片 ---------------------------------
{
  const completion = completionResponse({
    model: 'hy4',
    content: '',
    toolCalls: [{ id: 'call_9', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } }],
    finishReason: 'tool_calls',
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    via: 'container',
  })
  assert.equal(completion.choices[0].finish_reason, 'tool_calls', '带工具调用时不能写 stop，否则调用方以为这轮结束了')
  assert.equal(completion.choices[0].message.tool_calls[0].function.name, 'bash')
  assert.equal(completion.choices[0].message.content, null, '只有工具调用时 content 应为 null')

  const sse = completionToSse(completion)
  assert.match(sse, /"tool_calls"/)
  assert.match(sse, /"finish_reason":"tool_calls"/)
  assert.match(sse, /data: \[DONE\]/)

  // 纯文本回复仍然要正常结束。
  const plain = completionResponse({ model: 'hy4', content: '好了' })
  assert.equal(plain.choices[0].finish_reason, 'stop')
  assert.equal(plain.choices[0].message.content, '好了')
}

// --- 5. 正文里的 DSML 内联调用也要翻译成真调用 ----------------------------
{
  const inline = '<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="bash">'
    + '<｜｜DSML｜｜ parameter name="command" string="true">pwd</｜｜DSML｜｜ parameter>'
    + '</｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>'
  const completion = aggregateSse(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: inline }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n`,
    { model: 'hy4' },
  )
  const parts = partsFromCompletion(completion)
  assert.equal(parts.toolCalls.length, 1)
  assert.equal(parts.toolCalls[0].function.name, 'bash')
  assert.deepEqual(JSON.parse(parts.toolCalls[0].function.arguments), { command: 'pwd' })
  assert.equal(parts.finishReason, 'tool_calls')
  assert.equal(parts.content, '', '标记清掉后正文应为空，而不是留一段壳')
}

// --- 6. 拉满：并发、预算、轮询间隔 ---------------------------------------
{
  // 默认值就是"拉满"后的值；env 能覆盖（容器配额吃紧时往回拧）。
  assert.equal(ISSUE_PROXY_CONCURRENCY, 8, '默认并发应为 8（写死 2 会让排队白等）')
  assert.equal(DEFAULT_MAX_TOKENS, 32_000, '默认输出预算应为 32k（4k 会把推理模型的正文截掉）')
  assert.ok(ISSUE_PROXY_POLL_MS <= 1_500, '容器日志轮询应压到秒级以内')

  const probe = (env) => execFileSync(process.execPath, [
    '-e',
    `import('${new URL('../lib/issue-proxy.js', import.meta.url).href}').then((m) => console.log([m.ISSUE_PROXY_CONCURRENCY, m.DEFAULT_MAX_TOKENS, m.ISSUE_PROXY_POLL_MS].join(',')))`,
  ], { env: { ...process.env, ...env }, encoding: 'utf8' }).trim()

  assert.equal(probe({ DSH_ISSUE_CONCURRENCY: '3', DSH_ISSUE_MAX_TOKENS: '8192', DSH_ISSUE_POLL_MS: '4000' }), '3,8192,4000')
  // 非法值不许把并发变成 0（那会永久排队）。
  assert.equal(probe({ DSH_ISSUE_CONCURRENCY: '0' }).split(',')[0], '8')
  assert.equal(probe({ DSH_ISSUE_CONCURRENCY: 'abc' }).split(',')[0], '8')
}

// --- 7. 流式分片：delta 原样、收尾帧带 finish_reason + usage --------------
{
  const meta = { id: 'chatcmpl-t', created: 1, model: 'hy4' }
  const chunk = openAiChunk({ content: '你' }, meta)
  assert.equal(chunk.object, 'chat.completion.chunk')
  assert.equal(chunk.choices[0].delta.content, '你')
  assert.equal(chunk.choices[0].finish_reason, null)

  const toolChunk = openAiChunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"com' } }] }, meta)
  assert.equal(toolChunk.choices[0].delta.tool_calls[0].function.name, 'bash', 'tool_calls 分片要原样转发')

  const last = openAiFinalChunk('tool_calls', meta, { total_tokens: 9 })
  assert.equal(last.choices[0].finish_reason, 'tool_calls')
  assert.equal(last.usage.total_tokens, 9, 'usage 必须和 finish_reason 同帧给出')
}

// --- 8. streamLocal：被指纹拦时换形态，不是原样重发 -----------------------
// 11128 是确定性的：同一份 body 重发多少次都被拦。所以这里让上游**只在
// 形态变了之后**放行，验证的是「换体」而非「重试」。
{
  const SSE = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '你' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '好' } }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('')
  let hits = 0
  const bodies = []
  const server = http.createServer((request, reply) => {
    hits += 1
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      bodies.push(body)
      // 还有 system 角色 = 仍是原始形态 = 上游照拦。
      const hasSystem = body.messages.some((message) => message.role === 'system')
      if (hasSystem) {
        reply.writeHead(400, { 'content-type': 'application/json' })
        reply.end(JSON.stringify({ errmsg: 'Illegal API invocation from an unapproved channel', errcode: 11128 }))
        return
      }
      reply.writeHead(200, { 'content-type': 'text/event-stream' })
      reply.end(SSE)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const events = []
  let opened = 0
  const streamed = await streamLocal({
    model: 'hy4',
    payload: {
      model: 'hy4',
      messages: [{ role: 'system', content: '你是助手。' }, { role: 'user', content: 'hi' }],
    },
    token: 't',
    repo: 'acme/x',
    origin: `http://127.0.0.1:${port}`,
    onOpen: () => { opened += 1 },
    onEvent: (event) => events.push(event),
  })
  server.close()

  assert.equal(streamed.ok, true)
  assert.equal(hits, 2, '被拦后换形态重发一次')
  assert.equal(opened, 1, 'onOpen 只在真正拿到 2xx 之后调用一次')
  assert.equal(events.length, 2)
  assert.equal(events.map((event) => event.choices[0].delta.content ?? '').join(''), '你好')
  assert.equal(typeof streamed.firstEventMs, 'number')
  assert.match(streamed.text, /\[DONE\]/)

  // 关键：第二次发出去的**不是同一份 body** —— system 已经折进首条 user。
  assert.ok(bodies[0].messages.some((message) => message.role === 'system'), '第一次是原形态')
  assert.ok(!bodies[1].messages.some((message) => message.role === 'system'), '第二次必须换形态')
  assert.match(bodies[1].messages.find((message) => message.role === 'user').content, /你是助手/)
  assert.match(bodies[1].messages.find((message) => message.role === 'user').content, /hi/, '原语义不丢')
}

console.log('issue relay OK · 请求透传、容器只搬字节、tool_calls 与多轮在两条后端上都成立、并发与流式拉满')
