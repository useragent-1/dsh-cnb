/**
 * 会话模型选择的对齐。
 *
 * 为什么需要它：DSH 的模型选择是**按会话**记住的。configEditor 写好了 provider、
 * `agent-default-model` 也指向了新路由，但一个老会话里存着上一个 provider，
 * 打开它仍然用老模型 —— 用户看到的就是「配好了，可对话还是原来那个」。
 *
 * 这里只做一件保守的事：**读、判断、报告**，不在进程外偷改会话文件。
 * 直接改 `storages/session_projcache` 里的 JSON 是不可行的 —— 运行中的进程持有
 * 内存状态并在下次落盘时覆盖回去（实测：手改后 3 个会话在 10 秒内被写回原值）。
 * 真正能改它的只有 DSH 自己的 `session.selectModel`（或界面上点一次）。
 *
 * 所以这个模块产出的是**可执行的结论**：哪些会话需要切、切到哪个模型、
 * 以及一条可以直接照做的指引。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 会话缓存目录相对 Harness home 的位置。 */
export const SESSION_CACHE = 'storages/session_projcache/sessions'

/**
 * 读出每个会话记住的模型选择。
 *
 * 会话文件是带版本号的状态文档，`modelSelection` 可能出现在任意深度，所以按
 * 深度优先找第一个带 `lastUsed` 的那个 —— 那是 UI 真正使用的字段。
 *
 * @param {{ home: string }} input
 * @returns {Array<{ id: string, provider: string, model: string, mtime: number }>}
 */
export function readSessionSelections(input) {
  const dir = join(input.home, SESSION_CACHE)
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const rows = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(dir, name)
    let text
    let mtime = 0
    try {
      text = readFileSync(path, 'utf8')
      mtime = statSync(path).mtimeMs
    } catch {
      continue
    }
    let doc
    try {
      doc = JSON.parse(text)
    } catch {
      continue
    }
    const seen = new Set()
    let found = null
    const walk = (node) => {
      if (found !== null || node === null || typeof node !== 'object') return
      if (seen.has(node)) return
      seen.add(node)
      const candidate = node.modelSelection?.val?.lastUsed
      if (candidate && typeof candidate.provider === 'string' && typeof candidate.model === 'string') {
        found = candidate
        return
      }
      for (const key of Object.keys(node)) walk(node[key])
    }
    walk(doc)
    if (found === null) continue
    rows.push({
      id: name.replace(/\.json$/, ''),
      provider: found.provider,
      model: found.model,
      mtime,
    })
  }
  return rows
}

/**
 * 判断哪些会话需要切到新路由。
 *
 * 只挑「记着别的 provider」的那些。已经在新路由上的不动 —— 用户可能在某个会话里
 * 特意选了另一个模型，那个选择是对的。
 *
 * @param {{ home: string, route: string, availableModels?: string[] }} input
 * @returns {{ total: number, onRoute: number, elsewhere: Array<{ id: string, provider: string, model: string }>, staleModel: Array<{ id: string, provider: string, model: string }> }}
 */
export function surveySessionSelections(input) {
  const rows = readSessionSelections({ home: input.home })
  const available = Array.isArray(input.availableModels) ? new Set(input.availableModels) : null
  const elsewhere = []
  const staleModel = []
  let onRoute = 0
  for (const row of rows) {
    if (row.provider !== input.route) {
      elsewhere.push({ id: row.id, provider: row.provider, model: row.model })
      continue
    }
    // 在新路由上，但模型已经不在清单里（网关重建后清单会变），这个会话一开口就失败。
    if (available !== null && !available.has(row.model)) {
      staleModel.push({ id: row.id, provider: row.provider, model: row.model })
      continue
    }
    onRoute += 1
  }
  return { total: rows.length, onRoute, elsewhere, staleModel }
}

/**
 * 对人说清楚「差最后一步」。
 *
 * 写这段文字的理由：这个插件确实改不了会话选择（那需要 DSH 的 session 服务，
 * 而它不在插件的可用依赖里）。与其假装成功，不如把状态和两个可行操作讲明白 ——
 * 用户点一次模型选择器就好，或者在新会话里直接就是新模型。
 *
 * @param {{ route: string, model: string, survey: ReturnType<typeof surveySessionSelections> }} input
 */
export function describeSessionAdoption(input) {
  const { route, model, survey } = input
  if (survey.total === 0) {
    return { done: true, message: '还没有历史会话，新对话会直接用上这个模型。' }
  }
  const pending = survey.elsewhere.length + survey.staleModel.length
  if (pending === 0) {
    return { done: true, message: `${survey.total} 个会话都已指向 ${route}/${model}。` }
  }
  return {
    done: false,
    pending,
    message:
      `${survey.total} 个会话里有 ${pending} 个仍在使用别的 provider。`
      + `DSH 的模型选择按会话保存，插件改不到它（那要 session 服务）；`
      + `在那些会话里点一次模型选择器选 ${route}，或者开一个新会话 —— 新会话默认就是 ${route}/${model}。`,
  }
}
