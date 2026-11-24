/**
 * issue 反代的地址必须按**当前环境**推，不能写死回环。
 *
 * ## 这条测的是「别人装了能不能用」
 *
 * dsh 在 CNB 环境里以 `--host <容器IP>` 启动（实测 `172.17.0.16`），所以
 * `http://127.0.0.1:3080/...` 上**没有任何东西在监听**：
 *
 *     127.0.0.1:3080     -> 000   （连不上）
 *     172.17.0.16:3080   -> 200
 *     xxx-3080.cnb.run   -> 200
 *
 * 写死回环的 provider 在**所有**环境里都是坏的，报错却只说 connection refused，
 * 看不出是地址问题。更迷惑的是「在我这台能用」：某次配置里恰好写了容器 IP，
 * 换一台环境那个 IP 就不存在了。
 *
 * 所以默认值必须走端口预览模板，它会在每次启动时按当前环境重算。
 */
import assert from 'node:assert/strict'
import { issueBaseFor } from '../lib/index.js'

// --- 1. 有端口预览模板时，用当前环境的域名 ----------------------------
{
  const url = issueBaseFor({ CNB_VSCODE_PROXY_URI: 'https://9ii8zsqtus-{{port}}.cnb.run' })
  assert.equal(url, 'https://9ii8zsqtus-3080.cnb.run/dsh-cnb/issue/v1')
  // 换个环境就是另一个域名 —— 这正是「每台环境各自算一遍」的意思。
  const other = issueBaseFor({ CNB_VSCODE_PROXY_URI: 'https://l4v7a0n4ls-{{port}}.cnb.run' })
  assert.notEqual(other, url)
  assert.match(other, /^https:\/\/l4v7a0n4ls-3080\.cnb\.run\//)
}

// --- 2. 模板里的 {{port}} 必须被换成 web 端口 -------------------------
{
  assert.match(issueBaseFor({ CNB_VSCODE_PROXY_URI: 'https://x-{{port}}.cnb.run' }, 4000), /x-4000\.cnb\.run/)
  // 尾斜杠不能变成双斜杠。
  assert.equal(
    issueBaseFor({ CNB_VSCODE_PROXY_URI: 'https://x-{{port}}.cnb.run/' }),
    'https://x-3080.cnb.run/dsh-cnb/issue/v1',
  )
  // 模板里没有 {{port}} 就不是端口预览模板，退回下一档。
  const noToken = issueBaseFor({ CNB_VSCODE_PROXY_URI: 'https://fixed.cnb.run', CNB_WORKSPACE_HOST: '10.0.0.5' })
  assert.equal(noToken, 'http://10.0.0.5:3080/dsh-cnb/issue/v1')
}

// --- 3. 没有模板时用容器 IP，而不是回环 -------------------------------
{
  const url = issueBaseFor({ CNB_WORKSPACE_HOST: '172.17.0.16' })
  assert.equal(url, 'http://172.17.0.16:3080/dsh-cnb/issue/v1')
  assert.ok(!url.includes('127.0.0.1'), 'the container IP beats loopback: loopback has no listener')
}

// --- 4. 回环只是最后兜底 ----------------------------------------------
{
  const url = issueBaseFor({})
  assert.equal(url, 'http://127.0.0.1:3080/dsh-cnb/issue/v1')
  // 空白值不能当有效值用（环境变量常见形态）。
  const blank = issueBaseFor({ CNB_WORKSPACE_HOST: '   ', CNB_VSCODE_PROXY_URI: '' })
  assert.equal(blank, 'http://127.0.0.1:3080/dsh-cnb/issue/v1')
}

// --- 4b. 容器主机名不是地址，不能拿来当 host ---------------------------
//
// 实测（流水线容器）：`CNB_VSCODE_PROXY_URI` 为空，`hostname` 是 `2bb575c42639`
// 这种容器 ID。把它写进 provider 只会得到一个从别处解析不了的地址 —— 比回环更
// 糟，因为回环至少语义诚实（本机跑、本机用），而容器主机名看起来像个有效主机。
{
  const url = issueBaseFor({ HOSTNAME: '2bb575c42639' })
  assert.ok(!url.includes('2bb575c42639'), 'a container hostname must never become the provider host')
  assert.equal(url, 'http://127.0.0.1:3080/dsh-cnb/issue/v1')
  // 真给了可路由地址才用它。
  assert.equal(
    issueBaseFor({ HOSTNAME: '2bb575c42639', CNB_WORKSPACE_HOST: '172.17.0.24' }),
    'http://172.17.0.24:3080/dsh-cnb/issue/v1',
  )
}

// --- 4c. 真实的两种环境各算各的 ---------------------------------------
//
// 这两个值是从真环境里读出来的，不是编的：
//   · 云原生开发环境（dsh 主进程所在）：CNB_VSCODE_PROXY_URI 带 {{port}} 模板
//   · 流水线容器：该变量为空
// 后者根本不会跑本插件（webServer 只在 dsh 主进程里注册），所以前者是常态。
{
  const devEnv = issueBaseFor({ CNB_VSCODE_PROXY_URI: 'https://76j9sspyrr-{{port}}.cnb.run' })
  assert.equal(devEnv, 'https://76j9sspyrr-3080.cnb.run/dsh-cnb/issue/v1')

  const anotherDev = issueBaseFor({ CNB_VSCODE_PROXY_URI: 'https://l4v7a0n4ls-{{port}}.cnb.run' })
  assert.equal(anotherDev, 'https://l4v7a0n4ls-3080.cnb.run/dsh-cnb/issue/v1')
  assert.notEqual(anotherDev, devEnv, 'each environment derives its own domain')
}

// --- 5. 路径固定，且总是指向本插件的反代 ------------------------------
{
  for (const env of [
    { CNB_VSCODE_PROXY_URI: 'https://a-{{port}}.cnb.run' },
    { CNB_WORKSPACE_HOST: '1.2.3.4' },
    {},
  ]) {
    assert.match(issueBaseFor(env), /\/dsh-cnb\/issue\/v1$/, 'every form ends at the issue proxy path')
  }
}
