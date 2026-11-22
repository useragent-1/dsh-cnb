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

装好后侧边栏出现 **CNB** 图标，同时注册 13 个 `cnb_*` 工具。配置项只有一个可选的覆盖点，写在 `cordis.patch.yml` 里：

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

```
repo-basic-info  repo-code  repo-cnb-detail  repo-cnb-history
repo-manage  repo-delete
group-resource  group-manage  group-delete
account-profile
```

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
| `cnb_workspace_control` | `action` `sn` `pipelineId` | 停止或删除环境 |
| `cnb_usage` | `slug` `month` | 组织额度与用量 |
| `cnb_gateway_probe` | `repo` `model` `prompt` | 网关真实调用 |
| `cnb_gateway_configure` | `repo` `route` `model` `makeDefault` | 写入 `llm-pi-ai` 路由 |

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
npm test                      # 离线：mini-yaml、二维码、overlay 回退
CNB_TOKEN=... npm test        # 追加实网冒烟：仓库、用量、网关、配置写入
```

实网冒烟只读 CNB，不建/删仓库，也不启停环境。`gateway-overlay` 这组会把生成的 YAML 片段丢给真实的 `llm-pi-ai` Config schema 校验，保证复制出去的东西能被 loader 接受。

二维码那组在装了 `jsqr` 时会额外把 SVG path 光栅化后解码，断言解出来的正是票据 URL；没装就只校验几何。

## 许可

MIT。`vendor/qrcode.cjs` 来自 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（Copyright © 2009 Kazuhiko Arase，MIT）。
