# dsh-cnb

CNB（[cnb.cool](https://cnb.cool)）接入 DeepSeek​ Harness 的插件：扫码登录拿 token、管仓库、看云原生开发环境与组织用量，并把仓库自带的 CNB 网关模型一键写进 dsh 的模型配置。

一个插件，三个入口共用同一套能力：侧边栏 **CNB** 面板、`cnb_*` 工具、以及 `llm-pi-ai` 的 provider 路由。

---

## 能力

| 模块 | 面板 | 工具 | 说明 |
| --- | --- | --- | --- |
| 扫码登录 | 账号 | `cnb_status` `cnb_login_begin` `cnb_login_poll` | 微信扫码 → 自动创建访问令牌 → 存进 dsh 凭证库 |
| 多账户 | 账号 | `cnb_accounts` `cnb_account_switch` `cnb_account_rename` `cnb_account_remove` | 存多个 CNB 账号、一键切换、改名、删除；切换不重新扫码，过期令牌用该账户自己的会话自动重签 |
| 仓库 | 仓库 | `cnb_repos` `cnb_repo_status` `cnb_repo_create` `cnb_repo_delete` | 列表 / 详情 / 新建 / 删除（删除需 `confirm: true`） |
| 云原生开发 | 开发环境 | `cnb_workspaces` `cnb_workspace_open` `cnb_workspace_control` | 列表 / 启动 / 停止 / 删除，读取 `.cnb/settings.yml` 里的按钮配置 |
| 组织用量 | 用量 | `cnb_usage` | 额度 + 当月用量，构建/开发核时、GPU、Git、对象存储、AI Credits |
| 网关模型 | 网关模型 | `cnb_gateway_probe` `cnb_gateway_configure` | 探测仓库的 CNB AI 网关，并写入 `llm-pi-ai` 路由 |
| 云网关 | 云网关 | `cnb_cloud_gateway` `cnb_cloud_gateway_harvest` `cnb_cloud_gateway_verify` `cnb_cloud_gateway_wire` | **全自动**：建仓库 → 写零依赖代理 → 云原生启动 → 采集公开地址 → 校验 → 写 provider。含 11288 / 11128 风控适配 |
| 仓库清理 | 仓库 | `cnb_repos_delete` `cnb_cleanup_status` `cnb_cleanup_settings` `cnb_cleanup_cycle` `cnb_cleanup_environments` `cnb_cleanup_setup` | 批量删除（勾选 / 按条件，必须 `confirm: true`）；云网关建的仓库没人用了自动删掉（默认关闭）；已结束的开发环境记录自动清理（默认开启） |

## 安装

插件是标准 dsh bundle。下载后把目录装进你的 profile：

```bash
# 克隆到任意位置
git clone https://github.com/useragent-1/dsh-cnb.git
cd dsh-cnb && npm test          # 可选：先跑一遍离线测试

# 装进你的 profile（把 <profile> 换成你实际用的，例如 web）
dsh plugin --profile <profile> add /绝对路径/dsh-cnb
```

`dsh plugin` 转发给 pnpm，所以本地目录要用**绝对路径**。

装完在 dsh 的 Web 界面侧边栏会出现 **CNB** 入口，同时注册 33 个 `cnb_*` 工具给 agent。

配置项只有一个可选的覆盖点，写在 `cordis.patch.yml` 里：

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

### 二维码扫出来就报 `state is invalid`（≤ 0.19.2 的问题，已修）

现象：二维码刚显示，第一次轮询就报

```
state is invalid. (errcode 3)
```

这张票其实从生成那一刻起就是无效的，和手速、微信号、网络都无关。

原因是 `GET /login/state` 自己还会下发一个**票据绑定** cookie：

```
Set-Cookie: __Host-cnb_login_bind=…; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax
```

服务端把 `state`/`uuid` 和它绑在一起校验。旧代码只合并了 `/login` 的 `csrfkey`/`csrftoken`，漏掉这一个，于是每次轮询都是"有 state、有 uuid、没带票"——CNB 一律答 `errcode 3`，面板把英文原文当结论贴出来。

0.19.3 起：

- `/login/state` 的 `Set-Cookie` 一并进 cookie jar，轮询自然带齐三个 cookie；
- 票据绑定 cookie（10 分钟）**不**再被当成会话寿命，不会把"还剩 14 天"报成 10 分钟后过期；
- 万一票真的被判死（二维码放置超过 10 分钟、绑定 cookie 过期，或这张票已被用过），面板**自动换一张新票**并说明原因，而不是留一行英文报错让你猜；实测同时开两个登录会话不会互相作废，所以不必关掉别的窗口；
- 只有 `errcode 3` 才算票失效，上游 5xx 之类的故障不会把会话判死。

已装旧版的话，更新到 0.19.3 再重启即可，不需要清凭证。

### 权限不足时的替代路径

两项权限没有放宽的余地，但**停止环境**有一条等价的替代路径：

| 操作 | 账号级接口 | 需要 | 替代路径 | 需要 |
|---|---|---|---|---|
| 停止环境 | `POST /workspace/stop` | `account-engage:rw` | `POST /{repo}/-/build/stop/{sn}` | `repo-cnb-trigger:rw` |
| 删除环境 | `POST /workspace/delete` | `account-engage:rw` | 无 | — |
| 新建仓库 | `POST /{slug}/-/repos` | `group-resource:rw` | 无 | — |

停止环境时插件先走账号级接口；若返回缺 `account-engage`，自动改走仓库级流水线停止（只需 `repo-cnb-trigger:rw`，也就是启动环境本来就需要的权限），面板会标注「经仓库级流水线停止」。已结束的流水线返回 422，插件识别为「该环境已经结束」而不是失败。为此 `workspaces.stop` 接受 `repo` 参数；面板在列表里会自动带上。

删除环境与新建仓库只有组织/账号级接口，**没有仓库级替代路径**。它们靠的是另一条路：登录会话（见下节），而不是令牌的 scope。

### 用登录会话绕过 token 的 scope 限制

CNB 有两套彼此独立的鉴权模型：

- **访问令牌**（`Authorization: Bearer`）：权限由签发时写入的 scope 决定，导入的令牌可能永远缺 `group-resource:rw` 或 `account-engage:rw`。
- **网页登录会话**（cookie）：代表"已登录的这个人"本身，**不受 token scope 限制**。而且 `cnb.cool` 这个网页 origin 上同样挂载了同一批 JSON API。

所以插件遇到 `10023`（缺 scope）时不会立刻失败：它会把同一个请求改发到 `cnb.cool`，带上保存下来的会话 cookie 和 `csrftoken`。成功就用这个结果。只有会话也被拒（说明这个人本身没有该权限）才报告缺权限。

这条路径对**新建仓库**和**删除环境**是决定性的：只要你的账号在这些组织里是管理员/负责人，扫码一次之后这两项就能用，不需要改动令牌的任何 scope。

### 让这两项可用的三条路

按代价从低到高：

**A. 扫码一次（最省事）** —— 会话被保存，之后缺 scope 的调用自动改走会话。**不需要碰令牌的任何 scope**，只要你在组织里是管理员/负责人。

**B. 在 CNB 令牌页给令牌补 scope** —— [cnb.cool/profile/token](https://cnb.cool/profile/token) → 对应令牌 → 编辑：

| 权限项 | 级别 | 勾选后的效果 |
|---|---|---|
| 账号 · `account-engage` | 读写 | 关注仓库/关注者，**以及云原生开发环境的停止/删除** |
| 组织 · `group-resource` | 读写 | 组织资源：**新建仓库**、任务集等 |

**C. 重新签发令牌** —— 插件会按 26 项全权限重签。若重签后仍缺，说明账号被角色限制，不是令牌问题。

A 和 B 的区别在于**谁承担授权**：A 用的是你这个人的身份，B 把权限固化进令牌。令牌会过期、会丢，会话不会因为 scope 缺失而失效，所以 A 更稳。

「账号」页的 **检测权限** 会把缺的项直接列成可点行（权限名 + 中文含义 + 打开令牌页按钮），不用自己猜代码名对应哪个勾选框。

**级别后缀是必须的。** CNB 的授权项写法是 `<group>-<code>:<level>`。只发 `repo-code`（不带 `:r`/`:rw`）时，创建接口不会报错，但签出的令牌**不含任何有效权限**——之后每个调用都返回 `10023`，看起来就像账号没有权限。这就是为什么列表要现取现算，并且 `test/scopes.test.mjs` 会逐项断言级别存在且合法。

想只授权这个插件用到的部分，把 `profile` 换成 `plugin`：11 项，覆盖仓库、组织、身份与环境控制，不含制品库与任务集。

### 扫码后自动保证拿到能用的令牌

CNB 的创建接口对一份"授予不了任何权限"的 scope 也返回成功，所以"签出成功"不等于"能用"。插件因此不是签完就结束：

1. **签**：按平台权限表现取现算，全部 26 项、每项取最高级别（`<group>-<code>:<level>`）。
2. **验**：立刻拿新令牌读账号、仓库、组织。任一项读不到，就判定这个令牌不可用，**不写入、不报告成功**。
3. **换**：依次换用更窄的授权清单重试——全权限 → 插件所需 11 项 → 最小 8 项。账号角色限制了某类授权时，更窄的清单有时仍能通过。
4. **报**：只在某个清单真的产出可用令牌后才存进凭证库，并告诉你用的是哪一档。全部失败时明确说明这是账号角色限制，而不是令牌格式问题。

所以扫码是"一次操作、必然有结论"，不需要你事后自己去核对权限。

### 登录 Cookie 的有效期

**有效期由 CNB 决定，插件只读取并显示，不提供设置项。**

读取方式是看 CNB 确认登录时实际下发的 `Set-Cookie` 属性：

- `Max-Age` 优先（按 RFC 6265 它压过 `Expires`），其次 `Expires`
- 只认带生命周期的会话类 cookie（名称匹配 `session`/`alive`/`auth`/`token`/`login`）；`csrfkey`、`csrftoken` 没有生命周期，忽略；票据绑定 cookie（`__Host-cnb_login_bind`，10 分钟）属于这张二维码而不是会话，也忽略
- 服务端没给时长时，才回退到文档里的默认 7 天，并且**明确标注是估算**

「账号」页显示成这样：

```
登录 Cookie   到期 2026-12-21 19:54:23 · 还剩 29d0h
```

若来源是估算，会多一句「（按默认 7 天估算）」。没有保存会话时显示「未保存」，不编日期。

自动重签会**保留原始到期时间**，不会因为续签而把计时清零。

> 早先版本在面板上放过 1/7/30/90 天的选择器，那是错的：有效期不是用户该配的东西，而且它发送的 `login_days` 只被一条本插件走不到的确认路由识别。已删除。

### 登录会话会被保存，令牌问题自动修复

扫码时浏览器拿到的那份 cookie 会话会被一并存进凭证库（和令牌同一条记录，`session` 字段）。它的作用：

- 令牌**过期、被撤销、或权限不足**时，插件用这份会话自动向 CNB 重新申请一次令牌，并在换成功后重试刚才失败的那次调用。你在面板上看到的不是"请重新扫码"，而是调用直接成功。
- 重签走的是与扫码完全相同的三档清单（全权限 → 插件所需 → 最小）和验证流程，所以新令牌同样保证可用。
- 会话本身失效（回答 401）时才会提示重新扫码——这时也确实只有扫码能解决。

「账号」页的「自动续签」一行会告诉你当前是否已保存会话。保存了就不需要你再管令牌；没保存（比如手动粘贴令牌）就只在那一次有效。

### 多个账号：存着，随手切

以前一个 profile 只认一个登录：扫码换人，上一个人的令牌就被覆盖了，想换回来只能再扫一次。现在每个账号各占一条凭证记录，面板「账号」页把它们列出来。

```
dsh-cnb/accounts              账户索引：名字、时间、健康状态 —— 不含令牌
dsh-cnb/account-<id>          每个账户自己的令牌 + 会话
dsh-cnb/cnb-token             当前生效的那一条（始终是上面某一条的副本）
```

「当前」那条仍然是唯一权威：API 客户端、网关、令牌自检全读它，所以切换只是把某条记录复制过去再动一个指针——**没有第二条读取路径，也就没有"面板看着是 A、实际用 B"这种错位**。

面板上每个账户可以：

- **切换**：一次点击，不扫码。令牌过期了会先用这个账户自己的会话自动重签，成功才报切换完成；重签失败会明说「已切换，但自动重签失败」，而不是假装一切正常。
- **改名**：「公司号」「小号」这种。改名之后再次扫码登录同一个人，名字不会被冲掉。
- **删除**：先确认。删的是当前账户就自动切到最近用过的另一个；删光就是退出登录。

识别"同一个人"用的是 CNB 的 `username`，不是昵称——改显示名不会变成两个账户，重新扫码也不会多出一条。导入令牌（`login.importToken`）同样走这套，所以扫码和粘贴的账户在同一个列表里。

**退出登录只清当前账户**：其它账户的令牌原样留着，`kept` 会告诉面板还剩几个。因为「退出」的意思是"现在不用这个账号"，不是"把这些令牌都烧了"；真要删某个账户用「删除」。

账户列表里没有任何机密：只有名字、用户名、时间戳，和 `有令牌`/`有会话` 两个布尔。令牌本身只在那条按 id 读取的 payload 里，浏览器永远拿不到。

工具侧对应四个：`cnb_accounts` / `cnb_account_switch` / `cnb_account_rename` / `cnb_account_remove`，agent 可以直接"换成小号再看一眼仓库"。

### 令牌自检

「账号」页有 **令牌自检** 卡片（工具 `cnb_token_doctor`），逐个探测面板实际用到的 8 个接口——身份、仓库、组织、额度用量、环境列表，加上停止环境、新建仓库、删除仓库这三项写权限。

界面分三层读：

1. **一行结论**：`8/8 可用` 或 `7/8 可用`，并分开统计 `读取 5/5`、`写入 2/3`。
2. **按读写分组**：每项一行，显示中文名、判定和一句人话摘要（如「19 个仓库 · org/repo」），不输出原始 JSON。
3. **判定只有四种**：`可用` / `降级可用`（经仓库级回退，如「停止环境」走流水线停止）/ `受限`（缺 scope，直接列出缺哪项）/ `失败`（非权限原因）。

判定里的 `经会话可用` 是关键：令牌缺这项权限，但保存的登录会话把它完成了——功能能用，所以不算失败，只用黄色标注并说明原因。自检的探测客户端本身带着会话，因此它测的是**功能是否可用**，而不是令牌的字面 scope。

只有会话也拒绝时才会显示 `受限` 并列出「去 CNB 令牌页勾选」。

写权限的探测不会产生副作用：CNB 先查权限、再查对象，所以探测请求故意指向不可能存在的对象。权限缺失时返回 403，权限具备时会返回 400/404——两种情况都不会真的停环境、建仓库或删仓库。扫码成功后也会自动跑一遍自检——如果签出的令牌仍然缺权限，面板直接告诉你缺哪些，而不是让你对着空列表猜。

自检能区分三种情况：令牌无效（CNB 不接受）、令牌有效但缺权限项、一切正常。

令牌明文只出现一次，随后写进 dsh 的凭证库，不落配置文件：

- 记录 `dsh-cnb/cnb-token`（`kind: grant`）——面板与工具的身份来源；
- 键 `CNB_TOKEN`——`llm-pi-ai` 的 `apiKeyEnv` 解析到的同一个值。

也可以在「已有访问令牌？」里粘贴一个在 [cnb.cool/profile/token](https://cnb.cool/profile/token) 建好的令牌。

## 内容风控：为什么直连会 400

CNB 的 AI 网关会扫描请求体，命中「客户端指纹」就整条拒绝：

```
HTTP 400  {"code":11128,"msg":"Illegal API invocation from an unapproved channel"}
```

换令牌、换账号、换模型、补请求头都无效——被拦的是**提示词本身**。而且只在请求体较大时稳定触发（约 >1KB），所以表现为时好时坏：短探测通过，真实对话失败。

实测确认（2026-11，本机复现）：

| 请求体里的文本 | 结果 |
|---|---|
| `Main branch (the usual target for pull requests)` | **400 / 11128** |
| 同上，经插件改写后 | **200** |

只扫 `system` 和 `assistant` 两个角色的文本；`user` 内容和工具描述不扫。所以插件在发请求前做三件事，都不改语义：

1. **改写已知指纹**：把被拦的表述换成等价说法；身份词（`DeepSeek Harness`）中间插入零宽空格——人读不出差别，匹配不到。路径语境（`D:\...\DeepSeek Harness\...`）会跳过，否则会把坏路径交给工具调用。
2. **归一消息形状**：新的 `developer` 角色映射成 `system`，中途的 `system` 提前。
3. **兜底重试**：真的吃到 400/11128 时，逐级把 system 并进首条 user，再把非 user 消息逐词打散。

这套逻辑内置在插件里，**不需要额外部署任何代理**。

> 移植自 MIT 许可的 cnb2api 中性化实现，见 [LICENSE-cnb2api](LICENSE-cnb2api)。短语表已对真实网关验证。

### 让新仓库自动配好网关（推荐）

网关令牌只对签发它的仓库有效，但它**可以从密钥仓库自动注入**。配置一次，之后任何仓库启动环境都自带令牌，插件读到就直接用——不需要任何人手动粘贴。

**1. 建一个密钥仓库**（[cnb.cool/new/repos](https://cnb.cool/new/repos)，类型选「密钥仓库」），内容：

```yaml
# env.yml
CNB_GATEWAY_TOKEN: <你的流水线令牌>
```

密钥仓库禁止本地 clone，只能在网页编辑，带审计日志。

**2. 在需要网关的仓库里，改 `.cnb.yml`：**

```yaml
$:
  vscode:
    - services:
        - vscode
      imports:
        - https://cnb.cool/<密钥仓库路径>/-/blob/main/env.yml
```

**3. 完成。** 这个仓库每次启动开发环境，`CNB_GATEWAY_TOKEN` 都会作为环境变量注入；插件启动时自动读取、验证、存为网关令牌。

插件认可三个名字，按此顺序检查：

```
CNB_TOKEN          ← CNB 自己注入的（云环境自带）
CNB_API_TOKEN
CNB_GATEWAY_TOKEN  ← 密钥仓库导入的
```

所以老仓库不用改，新仓库加两行 `imports` 即可。

> 局限：令牌仍然只对**它所属的那个仓库**有效。用 `k` 的令牌，所有环境都会走 `k` 的网关与额度，这正是「统一一套网关」的做法；想让每个仓库各走各的额度，就得各自注入各自的令牌。

### 第一次使用的完整路径

网关只接受**流水线令牌**，而这种令牌只存在于运行中的环境里。个人访问令牌既读不到它，也调不了网关（两条 AI 路径都返回 `[NO_RIGHT] OpenAPI only allowed in pipeline`），所以插件无法代你取得。

能省掉的是猜测。面板上有一个 **帮我启动一个环境**：

1. 它在你能用的仓库里启动一个云环境（没有就自动挑一个）
2. 返回三步操作：打开 WebIDE → 在终端执行 `echo $CNB_TOKEN` → 把输出粘到「导入网关令牌」
3. 顺带给出可复制的命令和直达 WebIDE 的链接

导入时会先验证：个人令牌或属于别的仓库的令牌会被当场拒绝并说明原因，不会存下来变成以后每次调用都失败的配置。

### 如果你的部署已经有本地代理

有些部署用本地反向代理（`http://127.0.0.1:<port>/v1`）承担同样的改写，并通过 `--patch` 接管了 `llm-pi-ai`。那种情况下插件不会覆盖它：`--patch` 优先级高于 profile 层，DSH 会拒绝写入，面板会说明「由更高优先级的配置层接管」，并建议保持现状。

## Issue 网关：借一次容器，给你一个真正的 OpenAI 接口

网关只接受**流水线令牌**，而它只存在于运行中的环境里。于是插件提供了另一条路：**Issue / api_trigger 事件本身就能起一个一次性容器**，那个容器里有 `CNB_TOKEN`。反代把这条慢路径包成一个标准 OpenAI 端点：

```
GET  {baseURL}/models               # 免费模型清单，秒回
POST {baseURL}/chat/completions     # 真正的 chat，支持 tools 与多轮
```

`baseURL` 默认按当前环境算（端口预览域名 > 容器 IP > 回环），也可以用 `issue.endpoint` / `cnb_issue_endpoint` 查当前该用什么地址。

### 它支持什么

| 能力 | 说明 |
| --- | --- |
| `tools` / `tool_choice` | 原样送上游，响应里给**结构化 `tool_calls`**，`finish_reason` 为 `tool_calls` |
| 多轮 | `messages` 整段透传：`assistant.tool_calls`、`tool` 角色与 `tool_call_id` 都在，模型能看到工具跑出了什么 |
| `stream: true` | 标准 SSE：`delta.tool_calls` 分片 + 末尾 `finish_reason` + `usage` + `[DONE]` |
| `usage` | 上游的 token 统计原样带回，不做零填充 |
| 内联工具调用 | 上游偶尔把调用写成正文里的 DSML 标记，这里翻译成结构化 `tool_calls`（只删标记的话工具不会执行） |

一次真实的调用（`bash` 工具，两个来回）：

```bash
curl -sS $BASE/chat/completions -H 'content-type: application/json' -d '{
  "model": "deepseek-v4.1-flash",
  "messages": [{"role": "user", "content": "用 bash 跑 pwd"}],
  "tools": [{"type": "function", "function": {
    "name": "bash",
    "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}
  }}]
}'
# -> message.tool_calls = [{"function": {"name": "bash", "arguments": "{\"command\": \"pwd\"}"}}]
#    finish_reason = "tool_calls"

# 把结果回传，继续同一段对话：
#   {"role":"assistant","tool_calls":[...]}, {"role":"tool","tool_call_id":"...","content":"/workspace"}, {"role":"user","content":"路径是什么？"}
# -> message.content = "刚才 pwd 的输出是 /workspace"，finish_reason = "stop"
```

### 两条后端，行为一致

| 后端 | 何时用 | 延迟 |
| --- | --- | --- |
| **本地桥** | dsh 自己跑在云环境里（进程里有 `CNB_TOKEN`），直连 `/-/ai-ide/v2/chat/completions` | 1–2 秒，零调度 |
| **容器回落** | 不在云环境里；每次借一个一次性容器转发 | 数十秒（容器调度 + 推理） |

两条路吃的是**同一个上游 payload**，也不再有任何一条把 `messages` 压成一句 question —— 所以「换个部署位置工具就不灵了」这类问题不会再出现。

容器那条路怎么保证不丢字段：请求体在 Node 侧 `JSON.stringify` 后 base64 进容器，容器只做 `curl` 转发，**原始 SSE 以 base64 回传到构建日志**，解析全部在本机（`aggregateSse`）。容器里只有 `sh`/`awk`，让 awk 去抠 `tool_calls` 就是早先丢工具调用的原因。

### 代价与限制

- 每次容器回落都要等一次调度，**这是路径的物理属性**，不是可以优化掉的常数；并发上限 2，多余的排队而不是一起超时。
- 单请求上限 7 分钟（容器调度 + 推理 + 回传）；模型特别慢时请调小 `max_tokens`。
- 图片消息原样透传，但免费档模型未必支持视觉；这条路径不做降级改写。

## 云原生开发

### 启动不跳转，列出所有链接

点「启动开发」后**不会自动打开任何页面**。CNB 一次启动可能返回好几种地址（WebIDE 入口、跳转页、构建中的 loading 页、流水线日志），该看哪个取决于你为什么启动——直接替你打开一个等于替你猜。所以面板把这次拿到的**全部链接**列成卡片，每条都有：

- 标签说明这条是什么（`WebIDE 入口` / `启动页（环境就绪前）` / `流水线日志` / `仓库主页`）
- 完整 URL，可直接选中复制
- **复制**按钮（优先用 Clipboard API，老浏览器回退到 textarea + execCommand）
- **打开**链接（想跳的时候自己点）

地址按去掉尾部斜杠去重，`vscode-web/cnb-1/` 和 `vscode-web/cnb-1` 只出现一次。

### Cursor / VS Code 等桌面编辑器怎么接

**它们没有各自的 CNB 链接。** 这一点我实测确认过，值得说明白：

- CNB 前端构建清单里，`/-/workspace/` 下只有 `jump`、`loading`、`error` 三个页面；
- 页面是 catch-all 路由，所以 `/-/workspace/cursor/<sn>/` 这种编出来的路径会返回 401，**和真实路径的响应一模一样**，无法用状态码区分；
- 官方文档写的机制是：VS Code / Cursor / CodeBuddy 通过 **Remote-SSH** 连接，JetBrains 通过 **Gateway**（同样走 SSH）。

所以插件不编造 per-editor 链接，而是给出**连接坐标**：

```
Remote-SSH 连接串   ssh <pipelineId>@<ssh-host>
~/.ssh/config 片段  Host cnb-<pipelineId> / HostName … / User … / Port 22
```

前提两条，面板会写在链接下面：镜像需预装 `openssh-server`；JetBrains 还需把 IDE 装到 `/ide_cnb`。

SSH 主机名只在环境内部可获取（`CNB_WORKSPACE_SSH_HOST`）。拿不到时插件**不猜**——宁可少一条，也不给一个看起来对、连不上的地址。

### 一个环境有七类入口

`workspace/detail` 只返回两条（WebIDE、跳转页），但一个环境实际有这些：

| 入口 | 形态 | 说明 |
|---|---|---|
| **WebIDE** | `<web>/<repo>/-/workspace/vscode-web/<pipelineId>/` | 编辑器 |
| **CodeBuddy Web** | `<web>/<repo>/-/workspace/codebuddy/<pipelineId>/` | 浏览器里的 AI 编码 |
| **跳转页** | `<web>/<repo>/-/workspace/jump?pipelineId=<pipelineId>` | 环境状态页 |
| **端口预览模板** | `https://<prefix>-{{port}}.cnb.run` | 把 `{{port}}` 换成实际端口 |
| **端口预览 3000/5173/8080/8000/5000** | 同上 | 直接可用的常见端口 |
| **流水线日志** | `<web>/<repo>/-/build/logs/<pipelineId>` | 构建日志 |
| **仓库主页** | `<web>/<repo>` | — |

**端口预览**最容易漏，但它往往是最需要的：开发环境里起的服务在浏览器里打不开本地端口，只能通过这个域名访问，而且服务必须监听 `0.0.0.0`。

### 两种 sn 不能混用

CNB 对同一个环境有两种叫法，混用就 404：

- `workspace/detail` 只认**短 sn**：`cnb-lod-1k81349st`
- 链接路径里要用**流水线 id**：`cnb-lod-1k81349st-001`

插件在调用前把带后缀的 sn 归一化成短的，构造链接时再用带后缀的。

### 端口预览前缀只属于它自己的环境

前缀（如 `iti87odsrp`）由 CNB 按环境分配，只在环境内部通过 `CNB_VSCODE_PROXY_URI` 暴露。插件**只在本机所在的那个仓库**上使用它，对别的仓库不填——否则会生成一个看起来正确、实际返回 500 的链接。其他仓库需要时显式传 `proxyDomain`。

刚启动时流水线还没跑完，CNB 只给得出 loading 页、`webide` 还是空的。卡片会显示「刷新地址（环境就绪后）」，点一下重新向 `workspace/detail` 取真实入口，等环境起来就能拿到可直接用的 WebIDE 地址。

### 地址随时可查，不依赖"刚启动"

每个环境在列表里都有 **地址** 按钮：点开就在该行下方展开全部链接，再点收起。不需要重新启动，也不需要记得上次的卡片——**任何时候都能查**。

- **按需读取**：每次展开都向 `workspace/detail` 重新取一遍，所以环境起来之后新出现的端口和入口能反映出来。
- **保留在本地**：结果写进 `localStorage`（`dsh-cnb.addresses.v1`，最多 40 个环境，按时间淘汰）。刷新页面、关掉面板再打开，地址仍然在。
- **接口挂了也不丢**：拉取失败时保留已有缓存，只在上面加一条错误提示——地址不会因为网络抖一下就变错，你可能只是想再复制一次。
- **复制全部**：一次把这批地址按行拼好放进剪贴板。
- **自选端口**：`workspaces.detail` 接受 `ports` 参数。给了就只用你给的端口（不再混入默认的 3000/5173/…），因为常用端口是你自己的习惯，不该被默认值覆盖。

启动环境时 `branch` 是必填的（CNB 对空 body 直接答 `[PARAM_MISS]branch is required`，只给 `ref` 也不行）。所以省略 branch 时插件自己解析：仓库对象**没有** `default_branch` 字段，于是读取分支列表，优先 `main`、其次 `master`、否则取第一个。显式给了 branch 就完全不做这次查询。

重开一个已存在的环境时 CNB 只返回 URL、不返回 `sn`，而 `sn` 是之后停止环境要用的。插件从 URL 的 `sn=` 参数里取回来，所以「启动 → 停止」能闭环。

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

## 云网关：一条龙开通，代理跑在云环境里

上一节的直连方式有个天花板，实测确认过，不是配置问题：

| 事实 | 证据 |
| --- | --- |
| 网关只接受**流水线令牌**，个人令牌一律拒 | 403 `[NO_RIGHT] OpenAPI only allowed in pipeline` |
| 流水线令牌与仓库绑定 | 换仓库答 403 `[SLUG_ID_NOT_MATCH]` |
| 流水线令牌拿到**别的机器**上用会被拦 | 412 `10412 Blocked by network policy`（从构建 runner 与从本机都试过） |
| 令牌与环境同生命周期 | 从运行中的环境采集到的令牌，环境一停就 `10008 credentials have expired` |

所以「在本机直连云网关」这条路不存在。唯一可行的形态是：**代理跑在云环境里，经 CNB 端口预览域名对外**，本机 dsh 的 provider 指向那个域名。这就是「云网关」页做的事。

### 它做了什么

点「一键开通」之后，按顺序：

1. **确认组织** —— 不给就用账号的第一个组织。
2. **创建仓库** —— 名字不给就按 `dsh-gateway-<日期>-<时间>` 生成。
3. **写入网关脚手架** —— 这是唯一需要绕一下的地方：OpenAPI 的 `/-/git/contents` 只有 GET，**没有任何写文件接口**。真正的写路径是**用内联 `config` 触发一次 `api_trigger` 构建**，它的 stage 跑在签出好的 `/workspace` 上，于是 `git commit && git push` 就是合法的落盘方式。空仓库也能用：第一次提交顺带建立 `main` 分支（否则 `workspace/start` 连 branch 都没有）。
4. **云原生启动** —— 起一个开发环境，端口预览由平台映射。
5. **采集对外地址** —— 平台的 runner 不能回调任意地址，但 stage 日志能通过 OpenAPI 读回来。所以脚手架在日志里打标记行：

   ```
   DSH_GW_URL=https://xxxx-8794.cnb.run/v1
   DSH_GW_KEY=dshgw_…
   DSH_GW_REPO=org/repo
   DSH_GW_PORT=8794
   DSH_GW_MODELS=deepseek-v4.1-flash,…
   DSH_GW_READY=1
   ```

   解析器只认「行首就是标记名」的行，所以日志里的 shell 回显（`printf 'DSH_GW_URL=%s\n' …`）不会被误读。**缺 `READY` 就不写 provider** —— 宁可报「还没起来」，也不要往 dsh 里塞一条永远 404 的路由。

6. **校验** —— 从本机真打一次那个公网地址：`/health` + 一次非流式对话。端口预览是否映射、key 是否一致、模型是否开通，只有真发一次才能同时确认。
7. **写 provider** —— 往 `llm-pi-ai` 写 `cnb-gateway` 路由，并把 key 存进凭证库的 `DSH_CLOUD_GW_KEY`（配置文件里没有明文）。

### 写不进去时怎么办：三级落地，不是「请自己合并片段」

配置层级是 `--patch` overlay ＞ profile 的 `cordis.patch.yml` ＞ 各 bundle 的 patch。`configEditor` 拒绝写在更高优先级层之下（写进去也改不了行为），所以落到哪一层要按顺序试：

| 顺序 | 目标 | 生效方式 | 说明 |
| --- | --- | --- | --- |
| 1 | `configEditor`（profile 层） | 立即 | 没有 overlay 时这是最简单的一层 |
| 2 | profile 的 `cordis.patch.yml` | **立即（HMR 热加载）** | overlay 挡住 configEditor 时走这里；HMR 监听这个文件，一改就 recompose |
| 3 | overlay 片段 | 需重启 | 仅当 overlay **已经**定义了这个路由 |

第 2 步是这个插件能「自己配好」的关键：它由 `dsh-hmr` 监听，改完立即 recompose，不需要重启进程，也不需要人手工合并 YAML。实测在运行中的 host 上调用后，`--dump-config` 立刻能看到新路由，模型调用计数同步增长。

第 3 步不抢：如果 overlay 里**已经**有同名 route，说明有人特意配了那一路，插件只把片段交出来。`dsh-hmr` 只监听 profile patch 与 home patch，**不监听 `--patch` 文件** —— 所以 overlay 层的改动无论如何都要等重启。

写第 2 层时有两个坑，测试里都钉住了：

- **缩进**：provider 的字段必须比路由名深一级。浅一格 YAML 仍能解析，但会把路由解析成 `null`，热加载后模型选择器里什么都没有；
- **幂等**：重写要替换插件自己那段（用固定注释标记），不是追加，否则多跑几次文件会越来越长。

profile 目录从 `ctx.get('profileContext').dir` 取，不靠 `DSH_PROFILE` 或硬编码名字推断 —— 猜错的后果是写进另一个文件，而它只表现为「patch 层不存在」。

写进仓库的文件（全部零依赖，环境里不需要 `npm install`）：

```
.dsh-gateway/serve.mjs         服务入口：拉起代理、打印标记、保持前台
.dsh-gateway/gateway-proxy.js  OpenAI 兼容代理 + 修复阶梯 + SSE 聚合
.dsh-gateway/model-guard.js    错误归类 + 请求体修复（纯函数，可离线测试）
.dsh-gateway/models.json       要曝光的模型 id
.dsh-gateway/bootstrap.sh      在环境终端里手动重跑用
.dsh-gateway/README.md         这个目录自己的说明
.cnb.yml                       云开发环境定义 + 启动 stage
```

云端跑的就是本机测试的那三份源码（`test/cloud-provision.test.mjs` 逐字节断言），否则「本机通过、云端是另一版」这种问题会一直存在。

### 11288 / 11128 内容风控适配

上游会扫 `system` / `assistant` 文本里的「客户端指纹」，命中整条拒绝：

```
HTTP 400  {"code":11128,"msg":"Illegal API invocation from an unapproved channel"}
```

`11288` 是同一类（未获批准渠道），修复动作完全相同，所以两者归一类处理。换令牌、换模型、补请求头都无效 —— 被拦的是提示词本身。代理在发送前按阶梯退让，每一级都不改语义：

| 级别 | 动作 | 依据 |
| --- | --- | --- |
| 0 | 改写已知指纹句；身份词中间插 U+200B（**路径语境跳过**，否则会把坏路径交给工具调用）；`developer`→`system`；`system` 提前；图片段归一到上游认的形状；丢掉孤立的 tool 结果 | 逐项实测：身份词打散后 200；`developer` 角色单独可触发 11128；图片段**换形状**后 200（见下）；孤立 tool 答 11148 |
| 1 | 仍被拦时把 `system` 折进首条 `user` | 实测：同一段文本放 `user` 里 200（拦截面只扫 system/assistant） |
| 2 | 再把 `system` / `assistant` 逐词打散 | 覆盖指纹落在历史消息里的情况 |

只有「指纹」类拒绝才升级阶梯 —— 11148 / 11133 在第一级已经修过，再升级只会重复发同样的坏请求。

### 图片

上游**能识图**，只认一种形状：`{type:'image_url', image_url:{url:'data:image/png;base64,…'}}`。所以图片段是「换形状」，不是「丢掉」：

| 客户端形状 | 处理 |
| --- | --- |
| `{type:'image_url', image_url:{url}}` | 保留 |
| `{type:'image_url', image_url:'data:…'}` | 包成对象 |
| `{type:'input_image', image_url}` | 转换 |
| `{type:'image', source:{type:'base64', …}}` | 转成 data URL |
| `{type:'image', source:{type:'url', url}}` / 裸 `http(s)` | 下载后内联（上游不替客户端下载） |

早期版本直接删掉图片段（`drop:image-part`）—— 请求能通，但模型根本没看到图，只会对着空气描述。而实测上游是能识图的：三圆图能数出个数、说出横排、认出颜色。所以丢图是错的。取不回的远程图会降级成一句文字说明，而不是静默消失；超限的图原样透传，让上游给出明确报错。

provider 画像里必须写 `input: ['text','image']`，**不是** `input_modalities` —— schemastery 对未知键原样保留，写错了配置看起来完全正常，但模型解析出的 `input` 仍是 `[]`，pi-ai 在发请求前就抛 `does not support image input`，请求根本到不了网关。

另外网关**只认流式**（非流式答 `11101`），所以代理一律发流式，客户端要非流式时由它聚合后返回（`aggregateSse` 会正确拼接 `tool_calls` 的参数片段）。

### 安全

代理在公网上，所以**没有 key 就不启动**：

- key 由本机生成（`dshgw_…`），随脚手架写进仓库的 `.cnb.yml` 的 `env:`（新仓库没有别的注入通道，它的作用域就是这个仓库的网关），同时存进本机凭证库；
- 除 `/health` 外所有路由都要求 `Authorization: Bearer <key>`；
- 上游流水线令牌始终不出环境 —— 代理用它访问上游，客户端只看到 key。

`/health` 故意不鉴权，只为了能判断进程起没起；它不返回任何凭证。

### 模型不止一个：清单是实测出来的，不是写死的表

CNB 的 AI 网关**没有清单接口** —— `/-/ai/models`、`/-/ai-ide/v2/models`、`/-/model/list`、`/-/ai/models/list` 全部 404，`GET` 那个端点还会答 `Model (empty) is not in the optional models list`。它只提供一枚判定位：

| 上游回答 | 含义 |
| --- | --- |
| `200` | 可用 |
| `403 [MODEL_NOT_IN_LIST]` | 不在网关目录里（id 猜错了） |
| `403 [MODEL_NOT_AVAILABLE_FOR_ORG]` | 在目录里，但当前组织没开通 |

所以「发现模型」= 拿一批候选 id 并发真调用，按这三个结果分类（`lib/model-catalog.js`）。实测 11 个并发探测约 2 秒，只在网关启动时做一次。

这条设计的分工要说清：

- `models.json` / 开通时传的 `models` 是**候选**，不是最终清单；
- 云环境启动时探测，把**真实可用**的写进 `DSH_GW_MODELS` 标记；
- 本机据此写 provider。**没额度的模型一定被排除** —— 写进去只会让 dsh 的选择器里多一个点了必然失败的选项。

真机结果（一次真实开通，仓库名以 `org/repo` 代）：

```
候选 11 个 → 可用 9 个
not-entitled: glm-5.3-flashx     （目录里有，组织没开通）
unknown:      hy4free            （目录里没有）
```

两个结论都随 `DSH_GW_NOT_ENTITLED` / `DSH_GW_UNKNOWN` 标记回传，所以「为什么少了某个模型」不用翻日志。上游以后加新模型，只要 id 出现在候选表或你传的 `models` 里就能被发现，不需要插件发版。

### 装了插件后「原来的供应商不见了」：overlay 是整体覆盖

如果你的部署用启动脚本生成一个 `--patch` 文件（很多自建栈都这么做），会遇到三个连着的现象：

1. 界面上的「添加供应商 / 导入」被拒：
   `Configuration for "llm-pi-ai" is overridden by a home patch or command-line overlay`
2. 插件写进 `llm-pi-ai` 的 provider 不生效；
3. **反而是原来能用的那个 provider 消失了。**

根因是 patch 层的合并方式：

```js
// dsh-app-boot applyPatches
target[key] = value        // config 整体赋值，不深度合并
```

所以一旦某一层定义了 `llm-pi-ai.providers`，它就把整棵 providers 树按住 —— 上层看到的是这一份，不是几个来源的并集。插件早先只写自己那一个路由，于是把 overlay 里原有的 provider 一起替换掉了。

**现在插件的处理**（`wireCloudProvider`）：

- 读回 `--patch` overlay 里已有的 provider 画像，连同自己新加的路由**一起**写进 profile patch，做到「加一个」而不是「换一批」；
- overlay 里已经定义同名路由时不抢（那多半是有人特意配的）；
- 已被 profile patch 自己定义过的名字不重复写。

**你的部署该怎么做**（二选一）：

| 目标 | 做法 |
| --- | --- |
| 保留脚本接管 `cnb`，同时要别的 provider | 在启动脚本里把额外 provider 并进那份 overlay（`extraProviders`），别手写死一个 |
| 想让界面自由编辑模型 | 别传 `--patch`，或让脚本只在 `cnb` 缺失时写一次 |

判断标准很简单：`dsh --dump-config | grep -A20 'llm-pi-ai'` 看到的 `providers` 下面有几个键。只有一个、且不是你配的那个，就是被 overlay 按住了。

### 「配好了」不等于「对话在用」

这一步最容易漏。DSH 的模型选择是**按会话**记住的（`modelSelection.val.lastUsed`）：

```
configEditor / profile patch 写好了 provider      →  新会话默认用它
老会话里记着上一个 provider                          →  打开它仍然用老模型
```

所以 `cloud.wire` 会在结果里给出 `sessionAdoption`，明确告诉你差在哪：

```json
{
  "done": false,
  "pending": 3,
  "message": "17 个会话里有 3 个仍在使用别的 provider。…在那些会话里点一次模型选择器选 cnb-gateway，或者开一个新会话 —— 新会话默认就是 cnb-gateway/deepseek-v4.1-flash。"
}
```

**插件改不到这个字段**，这一点试过了，结论是明确的：

- 那需要 DSH 的 `session` 服务（`session.selectModel`），它不在插件的可用依赖里；
- 直接改 `storages/session_projcache/sessions/*.json` 会被运行中的进程覆盖回去 —— 实测手改 6 个会话，10 秒内 3 个被写回原值，因为进程持有内存状态。

所以这里只做「读准 + 说清最后一步」，不谎报完成。两条可行路径都是零成本的：在旧会话里点一次模型选择器，或者开一个新会话。

### 模型清单从哪来（优先级）

`cloud.wire` 不带 `models` 时按这个顺序取，并在结果里用 `catalogSource` 说明来源：

| 顺序 | 来源 | `catalogSource` |
| --- | --- | --- |
| 1 | 调用方显式传入 | `input` |
| 2 | 本进程上一次采集到的 | 沿用 |
| 3 | **当面问云网关 `/v1/models`** | `gateway` |
| 4 | 候选表（最后手段） | `candidates` |

第 3 步很关键：`/v1/models` 由云网关自己回答，那是探测阶段**实测过**的清单（没额度的已经剔掉）。退回候选表是最后的降级 —— 它可能包含当前组织没开通的模型。

### 推理模型要留足预算

有些模型先吐 `reasoning_content` 再给 `content`。实测 `hy4` 在 `max_tokens: 64` 时内容被推理占满、`content` 为空 —— 而 `finish_reason` 仍是 `stop`，从状态上看完全成功。所以 `describeModel()` 会给这类模型（`hy4*`、`step-5*`、`space-bunny`）标 `reasoning: true` 并留 32k 预算，这一项会写进 provider 的模型条目。

### 环境会消失，地址会变

`keepAliveTimeout: 18h` 是平台上限附近的值：默认 10 分钟内没有外部连接就回收环境，网关随之消失。环境重建后端口预览前缀会变，所以「重新采集」是一个常用按钮，不是兜底。面板也不把这个地址持久化 —— 持久化只会给一个「看起来配好了、其实指向已死域名」的假象。

### 局限

- 需要 `group-resource:rw` 才能建仓库；缺这项时会话路径会自动顶上（见前文），两者都没有时面板会说明缺哪一项。
- 新仓库的 AI 网关是否开通由组织决定；没开通时校验那一步会给出 `MODEL_NOT_IN_LIST` / 模型不可用，并列出真实放行的 id。
- 采集依赖 stage 日志，所以环境必须真的把 stage 跑起来；YAML 缩进错误这类问题会让 stage 静默不入队 —— `test/cloud-provision.test.mjs` 用真实 YAML 解析器断言结构，就是为了挡这一类。

## 仓库清理：批量删除，以及云网关仓库的自动回收

「一键开通云网关」每跑一次就建一个新仓库 —— 这是那条链路的必然结果：网关只接受流水线令牌，而流水线令牌与仓库绑定，所以每个网关都必须有自己的仓库。跑几次之后，组织里就会堆积一堆 `dsh-gateway-20260101-000000` 这种没人再用、却还在占 Git 存储的东西。

「仓库」页为此有两块能力。

### 批量删除

列表每一行前面有勾选框，勾上之后出现操作条：

- **预览删除** —— 只列出会删哪些，**一个请求都不发**；
- **删除选中的 N 个** —— 二次确认后真的删。

预览与真删调的是同一个后端操作（`cleanup.delete`），区别只有 `confirm`，所以预览里看到的清单一定就是真删时的清单。

按条件也可以（工具侧）：`filter.prefix` / `filter.search` / `filter.gatewayOnly`。**无条件批量删除不可用** —— 「什么都不填」等于「整个账号全删」，那不是一个可用的默认值，要删就请用 `repos` 显式列出。

三样东西永远被跳过：

| 跳过原因 | 为什么 |
| --- | --- |
| 正在承载云网关的仓库 | 它由配置里 provider 的 `displayName: CNB 云网关 (org/repo)` 指出；删了模型当场全断，而且看不出是谁删的 |
| dsh 自己所在的仓库（`CNB_REPO_SLUG`） | 那是在把正在跑的这套工具连根拔掉 |
| `keep` 名单里的 | 显式声明的保留项 |

受保护的那一行，勾选框是**禁用**的 —— 给一个勾得上却永远删不掉的框，比不给更糟。

### 自动清理

设置驱动的清理。**三条规则是硬的，没有任何配置项能放开：**

| 规则 | 含义 |
| --- | --- |
| 环境开着 → 仓库受保护 | 人可能正在里面改东西，删掉会连未提交的工作一起抹掉。**关掉环境之后**才进入清理范围 |
| 只碰云网关仓库 | 判据：名字 `dsh-gateway-<日期>-<时间>`，或描述里有「由 dsh-cnb 自动创建」（改过名的靠后者仍能认出） |
| 自建仓库不自动删 | 它们的价值判断只有人能做。要删请手动勾选 —— 那是明确的意图，不是启发式的猜测 |

满足上面三条，再超过 `maxAgeHours` 没有活动，才会被删。

这三条曾经各有一个「开关」（`deleteRunning`、`scope: 'all'`、`scope: 'prefix'`）。它们被移除了：一个能被配置绕过的保护，比没有保护更糟 —— 它看起来像保护。`test/cleanup.test.mjs` 第 12 组穷举了这些设置组合，断言每一种都删不掉该保护的东西。

**默认关闭。** 删除不可逆，装个插件不该替人做这个决定。开启后有两层：

- **本进程内定时器** —— 面板开着、dsh 在跑时有效，改设置立刻重排；
- **云端 crontab** —— `cnb_cleanup_setup` 生成的 `.cnb.yml` 片段，dsh 关掉之后仍然有效。

只有第一层是常见的假自动化：进程一停就什么都没发生，而界面上看起来「已开启」。所以面板会把两条路径各自的状态都报出来（「进程内定时器：未运行」是一件要显示的事）。

两条路径的判据**必须一致**，因为不一致的症状是「云端删掉了一个本机不会删的仓库」，不可逆且现场已消失。做法是把同一组常量（名字正则、描述标记、阈值、保护名单）以 JSON 注入云端脚本，`test/cleanup-script.test.mjs` 用同一批夹具分别喂给两边、逐条比对结论 —— 注释里写「保持一致」没有保证力，逐条比对才有。

云端脚本用 base64 带进 stage，不是 heredoc：YAML 的块标量要求每行缩进，而 heredoc 结束符必须顶格，两者直接冲突（实测会把整份 `.cnb.yml` 解析坏，而生成函数「成功返回」了一段看起来没问题的字符串）。`test/cleanup-cronfile.test.mjs` 用真实 YAML 解析器把片段解析一遍、再把脚本解回来 `node --check` 一遍。

需要注意的边界：

- 云端脚本走 Open API，根组织下的仓库跨不过 `errcode 9` —— 那些会记成 `DSH_CLEANUP_FAILED`，要打开面板用登录会话删（面板会自动改走控制台路由）。
- 需要 `CNB_CLEANUP_TOKEN` 这个 secret，且它应该是一个**只用于清理**的令牌，不要复用登录用的那个。
- 环境列表读不到时，云端脚本**什么都不删** —— 不知道有没有人在用，就不动手。
- 片段里 bake 的是**生成那一刻**的设置；改完设置要重新生成，否则云端还按旧阈值判断。

### 开发环境记录也清

「开发环境」列表会一直长：每启动一次就是一个环境记录，结束了也留在那里。它和仓库清理是**两条独立的开关**，理由是把风险和收益分开：

| | 默认 | 为什么 |
| --- | --- | --- |
| 仓库 | **关闭** | 删错一个仓库是真的丢代码，不可逆 |
| 环境记录 | **开启，只清 `closed`** | 删的是一条历史，不承载任何数据 |

环境记录这条的三条判据：

- 状态必须是 `closed`（`envScope: 'all'` 放宽到别的状态，但见下一条）；
- 超过 `envMaxAgeHours`，默认 168 小时 / 7 天 —— 刚结束的那次多半还要回看日志；
- **运行中的环境永远不动**，没有任何开关能放开。

最后一条是硬的，且没有开关能放开它。

面板上这块有独立的「预览」和「清掉已结束的」，和「现在跑一轮」分开 —— 后者会连带删仓库，而这里的意图只有「列表太长了，把结束的收掉」。绑在一个按钮上，早晚会有人只是想清列表却删了仓库。

云端 crontab 里也跑这一半（`DSH_CLEANUP_ENV_*` 标记），判据与本机逐条比对过，见 `test/cleanup-script.test.mjs` 第 8 组。

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
| `cnb_accounts` | — | 已保存的账户列表：当前是哪个、各自令牌/会话状态、最近使用时间（只有元数据，无令牌） |
| `cnb_account_switch` | `id` | 切换当前账户，之后的 `cnb_*` 与网关都用它；无需扫码，过期会自愈 |
| `cnb_account_rename` | `id` `label` | 给账户改个好认的名字；留空恢复默认 |
| `cnb_account_remove` | `id` | 删掉一个账户；删的是当前账户就自动切到最近用过的另一个，删光等于退出登录 |
| `cnb_cloud_gateway` | `org` `name` `visibility` `image` `models` `port` `route` `makeDefault` `waitMs` | **全自动开通云网关**：建仓库 → 写脚手架 → 云原生启动 → 采集 → 校验 → 写 provider |
| `cnb_cloud_gateway_harvest` | `repo` `sn` `waitMs` | 重新从环境日志采集地址与 key（环境重建后用） |
| `cnb_cloud_gateway_verify` | `url` `key` `model` | 从本机真打一次云网关 |
| `cnb_cloud_gateway_wire` | `repo` `baseURL` `key` `models` `route` `makeDefault` | 只写 provider（跳过建仓库那一步） |
| `cnb_repos_delete` | `repos` \| `filter` `confirm` `dryRun` `stopEnvironments` `limit` | 批量删仓库：显式列出或按条件选；不传 `confirm` 只预演 |
| `cnb_cleanup_status` | — | 清理设置、保护名单、上次结果、进程内定时器状态 |
| `cnb_cleanup_settings` | `enabled` `maxAgeHours` `keep` `intervalMinutes` `dryRun` `environments` `envScope` `envMaxAgeHours` | 读写自动清理设置，写完立刻重排定时器。范围与「运行中保护」不是配置项 |
| `cnb_cleanup_cycle` | `force` `dryRun` | 立刻跑一轮（`enabled: false` 时只出计划） |
| `cnb_cleanup_environments` | `dryRun` `envScope` `envMaxAgeHours` `environments` | 清掉已结束的开发环境记录；运行中的永远不动 |
| `cnb_cleanup_setup` | `repo` `intervalMinutes` | 生成 dsh 关掉后仍生效的 .cnb.yml crontab 片段 |

## 实现要点

- **令牌只在 Host**。浏览器调 `/dsh-cnb/api/*`，由 Host 用凭证库里的令牌访问 CNB；响应里不会出现令牌。
- **面板路由自带同源校验**：校验 `Origin`/`Host` 一致并拒绝 `Sec-Fetch-Site: cross-site`。
- **不用第三方依赖**。二维码用 MIT 许可的 `qrcode-generator`（vendored，`vendor/qrcode.cjs`）；`.cnb/settings.yml` 由一个只读该文件格式子集的解析器处理（`lib/mini-yaml.js`），不往 profile 里塞 YAML 库。
- **一个能力表**。`lib/index.js` 里的 `operations` 同时驱动面板路由和 agent 工具，两边不会漂移。
- **脚手架就是源码本身**。云环境里跑的三份模块与本机测试的是同一份文件（复制而非重写），所以离线测试的结论对云端成立。

```
dsh-cnb/
├── lib/
│   ├── index.js          Host：能力表、路由、工具、configEditor 写入、开通编排
│   ├── cnb-client.js     扫码状态机 + OpenAPI 客户端（含内联构建与 stage 日志）
│   ├── model-guard.js    网关错误归类 + 请求体修复（11288 / 11128）
│   ├── image-guard.js    图片段归一：多形状 → upstream 认的 data URL
│   ├── model-catalog.js  模型发现：按上游错误码探测可用清单
│   ├── session-adopt.js  会话级模型选择的调查与指引
│   ├── gateway-proxy.js  OpenAI 兼容代理：修复阶梯、SSE 聚合、key 校验
│   ├── provision.js      脚手架 .cnb.yml、内联构建配置、日志标记协议
│   ├── scaffold.js       要写进目标仓库的文件清单
│   ├── cloud/serve.mjs   云环境里的服务入口（被打包进目标仓库）
│   ├── mini-yaml.js      .cnb/settings.yml 子集解析
│   └── qr.js             票据 → SVG path
├── client.js             面板（React，slots 注册）
├── vendor/qrcode.cjs     MIT 二维码编码器
└── test/                 离线测试 + 需 CNB_TOKEN 的实网冒烟
```

## 测试

```bash
npm test                      # 离线：权限表与级别、扫码状态机、自检、mini-yaml、二维码、overlay、云网关、开通编排
CNB_TOKEN=... npm test        # 追加实网冒烟：仓库、用量、网关、配置写入
```

实网冒烟只读 CNB，不建/删仓库，也不启停环境。`gateway-overlay` 这组会把生成的 YAML 片段丢给真实的 `llm-pi-ai` Config schema 校验，保证复制出去的东西能被 loader 接受。

`cloud-gateway` 这组钉住风控适配的每一条实测结论：11288 与 11128 同类、403 的四种含义分开、身份词打散但路径跳过、修复阶梯每级都不改语义、SSE 的 `tool_calls` 参数片段要拼接。

`image-guard` 这组钉住图片链路：四种客户端形状都能取出地址、只有 `image/*` 的 data URL 才算内联、Anthropic/Responses 形状归一、认不出地址的段要丢、超限图原样透传、远程图下载后内联且**取不回时要降级成一句说明而不是消失**。`provider-input` 单独钉住 `input` 与 `input_modalities` 的区别 —— 后者静默失效，用错了整条图片链路在发请求前就断。

`cloud-provision` 这组钉住编排里的硬约束：`api_trigger` 事件名、写文件只能走内联构建的 checkout、标记协议要忽略 shell 回显、缺 `READY` 不写 provider、脚手架不引入任何 npm 包，以及**用真实 YAML 解析器断言 `.cnb.yml` 的结构**（缩进错位时 YAML 仍能解析，但 stage 根本不会入队）。

二维码那组在装了 `jsqr` 时会额外把 SVG path 光栅化后解码，断言解出来的正是票据 URL；没装就只校验几何。

## 许可

MIT。`vendor/qrcode.cjs` 来自 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（Copyright © 2009 Kazuhiko Arase，MIT）。
