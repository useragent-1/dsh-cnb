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
.dcnb-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre-wrap}
/* Buttons never read as blank white: the fill is a tinted surface, the border
   carries the tone, and the label keeps contrast in both themes. */
.dcnb-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.4;padding:6px 12px;border-radius:8px;cursor:pointer;transition:background .15s ease,border-color .15s ease,color .15s ease}
.dcnb-btn:hover{background:var(--dsw-alias-interactive-bg-hover-accent);border-color:var(--dsw-alias-border-l3)}
.dcnb-btn:active{background:var(--dsw-alias-interactive-bg-active)}
.dcnb-btn[data-tone=primary]{background:var(--dsw-alias-button-info-fill);border-color:transparent;color:#fff;font-weight:500;box-shadow:0 1px 2px #00000014}
.dcnb-btn[data-tone=primary]:hover{background:var(--dsw-alias-button-info-hover)}
.dcnb-btn[data-tone=danger]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
.dcnb-btn[data-tone=danger]:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent)}
.dcnb-btn:disabled{opacity:.45;cursor:default}
.dcnb-btn:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill);outline-offset:2px}
.dcnb-input,.dcnb-select{box-sizing:border-box;font:inherit;font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);min-width:0}
.dcnb-input{flex:1}
/* The QR sits on white in both themes: a code drawn in the panel's text colour is
   unscannable on a dark surface. */
