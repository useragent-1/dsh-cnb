# dsh-cnb

CNB（[cnb.cool](https://cnb.cool)）接入 DeepSeek​ Harness 的插件：扫码登录拿 token、管仓库、看云原生开发环境与组织用量，并把仓库自带的 CNB 网关模型一键写进 dsh 的模型配置。

一个插件，三个入口共用同一套能力：侧边栏 **CNB** 面板、`cnb_*` 工具、以及 `llm-pi-ai` 的 provider 路由。

---

## 能力

| 模块 | 面板 | 工具 | 说明 |
| --- | --- | --- | --- |
| 扫码登录 | 账号 | `cnb_status` `cnb_login_begin` `cnb_login_poll` | 微信扫码 → 自动创建访问令牌 → 存进 dsh 凭证库 |
| 仓库 | 仓库 | `cnb_repos` `cnb_repo_status` `cnb_repo_create` `cnb_repo_delete` | 列表 / 详情 / 新建 / 删除（删除需 `confirm: true`） |
| 云原生开发 | 开发环境 | `cnb_workspaces` `cnb_workspace_open` `cnb_workspace_control` | 列表 / 启动 / 停止 / 删除，读取 `.cnb/settings.yml` 里的按钮配置 |
| 组织用量 | 用量 | `cnb_usage` | 额度 + 当月用量，构建/开发核时、GPU、Git、对象存储、AI Credits |
| 网关模型 | 网关模型 | `cnb_gateway_probe` `cnb_gateway_configure` | 探测仓库的 CNB AI 网关，并写入 `llm-pi-ai` 路由 |

## 安装

插件是标准 dsh bundle。用插件管理器装上本地目录即可：

```bash
dsh plugin install /path/to/dsh-cnb      # 或在 Web UI 的插件页安装
```

装好后侧边栏出现 **CNB** 图标，同时注册 15 个 `cnb_*` 工具。配置项只有一个可选的覆盖点，写在 `cordis.patch.yml` 里：

```yaml
- id: dsh-cnb
  name: dsh-cnb
  config:
    webOrigin: https://cnb.cool      # 默认值，一般不用改
    apiOrigin: https://api.cnb.cool  # 默认值，一般不用改
    requestTimeoutMs: 25000
```

## 扫码登录

面板「账号」页点 **扫码登录**：插件向 CNB 取一个登录票据，把 `https://cnb.cool/login/wx/jump?ticket=…` 渲染成二维码（Host 侧编码成 SVG path，浏览器只画一个 `<path>`），每 2 秒轮询一次。

手机微信确认后，插件立刻用同一个会话调用 CNB 的令牌接口，按下面这些 scope 创建一个访问令牌：

**全部 26 项权限**，每项都取它能授予的最高级别，由 CNB 自己的 `GET /config/token/scope` 表在扫码时现取现算，不写死：

```
repo-code:rw  repo-pr:rw  repo-issue:rw  repo-notes:rw  repo-release:rw
repo-commit-status:rw  repo-cnb-trigger:rw  repo-cnb-history:r
repo-cnb-detail:rw  repo-basic-info:r  repo-manage:rw  repo-delete:rw
repo-security:r  registry-package:rw  registry-package-delete:rw
registry-security:r  registry-manage:rw  registry-delete:rw
account-profile:rw  account-email:r  account-engage:rw
group-resource:rw  group-manage:rw  group-delete:rw
mission-delete:rw  mission-manage:rw
```

### 权限不足时的替代路径

两项权限没有放宽的余地，但**停止环境**有一条等价的替代路径：

| 操作 | 账号级接口 | 需要 | 替代路径 | 需要 |
|---|---|---|---|---|
| 停止环境 | `POST /workspace/stop` | `account-engage:rw` | `POST /{repo}/-/build/stop/{sn}` | `repo-cnb-trigger:rw` |
| 删除环境 | `POST /workspace/delete` | `account-engage:rw` | 无 | — |
| 新建仓库 | `POST /{slug}/-/repos` | `group-resource:rw` | 无 | — |

停止环境时插件先走账号级接口；若返回缺 `account-engage`，自动改走仓库级流水线停止（只需 `repo-cnb-trigger:rw`，也就是启动环境本来就需要的权限），面板会标注「经仓库级流水线停止」。已结束的流水线返回 422，插件识别为「该环境已经结束」而不是失败。为此 `workspaces.stop` 接受 `repo` 参数；面板在列表里会自动带上。

删除环境与新建仓库只有组织/账号级接口，没有替代路径——这两项确实需要全权限令牌。

**级别后缀是必须的。** CNB 的授权项写法是 `<group>-<code>:<level>`。只发 `repo-code`（不带 `:r`/`:rw`）时，创建接口不会报错，但签出的令牌**不含任何有效权限**——之后每个调用都返回 `10023`，看起来就像账号没有权限。这就是为什么列表要现取现算，并且 `test/scopes.test.mjs` 会逐项断言级别存在且合法。

想只授权这个插件用到的部分，把 `profile` 换成 `plugin`：11 项，覆盖仓库、组织、身份与环境控制，不含制品库与任务集。

### 令牌自检

「账号」页有 **检测权限** 按钮（工具 `cnb_token_doctor`），逐个探测面板实际用到的 8 个接口——身份、仓库、组织、额度用量、环境列表，加上停止/删除环境、新建仓库、删除仓库这三项写权限。每次都单独报告结果和缺的 scope。

写权限的探测不会产生副作用：CNB 先查权限、再查对象，所以探测请求故意指向不可能存在的对象。权限缺失时返回 403，权限具备时会返回 400/404——两种情况都不会真的停环境、建仓库或删仓库。扫码成功后也会自动跑一遍自检——如果签出的令牌仍然缺权限，面板直接告诉你缺哪些，而不是让你对着空列表猜。

自检能区分三种情况：令牌无效（CNB 不接受）、令牌有效但缺权限项、一切正常。

令牌明文只出现一次，随后写进 dsh 的凭证库，不落配置文件：

- 记录 `dsh-cnb/cnb-token`（`kind: grant`）——面板与工具的身份来源；
- 键 `CNB_TOKEN`——`llm-pi-ai` 的 `apiKeyEnv` 解析到的同一个值。

也可以在「已有访问令牌？」里粘贴一个在 [cnb.cool/profile/token](https://cnb.cool/profile/token) 建好的令牌。

## 云原生开发

「开发环境」页列出当前账号的全部环境（运行中/已关闭），可直接打开 WebIDE、停止或删除。查询某个仓库时会额外读取默认分支的 `.cnb/settings.yml`，把开发按钮的 `name` / `description` / `hoverImage` / `cpus` / `disabled` / `autoOpenWebIDE` 显示出来，并列出该仓库已有环境。

## 组织用量

「用量」页按组织展示 7 类资源的「已用 / 总额度」与占比条：Git 存储、对象存储、云原生构建、云原生开发、构建 GPU、开发 GPU、AI Credits。

额度接口任何成员都能读；**用量**接口需要根组织负责人权限，读不到时该组织的用量显示为不可读，额度仍然展示。

## 网关模型

CNB 的 AI 网关挂在仓库下，只接受流式 Chat Completions：

```
POST https://api.cnb.cool/<repo>/-/ai/chat/completions
Authorization: Bearer <CNB token>
{ "model": "deepseek-v4.1-flash", "stream": true, "messages": [...] }
```

「网关模型」页填仓库 → **测试调用** 会对网关发一次真实请求；**一键配置到 dsh** 会往 `llm-pi-ai` 写一个 provider 路由：

```yaml
- id: llm-pi-ai
  config:
    providers:
      cnb-gateway:
        api: openai-completions
        baseURL: https://api.cnb.cool/<repo>/-/ai
        apiKeyEnv: CNB_TOKEN
        models:
          - id: deepseek-v4.1-flash
```

勾选「同时设为默认模型」会一并改写 `agent-default-model`。两处写入都走 dsh 的 `configEditor`，因此配置文件仍是唯一事实来源。

**如果这两个条目被 home patch 或命令行 `--patch` 覆盖**，`configEditor` 会拒绝写入（它不写在更高优先级层之下）。这时面板不会报错收场，而是给出可直接并入那份 overlay 的 YAML 片段，并附「复制片段」。

## 工具清单

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `cnb_status` | — | 登录状态、账号、令牌有效期、待扫码会话 |
| `cnb_login_begin` | — | 取扫码票据，返回 URL 与二维码 SVG path |
| `cnb_login_poll` | — | 轮询一次；confirmed 时已自动建好并保存令牌 |
| `cnb_repos` | `search` `page` `pageSize` | 仓库列表，附每个仓库的环境 |
| `cnb_repo_status` | `repo` | 元信息 + 最近构建 + 环境 + 开发按钮 |
| `cnb_repo_create` | `slug` `name` `visibility` `description` | 建仓库 |
| `cnb_repo_delete` | `repo` `confirm` | 删仓库（必须 `confirm: true`） |
| `cnb_workspaces` | `repo` `status` | 环境列表 |
| `cnb_workspace_open` | `repo` `branch` | 启动/复用环境，返回 WebIDE 地址 |
| `cnb_workspace_control` | `action` `repo` `sn` `pipelineId` | 停止或删除环境（`repo` 让停止可改走仓库级） |
| `cnb_usage` | `slug` `month` | 组织额度与用量 |
| `cnb_gateway_probe` | `repo` `model` `prompt` | 网关真实调用 |
| `cnb_gateway_configure` | `repo` `route` `model` `makeDefault` | 写入 `llm-pi-ai` 路由 |
| `cnb_login_scopes` | — | 列出 CNB 可授权的权限项及级别 |
| `cnb_token_doctor` | — | 逐接口探测令牌能做什么、缺哪个权限项 |

## 实现要点

- **令牌只在 Host**。浏览器调 `/dsh-cnb/api/*`，由 Host 用凭证库里的令牌访问 CNB；响应里不会出现令牌。
- **面板路由自带同源校验**：校验 `Origin`/`Host` 一致并拒绝 `Sec-Fetch-Site: cross-site`。
- **不用第三方依赖**。二维码用 MIT 许可的 `qrcode-generator`（vendored，`vendor/qrcode.cjs`）；`.cnb/settings.yml` 由一个只读该文件格式子集的解析器处理（`lib/mini-yaml.js`），不往 profile 里塞 YAML 库。
- **一个能力表**。`lib/index.js` 里的 `operations` 同时驱动面板路由和 agent 工具，两边不会漂移。

```
dsh-cnb/
├── lib/
│   ├── index.js        Host：能力表、路由、工具、configEditor 写入
│   ├── cnb-client.js   扫码状态机 + OpenAPI 客户端
│   ├── mini-yaml.js    .cnb/settings.yml 子集解析
│   └── qr.js           票据 → SVG path
├── client.js           面板（React，slots 注册）
├── vendor/qrcode.cjs   MIT 二维码编码器
└── test/               离线测试 + 需 CNB_TOKEN 的实网冒烟
```

## 测试

```bash
npm test                      # 离线：权限表与级别、扫码状态机、自检、mini-yaml、二维码、overlay
CNB_TOKEN=... npm test        # 追加实网冒烟：仓库、用量、网关、配置写入
```

实网冒烟只读 CNB，不建/删仓库，也不启停环境。`gateway-overlay` 这组会把生成的 YAML 片段丢给真实的 `llm-pi-ai` Config schema 校验，保证复制出去的东西能被 loader 接受。

二维码那组在装了 `jsqr` 时会额外把 SVG path 光栅化后解码，断言解出来的正是票据 URL；没装就只校验几何。

## 许可

MIT。`vendor/qrcode.cjs` 来自 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（Copyright © 2009 Kazuhiko Arase，MIT）。
