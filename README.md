# WorkBuddy Bridge（workbuddy-bridge）

把腾讯 **WorkBuddy / CodeBuddy（国内版）** 的积分与模型桥接进 ZCode：

- ZCode 的自定义模型供应商指向本地代理 → 对话直接消耗 WorkBuddy 积分
- **积分到期优先调度**：多账号之间优先消耗「最早到期且有余额」的账号
- **多账户**：设备授权登录逐个添加账号，**可自动导入本机已登录客户端的账号（免扫码）**，额度耗尽/失败自动切换，也可手动固定
- **自动任务**：每日签到 + 成长任务自动报名/领奖
- OpenAI 兼容（`/v1/chat/completions`、`/v1/models`）+ Anthropic 兼容（`/v1/messages`）双端点

> ⚠️ **风险声明**：本插件通过非官方接口调用 WorkBuddy，并以自动化方式执行签到/任务，
> **违反 WorkBuddy 服务条款，存在封号风险**。请自行评估，勿用重要账号。
> 上游接口随时可能变动，失效时需要跟进维护。

---

## 1. 安装（ZCode 桌面端）

### 方式 A：插件市场 UI（推荐）

1. 打开 ZCode → 插件市场 → 添加 → 从 GitHub 添加，填入仓库：
   `zhougonjin-ux/workbuddy-bridge-market`
2. 在市场里找到 **WorkBuddy 积分桥** → **安装**
3. 安装后到 **设置 → 插件** 确认处于启用状态

### 方式 B：命令行

```bash
zcode plugins marketplace add zhougonjin-ux/workbuddy-bridge-market
zcode plugins install workbuddy-bridge@workbuddy-bridge-market
```

## 2. 启动代理

- 安装后**每次打开 ZCode 会话会自动拉起代理**（SessionStart hook，幂等、不阻塞）；
  也可在会话里运行 `/wb-start` 手动启动。
- 验证：浏览器打开可视化管理台 http://127.0.0.1:8788/console
  （五个面板：**账号与积分**——策略切换/账号卡片/每批积分到期倒计时/微信扫码登录；**模型**——倍率、上下文容量、图片/工具/推理能力表；**自动任务**；**用量**；**日志**）
- 数据目录：`%USERPROFILE%\.zcode\workbuddy-bridge\`（配置、账号池、用量、任务状态都在这，
  与插件代码分离，升级/重装插件不丢账号）
- 关闭自动拉起：在数据目录放 `autostart.json` 内容 `{"enabled": false}`

## 3. 添加 WorkBuddy 账号（多账户）

方式一（最省事）：**本机自动导入** —— 只要这台电脑上登录过 WorkBuddy / CodeBuddy 客户端，
点控制台的「⬇ 导入本机账号」（或运行 `/wb-import`），登录态直接从
`~/.codebuddy/settings.json` 提取并入池，免扫码。服务**每次启动也会自动重扫一次**，
客户端续期 token 后自动跟进。

方式二：会话里运行 **`/wb-login`**，agent 会发起设备授权登录、
把授权链接给你、轮询到登录成功后自动刷新积分明细；控制台「＋添加账号」里也能
**微信扫码**登录。

方式三（手动）：数据目录下运行

```
node "<插件安装目录>/server/login.mjs" --site cn-cli --label 小号A
```

重复执行即可添加多个账号（同一账号重复登录只更新不重复）。账号池文件：
`%USERPROFILE%\.zcode\workbuddy-bridge\auth.cn-cli.pool.json`

> 本机导入的账号没有 refreshToken：token 到期后（客户端会自动续期）重新点一次导入即可；
> 若同账号已扫码登录（有 refreshToken、支持自动续期），导入不会覆盖它。

## 4. 把 ZCode 指向代理（一次性，之后切模型不用再进设置）

**设置 → 模型供应商（Model Provider）→ 添加自定义供应商（OpenAI 兼容）**：

| 项 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:8788/v1` |
| API Key | 控制台顶栏「⧉ 复制 ZCode 配置」一键复制（或看数据目录 `config.json` 的 `apiKey`） |
| 模型 ID | **`default`** ← 填这个 |

> **为什么填 `default`**：代理会把 `default` 路由到「当前默认模型」。以后想换模型
> （glm → deepseek → kimi），在管理台模型页点「设为默认」、或会话里说一声即可，
> **永远不用再进 ZCode 设置**。

Anthropic 兼容端点同样可用：Base URL `http://127.0.0.1:8788`（`/v1/messages`）。
ZCode 自带 OpenAI 兼容探活的（`GET /v1/models`）无需鉴权也能同步模型列表。

## 4.5 建议安装：开机自启（签到不漏）

