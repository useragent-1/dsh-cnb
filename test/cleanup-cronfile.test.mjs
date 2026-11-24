/**
 * 生成的 crontab 片段必须是**真的能被 CNB 解析**的 YAML，而且带进去的脚本必须是
 * 仓里那一份、不是别的什么。
 *
 * 这条测试存在的原因是踩过一次：第一版用 heredoc 把脚本嵌进 `script: |`，
 * YAML 的块标量要求每行缩进，而 shell 的 heredoc 结束符必须顶格 —— 两边直接冲突。
 * 生成函数「成功返回了一段字符串」，`yaml.parse` 却报
 * `Implicit keys need to be on a single line`。也就是说：界面上说「片段生成好了」，
 * 用户并进 `.cnb.yml` 之后整个仓库的流水线都跑不起来，而没有任何一步报错。
 *
 * 所以这里用**真实的 YAML 解析器**（profile 里那份，和 dsh 自己加载配置用的是同一个）
 * 把它解析一遍，再把 base64 解回来、`node --check` 一遍，确认那确实是一份可执行脚本。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { cleanupDaemonScript, normalizeCleanupSettings } from '../lib/cleanup.js'
import { importFromDsh } from './resolve-dsh.mjs'

const yaml = await importFromDsh('yaml', 'dist/index.js')

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-cnb-cron-'))
const credentials = {
  async readRecord() { return { kind: 'grant', payload: { token: 'tok' } } },
  async modifyRecord() {},
  async deleteRecord() {},
  async set() {},
  async unset() {},
  async resolve() { return undefined },
}
const ctx = {
  effect: (fn) => { fn(); return () => {} },
  get: (name) => (name === 'credentials' ? credentials : undefined),
  inject() {},
  on() {},
}
const api = apply(ctx, {})

const setup = await api.runOperation('cleanup.setup', { repo: 'acme/self', intervalMinutes: 30 })
const snippet = setup.snippet

// --- 1. 片段是合法 YAML，且结构就是「一个 crontab 任务」 -------------
{
  const doc = yaml.parse(snippet)
  assert.ok(doc !== null && typeof doc === 'object', 'the snippet parses as a YAML document')
  const entries = doc.$?.crontab
  assert.ok(Array.isArray(entries), 'it lands under $.crontab, where CNB looks for scheduled jobs')
  assert.equal(entries.length, 1, 'exactly one job')
  assert.equal(entries[0].cron, '*/30 * * * *', 'the interval asked for is the interval written')
  assert.equal(entries[0].stages.length, 1, 'one stage')
  assert.match(entries[0].stages[0].script, /node "\$tmp"/, 'and it runs the script it just wrote')
}

// --- 2. 带进 stage 的脚本能解回来，且语法正确 -----------------------
{
  const doc = yaml.parse(snippet)
  const script = doc.$.crontab[0].stages[0].script
  // 生成器把脚本 base64 成单引号字面量；那串东西必须能解回一份真的 ESM 脚本。
  const encoded = /'([A-Za-z0-9+/=]{200,})'/.exec(script)
  assert.ok(encoded !== null, 'the script travels as a base64 literal')
  const decoded = Buffer.from(encoded[1], 'base64').toString('utf8')
  assert.ok(decoded.startsWith('#!/usr/bin/env node'), 'and decodes back to the node script')
  assert.ok(decoded.includes('DSH_CLEANUP_DONE=1'), 'with its completion marker')
  assert.ok(decoded.includes('CNB_CLEANUP_TOKEN'), 'and it reads the token from the environment')

  const file = join(process.env.DSH_HOME, 'decoded.mjs')
  writeFileSync(file, decoded, 'utf8')
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  assert.equal(check.status, 0, `the decoded script must be valid JavaScript:\n${check.stderr}`)
}

// --- 3. 片段里没有任何明文令牌 -------------------------------------
{
  assert.ok(!/CNB_CLEANUP_TOKEN\s*=\s*['"]?[A-Za-z0-9]{10,}/.test(snippet), 'no token value is baked in')
  assert.ok(snippet.includes('CNB_CLEANUP_TOKEN:-'), 'it only refers to the variable')
}

// --- 4. 设置真的会影响生成的脚本 -----------------------------------
//
// 生成器把阈值写成常量塞进脚本；如果它读的是默认值而不是设置，云端与本机就会
// 用两套阈值 —— 那正是本功能最危险的失配。
{
  const strict = cleanupDaemonScript({
    settings: normalizeCleanupSettings({ enabled: true, maxAgeHours: 6, envMaxAgeHours: 3 }),
    apiOrigin: 'https://api.cnb.cool',
  })
  assert.match(strict, /"maxAgeHours": 6/, 'the repo window comes from settings')
  assert.match(strict, /"envMaxAgeHours": 3/, 'and so does the environment window')
  // 已经没有 scope/prefix 这类会扩大清理范围的字段了 —— 只认云网关仓库。
  assert.ok(!strict.includes('"scope"'), 'no scope field: automatic cleanup only ever targets gateway repos')
  const loose = cleanupDaemonScript({
    settings: normalizeCleanupSettings({ enabled: true, maxAgeHours: 72 }),
    apiOrigin: 'https://api.cnb.cool',
  })
  assert.match(loose, /"maxAgeHours": 72/, 'and a different setting produces a different script')
}

// --- 5. 保护名单进入脚本 -------------------------------------------
{
  const script = cleanupDaemonScript({
    settings: normalizeCleanupSettings({ enabled: true }),
    activeRepo: 'acme/gateway-repo',
    extraProtected: ['acme/keep-me'],
    selfRepo: 'acme/self',
    apiOrigin: 'https://api.cnb.cool',
  })
  assert.match(script, /acme\/gateway-repo/, 'the gateway carrier is baked in')
  assert.match(script, /acme\/keep-me/, 'as is every extra protected repo')
  assert.match(script, /acme\/self/, 'and the repo dsh itself runs in')
}

console.log('cleanup-cronfile OK · 片段是合法 YAML、脚本能解回并通过语法检查、阈值来自设置')