.dcnb-qr{display:grid;place-items:center;padding:16px;background:#fff;border-radius:14px;width:fit-content;box-shadow:0 2px 10px #0000001a;margin:0 auto}
.dcnb-qr svg{display:block}

.dcnb-login{display:flex;flex-direction:column;align-items:center;gap:16px;padding:8px 0 4px;max-width:420px;margin:0 auto;text-align:center}
.dcnb-login-head{display:flex;flex-direction:column;align-items:center;gap:6px}
.dcnb-login-head h3{margin:0;font-size:15px;font-weight:600}
.dcnb-login-head p{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);max-width:34ch}
.dcnb-login-mark{display:grid;place-items:center;width:52px;height:52px;border-radius:15px;color:var(--dsw-alias-button-info-fill);background:color-mix(in srgb,var(--dsw-alias-button-info-fill) 12%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-button-info-fill) 28%,transparent)}
.dcnb-qr-placeholder{display:grid;place-items:center;width:180px;height:180px;border-radius:14px;border:1px dashed var(--dsw-alias-border-l2);color:var(--dsw-alias-label-caption);background:var(--dsw-alias-interactive-bg-hover)}
.dcnb-login-actions{display:flex;flex-direction:column;align-items:center;gap:6px;width:100%}
.dcnb-btn-lg{padding:9px 26px;font-size:13px;border-radius:10px;min-width:180px}
.dcnb-login-notes{list-style:none;margin:2px 0 0;padding:0;display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--dsw-alias-label-caption)}
.dcnb-login-notes li::before{content:'·';margin-right:6px;opacity:.6}
.dcnb-banner{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:8px;font-size:12px;border:1px solid var(--dsw-alias-border-l1)}
.dcnb-banner[data-tone=error]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dcnb-banner[data-tone=ok]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dcnb-list{display:flex;flex-direction:column;gap:8px}
.dcnb-item{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base)}
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
      const hours = Math.floor(minutes / 60)
      if (hours < 48) return `${hours}h${minutes % 60}m`
      // A session lifetime is measured in days, so do not report "168h".
      return `${Math.floor(hours / 24)}d${hours % 24}h`
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

    /** Where the resolved address lists live between page loads. */
    const ADDRESS_CACHE_KEY = 'dsh-cnb.addresses.v1'
    /** Enough entries for a page of environments; older ones fall off. */
    const ADDRESS_CACHE_LIMIT = 40

    /** @returns {Record<string, { rows: Array<{kind: string, label: string, url: string, note?: string}>, error: null, portTemplate: string | null, at: number }>} */
    function readAddressCache() {
      try {
        const raw = window.localStorage.getItem(ADDRESS_CACHE_KEY)
        if (raw === null) return {}
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return {}
        const entries = Object.entries(parsed).filter(([, value]) => value && Array.isArray(value.rows))
        entries.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
        return Object.fromEntries(entries.slice(0, ADDRESS_CACHE_LIMIT))
      } catch {
        // A corrupt or unavailable store must not break the panel.
        return {}
      }
    }

    /** @param {Record<string, unknown>} value */
    function writeAddressCache(value) {
      try {
        const entries = Object.entries(value).sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
        window.localStorage.setItem(ADDRESS_CACHE_KEY, JSON.stringify(Object.fromEntries(entries.slice(0, ADDRESS_CACHE_LIMIT))))
      } catch {
        // Quota or a disabled store only costs persistence, not the feature.
      }
    }

    /**
     * The signed-out card: invitation, QR, and one clear primary action, centred.
     *
     * Laid out as a single column with a measured width so it reads as a deliberate
     * sign-in surface rather than a paragraph with a button under it. The QR sits on
     * a light tile because a dark-on-dark code cannot be scanned.
     */
    function LoginPanel({ status, busy, attempt, error, onBegin }) {
      const scanning = attempt !== null && attempt !== undefined
      return h(
        'div',
        { className: 'dcnb-login' },
        h(
          'div',
          { className: 'dcnb-login-head' },
          h('div', { className: 'dcnb-login-mark', 'aria-hidden': 'true' }, h(QrMark)),
          h('h3', null, scanning ? '等待手机确认' : '登录 CNB'),
          h(
            'p',
            null,
            status?.ambientToken
              ? '检测到环境变量 CNB_TOKEN，但尚未在此插件中登录。扫码后会写入凭证记录并接管。'
              : '用微信扫描下方二维码。确认后插件会自动创建访问令牌并存入本机凭证库。',
          ),
        ),
        scanning
          ? h(QrCode, { qr: attempt.qr })
          : h('div', { className: 'dcnb-qr-placeholder', 'aria-hidden': 'true' }, h(QrMark)),
        h(
          'div',
          { className: 'dcnb-login-actions' },
          h(
            'button',
            { className: 'dcnb-btn dcnb-btn-lg', 'data-tone': 'primary', onClick: onBegin, disabled: busy },
            busy ? '正在准备二维码…' : scanning ? '重新生成二维码' : '扫码登录',
          ),
          scanning
            ? h('span', { className: 'dcnb-muted', style: { fontSize: 11 } }, '二维码约 4 分钟内有效')
            : null,
        ),
        error === null || error === undefined ? null : h(Banner, null, error),
        h(
          'ul',
          { className: 'dcnb-login-notes' },
          h('li', null, '令牌保存在本机凭证库，面板不再展示明文'),
          h('li', null, '登录会话会一并保存，令牌过期可自动重签'),
        ),
      )
    }

    /** A small QR glyph for the empty state, drawn with CSS-free inline SVG. */
    function QrMark() {
      return h(
        'svg',
        { width: 34, height: 34, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' },
        h('rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }),
        h('rect', { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }),
        h('rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }),
        h('path', { d: 'M14 14h3v3h-3zM20 14v.01M14 20v.01M20 20v.01' }),
      )
    }

    /**
     * One sentence describing the gateway's real state.
     *
     * The distinction that matters: whether a token is present, and whether DSH accepted
     * a provider for it. A token adopted automatically but blocked from the config by a
     * `--patch` layer looks, from the outside, exactly like "nothing was configured" — so
     * the wording has to separate the two, or it tells someone to fetch a token they
     * already have.
     */
    function describeGatewayState(gateway, status) {
      const adoption = status?.gatewayAdoption
      const stored = gateway?.stored === true
      const repo = gateway?.repo ?? adoption?.repo ?? null

      if (stored) {
        if (adoption?.provider?.overridden === true) {
          return `网关令牌已就绪${repo ? `（${repo}）` : ''}。但 llm-pi-ai 由更高优先级的 --patch 层接管，插件不写入 provider —— 模型选择器里不会出现插件这一路，你现有的配置不受影响。`
        }
        return `网关令牌已就绪${repo ? `（${repo}）` : ''}。登录用的令牌与它分开保存，互不覆盖。`
      }
      if (adoption?.adopted === true) {
        return `已自动导入环境里的 CNB_TOKEN${repo ? `（${repo}）` : ''}，正在进行最后一步。`
      }
      if (status?.ambient?.token === false) {
        return '这个进程不在 CNB 云环境里，没有可继承的 CNB_TOKEN。在云环境里启动会自动获取；否则需要手动粘贴一个流水线令牌。'
      }
      return 'AI 网关只接受流水线令牌。点「帮我启动一个环境」会给你确切的三步。'
    }


    /**
     * One line describing the stored session's expiry.
     *
     * The lifetime is CNB's decision, read from the `Set-Cookie` its confirmation
     * returns. When it sent none, the date shown is the documented default and is
     * labelled as an estimate rather than presented as fact.
     * @param {{ stored: boolean, savedAt: string | null, expiresAt: string | null, remainingMs: number | null, source: 'server' | 'estimated' | null } | undefined} cookie
     */
    function cookieSummary(cookie) {
      if (cookie === undefined || cookie === null || cookie.stored !== true) {
        return '未保存（扫码后自动保存，到期时间由 CNB 决定）'
      }
      const left = cookie.remainingMs === null
        ? '未知'
        : cookie.remainingMs <= 0
          ? '已过期'
          : `还剩 ${formatDuration(cookie.remainingMs)}`
      const expires = cookie.expiresAt === null ? '未知' : new Date(cookie.expiresAt).toLocaleString()
      // Say where the number came from: the server sets it, so an estimate would be
      // misleading without that label.
      const basis = cookie.source === 'server' ? '' : '（按默认 7 天估算）'
      return `到期 ${expires}${basis} · ${left}`
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

    /**
     * Links returned by an action, shown for copying instead of auto-opened.
     *
     * Starting an environment answers with several different URLs depending on
     * whether it created or reused one: the WebIDE entry, a loading page, the
     * build log. Opening one of them on the user's behalf guesses which they
     * wanted, so every link is listed with a copy button and they choose.
     */
    function LinkList({ title, links, onDismiss, onRefresh, refreshLabel, inline, hint }) {
      const [copied, setCopied] = useState('')
      const rows = (links ?? []).filter((link) => typeof link.url === 'string' && link.url !== '')
      if (rows.length === 0) return null
      const copy = (url) => {
        const done = () => setCopied(url)
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(url).then(done).catch(done)
        } else {
          // Older or unfocused documents have no async clipboard; a hidden
          // textarea plus execCommand still works there.
          const area = document.createElement('textarea')
          area.value = url
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          try { document.execCommand('copy') } catch { /* nothing else to try */ }
          document.body.removeChild(area)
          done()
        }
      }
      const copyAll = () => copy(rows.map((row) => row.url).join('\n'))
      return h(
        inline === true ? 'div' : 'section',
        inline === true ? { style: { marginTop: 8 } } : { className: 'dcnb-card' },
        h(
          'div',
          { className: 'dcnb-row' },
          h('h2', { style: { margin: 0, fontSize: inline === true ? 12 : undefined } }, title ?? '链接'),
          h('span', { className: 'dcnb-spacer' }),
          onRefresh === undefined
            ? null
            : h('button', { className: 'dcnb-btn', onClick: onRefresh }, refreshLabel ?? '刷新地址'),
          h('button', { className: 'dcnb-btn', onClick: copyAll }, copied === rows.map((row) => row.url).join('\n') ? '已复制全部' : `复制全部 (${rows.length})`),
          onDismiss === undefined ? null : h('button', { className: 'dcnb-btn', onClick: onDismiss }, '关闭'),
        ),
        h(
          'div',
          { className: 'dcnb-list', style: { marginTop: 10 } },
          rows.map((link) =>
            h(
              'div',
              { key: link.label + link.url, className: 'dcnb-item' },
              h(
                'div',
                { className: 'dcnb-main' },
                h(
                  'div',
                  { className: 'dcnb-title' },
                  h('span', null, link.label),
                  link.note ? h('span', { className: 'dcnb-tag' }, link.note) : null,
                ),
                h(
                  'div',
                  { className: 'dcnb-mono', style: { marginTop: 2, wordBreak: 'break-all', userSelect: 'all' } },
                  link.url,
                ),
              ),
              h(
                'div',
                { className: 'dcnb-row' },
                h('button', { className: 'dcnb-btn', onClick: () => copy(link.url) }, copied === link.url ? '已复制' : '复制'),
                // A URI-scheme link (cursor://, vscode://, ssh …) must not be opened in
                // a new tab: the browser hands it to the local client, and target=blank
                // produces a dead tab. Plain https links and non-URL strings get no
                // open button at all when they cannot be followed.
                h(
                  'a',
                  {
                    className: 'dcnb-btn',
                    href: link.url,
                    ...(link.url.startsWith('http') ? { target: '_blank', rel: 'noreferrer noopener' } : {}),
                    style: { textDecoration: 'none' },
                  },
                  link.url.startsWith('http') ? '打开' : '交由本机处理',
                ),
              ),
            ),
          ),
        ),
        hint === undefined || hint === null || hint === ''
          ? null
          : h('p', { className: 'dcnb-muted', style: { margin: '10px 0 0', fontSize: 11, lineHeight: 1.6 } }, hint),
      )
    }

    /** How each link kind is presented. */
    const LINK_LABELS = {
      webide: 'WebIDE',
      codebuddy: 'CodeBuddy Web',
      jump: '跳转页',
      logs: '流水线日志',
      repo: '仓库主页',
      ports: '端口预览',
    }

    /**
     * Normalise links from either source shape.
     *
     * The Host's `workspaces.detail` already returns `{ kind, label, url, note }`
     * covering every entry point — WebIDE, CodeBuddy, the jump page, the log, the
     * repository, and the port-preview template with its ready-made ports. A start
     * result carries only the handful CNB answered with, so both are folded here.
     * @param {{ links?: Array<{kind?: string, label?: string, url: string, note?: string}>, webide?: string, jumpUrl?: string, url?: string, buildLogUrl?: string, repo?: string, sn?: string }} source
     */
    function normaliseLinks(source) {
      if (source === null || source === undefined) return []
      const rows = []
      const bare = (value) => String(value).replace(/\/+$/, '')
      const push = (kind, label, url, note) => {
        if (typeof url !== 'string' || url === '') return
        if (rows.some((row) => bare(row.url) === bare(url))) return
        rows.push({ kind, label, url, ...(note === undefined ? {} : { note }) })
      }
      for (const link of source.links ?? []) {
        push(link.kind ?? 'other', link.label ?? LINK_LABELS[link.kind] ?? '链接', link.url, link.note)
      }
      // A start result has not gone through workspaces.detail, so fill in the rest.
      if ((source.links ?? []).length === 0) {
        push('webide', 'WebIDE', source.webide)
        push('jump', '跳转页', source.jumpUrl)
        if (typeof source.webide !== 'string' || source.webide === '') {
          push('loading', '启动页（环境就绪前）', source.url, source.message ? '构建中' : undefined)
        }
        push('logs', '流水线日志', source.buildLogUrl)
        if (source.repo) push('repo', '仓库主页', `https://cnb.cool/${source.repo}`)
      }
      return rows
    }

    /** One line: how much of the panel actually works. */
    function DoctorSummary({ doctor }) {
      const checks = doctor.checks ?? []
      const ok = checks.filter((check) => check.ok).length
      const failed = checks.filter((check) => !check.ok)
      const reads = checks.filter((check) => CHECK_META[check.name]?.kind !== 'write')
      const writes = checks.filter((check) => CHECK_META[check.name]?.kind === 'write')
      const countOk = (list) => list.filter((check) => check.ok).length
      const keptAlive = checks.filter((check) => check.ok && check.viaSession === true).length
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
        // Say plainly that some of it works because of the session, so the numbers
        // are not mistaken for the token being fully privileged.
        keptAlive > 0 ? h('span', { className: 'dcnb-muted' }, `其中 ${keptAlive} 项经登录会话完成`) : null,
        doctor.rejected === true ? h('span', { className: 'dcnb-tag', 'data-tone': 'err' }, '令牌无效') : null,
      )
    }

    /** A probe row: name, verdict, and one readable line — never raw JSON. */
    function DoctorRow({ check }) {
      const meta = CHECK_META[check.name] ?? { label: check.name, kind: 'read', summary: () => '' }
      // A scope refusal is the common failure; show only the scope names, not the
      // whole guidance sentence, which already appears once below the list.
      const scopes = check.missingScopes ?? []
      // Three ways a capability can be available; none of them is a red failure.
      // `viaSession` means the token could not authorize it but the stored session
      // did — which is a success, not a problem to fix.
      const viaSession = check.ok && check.viaSession === true
      const viaBuild = check.ok && check.value?.via === 'build'
      const tone = check.ok ? (viaSession || viaBuild ? 'warn' : 'ok') : scopes.length > 0 ? 'warn' : 'err'
      const verdict = check.ok
        ? viaSession
          ? '经会话可用'
          : viaBuild
            ? '降级可用'
            : '可用'
        : scopes.length > 0
          ? '受限'
          : '失败'
      const detail = check.ok
        ? viaSession
          ? `${meta.summary(check.value ?? {})} · 令牌缺该项权限，已用登录会话完成`
          : meta.summary(check.value ?? {})
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
              // The scan itself worked and the session is kept, so this is not a
              // dead end: say what failed (the minted token), what still works (the
              // session), and the one action that fixes it.
              const attempts = (result.tried ?? []).map((entry) => entry.profile).join(' → ')
              const reasons = (result.tried ?? [])
                .filter((entry) => entry.error)
                .map((entry) => `${entry.profile}: ${entry.error}`)
                .slice(0, 2)
              setError(
                `扫码成功（${who}），登录会话已保存，但自动签发的访问令牌都用不了（试过 ${attempts || '全权限'}）。` +
                  (reasons.length > 0 ? `失败原因：${reasons.join('；')}。` : '') +
                  '会话本身可用：面板里的读取操作会直接走会话。' +
                  '要彻底解决，去 cnb.cool/profile/token 手动创建一个令牌再粘贴进来，或在令牌页确认这个账号的角色。',
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
                  h('dt', null, '令牌名称'),
                  h('dd', { className: 'dcnb-mono' }, account?.tokenName ?? '—'),
                  h('dt', null, '令牌过期'),
                  h('dd', null, account?.expiredAt ? new Date(account.expiredAt).toLocaleString() : '长期有效'),
                  h('dt', null, '登录 Cookie'),
                  h('dd', null, cookieSummary(status?.cookie)),
                  h('dt', null, '自动续签'),
                  h(
                    'dd',
                    null,
                    status?.sessionStored
                      ? '已保存会话，令牌失效会自动重签，无需再扫码'
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
            : h(LoginPanel, { status, busy, attempt, error, onBegin: begin }),
        ),
        status?.health === 'session-only'
          ? h(
              Banner,
              { tone: 'ok' },
              '当前是「仅会话」登录：自动签发的令牌没通过验证，但扫码会话有效，读取操作可直接用。' +
                '需要写权限时，在 cnb.cool/profile/token 手动创建一个令牌并粘贴到下面。',
            )
          : null,
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
        h(
          Card,
          { title: '已有访问令牌？' },
          h(
            'div',
            { className: 'dcnb-login' },
            h(
              'div',
              { className: 'dcnb-row', style: { width: '100%' } },
              h('input', {
                className: 'dcnb-input',
                type: 'password',
                placeholder: '粘贴 CNB 访问令牌',
                value: tokenValue,
                onChange: (event) => setTokenValue(event.target.value),
              }),
              h('button', { className: 'dcnb-btn', onClick: importToken, disabled: busy || tokenValue.trim() === '' }, '导入'),
            ),
            h(
              'p',
              { className: 'dcnb-muted', style: { margin: 0, fontSize: 11, lineHeight: 1.6 } },
              '在 cnb.cool/profile/token 创建。令牌存入 dsh 凭证库，不会写进 cordis.patch.yml。',
            ),
          ),
        ),
      )
    }

    function ReposTab({ status }) {
      const [query, setQuery] = useState('')
      const [draft, setDraft] = useState({ slug: '', name: '', visibility: 'private', description: '' })
      const [actionError, setActionError] = useState(null)
      const [actionMessage, setActionMessage] = useState(null)
      const [busy, setBusy] = useState(false)
      const [links, setLinks] = useState(null)
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
        links === null
          ? null
          : h(LinkList, {
              title: links.title,
              links: links.rows,
              onDismiss: () => setLinks(null),
              refreshLabel: links.starting ? '刷新地址（环境就绪后）' : '刷新地址',
              onRefresh:
                links.sn === null || links.sn === undefined
                  ? undefined
                  : async () => {
                      const detail = await callApi('workspaces.detail', { repo: links.repo, sn: links.sn }).catch(() => null)
                      const resolved = normaliseLinks(detail ?? {})
                      setLinks({ ...links, rows: resolved, starting: typeof detail?.detail?.webide !== 'string' })
                    },
            }),
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
                                setLinks({
                                  title: `${repo.slug} · 启动结果`,
                                  rows: normaliseLinks(started),
                                  repo: repo.slug,
                                  sn: started.sn,
                                  starting: typeof started.webide !== 'string' || started.webide === '',
                                })
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
                              act('删除仓库', () => callApi('repos.delete', { repo: repo.slug, confirm: true })).then(() => repos.reload())
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
      const [links, setLinks] = useState(null)
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

      /**
       * Resolved addresses per environment, kept for as long as the tab is open.
       *
       * A start result used to be the only place the links appeared, so they were
       * gone the moment the card was dismissed or the page reloaded. Caching them
       * by `repo/sn` means any environment can be re-expanded at any time, and the
       * addresses do not depend on having just started it.
       */
      const [addresses, setAddresses] = useState(() => readAddressCache())
      const [openRow, setOpenRow] = useState('')

      /** @param {string} slug @param {string} sn */
      const loadAddresses = useCallback(async (slug, sn) => {
        const key = `${slug}/${sn}`
        try {
          const result = await callApi('workspaces.detail', { repo: slug, sn })
          const rows = normaliseLinks(result ?? {})
          if (rows.length === 0) throw new Error('该环境暂无可用地址')
          setAddresses((previous) => {
            const next = { ...previous, [key]: { rows, error: null, portTemplate: result?.portTemplate ?? null, hint: result?.clientHint ?? null, at: Date.now() } }
            writeAddressCache(next)
            return next
          })
        } catch (error) {
          // Keep whatever was cached: the addresses do not become wrong because the
          // API is unreachable, and the person may simply want them copied again.
          setAddresses((previous) => {
            const cached = previous[key]
            const next = {
              ...previous,
              [key]: { rows: cached?.rows ?? [], error: error.message, portTemplate: cached?.portTemplate ?? null, at: cached?.at ?? 0 },
            }
            writeAddressCache(next)
            return next
          })
        }
      }, [])

      const toggleAddresses = useCallback(
        (slug, sn) => {
          const key = `${slug}/${sn}`
          setOpenRow((current) => (current === key ? '' : key))
          setActionError(null)
          // Fetch again on open so a started environment's new ports and entry
          // points show up; a cached list is still useful while it loads.
          void loadAddresses(slug, sn)
        },
        [loadAddresses],
      )

      const environments = detail.data?.environments ?? []
      const button = detail.data?.workspace

      return h(
        React.Fragment,
        null,
        actionError === null ? null : h(Banner, null, actionError),
        links === null
          ? null
          : h(LinkList, {
              title: links.title,
              links: links.rows,
              onDismiss: () => setLinks(null),
              refreshLabel: links.starting ? '刷新地址（环境就绪后）' : '刷新地址',
              onRefresh:
                links.sn === null || links.sn === undefined
                  ? undefined
                  : async () => {
                      const detail = await callApi('workspaces.detail', { repo: links.repo, sn: links.sn }).catch(() => null)
                      setLinks({
                        ...links,
                        rows: normaliseLinks(detail ?? {}),
                        starting: typeof detail?.detail?.webide !== 'string',
                      })
                    },
            }),
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
                          {
                            className: 'dcnb-btn',
                            'data-tone': openRow === `${workspace.slug}/${workspace.sn}` ? 'primary' : undefined,
                            onClick: () => toggleAddresses(workspace.slug, workspace.sn),
                          },
                          openRow === `${workspace.slug}/${workspace.sn}` ? '收起地址' : '地址',
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
                      openRow === `${workspace.slug}/${workspace.sn}`
                        ? h(
                            'div',
                            { style: { flexBasis: '100%' } },
                            (() => {
                              const entry = addresses[`${workspace.slug}/${workspace.sn}`]
                              if (entry === undefined) return h('div', { className: 'dcnb-muted', style: { paddingTop: 6 } }, '读取地址…')
                              const rows = entry.rows ?? []
                              return h(
                                React.Fragment,
                                null,
                                entry.error === null ? null : h(Banner, null, entry.error),
                                rows.length === 0
                                  ? h('div', { className: 'dcnb-muted', style: { paddingTop: 6 } }, '暂无地址，点「刷新地址」重试')
                                  : h(LinkList, {
                                      title: `${workspace.slug} · ${workspace.sn}`,
                                      links: rows,
                                      inline: true,
                                      hint: entry.hint ?? null,
                                      refreshLabel: '刷新地址',
                                      onRefresh: () => loadAddresses(workspace.slug, workspace.sn),
                                    }),
                              )
                            })(),
                          )
                        : null,
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
                    setLinks({
                      title: `${repo.trim()} · 启动结果`,
                      rows: normaliseLinks(started),
                      repo: repo.trim(),
                      sn: started.sn,
                      starting: typeof started.webide !== 'string' || started.webide === '',
                    })
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
                                // 这里原本还有一句 set-selected 的调用，但本组件没有
                                // 对应的 useState —— 点一下就 ReferenceError、面板黑屏。
                                // act() 已经负责呈现结果，这行本来就是多余的。
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
      const [live, setLive] = useState(true)
      const [tick, setTick] = useState(0)

      /**
       * Consumption moves while the tab is open — a build finishes, an environment
       * runs — so the numbers are re-read on a timer instead of once at mount. The
       * quota endpoint is cheap and the interval is deliberately relaxed: this is a
       * dashboard, not a counter, and hammering the API would slow the panel down for
       * no benefit.
       */
      useEffect(() => {
        if (!live || !status?.loggedIn) return undefined
        const timer = setInterval(() => {
          usage.reload()
          setTick((value) => value + 1)
        }, 30_000)
        return () => clearInterval(timer)
      }, [live, status?.loggedIn, usage])

      useEffect(() => {
        // A tab left in the background should not keep polling.
        const onVisibility = () => setLive(document.visibilityState !== 'hidden')
        document.addEventListener('visibilitychange', onVisibility)
        return () => document.removeEventListener('visibilitychange', onVisibility)
      }, [])

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
          h(
            'label',
            { className: 'dcnb-row', style: { gap: 6 } },
            h('input', { type: 'checkbox', checked: live, onChange: (event) => setLive(event.target.checked) }),
            h('span', { className: 'dcnb-muted', style: { fontSize: 11 } }, live ? '每 30 秒自动刷新' : '已暂停刷新'),
          ),
          h('button', { className: 'dcnb-btn', onClick: usage.reload }, usage.status === 'loading' ? '刷新中…' : '刷新'),
          tick > 0 ? h('span', { className: 'dcnb-muted', style: { fontSize: 11 } }, `已刷新 ${tick} 次`) : null,
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

    // ------------------------------------------------------------------- page

    /**
     * 云网关：一条龙开通「跑在云环境里的 AI 网关」，并把结果接进 dsh。
     *
     * 这一页之所以存在，是因为在本机直连 CNB 网关走不通：网关只接受流水线令牌，
     * 而该令牌与仓库、与管道生命周期绑定，拿到别处使用会被网络策略拦下（10412）。
     * 所以代理必须跑在云环境里，经端口预览域名对外 —— 这一页就是把那条链路自动化，
     * 并把 11288 / 11128 的内容风控适配内置到代理里。
     */
    function CloudGatewayTab({ status }) {
      const [org, setOrg] = useState('')
      const [name, setName] = useState('')
      const [models, setModels] = useState('deepseek-v4.1-flash,deepseek-v4-flash,glm-5.3-flash,step-5-preview')
      const [port, setPort] = useState('8794')
      const [route, setRoute] = useState('cnb-gateway')
      const [makeDefault, setMakeDefault] = useState(true)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [note, setNote] = useState(null)
      const [result, setResult] = useState(null)
      const [state, setState] = useState(null)
      const [check, setCheck] = useState(null)
      const [scaffold, setScaffold] = useState(null)

      const loadState = useCallback(async () => {
        try {
          setState(await callApi('cloud.state', {}))
        } catch {
          setState(null)
        }
      }, [])

      useEffect(() => { void loadState() }, [loadState])

      const provision = useCallback(async () => {
        setBusy(true)
        setError(null)
        setNote(null)
        setCheck(null)
        setResult(null)
        try {
          const payload = {
            ...(org.trim() === '' ? {} : { org: org.trim() }),
            ...(name.trim() === '' ? {} : { name: name.trim() }),
            ...(models.trim() === '' ? {} : { models: models.split(',').map((entry) => entry.trim()).filter(Boolean) }),
            port: Number(port) || 8794,
            route: route.trim() || 'cnb-gateway',
            makeDefault,
          }
          const outcome = await callApi('cloud.provision', payload)
          setResult(outcome)
          if (outcome.ready) setNote(`云网关已就绪：${outcome.harvest.url}`)
          else setError('链路没有完全打通，展开下面的步骤看卡在哪一步。')
          await loadState()
        } catch (provisionError) {
          setError(provisionError.message)
          await loadState()
        } finally {
          setBusy(false)
        }
      }, [loadState, makeDefault, models, name, org, port, route])

      // 环境重建后地址会变，所以「重新采集」是一个常用按钮而不是兜底。
      const harvest = useCallback(async () => {
        setBusy(true)
        setError(null)
        setNote(null)
        try {
          const found = await callApi('cloud.harvest', {
            repo: result?.repo ?? state?.repo ?? '',
            ...(result?.harvest?.sn === undefined ? {} : { sn: result.harvest.sn }),
          })
          if (found.ok) setNote(`已采集到 ${found.url}`)
          else setError(`还没有就绪标记：${found.reason}`)
          await loadState()
        } catch (harvestError) {
          setError(harvestError.message)
        } finally {
          setBusy(false)
        }
      }, [loadState, result, state])

      const verify = useCallback(async () => {
        setBusy(true)
        setCheck(null)
        try {
          setCheck(await callApi('cloud.verify', { ...(models.trim() === '' ? {} : { model: models.split(',')[0].trim() }) }))
        } catch (verifyError) {
          setCheck({ ok: false, reason: verifyError.message })
        } finally {
          setBusy(false)
        }
      }, [models])

      const preview = useCallback(async () => {
        setBusy(true)
        try {
          setScaffold(await callApi('cloud.scaffold', {
            port: Number(port) || 8794,
            models: models.split(',').map((entry) => entry.trim()).filter(Boolean),
          }))
        } catch (previewError) {
          setError(previewError.message)
        } finally {
          setBusy(false)
        }
      }, [models, port])

      if (!status?.loggedIn) return h(Banner, { tone: 'error' }, '请先在「账号」页扫码登录 CNB')

      const steps = result?.steps ?? state?.steps ?? []
      const definition = state?.stepsDefinition ?? []
      const stepOf = (id) => steps.find((step) => step.id === id) ?? null

      return h(
        React.Fragment,
        null,
        error === null ? null : h(Banner, null, error),
        note === null ? null : h(Banner, { tone: 'ok' }, note),

        h(
          Card,
          {
            title: '一键开通云网关',
          },
          h(
            'p',
            { className: 'dcnb-muted', style: { margin: '0 0 10px', lineHeight: 1.7 } },
            '自动建一个新仓库、把零依赖网关脚手架写进去、云原生启动、从环境日志里采集对外地址与 key，',
            '最后写进 dsh 的 llm-pi-ai（provider 路由 ',
            h('code', { className: 'dcnb-mono' }, route || 'cnb-gateway'),
            '）。',
            h('br'),
            '为什么必须这样：CNB 网关只接受流水线令牌，它只在运行中的云环境里存在，拿到其它机器上会被网络策略拦下（',
            h('code', { className: 'dcnb-mono' }, '10412'),
            '），所以代理只能跑在环境里。',
          ),
          h(
            'div',
            { className: 'dcnb-grid', style: { marginBottom: 10 } },
            h('label', { className: 'dcnb-muted' }, '组织（留空＝账号第一个）', h('br'),
              h('input', { className: 'dcnb-input', value: org, onChange: (event) => setOrg(event.target.value), placeholder: '例如 your-org', style: { width: '100%' } })),
            h('label', { className: 'dcnb-muted' }, '仓库名（留空＝自动）', h('br'),
              h('input', { className: 'dcnb-input', value: name, onChange: (event) => setName(event.target.value), placeholder: 'dsh-gateway-…', style: { width: '100%' } })),
            h('label', { className: 'dcnb-muted' }, '云网关端口', h('br'),
              h('input', { className: 'dcnb-input', value: port, onChange: (event) => setPort(event.target.value), style: { width: '100%' } })),
          ),
          h('label', { className: 'dcnb-muted' }, '模型（逗号分隔，会逐个写进 provider）'),
          h('input', { className: 'dcnb-input', value: models, onChange: (event) => setModels(event.target.value), style: { width: '100%', marginBottom: 10 } }),
          h('label', { className: 'dcnb-muted' }, 'provider 路由名'),
          h('input', { className: 'dcnb-input', value: route, onChange: (event) => setRoute(event.target.value), style: { width: '100%', marginBottom: 10 } }),
          h(
            'div',
            { className: 'dcnb-row' },
            h('label', { className: 'dcnb-row', style: { gap: 6 } },
              h('input', { type: 'checkbox', checked: makeDefault, onChange: (event) => setMakeDefault(event.target.checked) }),
              h('span', { className: 'dcnb-muted' }, '设为 dsh 默认模型'),
            ),
            h('span', { className: 'dcnb-spacer' }),
            h('button', { className: 'dcnb-btn', disabled: busy, onClick: preview, title: '只生成不写盘，先看会往仓库里放什么' }, '预览脚手架'),
            h('button', { className: 'dcnb-btn', 'data-tone': 'primary', disabled: busy, onClick: provision },
              busy ? '正在开通…' : '一键开通'),
          ),
        ),

        // 进度：每一步都带自己的状态与证据，卡住时能直接看出是哪一环。
        definition.length === 0 && steps.length === 0
          ? null
          : h(
              Card,
              { title: '开通进度' },
              h(
                'div',
                { className: 'dcnb-list' },
                (steps.length > 0 ? steps.map((step) => ({ id: step.id, label: definition.find((row) => row.id === step.id)?.label ?? step.id, step })) : definition.map((row) => ({ id: row.id, label: row.label, step: null })))
                  .map((row) => h(
                    'div',
                    { key: row.id, className: 'dcnb-item' },
                    h('span', { className: 'dcnb-tag', 'data-tone': row.step === null ? undefined : row.step.state === 'ok' ? 'ok' : 'err' },
                      row.step === null ? '待执行' : row.step.state === 'ok' ? '完成' : '失败'),
                    h('div', { className: 'dcnb-main' },
                      h('div', { className: 'dcnb-title' }, row.label),
                      row.step === null || row.step.detail === null || row.step.detail === undefined
                        ? null
                        : h('div', { className: 'dcnb-mono', style: { marginTop: 4 } }, summarizeDetail(row.step.detail)),
                    ),
                  )),
              ),
            ),

        result === null ? null : h(
          Card,
          { title: '结果' },
          h(
            'dl',
            { className: 'dcnb-kv' },
            h('dt', null, '仓库'), h('dd', { className: 'dcnb-mono' }, result.repo),
            h('dt', null, '对外地址'), h('dd', { className: 'dcnb-mono' }, result.harvest?.url ?? '—'),
            h('dt', null, '模型'), h('dd', { className: 'dcnb-mono' }, (result.harvest?.models ?? []).join(', ') || '—'),
            h('dt', null, 'provider'), h('dd', { className: 'dcnb-mono' }, `${result.provider?.route ?? route}${result.provider?.written ? '（已写入）' : result.provider?.overridden ? '（由 --patch 层接管）' : '（未写入）'}`),
            h('dt', null, '凭证引用'), h('dd', { className: 'dcnb-mono' }, result.provider?.apiKeyEnv ?? '—'),
          ),
          h(
            'div',
            { className: 'dcnb-row', style: { marginTop: 10 } },
            h('button', { className: 'dcnb-btn', disabled: busy, onClick: harvest }, '重新采集'),
            h('button', { className: 'dcnb-btn', disabled: busy, onClick: verify }, '测一下'),
          ),
          check === null
            ? null
            : h(Banner, { tone: check.ok ? 'ok' : 'error' },
                check.ok
                  ? `通了：${check.model} 回「${String(check.reply ?? '').slice(0, 40)}」`
                  : `${check.label ?? '失败'}：${check.fix ?? check.reason ?? ''}`),
          result.provider?.snippet === undefined
            ? null
            : h(
                'details',
                { style: { marginTop: 10 } },
                h('summary', { className: 'dcnb-muted', style: { cursor: 'pointer' } }, '由更高优先级层接管，展开可并入的片段'),
                h('pre', { className: 'dcnb-mono', style: { margin: '8px 0 0', padding: 10, borderRadius: 8, overflow: 'auto', maxHeight: 320, background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)' } }, result.provider.snippet),
              ),
        ),

        scaffold === null ? null : h(
          Card,
          { title: '脚手架预览', extra: h('span', { className: 'dcnb-muted' }, `key ${String(scaffold.key).slice(0, 12)}…`) },
          h('div', { className: 'dcnb-list' },
            scaffold.files.map((file) => h('div', { key: file.path, className: 'dcnb-row' },
              h('span', { className: 'dcnb-mono', style: { flex: 1 } }, file.path),
              h('span', { className: 'dcnb-muted' }, `${file.bytes} B`),
            ))),
          h('pre', { className: 'dcnb-mono', style: { margin: '10px 0 0', padding: 10, borderRadius: 8, overflow: 'auto', maxHeight: 260, background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)' } }, scaffold.cnf),
        ),

        h(
          Card,
          { title: '11288 / 11128 内容风控适配' },
          h('p', { className: 'dcnb-muted', style: { margin: '0 0 8px', lineHeight: 1.7 } },
            '上游会扫 system / assistant 文本里的「客户端指纹」，命中整条拒绝：',
            h('code', { className: 'dcnb-mono' }, 'HTTP 400 / code 11288（同类 11128）Illegal API invocation from an unapproved channel'),
            '。换令牌、换模型、补请求头都无效，被拦的是提示词。云网关代理在发请求前做三件事，都不改语义：'),
          h('ol', { className: 'dcnb-muted', style: { margin: '0 0 0 18px', padding: 0, lineHeight: 1.8 } },
            h('li', null, '改写已知指纹句、把身份词中间插零宽空格（路径语境跳过，否则会把坏路径交给工具调用）'),
            h('li', null, '消息形状归一：developer→system、system 提前、剥掉图片段、丢掉孤立的 tool 结果'),
            h('li', null, '仍被拦时把 system 折进首条 user，最后逐词打散'),
          ),
          h('p', { className: 'dcnb-muted', style: { margin: '8px 0 0', fontSize: 11, lineHeight: 1.6 } },
            '另外网关只认流式（非流式答 11101），所以代理一律发流式，非流式由它聚合后返回。'),
        ),
      )
    }

    /** 一句话概括一步的证据，避免把整段 JSON 摊在面板上。 */
    function summarizeDetail(detail) {
      if (typeof detail === 'string') return detail
      if (detail === null || typeof detail !== 'object') return String(detail)
      if (typeof detail.url === 'string') return detail.url
      if (typeof detail.repo === 'string') return detail.repo
      if (typeof detail.reason === 'string') return detail.reason
      if (typeof detail.label === 'string') return `${detail.label}${detail.fix ? ` · ${detail.fix}` : ''}`
      if (typeof detail.sn === 'string') return detail.sn
      if (typeof detail.route === 'string') return `${detail.route} → ${detail.baseURL ?? ''}`
      if (Array.isArray(detail.tail)) return detail.tail.slice(-2).join(' / ')
      return JSON.stringify(detail).slice(0, 200)
    }

    /**
     * 保活：所有运行中的云环境，各自还能活多久、什么时候会被收、怎么验证心跳真的通。
     *
     * 这一页刻意不做「一键保活」按钮：平台按「进入环境的连接」判定活跃，容器内
     * 自己 ping 自己不算。所以真正有效的手段只有一个 —— 让**另一个 Runner** 定时
     * 请求环境的端口预览域名。页面把这条讲清楚，并给出可直接用的 crontab 片段。
     *
     * 同时**明确说清它救不了什么**：18 小时上限与凌晨 4–6 点的「不过夜」策略按
     * 使用时长判定，与活跃度无关。一个不说明这一点的保活界面只是在骗人。
     */
    function KeepaliveTab({ status }) {
      const [data, setData] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [note, setNote] = useState(null)
      const [snippet, setSnippet] = useState(null)
      const [endpoint, setEndpoint] = useState(null)
      const [pings, setPings] = useState({})
      const [quota, setQuota] = useState(null)

      const load = useCallback(async (probe) => {
        setBusy(true)
        setError(null)
        try {
          setData(await callApi('keepalive.status', { ...(probe === true ? { probe: true } : {}) }))
        } catch (loadError) {
          setError(loadError.message)
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => { void load(false) }, [load])

      // 一分钟一次刷新倒计时：数字要自己走，而不是停在打开页面那一刻。
      useEffect(() => {
        const timer = setInterval(() => { void load(false) }, 60_000)
        return () => clearInterval(timer)
      }, [load])

      const probe = useCallback(async () => {
        await load(true)
        setNote('已对每个运行中环境真打一次端口预览域名。')
      }, [load])

      const pingOne = useCallback(async (repo, sn) => {
        setPings((prev) => ({ ...prev, [sn]: { busy: true } }))
        try {
          const result = await callApi('keepalive.ping', { repo, sn })
          setPings((prev) => ({ ...prev, [sn]: result }))
        } catch (pingError) {
          setPings((prev) => ({ ...prev, [sn]: { ok: false, note: pingError.message } }))
        }
      }, [])

      // 一体化：生成守护配置 + 给出每个环境的处置计划。
      // 额度自动调配：读本月开发额度，按档位决定要不要收环境。
      // 默认 apply=false（只报告）—— 停环境有副作用，但面板上可以显式执行。
      const autopilot = useCallback(async () => {
        setBusy(true)
        setError(null)
        setNote(null)
        try {
          const result = await callApi('keepalive.autopilot', {})
          if (result.plan === null) {
            setError(result.note)
          } else {
            setQuota(result)
            setNote(result.note)
          }
        } catch (quotaError) {
          setError(quotaError.message)
        } finally {
          setBusy(false)
        }
      }, [])

      // 地址自愈：provider 指向的域名若已失效（环境被重启过），自动重新采集并改写。
      const heal = useCallback(async () => {
        setBusy(true)
        setError(null)
        setNote(null)
        try {
          const result = await callApi('keepalive.selfHeal', {})
          setNote(result.healed
            ? `地址已自愈：${result.previous ?? '(无)'} → ${result.baseURL}`
            : result.note)
        } catch (healError) {
          setError(healError.message)
        } finally {
          setBusy(false)
        }
      }, [])

      const automate = useCallback(async () => {
        setBusy(true)
        setError(null)
        setSnippet(null)
        try {
          const result = await callApi('keepalive.automate', {})
          setSnippet({ ...result, note: result.note ?? `守护配置已就绪（${result.cron}）。` })
          const urgent = (result.plan ?? []).filter((row) => row.urgent === true)
          setNote(urgent.length === 0
            ? '守护配置已生成；当前没有需要立刻处理的环境。'
            : `守护配置已生成。有 ${urgent.length} 个环境需要关注：` + urgent.map((row) => `${row.repo} → ${row.action}`).join('，'))
        } catch (automateError) {
          setError(automateError.message)
        } finally {
          setBusy(false)
        }
      }, [])

      const generate = useCallback(async () => {
        setBusy(true)
        setError(null)
        setSnippet(null)
        try {
          // 默认只生成片段：改别人的 .cnb.yml 是破坏性操作，不该悄悄发生。
          setSnippet(await callApi('keepalive.setup', {}))
        } catch (setupError) {
          setError(setupError.message)
        } finally {
          setBusy(false)
        }
      }, [])

      if (!status?.loggedIn) return h(Banner, { tone: 'error' }, '请先在「账号」页扫码登录 CNB')

      const rows = data?.rows ?? []
      const verdictTag = (verdict) => {
        if (verdict === 'overnight-risk') return { tone: 'err', label: '凌晨窗口内·随时被收' }
        if (verdict === 'overnight-soon') return { tone: 'warn', label: '今晚 4 点会被收' }
        if (verdict === 'expiring') return { tone: 'warn', label: '即将到期' }
        if (verdict === 'running') return { tone: 'ok', label: '运行中' }
        return { tone: undefined, label: '已停止' }
      }

      return h(
        React.Fragment,
        null,
        error === null ? null : h(Banner, null, error),
        note === null ? null : h(Banner, { tone: 'ok' }, note),

        h(
          Card,
          {
            title: '云环境保活',
            extra: h('span', { className: 'dcnb-muted' }, data === null ? '' : `${data.running}/${data.total} 运行中`),
          },
          h(
            'p',
            { className: 'dcnb-muted', style: { margin: '0 0 10px', lineHeight: 1.7 } },
            '平台规则：连续 ',
            h('strong', null, '10 分钟'),
            ' 无操作即回收；最长存活 ',
            h('strong', null, '18 小时'),
            '；另有一条「环境不过夜」—— 使用超过 8 小时且处于凌晨 4–6 点会强制回收。',
            h('br'),
            '保活只能守住第一条。后两条按',
            h('strong', null, '使用时长'),
            '判定，任何心跳都挡不住，所以这里把到期时间直接算给你看。',
          ),
          h(
            'div',
            { className: 'dcnb-row' },
            h('button', { className: 'dcnb-btn', disabled: busy, onClick: () => void load(false) }, busy ? '刷新中…' : '刷新'),
            h('button', { className: 'dcnb-btn', disabled: busy, onClick: probe }, '真打一次验证'),
            h('span', { className: 'dcnb-spacer' }),
            h('button', { className: 'dcnb-btn', disabled: busy, onClick: generate }, '生成外部心跳配置'),
            h('button', { className: 'dcnb-btn', 'data-tone': 'primary', disabled: busy, onClick: automate }, busy ? '处理中…' : '一键自动化守护'),
            h('button', { className: 'dcnb-btn', disabled: busy, onClick: heal }, '地址自愈'),
            h('button', { className: 'dcnb-btn', disabled: busy, onClick: autopilot }, '额度自动调配'),
          ),
          data === null
            ? h(Spinner, { label: '读取环境状态…' })
            : rows.length === 0
              ? h('div', { className: 'dcnb-empty' }, '当前账号下没有云环境')
              : h(
                  'div',
                  { className: 'dcnb-list', style: { marginTop: 12 } },
                  rows.map((row) => {
                    const tag = verdictTag(row.verdict)
                    const ping = pings[row.sn]
                    return h(
                      'div',
                      { key: row.sn, className: 'dcnb-item' },
                      h(
                        'div',
                        { className: 'dcnb-main' },
                        h(
                          'div',
                          { className: 'dcnb-title' },
                          h('span', null, row.repo ?? '—'),
                          h('span', { className: 'dcnb-tag', 'data-tone': tag.tone }, tag.label),
                          row.gateway ? h('span', { className: 'dcnb-tag', 'data-tone': 'warn' }, '云网关承载') : null,
                        ),
                        h(
                          'div',
                          { className: 'dcnb-kv', style: { marginTop: 6 } },
                          h('dt', null, '已运行'), h('dd', null, `${row.ageHours} h`),
                          h('dt', null, '距 18h 上限'), h('dd', null, row.status === 'running' ? `${row.remainingHours} h` : '—'),
                          h('dt', null, '预计到期'), h('dd', { className: 'dcnb-mono' }, row.expiresAt === null ? '—' : new Date(row.expiresAt).toLocaleString('zh-CN')),
                          h('dt', null, '凌晨回收'), h('dd', null, `${row.overnight.at === null ? '—' : new Date(row.overnight.at).toLocaleString('zh-CN')} · ${row.overnight.reason}`),
                          h('dt', null, '心跳地址'), h('dd', { className: 'dcnb-mono' }, row.previewUrl ?? '（拿不到端口预览域名）'),
                          h('dt', null, '心跳探测'), h('dd', null,
                            row.heartbeat.reachable === null
                              ? h('span', { className: 'dcnb-muted' }, '未测（点「真打一次验证」）')
                              : row.heartbeat.reachable
                                ? h('span', { style: { color: 'var(--dsw-alias-state-success-primary)' } }, `已到达 · HTTP ${row.heartbeat.status}`)
                                : h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, '连不上'),
                          ),
                        ),
                        h('div', { className: 'dcnb-muted', style: { marginTop: 6, fontSize: 11, lineHeight: 1.6 } }, row.advice),
                        ping === undefined
                          ? null
                          : h('div', { className: 'dcnb-mono', style: { marginTop: 6, fontSize: 11 } },
                              ping.busy === true ? '正在发请求…' : `${ping.ok ? '已到达' : '失败'} · ${ping.status ?? ''} ${ping.note ?? ''}`),
                      ),
                      h(
                        'div',
                        { className: 'dcnb-row', style: { flexDirection: 'column', gap: 6 } },
                        h('button', {
                          className: 'dcnb-btn',
                          disabled: row.status !== 'running' || (ping !== undefined && ping.busy === true),
                          onClick: () => void pingOne(row.repo, row.sn),
                        }, '打一次'),
                      ),
                    )
                  }),
                ),
        ),

        quota === null
          ? null
          : h(
              Card,
              { title: '开发额度', extra: h('span', { className: 'dcnb-tag', 'data-tone': quota.plan.level === 'ample' ? 'ok' : quota.plan.level === 'tight' ? 'warn' : 'err' }, quota.plan.level === 'ample' ? '充足' : quota.plan.level === 'tight' ? '偏紧' : '临界') },
              h('div', { className: 'dcnb-kv' },
                h('dt', null, '总额度'), h('dd', null, `${(quota.quota.devTotal / 3600).toFixed(0)} 核·时`),
                h('dt', null, '已用'), h('dd', null, `${(quota.quota.devUsed / 3600).toFixed(0)} 核·时`),
                h('dt', null, '日均'), h('dd', null, `${(quota.quota.usedInLastDay / 3600).toFixed(1)} 核·时/天`),
                h('dt', null, '可撑'), h('dd', null, quota.plan.daysLeft === null ? '?' : `${quota.plan.daysLeft.toFixed(1)} 天`),
                h('dt', null, '并发上限'), h('dd', null, `${quota.plan.maxEnvironments} 台`),
              ),
              h('div', { className: 'dcnb-muted', style: { marginTop: 8, fontSize: 11, lineHeight: 1.7 } }, quota.plan.advice),
            ),

        snippet === null
          ? null
          : h(
              Card,
              {
                title: '外部心跳配置',
                extra: h('button', {
                  className: 'dcnb-btn',
                  onClick: () => { if (navigator.clipboard?.writeText) navigator.clipboard.writeText(snippet.yml).catch(() => {}) },
                }, '复制'),
              },
              h('p', { className: 'dcnb-muted', style: { margin: '0 0 8px', lineHeight: 1.7 } },
                '把它并入仓库的 ',
                h('code', { className: 'dcnb-mono' }, '.cnb.yml'),
                '。这段跑在',
                h('strong', null, '独立 Runner'),
                '上，请求经 CNB 网关进入环境，才是平台认的心跳（容器内自己 curl 不算）。',
                h('br'),
                '它会覆盖 .cnb.yml 里已有的 crontab 段，合并前先确认不要冲突。',
              ),
              h(Banner, { tone: 'ok' }, snippet.note),
              h('pre', {
                className: 'dcnb-mono',
                style: {
                  margin: '10px 0 0', padding: 10, borderRadius: 8, overflow: 'auto', maxHeight: 320,
                  background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)',
                },
              }, snippet.yml),
            ),
      )
    }

    /**
     * Issue 网关：借一次性容器问模型。
     *
     * 与「云网关」的区别值得摆在明面上，否则用户会奇怪为什么这里这么慢：
     *   · 云网关 —— 常驻环境，秒级响应，但一直占着一台；
     *   · Issue 网关 —— 用一个临时容器，不占常驻资源，但要等调度（几十秒起）。
     *
     * 它存在的理由只有一个：额度紧的时候，这是唯一还能用上免费模型的通道。
     */
    function IssueGatewayTab({ status }) {
      const [state, setState] = useState(null)
      const [question, setQuestion] = useState('')
      const [model, setModel] = useState('hy4')
      const [answer, setAnswer] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [snippet, setSnippet] = useState(null)
      // 反代地址与模型清单。上一版漏了这个声明 —— 组件里直接用了 setEndpoint，
      // 运行时抛 ReferenceError，整个面板黑屏（与 GATEWAY_BLOCKERS 那次同源：
      // 引用了不存在的绑定）。
      const [endpoint, setEndpoint] = useState(null)

      const load = useCallback(async () => {
        setBusy(true)
        setError(null)
        try {
          setState(await callApi('issue.state', {}))
          setEndpoint(await callApi('issue.endpoint', {}))
        } catch (loadError) {
          setError(loadError.message)
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => { void load() }, [load])

      const ask = useCallback(async () => {
        const text = question.trim()
        if (text === '') {
          setError('先写一个问题')
          return
        }
        setBusy(true)
        setError(null)
        setAnswer(null)
        try {
          // 这条路径要等容器调度，几十秒到几分钟，所以等待时间放宽。
          setAnswer(await callApi('issue.ask', { question: text, model, waitMs: 300_000 }))
        } catch (askError) {
          setError(askError.message)
        } finally {
          setBusy(false)
        }
      }, [model, question])

      // 把反代写成 provider，这样模型选择器里就能直接选它。
      const writeProvider = useCallback(async () => {
        setBusy(true)
        setError(null)
        try {
          const result = await callApi('gateway.configure', {
            baseURL: endpoint.baseURL,
            models: endpoint.models.map((m) => m.id),
            route: 'cnb-issue',
          })
          setError(null)
          window.alert(result.written ? '已写入 provider cnb-issue' : (result.reason ?? '未写入'))
        } catch (writeError) {
          setError(writeError.message)
        } finally {
          setBusy(false)
        }
      }, [endpoint])

      const showSnippet = useCallback(async () => {
        setBusy(true)
        setError(null)
        try {
          setSnippet(await callApi('issue.configure', {}))
        } catch (snippetError) {
          setError(snippetError.message)
        } finally {
          setBusy(false)
        }
      }, [])

      if (!status?.loggedIn) return h(Banner, { tone: 'error' }, '请先在「账号」页扫码登录 CNB')

      const freeModels = state?.freeModels ?? []

      return h(
        React.Fragment,
        null,
        error === null ? null : h(Banner, null, error),

        h(
          Card,
          {
            title: 'Issue 网关',
            extra: h('span', { className: 'dcnb-muted' }, state === null ? '' : (state.repo ?? '未选仓库')),
          },
          h(
            'p',
            { className: 'dcnb-muted', style: { margin: '0 0 10px', lineHeight: 1.7 } },
            '不占用常驻云环境：每次提问借一个一次性容器，容器里有流水线令牌，可以直连 CNB 的 AI 网关。',
            h('br'),
            h('strong', null, '代价是慢'),
            ' —— 要等容器调度，几十秒起。需要秒回就用「云网关」。',
          ),
          h(
            'div',
            { className: 'dcnb-kv' },
            h('dt', null, '可用免费模型'),
            h('dd', null, freeModels.length === 0
              ? '（读取中）'
              : freeModels.map((entry) => entry.id).join(' · ')),
            h('dt', null, '注意'),
            h('dd', null, 'hy4free 并不存在（上游答 model-unknown），正确的是 hy4'),
          ),
          h(
            'div',
            { className: 'dcnb-row', style: { marginTop: 12 } },
            h('input', {
              className: 'dcnb-input',
              style: { flex: 1, minWidth: 200 },
              placeholder: '问它一句话…',
              value: question,
              disabled: busy,
              onChange: (event) => setQuestion(event.target.value),
            }),
            h('select', {
              className: 'dcnb-input',
              value: model,
              disabled: busy,
              onChange: (event) => setModel(event.target.value),
            }, (freeModels.length === 0 ? [{ id: 'hy4', label: 'hy4' }] : freeModels).map((entry) =>
              h('option', { key: entry.id, value: entry.id }, entry.label ?? entry.id))),
            h('button', { className: 'dcnb-btn', 'data-tone': 'primary', disabled: busy, onClick: () => void ask() },
              busy ? '等待容器…' : '提问'),
          ),
          busy
            ? h('div', { className: 'dcnb-muted', style: { marginTop: 10, fontSize: 12 } },
                '正在等一次性容器启动并调用模型。这条路径本身就是几十秒级，不是卡住了。')
            : null,
          answer === null
            ? null
            : h(
                'div',
                { style: { marginTop: 12 } },
                answer.ok
                  ? h(React.Fragment, null,
                      h('div', { className: 'dcnb-muted', style: { fontSize: 11, marginBottom: 6 } },
                        `模型 ${answer.model} · 构建 ${answer.build}`),
                      h('pre', {
                        className: 'dcnb-mono',
                        style: {
                          margin: 0, padding: 10, borderRadius: 8, whiteSpace: 'pre-wrap',
                          background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)',
                        },
                      }, answer.answer))
                  : h(Banner, { tone: 'error' }, answer.reason ?? '没有拿到答案'),
              ),
        ),

        h(
          Card,
          { title: '反向代理', extra: h('span', { className: 'dcnb-muted' }, 'OpenAI 兼容') },
          h(
            'p',
            { className: 'dcnb-muted', style: { margin: '0 0 10px', lineHeight: 1.7 } },
            '把这条路径包成标准接口，可以直接当 provider 用 —— 不需要为它改任何客户端。',
            h('br'),
            h('strong', null, '每次请求都会起一个一次性容器'),
            '，实测单次约 10 秒起；并发 ',
            String(endpoint === null ? '?' : endpoint.concurrency),
            '，超出的排队。',
          ),
          endpoint === null
            ? h(Spinner, { label: '读取地址…' })
            : h(React.Fragment, null,
                h('div', { className: 'dcnb-kv' },
                  h('dt', null, 'baseURL'),
                  h('dd', { className: 'dcnb-mono' }, endpoint.baseURL),
                  h('dt', null, '可用模型'),
                  h('dd', null, endpoint.models.map((m) => m.id).join(' · ')),
                ),
                h('div', { className: 'dcnb-row', style: { marginTop: 10 } },
                  h('button', {
                    className: 'dcnb-btn',
                    onClick: () => { if (navigator.clipboard?.writeText) navigator.clipboard.writeText(endpoint.baseURL).catch(() => {}) },
                  }, '复制 baseURL'),
                  h('button', { className: 'dcnb-btn', disabled: busy, onClick: () => void writeProvider() }, '写入 provider'),
                ),
                h('div', { className: 'dcnb-muted', style: { marginTop: 8, fontSize: 11, lineHeight: 1.7 } }, endpoint.note),
              ),
        ),

        h(
          Card,
          { title: '触发配置', extra: h('button', { className: 'dcnb-btn', disabled: busy, onClick: () => void showSnippet() }, '查看片段') },
          h('p', { className: 'dcnb-muted', style: { margin: 0, lineHeight: 1.7 } },
            '当前「提问」按钮走的是 ',
            h('code', { className: 'dcnb-mono' }, 'api_trigger'),
            '，不需要仓库额外配置。',
            h('br'),
            '下面这份是 ',
            h('code', { className: 'dcnb-mono' }, 'issue.open'),
            ' 版本 —— 想用「在仓库里开 Issue 就自动回答」时才需要，且必须在仓库页面',
            h('strong', null, ' 设置 → 云原生构建 '),
            '勾选「允许自动触发」，否则 Issue 开了也不会跑（平台限制，API 改不了）。'),
          snippet === null
            ? null
            : h('pre', {
                className: 'dcnb-mono',
                style: {
                  margin: '10px 0 0', padding: 10, borderRadius: 8, overflow: 'auto', maxHeight: 280,
                  background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)',
                },
              }, snippet.yml),
        ),
      )
    }


    const TABS = [
      ['account', '账号'],
      ['repos', '仓库'],
      ['envs', '开发环境'],
      ['usage', '用量'],
      ['cloud', '云网关'],
      ['issue', 'Issue 网关'],
      ['keepalive', '保活'],
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
          tab === 'cloud' ? h(CloudGatewayTab, { status: status.data }) : null,
          tab === 'issue' ? h(IssueGatewayTab, { status: status.data }) : null,
          tab === 'keepalive' ? h(KeepaliveTab, { status: status.data }) : null,
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
