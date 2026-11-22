/**
 * dsh-cnb Client half: the CNB panel.
 *
 * Everything here is presentation and polling; every CNB call, and the access
 * token itself, stay in the Host half behind `/dsh-cnb/api`. The browser never
 * receives the token.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cnb',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const PANEL_ID = 'dsh-cnb'
    const NS = 'dsh-cnb'

    const CSS = `
.dcnb-page{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}
.dcnb-head{display:flex;align-items:center;gap:10px;padding:16px 20px 12px}
.dcnb-head h1{margin:0;font-size:16px;font-weight:600;letter-spacing:.2px}
.dcnb-head p{margin:2px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dcnb-spacer{flex:1}
.dcnb-tabs{display:flex;gap:4px;padding:0 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.dcnb-tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;padding:8px 10px;border-radius:8px 8px 0 0;cursor:pointer;border-bottom:2px solid transparent}
.dcnb-tab[data-active=true]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary)}
.dcnb-body{flex:1;min-height:0;overflow:auto;padding:16px 20px 32px;display:flex;flex-direction:column;gap:14px}
.dcnb-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px}
.dcnb-card h2{margin:0 0 10px;font-size:13px;font-weight:600}
.dcnb-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.dcnb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.dcnb-muted{color:var(--dsw-alias-label-secondary)}
.dcnb-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.dcnb-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:6px 12px;border-radius:8px;cursor:pointer}
.dcnb-btn:hover{background:var(--dsw-alias-bg-overlay)}
.dcnb-btn[data-tone=primary]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.dcnb-btn[data-tone=danger]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dcnb-btn:disabled{opacity:.5;cursor:default}
.dcnb-input,.dcnb-select{box-sizing:border-box;font:inherit;font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);min-width:0}
.dcnb-input{flex:1}
.dcnb-qr{display:grid;place-items:center;padding:14px;background:#fff;border-radius:12px;width:fit-content}
.dcnb-qr svg{display:block}
.dcnb-banner{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:8px;font-size:12px;border:1px solid var(--dsw-alias-border-l1)}
.dcnb-banner[data-tone=error]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dcnb-banner[data-tone=ok]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dcnb-list{display:flex;flex-direction:column;gap:8px}
.dcnb-item{display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base)}
.dcnb-item .dcnb-main{flex:1;min-width:0}
.dcnb-item .dcnb-title{display:flex;gap:8px;align-items:center;font-weight:600;font-size:12.5px}
.dcnb-tag{font-size:10.5px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dcnb-tag[data-tone=ok]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dcnb-tag[data-tone=warn]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dcnb-tag[data-tone=err]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dcnb-meter{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin-top:6px}
.dcnb-meter span{display:block;height:100%;background:var(--dsw-alias-brand-primary)}
.dcnb-meter span[data-sev=warning]{background:var(--dsw-alias-state-warn-primary)}
.dcnb-meter span[data-sev=critical]{background:var(--dsw-alias-state-error-primary)}
.dcnb-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px}
.dcnb-kv dt{color:var(--dsw-alias-label-secondary)}
.dcnb-kv dd{margin:0;word-break:break-all}
.dcnb-empty{padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}
`

    // ---------------------------------------------------------------- helpers

    function readPath(source, path) {
      let node = source
      for (const key of path.split('.')) {
        if (node === null || node === undefined) return undefined
        node = node[key]
      }
      return node
    }

    /** The API base follows the module's own origin, so a reverse proxy prefix keeps working. */
    function apiBase() {
      return '/dsh-cnb/api'
    }

    async function callApi(op, input, method) {
      const response = await fetch(`${apiBase()}/${op}`, {
        method: method ?? (input === undefined ? 'GET' : 'POST'),
        credentials: 'same-origin',
        headers: input === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        body: input === undefined ? undefined : JSON.stringify(input),
      })
      const text = await response.text()
      let payload
      try {
        payload = text === '' ? {} : JSON.parse(text)
      } catch {
        throw new Error(`接口返回非 JSON：${text.slice(0, 200)}`)
      }
      if (!payload.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
      return payload.result
    }

    function formatBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
      let number = value
      let unit = 0
      while (number >= 1024 && unit < units.length - 1) {
        number /= 1024
        unit += 1
      }
      return `${number.toFixed(number >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`
    }

    function formatCoreSeconds(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const hours = value / 3600
      if (hours >= 1) return `${hours.toFixed(hours >= 100 ? 0 : 1)} 核时`
      return `${Math.round(value)} 核秒`
    }

    function formatCredit(milli) {
      if (typeof milli !== 'number' || !Number.isFinite(milli)) return '—'
      return `${(milli / 1000).toFixed(2)} credit`
    }

    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      const seconds = Math.round(ms / 1000)
      if (seconds < 60) return `${seconds}s`
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `${minutes}m${seconds % 60}s`
      return `${Math.floor(minutes / 60)}h${minutes % 60}m`
    }

    function formatMetric(metric, value) {
      if (value === null || value === undefined) return '—'
      if (metric.unit === 'byte') return formatBytes(value)
      if (metric.unit === 'credit') return formatCredit(value)
      return formatCoreSeconds(value)
    }

    // ------------------------------------------------------------------ atoms

    function Banner({ tone = 'error', children }) {
      return h('div', { className: 'dcnb-banner', 'data-tone': tone }, h('span', null, children))
    }

    function Card({ title, extra, children }) {
      return h(
        'section',
        { className: 'dcnb-card' },
        title === undefined
          ? null
          : h('div', { className: 'dcnb-row' }, h('h2', null, title), h('span', { className: 'dcnb-spacer' }), extra),
        children,
      )
    }

    function QrCode({ qr }) {
      if (!qr || typeof qr.path !== 'string') return null
      return h(
        'div',
        { className: 'dcnb-qr' },
        h(
          'svg',
          { width: qr.size, height: qr.size, viewBox: `0 0 ${qr.size} ${qr.size}`, role: 'img', 'aria-label': 'CNB 扫码登录二维码' },
          h('rect', { width: qr.size, height: qr.size, fill: '#ffffff' }),
          h('path', { d: qr.path, fill: '#111111' }),
        ),
      )
    }

    function Spinner({ label }) {
      return h('div', { className: 'dcnb-empty' }, label ?? '加载中…')
    }

    // ------------------------------------------------------------------ hooks

    function useApiState(loader, deps) {
      const [state, setState] = useState({ status: 'idle', data: null, error: null })
      const [nonce, setNonce] = useState(0)
      const reload = useCallback(() => setNonce((value) => value + 1), [])
      useEffect(() => {
        let cancelled = false
        setState((previous) => ({ status: 'loading', data: previous.data, error: null }))
        loader()
          .then((data) => {
            if (!cancelled) setState({ status: 'ready', data, error: null })
          })
          .catch((error) => {
            if (!cancelled) setState({ status: 'error', data: null, error: error.message })
          })
        return () => {
          cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [...deps, nonce])
      return { ...state, reload }
    }

    /** Service names the doctor reports, in the panel's own words. */
    /**
     * How each probe is presented: what it means to the person, not the endpoint
     * name. `kind` separates reads from writes so the list can group them, and
     * `summary` turns the raw probe payload into one readable line.
     */
    const CHECK_META = {
      identity: { label: '账号身份', kind: 'read', summary: (v) => (v?.username ? `${v.nickname || v.username}（${v.username}）` : '已登录') },
      repositories: { label: '仓库列表', kind: 'read', summary: (v) => `${v?.total ?? 0} 个仓库${v?.first ? ` · ${v.first}` : ''}` },
      organizations: { label: '组织列表', kind: 'read', summary: (v) => `${v?.count ?? 0} 个组织${(v?.slugs ?? []).length ? ` · ${v.slugs.join('、')}` : ''}` },
      quota: {
        label: '组织额度与用量',
        kind: 'read',
        summary: (v) => (v?.skipped ? '跳过：没有组织' : `${v?.slug ?? ''} · 额度${v?.hasQuota ? '✓' : '✗'} 用量${v?.hasUsage ? '✓' : '✗'}`),
      },
      workspaces: { label: '开发环境列表', kind: 'read', summary: (v) => `${v?.total ?? 0} 个环境` },
      'workspace-control': {
        label: '停止环境',
        kind: 'write',
        summary: (v) => (v?.via === 'build' ? '经仓库级流水线停止（账号级接口不可用）' : '账号级接口可用'),
      },
      'repo-create': { label: '新建仓库', kind: 'write', summary: (v) => (v?.slug ? `探测组织 ${v.slug}` : '组织级接口可用') },
      'repo-delete': { label: '删除仓库', kind: 'write', summary: () => '仓库级接口可用' },
    }

    /** One line: how much of the panel actually works. */
    function DoctorSummary({ doctor }) {
      const checks = doctor.checks ?? []
      const ok = checks.filter((check) => check.ok).length
      const failed = checks.filter((check) => !check.ok)
      const reads = checks.filter((check) => CHECK_META[check.name]?.kind !== 'write')
      const writes = checks.filter((check) => CHECK_META[check.name]?.kind === 'write')
      const countOk = (list) => list.filter((check) => check.ok).length
      return h(
        'div',
        { className: 'dcnb-row', style: { gap: 14, marginBottom: 10 } },
        h(
          'span',
          { className: 'dcnb-tag', 'data-tone': failed.length === 0 ? 'ok' : failed.length === checks.length ? 'err' : 'warn' },
          failed.length === 0 ? '全部可用' : `${ok}/${checks.length} 可用`,
        ),
        h('span', { className: 'dcnb-muted' }, `读取 ${countOk(reads)}/${reads.length}`),
        h('span', { className: 'dcnb-muted' }, `写入 ${countOk(writes)}/${writes.length}`),
        doctor.rejected === true ? h('span', { className: 'dcnb-tag', 'data-tone': 'err' }, '令牌无效') : null,
      )
    }

    /** A probe row: name, verdict, and one readable line — never raw JSON. */
    function DoctorRow({ check }) {
      const meta = CHECK_META[check.name] ?? { label: check.name, kind: 'read', summary: () => '' }
      // A scope refusal is the common failure; show only the scope names, not the
      // whole guidance sentence, which already appears once below the list.
      const scopes = check.missingScopes ?? []
      // A capability reached through a fallback is available but not the full
      // thing, so it gets its own tone instead of reading as plain success.
      const degraded = check.ok && check.value?.via === 'build'
      const tone = check.ok ? (degraded ? 'warn' : 'ok') : scopes.length > 0 ? 'warn' : 'err'
      const verdict = check.ok ? (degraded ? '降级可用' : '可用') : scopes.length > 0 ? '受限' : '失败'
      const detail = check.ok
        ? meta.summary(check.value ?? {})
        : scopes.length > 0
          ? `缺少 ${scopes.join('、')}`
          : check.error ?? '失败'
      return h(
        'div',
        { className: 'dcnb-item' },
        h(
          'div',
          { className: 'dcnb-main' },
          h(
            'div',
            { className: 'dcnb-title' },
            h('span', null, meta.label),
            h('span', { className: 'dcnb-tag', 'data-tone': tone }, verdict),
          ),
          h('div', { className: 'dcnb-muted', style: { marginTop: 2, wordBreak: 'break-word' } }, detail),
          check.ok && meta.summary(check.value ?? {}).length === 0
            ? h('div', { className: 'dcnb-mono', style: { marginTop: 2 } }, JSON.stringify(check.value))
            : null,
        ),
      )
    }

    /**
     * The whole self-check: a one-line verdict, the probes grouped by read/write,
     * one guidance sentence, and the exact rows to tick when something is missing.
     */
    function DoctorReport({ doctor }) {
      if (doctor.signedIn === false) {
        return h(Banner, { tone: 'error' }, doctor.hint ?? '尚未登录：请先扫码登录，或粘贴一个访问令牌。')
      }
      const checks = doctor.checks ?? []
      const reads = checks.filter((check) => CHECK_META[check.name]?.kind !== 'write')
      const writes = checks.filter((check) => CHECK_META[check.name]?.kind === 'write')
      const group = (title, rows) =>
        rows.length === 0
          ? null
          : h(
              'div',
              { style: { marginTop: 10 } },
              h('div', { className: 'dcnb-muted', style: { fontSize: 11, marginBottom: 4 } }, title),
              h('div', { className: 'dcnb-list' }, rows.map((check) => h(DoctorRow, { key: check.name, check }))),
            )
      return h(
        React.Fragment,
        null,
        h(DoctorSummary, { doctor }),
        group('读取', reads),
        group('写入', writes),
        doctor.hint === null || doctor.hint === undefined ? null : h(Banner, { tone: doctor.healthy ? 'ok' : 'error' }, doctor.hint),
        (doctor.grants ?? []).length === 0
          ? null
          : h(
              'div',
              { style: { marginTop: 10 } },
              h('div', { className: 'dcnb-muted', style: { fontSize: 11, marginBottom: 4 } }, '去 CNB 令牌页勾选：'),
              (doctor.grants ?? []).map((grant) =>
                h(
                  'div',
                  { key: grant.scope, className: 'dcnb-row', style: { padding: '3px 0' } },
                  h('span', { className: 'dcnb-tag' }, grant.label),
                  h('span', { className: 'dcnb-muted', style: { flex: 1, minWidth: 120 } }, grant.meaning ?? grant.scope),
                  h(
                    'a',
                    { className: 'dcnb-btn', href: grant.url, target: '_blank', rel: 'noreferrer noopener', style: { textDecoration: 'none' } },
                    '打开令牌页',
                  ),
                ),
              ),
            ),
      )
    }

    // ------------------------------------------------------------------- tabs

    function AccountTab({ status, onRefresh }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [attempt, setAttempt] = useState(status?.pending ?? null)
      const [message, setMessage] = useState(null)
      const [tokenValue, setTokenValue] = useState('')
      const [doctor, setDoctor] = useState(null)
      const [doctorBusy, setDoctorBusy] = useState(false)
      const timer = useRef(null)

      const stopPolling = useCallback(() => {
        if (timer.current !== null) {
          clearTimeout(timer.current)
          timer.current = null
        }
      }, [])

      useEffect(() => () => stopPolling(), [stopPolling])

      const poll = useCallback(async () => {
        try {
          const result = await callApi('login.poll', {})
          if (result.state === 'confirmed') {
            stopPolling()
            setAttempt(null)
            const who = result.login?.user?.nickname ?? result.login?.user?.username ?? 'CNB 账号'
            const check = result.verification
            if (check !== null && check !== undefined && !check.ok) {
              // Every profile was tried and none produced a usable token. Say that,
              // and say what was asked for, so this reads as a platform-side limit
              // rather than a silent success.
              const attempts = (result.tried ?? []).map((entry) => entry.profile).join(' → ')
              setError(
                `已登录 ${who}，但签出的令牌都无法读取账号（已依次尝试：${attempts || '全权限'}）。` +
                  '这说明账号角色限制了可授予的权限，不是令牌格式问题。' +
                  '请在 CNB 令牌页确认账号在这些组织里的角色，或直接粘贴一个能用的令牌。',
              )
            } else {
              const profile = result.login?.scopeProfile
              const label = profile === 'full' ? '全权限' : profile === 'plugin' ? '插件所需权限' : profile ? '最小权限' : '权限'
              setMessage(`已登录：${who}，已取得${label}令牌，自检通过`)
            }
            onRefresh()
          } else if (result.state === 'expired') {
            stopPolling()
            setAttempt(null)
            setError('二维码已失效，请重新生成')
          } else {
            timer.current = setTimeout(poll, 2000)
          }
        } catch (pollError) {
          stopPolling()
          setError(pollError.message)
        }
      }, [onRefresh, stopPolling])

      const begin = useCallback(async () => {
        setError(null)
        setMessage(null)
        setBusy(true)
        try {
          const view = await callApi('login.begin', {})
          setAttempt(view)
          stopPolling()
          timer.current = setTimeout(poll, 1500)
        } catch (beginError) {
          setError(beginError.message)
        } finally {
          setBusy(false)
        }
      }, [poll, stopPolling])

      const logout = useCallback(async () => {
        setBusy(true)
        setError(null)
        try {
          stopPolling()
          setAttempt(null)
          await callApi('login.logout', {})
          setMessage('已退出登录，本地令牌已清除')
          onRefresh()
        } catch (logoutError) {
          setError(logoutError.message)
        } finally {
          setBusy(false)
        }
      }, [onRefresh, stopPolling])

      const runDoctor = useCallback(async () => {
        setDoctorBusy(true)
        setError(null)
        try {
          setDoctor({ ...(await callApi('token.doctor', {})), ranAt: Date.now() })
        } catch (doctorError) {
          setError(doctorError.message)
        } finally {
          setDoctorBusy(false)
        }
      }, [])

      const importToken = useCallback(async () => {
        if (tokenValue.trim() === '') return
        setBusy(true)
        setError(null)
        try {
          const result = await callApi('login.importToken', { token: tokenValue.trim() })
          setTokenValue('')
          setMessage(`已导入令牌：${result.login?.user?.nickname ?? result.login?.user?.username ?? 'CNB 账号'}`)
          onRefresh()
        } catch (importError) {
          setError(importError.message)
        } finally {
          setBusy(false)
        }
      }, [onRefresh, tokenValue])

      const user = status?.user
      const account = status?.account

      return h(
        React.Fragment,
        null,
        error === null ? null : h(Banner, null, error),
        message === null ? null : h(Banner, { tone: 'ok' }, message),
        h(
          Card,
          { title: '账号' },
          status?.loggedIn
            ? h(
                React.Fragment,
                null,
                h(
                  'dl',
                  { className: 'dcnb-kv' },
                  h('dt', null, '昵称'),
                  h('dd', null, user?.nickname || user?.username || '（未取得）'),
                  h('dt', null, '用户名'),
                  h('dd', { className: 'dcnb-mono' }, user?.username ?? '—'),
                  h('dt', null, '登录时间'),
                  h('dd', null, account?.loginAt === null || account?.loginAt === undefined ? '—' : new Date(account.loginAt).toLocaleString()),
                  h('dt', null, '令牌过期'),
                  h('dd', null, account?.expiredAt ? new Date(account.expiredAt).toLocaleString() : '长期有效'),
                  h('dt', null, '自动续签'),
                  h(
                    'dd',
                    null,
                    status?.sessionStored
                      ? `已保存登录会话${status.sessionAge ? `（${new Date(status.sessionAge).toLocaleString()}）` : ''}，令牌失效会自动重签，无需再扫码`
                      : '未保存会话：下次令牌失效需要重新扫码',
                  ),
                ),
                h(
                  'div',
                  { className: 'dcnb-row', style: { marginTop: 12 } },
                  h('button', { className: 'dcnb-btn', onClick: onRefresh, disabled: busy }, '刷新'),
                  h('button', { className: 'dcnb-btn', 'data-tone': 'danger', onClick: logout, disabled: busy }, '退出登录'),
                ),
              )
            : h(
                React.Fragment,
                null,
                h(
                  'p',
                  { className: 'dcnb-muted', style: { margin: '0 0 10px' } },
                  status?.ambientToken
                    ? '检测到环境变量 CNB_TOKEN，但尚未在本插件登录；扫码后可写入凭证记录并接管。'
                    : '使用微信扫码登录 CNB。扫码确认后插件会自动创建访问令牌并保存到本机凭证库，不再展示明文。',
                ),
                h('button', { className: 'dcnb-btn', 'data-tone': 'primary', onClick: begin, disabled: busy }, busy ? '处理中…' : '扫码登录'),
              ),
        ),
        status?.health === 'no-permission'
          ? h(
              Banner,
              { tone: 'error' },
              `已保存令牌，但 CNB 判定它没有任何权限${status.healthDetail ? `：${status.healthDetail}` : ''}。` +
                '常见原因是令牌按不带级别的授权项创建（CNB 会丢弃这种授权）。点下面的「重新扫码」拿到全权限令牌。',
            )
          : null,
        status?.loggedIn
          ? h(
              Card,
              {
                title: '令牌自检',
                extra: h(
                  'div',
                  { className: 'dcnb-row', style: { gap: 10 } },
                  doctor === null
                    ? null
                    : h('span', { className: 'dcnb-muted', style: { fontSize: 11 } }, `上次检测 ${new Date(doctor.ranAt ?? Date.now()).toLocaleTimeString()}`),
                  h(
                    'button',
                    { className: 'dcnb-btn', disabled: doctorBusy, onClick: runDoctor },
                    doctorBusy ? '检测中…' : doctor === null ? '开始检测' : '重新检测',
                  ),
                ),
              },
              doctor === null
                ? h('p', { className: 'dcnb-muted', style: { margin: 0 } }, `逐个探测面板用到的 ${Object.keys(CHECK_META).length} 个接口（读 5 项、写 3 项），指出缺哪个权限项。`)
                : h(DoctorReport, { doctor }),
            )
          : null,
        attempt
          ? h(
              Card,
              { title: '用微信扫码' },
              h(
                'div',
                { className: 'dcnb-row', style: { alignItems: 'flex-start' } },
                h(QrCode, { qr: attempt.qr }),
                h(
                  'div',
                  { style: { flex: 1, minWidth: 180 } },
                  h('p', { className: 'dcnb-muted', style: { margin: '0 0 8px' } }, '在微信中扫码，并在手机上确认登录；本面板每 2 秒自动轮询一次。'),
                  h('p', { className: 'dcnb-mono', style: { margin: '0 0 8px', wordBreak: 'break-all' } }, attempt.ticketUrl ?? ''),
                  h('button', { className: 'dcnb-btn', onClick: begin, disabled: busy }, '换一张二维码'),
                ),
              ),
            )
          : null,
        h(
          Card,
          { title: '已有访问令牌？' },
          h(
            'div',
            { className: 'dcnb-row' },
            h('input', {
              className: 'dcnb-input',
              type: 'password',
              placeholder: '粘贴 CNB 访问令牌（https://cnb.cool/profile/token）',
              value: tokenValue,
              onChange: (event) => setTokenValue(event.target.value),
            }),
            h('button', { className: 'dcnb-btn', onClick: importToken, disabled: busy || tokenValue.trim() === '' }, '导入'),
          ),
          h('p', { className: 'dcnb-muted', style: { margin: '8px 0 0' } }, '令牌保存在 dsh 的凭证库中，不会写进 cordis.patch.yml。'),
        ),
      )
    }

    function ReposTab({ status }) {
      const [query, setQuery] = useState('')
      const [draft, setDraft] = useState({ slug: '', name: '', visibility: 'private', description: '' })
      const [actionError, setActionError] = useState(null)
      const [actionMessage, setActionMessage] = useState(null)
      const [busy, setBusy] = useState(false)
      const repos = useApiState(() => callApi('repos.list', {}), [])
      const groups = useApiState(() => callApi('usage.list', {}), [])

      const items = useMemo(() => {
        const all = repos.data?.items ?? []
        const needle = query.trim().toLowerCase()
        return needle === '' ? all : all.filter((repo) => String(repo.slug).toLowerCase().includes(needle))
      }, [repos.data, query])

      const act = useCallback(
        async (label, fn) => {
          setBusy(true)
          setActionError(null)
          setActionMessage(null)
          try {
            const result = await fn()
            setActionMessage(`${label}成功${result?.slug ? `：${result.slug}` : ''}`)
            repos.reload()
          } catch (error) {
            setActionError(error.message)
          } finally {
            setBusy(false)
          }
        },
        [repos],
      )

      if (!status?.loggedIn) return h(Banner, { tone: 'error' }, '请先在「账号」页扫码登录 CNB')

      return h(
        React.Fragment,
        null,
        actionError === null ? null : h(Banner, null, actionError),
        actionMessage === null ? null : h(Banner, { tone: 'ok' }, actionMessage),
        h(
          Card,
          {
            title: `我的仓库 (${repos.data?.total ?? items.length})`,
            extra: h('button', { className: 'dcnb-btn', onClick: repos.reload }, '刷新'),
          },
          h(
            'div',
            { className: 'dcnb-row', style: { marginBottom: 10 } },
            h('input', {
              className: 'dcnb-input',
              placeholder: '过滤仓库路径',
              value: query,
              onChange: (event) => setQuery(event.target.value),
            }),
          ),
          repos.status === 'loading' && repos.data === null
            ? h(Spinner)
            : items.length === 0
              ? h('div', { className: 'dcnb-empty' }, '没有匹配的仓库')
              : h(
                  'div',
                  { className: 'dcnb-list' },
                  items.map((repo) =>
                    h(
                      'div',
                      { key: repo.slug, className: 'dcnb-item' },
                      h(
                        'div',
                        { className: 'dcnb-main' },
                        h(
                          'div',
                          { className: 'dcnb-title' },
                          h('span', null, repo.slug),
                          h('span', { className: 'dcnb-tag' }, repo.visibility ?? '—'),
                          repo.environments.length > 0
                            ? h('span', { className: 'dcnb-tag', 'data-tone': 'ok' }, `${repo.environments.length} 个环境`)
                            : null,
                        ),
                        h('div', { className: 'dcnb-muted', style: { marginTop: 2 } }, repo.description || '（无描述）'),
                      ),
                      h(
                        'div',
                        { className: 'dcnb-row' },
                        h(
                          'button',
                          {
                            className: 'dcnb-btn',
                            disabled: busy,
                            onClick: () =>
                            act('启动开发环境', async () => {
                              const started = await callApi('workspaces.open', { repo: repo.slug })
                              if (typeof started.url === 'string') window.open(started.url, '_blank', 'noopener')
                              return started
                            }),
                          },
                          '启动开发',
                        ),
                        h(
                          'button',
                          {
                            className: 'dcnb-btn',
                            'data-tone': 'danger',
                            disabled: busy,
                            onClick: () => {
                              if (!window.confirm(`确定删除 ${repo.slug}？该操作会删除仓库全部数据。`)) return
                              act('删除仓库', () => callApi('repos.delete', { repo: repo.slug, confirm: true }))
                            },
                          },
                          '删除',
                        ),
                      ),
                    ),
                  ),
                ),
        ),
        h(
          Card,
          { title: '新建仓库' },
          h(
            'div',
            { className: 'dcnb-grid' },
            h('input', {
              className: 'dcnb-input',
              placeholder: '组织 slug',
              list: 'dcnb-groups',
              value: draft.slug,
              onChange: (event) => setDraft({ ...draft, slug: event.target.value }),
            }),
            h('datalist', { id: 'dcnb-groups' }, (groups.data?.groups ?? []).map((group) => h('option', { key: group.slug, value: group.slug }))),
            h('input', {
              className: 'dcnb-input',
              placeholder: '仓库名',
              value: draft.name,
              onChange: (event) => setDraft({ ...draft, name: event.target.value }),
            }),
            h(
              'select',
              {
                className: 'dcnb-select',
                value: draft.visibility,
                onChange: (event) => setDraft({ ...draft, visibility: event.target.value }),
              },
              h('option', { value: 'private' }, '私有'),
              h('option', { value: 'public' }, '公开'),
              h('option', { value: 'secret' }, '密钥仓库'),
            ),
          ),
          h('input', {
            className: 'dcnb-input',
            style: { marginTop: 8, width: '100%' },
            placeholder: '仓库描述（可选）',
            value: draft.description,
            onChange: (event) => setDraft({ ...draft, description: event.target.value }),
          }),
          h(
            'div',
            { className: 'dcnb-row', style: { marginTop: 10 } },
            h(
              'button',
              {
                className: 'dcnb-btn',
                'data-tone': 'primary',
                disabled: busy || draft.slug.trim() === '' || draft.name.trim() === '',
                onClick: () =>
                  act('创建仓库', async () => {
                    const result = await callApi('repos.create', draft)
                    setDraft({ slug: draft.slug, name: '', visibility: 'private', description: '' })
                    return result
                  }),
              },
              '创建',
            ),
          ),
        ),
      )
    }

    function EnvironmentsTab({ status }) {
      const [repo, setRepo] = useState('')
      const [actionError, setActionError] = useState(null)
      const workspaces = useApiState(() => callApi('workspaces.list', {}), [])
      const detail = useApiState(
        () => (repo.trim() === '' ? Promise.resolve(null) : callApi('repos.status', { repo: repo.trim() })),
        [repo],
      )

      if (!status?.loggedIn) return h(Banner, { tone: 'error' }, '请先在「账号」页扫码登录 CNB')

      const act = useCallback(
        async (fn, label) => {
          setActionError(null)
          try {
            const result = await fn()
            workspaces.reload()
            if (repo.trim() !== '') detail.reload()
            if (result?.alreadyStopped === true) setActionError(`${label}：该环境已经结束`)
            else if (result?.via === 'build') setActionError(`${label}已提交（经仓库级流水线停止）`)
            else setActionError(`${label}已提交`)
          } catch (error) {
            setActionError(error.message)
          }
        },
        [detail, repo, workspaces],
      )

      /** Resolve the environment's WebIDE URL, then hand it to the browser. */
      const openEnvironment = useCallback(
        async (slug, sn) => {
          setActionError(null)
          try {
            const result = await callApi('workspaces.detail', { repo: slug, sn })
            const url = result?.detail?.webide ?? result?.detail?.jumpUrl
            if (typeof url !== 'string' || url === '') throw new Error('该环境暂无可用地址')
            window.open(url, '_blank', 'noopener')
          } catch (error) {
            setActionError(error.message)
          }
        },
        [],
      )

      const environments = detail.data?.environments ?? []
      const button = detail.data?.workspace

      return h(
        React.Fragment,
        null,
        actionError === null ? null : h(Banner, null, actionError),
        h(
          Card,
          {
            title: `我的开发环境 (${workspaces.data?.total ?? 0})`,
            extra: h('button', { className: 'dcnb-btn', onClick: workspaces.reload }, '刷新'),
          },
          workspaces.status === 'loading' && workspaces.data === null
            ? h(Spinner)
            : (workspaces.data?.items ?? []).length === 0
              ? h('div', { className: 'dcnb-empty' }, '当前没有云原生开发环境')
              : h(
                  'div',
                  { className: 'dcnb-list' },
                  (workspaces.data?.items ?? []).map((workspace) =>
                    h(
                      'div',
                      { key: workspace.pipeline_id ?? workspace.sn, className: 'dcnb-item' },
                      h(
                        'div',
                        { className: 'dcnb-main' },
                        h(
                          'div',
                          { className: 'dcnb-title' },
                          h('span', null, workspace.slug),
                          h(
                            'span',
                            { className: 'dcnb-tag', 'data-tone': workspace.status === 'running' ? 'ok' : undefined },
                            workspace.status === 'running' ? '运行中' : '已关闭',
                          ),
                          h('span', { className: 'dcnb-tag' }, workspace.branch ?? '—'),
                        ),
                        h(
                          'div',
                          { className: 'dcnb-muted', style: { marginTop: 2 } },
                          `${workspace.sn ?? '—'} · 已运行 ${formatDuration(workspace.duration)}`,
                        ),
                      ),
                      h(
                        'div',
                        { className: 'dcnb-row' },
                        h(
                          'button',
                          { className: 'dcnb-btn', onClick: () => openEnvironment(workspace.slug, workspace.sn) },
                          '打开',
                        ),
                        h(
                          'button',
                          {
                            className: 'dcnb-btn',
                            onClick: () => act(() => callApi('workspaces.stop', { repo: workspace.slug, sn: workspace.sn }), '停止环境'),
                          },
                          '停止',
                        ),
                        h(
                          'button',
                          {
                            className: 'dcnb-btn',
                            'data-tone': 'danger',
                            onClick: () => {
                              if (!window.confirm(`确定删除环境 ${workspace.sn}？`)) return
                              act(() => callApi('workspaces.delete', { repo: workspace.slug, sn: workspace.sn }), '删除环境')
                            },
                          },
                          '删除',
                        ),
                      ),
                    ),
                  ),
                ),
        ),
        h(
          Card,
          { title: '仓库开发按钮与状态' },
          h(
            'div',
            { className: 'dcnb-row' },
            h('input', {
              className: 'dcnb-input',
              placeholder: 'group/name',
              value: repo,
              onChange: (event) => setRepo(event.target.value),
            }),
            h('button', { className: 'dcnb-btn', disabled: repo.trim() === '', onClick: detail.reload }, '查询'),
            h(
              'button',
              {
                className: 'dcnb-btn',
                'data-tone': 'primary',
                disabled: repo.trim() === '',
                onClick: () =>
                  act(async () => {
                    const started = await callApi('workspaces.open', { repo: repo.trim() })
                    if (typeof started.url === 'string') window.open(started.url, '_blank', 'noopener')
                    return started
                  }, '启动开发环境'),
              },
              '启动开发',
            ),
          ),
          detail.status === 'error' ? h(Banner, null, detail.error) : null,
          detail.data === null
            ? null
            : h(
                React.Fragment,
                null,
                h(
                  'dl',
                  { className: 'dcnb-kv', style: { marginTop: 10 } },
                  h('dt', null, '仓库'),
                  h('dd', null, detail.data.info?.name ?? '—'),
                  h('dt', null, '默认分支'),
                  h('dd', null, detail.data.info?.defaultBranch ?? '—'),
                  h('dt', null, '最近构建'),
                  h('dd', null, detail.data.builds?.items?.[0]?.sn ?? '—'),
                  h('dt', null, '按钮来源'),
                  h(
                    'dd',
                    null,
                    button?.found
                      ? `.cnb/settings.yml @ ${button.ref}`
                      : button?.error
                        ? `读取失败：${button.error}`
                        : '未配置（使用平台默认按钮）',
                  ),
                  h('dt', null, '按钮名称'),
                  h('dd', null, button?.config?.button?.name ?? '—'),
                  h('dt', null, '按钮描述'),
                  h('dd', null, button?.config?.button?.description ?? '—'),
                  h('dt', null, 'CPU'),
                  h('dd', null, button?.config?.cpus === null || button?.config?.cpus === undefined ? '默认' : `${button.config.cpus} 核`),
                  h('dt', null, '禁用'),
                  h('dd', null, button?.config?.disabled === true ? '是' : button?.config?.disabled === false ? '否' : '—'),
                ),
                environments.length === 0
                  ? null
                  : h(
                      'div',
                      { style: { marginTop: 10 } },
                      h('div', { className: 'dcnb-muted' }, '该仓库的环境：'),
                      environments.map((environment) =>
                        h(
                          'div',
                          { key: environment.pipeline_id ?? environment.sn, className: 'dcnb-row', style: { marginTop: 6 } },
                          h('span', { className: 'dcnb-mono' }, environment.sn ?? environment.pipeline_id),
                          h('span', { className: 'dcnb-tag' }, environment.status ?? '—'),
                          h('span', { className: 'dcnb-muted' }, environment.branch ?? ''),
                          h(
                            'button',
                            {
                              className: 'dcnb-btn',
                              onClick: () => {
                                setSelected(environment.sn ?? '')
                                act(
                                  () => callApi('workspaces.detail', { repo: repo.trim(), sn: environment.sn }),
                                  '读取环境地址',
                                )
                              },
                            },
                            '地址',
                          ),
                        ),
                      ),
                    ),
              ),
        ),
      )
    }

    function UsageTab({ status }) {
      const usage = useApiState(() => callApi('usage.list', {}), [])
      if (!status?.loggedIn) return h(Banner, { tone: 'error' }, '请先在「账号」页扫码登录 CNB')
      if (usage.status === 'loading' && usage.data === null) return h(Spinner, { label: '读取用量…' })
      if (usage.status === 'error') return h(Banner, null, usage.error)

      const groups = usage.data?.groups ?? []
      if (groups.length === 0) return h('div', { className: 'dcnb-empty' }, '没有可读取的组织')

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dcnb-row' },
          h('span', { className: 'dcnb-muted' }, `统计月份 ${usage.data?.month ?? '—'}`),
          h('span', { className: 'dcnb-spacer' }),
          h('button', { className: 'dcnb-btn', onClick: usage.reload }, '刷新'),
        ),
        groups.map((group) =>
          h(
            Card,
            { key: group.slug, title: group.slug },
            h(
              'div',
              { className: 'dcnb-grid' },
              (group.metrics ?? []).map((metric) =>
                h(
                  'div',
                  { key: metric.id, style: { minWidth: 140 } },
                  h('div', { className: 'dcnb-muted', style: { fontSize: 11 } }, metric.label),
                  h(
                    'div',
                    { style: { fontWeight: 600 } },
                    `${formatMetric(metric, metric.used)} / ${formatMetric(metric, metric.total)}`,
                  ),
                  h(
                    'div',
                    { className: 'dcnb-meter', title: metric.ratio === null ? '无可比额度' : `${Math.round(metric.ratio * 100)}%` },
                    h('span', {
                      'data-sev': metric.severity,
                      style: { width: `${metric.ratio === null ? 0 : Math.min(100, Math.round(metric.ratio * 100))}%` },
                    }),
                  ),
                ),
              ),
            ),
            group.used?.error
              ? h('p', { className: 'dcnb-muted', style: { margin: '8px 0 0' } }, `用量不可读：${group.used.error}`)
              : null,
            (group.repos ?? []).length === 0
              ? null
              : h(
                  'details',
                  { style: { marginTop: 10 } },
                  h('summary', { className: 'dcnb-muted', style: { cursor: 'pointer' } }, `仓库用量 Top ${Math.min(8, group.repos.length)}`),
                  h(
                    'div',
                    { style: { marginTop: 8 } },
                    group.repos.slice(0, 8).map((row) =>
                      h(
                        'div',
                        { key: row.slug, className: 'dcnb-row', style: { justifyContent: 'space-between', padding: '2px 0' } },
                        h('span', { className: 'dcnb-mono' }, row.slug),
                        h('span', { className: 'dcnb-muted' }, formatBytes(Number(row.volume))),
                      ),
                    ),
                  ),
                ),
          ),
        ),
      )
    }

    function GatewayTab({ status }) {
      const [repo, setRepo] = useState('')
      const [model, setModel] = useState('deepseek-v4.1-flash')
      const [route, setRoute] = useState('cnb-gateway')
      const [makeDefault, setMakeDefault] = useState(true)
      const [probe, setProbe] = useState(null)
      const [error, setError] = useState(null)
      const [message, setMessage] = useState(null)
      const [overlay, setOverlay] = useState(null)
      const [busy, setBusy] = useState(false)

      const runProbe = useCallback(async () => {
        setBusy(true)
        setError(null)
        setMessage(null)
        setProbe(null)
        try {
          setProbe(await callApi('gateway.probe', { repo: repo.trim(), model }))
        } catch (probeError) {
          setError(probeError.message)
        } finally {
          setBusy(false)
        }
      }, [model, repo])

      const configure = useCallback(async () => {
        setBusy(true)
        setError(null)
        setMessage(null)
        setOverlay(null)
        try {
          const result = await callApi('gateway.configure', {
            repo: repo.trim(),
            route: route.trim() || 'cnb-gateway',
            model: model.trim(),
            makeDefault,
          })
          if (result.overlay !== null && result.overlay !== undefined) {
            setOverlay(result.overlay)
          } else {
            setMessage(
              `已写入 llm-pi-ai 路由 ${result.route}（${result.baseURL}）` +
                (result.defaultModel ? `，并设为默认模型 ${result.defaultModel.provider}/${result.defaultModel.model}` : ''),
            )
          }
        } catch (configureError) {
          setError(configureError.message)
        } finally {
          setBusy(false)
        }
      }, [makeDefault, model, repo, route])

      if (!status?.loggedIn) return h(Banner, { tone: 'error' }, '请先在「账号」页扫码登录 CNB')

      return h(
        React.Fragment,
        null,
        error === null ? null : h(Banner, null, error),
        message === null ? null : h(Banner, { tone: 'ok' }, message),
        h(
          Card,
          { title: 'CNB 网关反代模型' },
          h(
            'p',
            { className: 'dcnb-muted', style: { margin: '0 0 10px' } },
            'CNB 的 AI 网关挂在仓库下（https://api.cnb.cool/<repo>/-/ai），只接受流式 Chat Completions。配置后会写入 llm-pi-ai 的 provider 路由，令牌通过 CNB_TOKEN 凭证引用解析。',
          ),
          h(
            'div',
            { className: 'dcnb-grid' },
            h('input', {
              className: 'dcnb-input',
              placeholder: '提供网关的仓库 group/name',
              value: repo,
              onChange: (event) => setRepo(event.target.value),
            }),
            h('input', {
              className: 'dcnb-input',
              placeholder: '模型 id',
              value: model,
              onChange: (event) => setModel(event.target.value),
            }),
            h('input', {
              className: 'dcnb-input',
              placeholder: 'provider 路由名',
              value: route,
              onChange: (event) => setRoute(event.target.value),
            }),
            h(
              'label',
              { className: 'dcnb-row', style: { gap: 6 } },
              h('input', { type: 'checkbox', checked: makeDefault, onChange: (event) => setMakeDefault(event.target.checked) }),
              h('span', null, '同时设为默认模型'),
            ),
          ),
          h(
            'div',
            { className: 'dcnb-row', style: { marginTop: 10 } },
            h('button', { className: 'dcnb-btn', disabled: busy || repo.trim() === '', onClick: runProbe }, '测试调用'),
            h('button', { className: 'dcnb-btn', 'data-tone': 'primary', disabled: busy || repo.trim() === '', onClick: configure }, '一键配置到 dsh'),
          ),
        ),
        probe === null
          ? null
          : h(
              Card,
              { title: `探测结果 · ${probe.repo ?? '—'}` },
              h(
                'dl',
                { className: 'dcnb-kv' },
                h('dt', null, '可调用'),
                h('dd', null, probe.reachable ? '是' : `否（${probe.reason ?? '未知原因'}）`),
                h('dt', null, 'baseURL'),
                h('dd', { className: 'dcnb-mono' }, probe.baseURL ?? '—'),
                h('dt', null, '模型'),
                h('dd', null, probe.model ?? '—'),
                h('dt', null, '返回采样'),
                h('dd', { className: 'dcnb-mono' }, probe.sample ?? '—'),
                h('dt', null, '思考内容'),
                h('dd', { className: 'dcnb-mono' }, probe.reasoning ? probe.reasoning : '—'),
                h('dt', null, '用量'),
                h('dd', { className: 'dcnb-mono' }, probe.usage ? JSON.stringify(probe.usage) : '—'),
              ),
            ),
        overlay === null
          ? null
          : h(
              Card,
              {
                title: '需要并入 overlay 配置',
                extra: h(
                  'button',
                  {
                    className: 'dcnb-btn',
                    onClick: () => {
                      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(overlay.snippet).catch(() => {})
                    },
                  },
                  '复制片段',
                ),
              },
              h(Banner, { tone: 'error' }, overlay.hint),
              h(
                'pre',
                {
                  className: 'dcnb-mono',
                  style: {
                    margin: '10px 0 0',
                    padding: 10,
                    borderRadius: 8,
                    overflow: 'auto',
                    maxHeight: 320,
                    background: 'var(--dsw-alias-bg-base)',
                    border: '1px solid var(--dsw-alias-border-l1)',
                  },
                },
                overlay.snippet,
              ),
            ),
      )
    }

    // ------------------------------------------------------------------- page

    const TABS = [
      ['account', '账号'],
      ['repos', '仓库'],
      ['envs', '开发环境'],
      ['usage', '用量'],
      ['gateway', '网关模型'],
    ]

    function Panel() {
      const [tab, setTab] = useState('account')
      const status = useApiState(() => callApi('status'), [])
      const current = TABS.find((row) => row[0] === tab) ?? TABS[0]
      return h(
        'div',
        { className: 'dcnb-page' },
        h('style', null, CSS),
        h(
          'header',
          { className: 'dcnb-head' },
          h(Glyph, { size: 20 }),
          h(
            'div',
            null,
            h('h1', null, 'CNB'),
            h('p', null, `${current[1]} · 扫码登录、仓库、云原生开发、组织用量与网关模型`),
          ),
          h('span', { className: 'dcnb-spacer' }),
          status.status === 'error'
            ? h('span', { className: 'dcnb-muted' }, status.error)
            : h(
                'span',
                { className: 'dcnb-muted' },
                status.data?.loggedIn
                  ? `已登录：${status.data?.user?.nickname ?? status.data?.user?.username ?? 'CNB'}`
                  : '未登录',
              ),
        ),
        h(
          'nav',
          { className: 'dcnb-tabs', role: 'tablist' },
          TABS.map(([id, label]) =>
            h(
              'button',
              {
                key: id,
                className: 'dcnb-tab',
                role: 'tab',
                'data-active': id === tab,
                'aria-selected': id === tab,
                onClick: () => setTab(id),
              },
              label,
            ),
          ),
        ),
        h(
          'div',
          { className: 'dcnb-body' },
          tab === 'account' ? h(AccountTab, { status: status.data, onRefresh: status.reload }) : null,
          tab === 'repos' ? h(ReposTab, { status: status.data }) : null,
          tab === 'envs' ? h(EnvironmentsTab, { status: status.data }) : null,
          tab === 'usage' ? h(UsageTab, { status: status.data }) : null,
          tab === 'gateway' ? h(GatewayTab, { status: status.data }) : null,
        ),
      )
    }

    function Glyph({ size = 16 } = {}) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 2.5, y: 4.5, width: 19, height: 15, rx: 3.5, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M7.2 15.2l2.5-6.4 2.5 6.4M8.3 13h2.8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        h('path', { d: 'M15.2 8.8v6.4M13.4 15.2h3.6', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 31, label: 'CNB' },
          Glyph,
        ),
      )
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel),
      )
    }

    return { inject, apply, Panel, PANEL_ID, NS }
  },
})