代理目前由 ZCode 会话拉起——哪天没开 ZCode，当天的自动签到就会漏。运行
**`/wb-startup install`** 注册登录自启（Windows 计划任务，免管理员），之后代理常驻、
ZCode 会话钩子检测到存活不会重复拉起。`/wb-startup remove` 卸载，`/wb-startup status` 查看状态。

## 5. 积分到期优先调度（核心）

- 后台每 30 分钟（`creditRefreshMinutes` 可调）刷新每个账号的积分批次明细，
  每批积分带**到期时间**（上游 `CycleEndTime` 字段）。
- 调度策略（`config.json → pool.policy`，或用 `/wb-switch` 切换）：

| 策略 | 行为 |
|---|---|
| `expiry-first`（默认） | 最早到期且有余额的账号先用；同到期先耗余额少的 |
| `balance-first` | 余额多的先用 |
| `round-robin` | 最久未用的先用（原上游代理默认） |
| `pinned` | 固定用 `pool.pinnedAccountId` 指定的账号，不可用时回落 expiry-first |

- 所有策略下：额度耗尽（429/余额 0）与连续失败的账号都会被自动跳过并冷却，对话不中断。
- **边界**：单个账号内部先扣哪批积分由腾讯服务端决定，无法干预；本插件控制的是
  **多账号之间**的消耗顺序。
- **兜底**：若上游某天不再下发到期明细，可在账号池条目里手填
  `"manualExpireAt": "2026-10-15"`（支持 `YYYY-MM-DD`）。

## 6. 自动签到与成长任务

- 每日签到（`/v2/billing/meter/daily-checkin`）：默认 9 点、21 点各尝试一轮，当天成功即停。
- 成长任务（`/v2/activity/growth/tasks`）：自动**报名**可报名任务；进度达标的自动**领奖**；
  「对话 N 次」这类进度任务靠真实使用点亮。默认 1 点、13 点各扫描一轮。
- 首次触发带随机延迟（`tasks.jitterMinutes`，默认 30 分钟内）避开整点高峰。
- 总开关：`config.json → tasks.enabled`；分类开关 `tasks.checkin` / `tasks.growth`。
- 手动执行：`wb_tasks_run` 工具；查状态：`wb_tasks_status` 或 `/console`。

## 7. 更新插件（GitHub 市场）

插件市场已发布到 **https://github.com/zhougonjin-ux/workbuddy-bridge-market**（public），
在客户端里添加一次，之后随版本发布即可在客户端内更新：

1. **插件市场 → 添加 → 从 GitHub 仓库添加**：`zhougonjin-ux/workbuddy-bridge-market`
   （市场名：`workbuddy-bridge-market`；本地目录市场可删除，避免重复）
2. 安装后，源码新版本发布时：**插件市场 → 齿轮 → 市场源 → 刷新该市场**，
   回到插件详情点 **更新**（部分版本客户端会自动提示可更新）
3. 命令行发布/更新工具：`.ref/publish-github.mjs`（走 GitHub API，无需本机 git）

## 8. MCP 工具与命令一览

MCP 服务器 `workbuddy-bridge`（装好插件自动连接）提供：

`wb_status` · `wb_credit_plan` · `wb_switch` · `wb_models` · `wb_login_start` ·
`wb_login_poll` · `wb_import_local` · `wb_refresh_credits` · `wb_tasks_run` · `wb_tasks_status`

斜杠命令：`/wbp`（会话内总览面板，免浏览器）· `/wb-start` · `/wb-status` · `/wb-switch` · `/wb-login` · `/wb-import` · `/wb-console`（客户端内置浏览器打开管理台）

管理 API（本机 + apiKey）：`GET /admin/bridge` · `POST /admin/policy` ·
`POST /admin/credit/refresh` · `GET /admin/tasks` · `POST /admin/tasks/run`

## 9. 测试

```
cd <插件目录>/server
node --test test/expiry.test.mjs    # 调度排序单测（14 项）
set WB_CONFIG_DIR=%TEMP%\wb-t && node test/pick.smoke.mjs     # 选号链路
```

## 10. 来源与许可

- 代理核心移植自开源项目 [workbuddy-openai-proxy](https://github.com/yuan240324/workbuddy-openai-proxy)
  （MIT License，见 `server/LICENSE.third-party`），在其账号池基础上新增：
  积分到期解析（`src/expiry.mjs`）、四种调度策略、积分明细后台刷新、自动签到/成长任务
  （`src/tasks.mjs`，端点口径参考 [workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel)）、
  `/admin/*` 管理面与 ZCode 插件集成。
- 仅限本机使用：默认只监听 `127.0.0.1`，API Key 存于数据目录，绝不外发。
