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

## 0. 前置条件

- **Node.js 20 或更高版本（硬前置）** —— 代理服务、MCP 服务器、启动钩子全部以 `node` 命令拉起，
  ZCode 桌面端**不自带 Node**，没装的话插件装了也起不来。先确认 `node -v` 有输出。
  （Node 18 已于 2025-04 结束维护，服务启动时会直接提示升级，而不是抛一串 API 报错。）
- ZCode 桌面端。
- 一个 WorkBuddy / CodeBuddy **国内版**账号（`cn-cli` 站点）。

## 1. 安装（ZCode 桌面端）

### 方式 A：插件市场 UI（推荐）

1. 打开 ZCode → 插件市场 → 添加 → 从 GitHub 添加，填入仓库：
   `zhougonjin-ux/workbuddy-bridge-market`
2. 在市场里找到 **WorkBuddy 积分桥** → **安装**
3. 安装后到 **设置 → 插件** 确认处于启用状态

> 市场 ID 是 `dev-workbuddy-bridge-local`（取自 marketplace.json 的 `name`），
> 下面方式 B 的 `@` 后面要用它，不是仓库名。

### 方式 B：命令行

`zcode` 命令通常不在 PATH 里，CLI 实际在 ZCode 安装目录里（macOS/Linux 换对应路径）：

```bash
# Windows
node "C:\Program Files\ZCode\resources\glm\zcode.cjs" plugins marketplace add zhougonjin-ux/workbuddy-bridge-market
node "C:\Program Files\ZCode\resources\glm\zcode.cjs" plugins install workbuddy-bridge@dev-workbuddy-bridge-local
```

添加市场会先走 GitHub 公共仓库的 tarball 下载，**不需要本机装 git**（仅私有库、
Git LFS 等特殊情况才回退到 `git clone`）。

## 2. 启动代理

- 安装后**每次打开 ZCode 会话会自动拉起代理**（SessionStart hook，幂等、不阻塞）；
  也可在会话里运行 `/wbp-start` 手动启动。
- 验证：浏览器打开可视化管理台 http://127.0.0.1:8788/console
  （侧栏五个入口：**总控台**——KPI 大屏 / 积分池双环 / 账号余额 / 到期时间轴 / 24h 频谱；
  **资源池**——账号管理（策略切换/账号卡片/每批积分到期倒计时/微信扫码登录）与模型表（倍率、上下文容量、
  图片·工具·推理能力、巡检、设默认）；**运维中心**——自动任务（签到/成长/连登/猫猫旅行/任务中心）、
  用量（明细/24h 分布/压缩统计/CSV）、事件时间线；**系统设置**——接入配置、健康运维、日志；
  **使用说明**——三步接上 ZCode、功能导览、常见问题。右上角可切 7 套主题）
- 数据目录：`%USERPROFILE%\.zcode\workbuddy-bridge\`（配置、账号池、用量、任务状态都在这，
  与插件代码分离，升级/重装插件不丢账号）。**首次启动会自动生成随机 `apiKey` 并落盘**，
  第 4 步要用它。
- 端口默认 `8788`，被占用时改数据目录 `config.json` 里的 `port`（会话钩子会读它）。
- 关闭自动拉起：在数据目录放 `autostart.json` 内容 `{"enabled": false}`
- **不知道下一步？** 控制台首页顶部有一条「开始使用」清单：Node 版本、账号、选择器接入、
  API Key 四项自动检测，缺哪项点「去处理」直接跳到对应页；全部完成后自动隐藏。

### 平台支持

| 能力 | Windows | macOS | Linux |
|---|---|---|---|
| 代理 / 控制台 / MCP / 扫码登录 | ✅ | ✅ | ✅ |
| 桌面气泡通知 | ✅ | ✅（osascript） | ✅（notify-send，需 libnotify） |
| 点击气泡打开控制台 | ✅ | — | — |
| 开机自启 | ✅（计划任务） | 手动 launchd | 手动 systemd --user |
| 托盘客户端 / 安装器 | ✅ | — | — |

## 3. 添加 WorkBuddy 账号（多账户）

方式一（最省事）：**本机自动导入** —— 只要这台电脑上登录过 WorkBuddy / CodeBuddy 客户端，
点控制台的「⬇ 导入本机账号」（或运行 `/wbp-import`），登录态直接从
`~/.codebuddy/settings.json` 提取并入池，免扫码。服务**每次启动也会自动重扫一次**，
客户端续期 token 后自动跟进。

方式二：会话里运行 **`/wbp-login`**，agent 会发起设备授权登录、
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

> **其实这一步也能省掉**：插件会在会话启动时自动把自己的供应商和模型清单写进 ZCode
> 的模型目录（`provider_config.json`），**装好插件 + 加了账号后，模型选择器里就会直接
> 出现 WorkBuddy 分组**，不必手动建供应商。想手动建（比如要改 Base URL 或用 Anthropic
> 端点）再按上表填即可。模型池每 30 分钟自动同步一次，上游新增模型会自动出现；
> 控制台模型页也有「⟳ 手动同步」按钮。

## 4.5 建议安装：开机自启（签到不漏）

代理目前由 ZCode 会话拉起——哪天没开 ZCode，当天的自动签到就会漏。运行
**`/wbp-startup install`** 注册登录自启（Windows 计划任务，免管理员），之后代理常驻、
ZCode 会话钩子检测到存活不会重复拉起。`/wbp-startup remove` 卸载，`/wbp-startup status` 查看状态。

## 4.6 安全边界（默认值，可按需放宽）

- 只监听 `127.0.0.1`；控制台要求同端口来源（防 DNS rebinding、防任意网页读走页面内 token）。
- 模型接口跨域默认只允许「本机同端口页面 + 白名单」。ZCode 等桌面客户端**不带 Origin**，
  不受影响；浏览器里的客户端（LobeChat 等）把源加进 `config.json → corsAllowOrigins`
  （如 `["http://localhost:3210"]`），或设 `["*"]` 恢复旧的完全开放行为。
- 配置/账号池文件默认 `0600`（Unix）；Windows 依赖用户目录 ACL。
- 控制台可设 PIN（`consolePin`），连续失败 20 次后拒绝尝试（重启服务重置）。
- 每个响应头带 `X-WB-Request-Id`：报障时提供这个短号，就能在 `server.log` 里精确定位。

## 5. 积分到期优先调度（核心）

- 后台每 30 分钟（`creditRefreshMinutes` 可调）刷新每个账号的积分批次明细，
  每批积分带**到期时间**（上游 `CycleEndTime` 字段）。
- 调度策略（`config.json → pool.policy`，或用 `/wbp-switch` 切换）：

| 策略 | 行为 |
|---|---|
| `expiry-first`（默认） | 最早到期且有余额的账号先用；同到期先耗余额少的 |
| `balance-first` | 余额多的先用 |
| `round-robin` | 最久未用的先用（原上游代理默认） |
| `free-first` | 优先走 0 倍率（免费）模型，没有免费模型时回落到原行为 |
| `pinned` | 固定用 `pool.pinnedAccountId` 指定的账号，不可用时回落 expiry-first |
| `sticky` | 同一对话（按首条 user 消息识别）钉死同一账号，保住上游 prompt cache；30 分钟无活动自动解除 |
| `balanced` | 按「闲置时长」加权随机，长期把消耗均摊到各账号 |

- 所有策略下：额度耗尽（429/余额 0）与连续失败的账号都会被自动跳过并冷却，对话不中断。
- **边界**：单个账号内部先扣哪批积分由腾讯服务端决定，无法干预；本插件控制的是
  **多账号之间**的消耗顺序。
- **兜底**：若上游某天不再下发到期明细，可在账号池条目里手填
  `"manualExpireAt": "2026-10-15"`（支持 `YYYY-MM-DD`）。

## 6. 自动任务（签到 / 成长 / 连登 / 猫猫旅行）

全部可在控制台「运维中心 → 自动任务」改时点、逐类开关、立即执行、看执行记录：

- **每日签到**（`/v2/billing/meter/daily-checkin`）：默认 9 点、21 点各尝试一轮，当天成功即停。
- **成长任务**（`/v2/activity/growth/tasks`）：自动**报名**可报名任务；进度达标的自动**领奖**；
  「对话 N 次」这类进度任务可由插件代打点亮。默认 1 点、13 点各扫描一轮。
- **任务事件链重放**（0.3.54，移植 dsh-xdpool）：成长中心的打分器只看事件流——模板×5、
  设计画布、灵感案例、定时任务、资料库阅读、换主题、企鹅小助手、技能体验、召唤专家×3、
  轻量云专家等 12 类「看起来必须本人点鼠标」的任务，插件用带桌面/web 指纹的事件链重放
  直接点亮（打分要几秒落地，发完自动等再领奖）。控制台任务中心对这些任务显示
  「可代打」，单任务也可手动触发。
- **模型链**（0.3.56，借鉴 dsh 路由页）：控制台「路由规则」配 `模型=候选1,候选2`——
  请求撞上限流/额度/模型不存在这类**模型层**失败（账号轮换与换站都救不了）时，按序
  换链上的下一个模型再试；候选项支持别名与 `站点/模型`。
- **聚合渠道泳道**（0.3.58，借鉴 dsh aggregate lane）：自有 key 的 OpenAI 兼容 provider
  接进同一个本地端点——控制台「资源池 → 聚合渠道」添加（名称/baseUrl/多 key），模型
  目录自动拉取，模型 ID 形如 `agg:渠道/模型`，多 key 自动轮换；三协议入口统一转发。
- **活动专家任务**（0.3.58）：任务板的 `expert_use_*` 与季节活动（如无畏契约）这类
  「召唤某专家完成一次对话」任务，事件链自动定位专家（任务 jump_url 内嵌 id 或市场
  列表按名匹配）+ 召唤 + 真会话点亮，实测 0→1 计分。
- **连登管家**：补签保连登（用补签卡补昨天）→ 逐档兑换连登奖励 → 抽奖，搭在签到同一轮里跑。
- **猫猫旅行**：到站自动领奖并立即续派下一程。
- **券码到期提醒**：探测 7 天内到期的券码并发通知。
- **每日自动体检**（`tasks.doctorTimes`，默认 10:00）：自动跑一遍全桥体检（登录态、模型目录、
  数据文件、协议签名等），有 fail 项推一条汇总通知，全绿只记事件时间线不打扰；
  上游改版/登录态失效这类「静默故障」第二天上午就会被告知。`[]` 关闭。
- **每日数据备份**、**每周用量周报**（可配通知推送）。
- 时点到了但当时机器没开机？下次启动会**自动补跑**当天错过的任务（体检同样补跑）。
- 首次触发带随机延迟（`tasks.jitterMinutes`，默认 30 分钟内）避开整点高峰。
- **首次开启自动任务会弹一次风险确认**（ToS / 封号），确认结果记在 `config.json → tasks.riskAccepted`；
  只想当纯代理用就保持 `tasks.enabled: false`，不跑任何自动化。
- 通知走系统桌面气泡（Windows / macOS / Linux；**点击气泡直达控制台仅 Windows**）
  或 Webhook / Bark / Server酱 / 飞书 / 钉钉 / Telegram。
- 总开关：`config.json → tasks.enabled`；分类开关 `tasks.checkin` / `tasks.growth`。
- 手动执行：`wb_tasks_run` 工具、`/console` 按钮；查状态：`wb_tasks_status` 或 `/console`。

## 7. 更新插件（GitHub 市场）

插件市场已发布到 **https://github.com/zhougonjin-ux/workbuddy-bridge-market**（public），
在客户端里添加一次，之后随版本发布即可在客户端内更新：

1. **插件市场 → 添加 → 从 GitHub 仓库添加**：`zhougonjin-ux/workbuddy-bridge-market`
   （市场 ID：`dev-workbuddy-bridge-local`）
2. 安装后，源码新版本发布时：**插件市场 → 齿轮 → 市场源 → 刷新该市场**，
   回到插件详情点 **更新**。注意更新按钮只在「**浏览插件**」页出现，「已安装」页永远只有
   卸载/开关；桌面端把市场列表缓存在内存，刷新市场后若没看到更新按钮，
   把插件设置页完全关掉重开或重启桌面即可。

## 8. MCP 工具与命令一览

MCP 服务器 `workbuddy-bridge`（装好插件自动连接）提供 13 个工具：

`wb_status` · `wb_credit_plan` · `wb_switch` · `wb_models` · `wb_login_start` ·
`wb_login_poll` · `wb_import_local` · `wb_refresh_credits` · `wb_tasks_run` ·
`wb_tasks_status` · `wb_task_play`（成长任务单任务代打/领奖）· `wb_travel_patrol`（猫猫旅行巡逻）·
`wb_recent_requests`（最近请求明细与速度）

斜杠命令（`commands/` 目录，共 11 个）：`/wbp`（会话内总览面板，免浏览器）· `/wbp-start` · `/wbp-status` · `/wbp-switch` · `/wbp-login` · `/wbp-import` · `/wbp-console`（客户端内置浏览器打开管理台）· `/wbp-doctor`（自检诊断）· `/wbp-startup`（开机自启）· `/wbp-tray`（桌面托盘客户端）· `/wbp-build`（构建桌面客户端）

管理 API（本机 + apiKey）：`GET /admin/bridge` · `POST /admin/policy` ·
`POST /admin/credit/refresh` · `GET /admin/tasks` · `POST /admin/tasks/run`

## 9. 测试

```bash
cd <插件目录>/server
npm test        # 单元测试（当前 257 项；数量以实际输出为准，不在文档里写死）
npm run smoke   # 冒烟测试（自带临时目录隔离）
```

仓库根目录还有一组零依赖校验（CI 全跑）：

```bash
npm run lint       # 全部 .js/.mjs 语法检查（含控制台前端）
npm run coverage   # 覆盖率（Node 内置；当前约 55% 行 / 71% 分支）
npm run verify     # 语法 + 单测 + 发布物一致性 + 文档清单一致性
```

> ⚠️ **只跑 `npm test` / `npm run smoke`，不要裸跑 `node --test`**（会连 `*.smoke.mjs`
> 一起执行）。冒烟脚本必须经 `run-smoke.mjs` 启动：它会 `mkdtemp` 注入
> `WB_CONFIG_DIR` 再拉子进程，**直接跑 `node test/pick.smoke.mjs` 会写到真实的
> `~/.zcode/workbuddy-bridge` 账号池，把生产账号覆盖掉**。

## 10. 来源与许可

- 代理核心移植自开源项目 [workbuddy-openai-proxy](https://github.com/yuan240324/workbuddy-openai-proxy)
  （MIT License，见 `server/LICENSE.third-party`），在其账号池基础上新增：
  积分到期解析（`src/expiry.mjs`）、七种调度策略、积分明细后台刷新、自动签到/成长任务
  （`src/tasks.mjs`，端点口径参考 [workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel)）、
  `/admin/*` 管理面与 ZCode 插件集成。
- 仅限本机使用：默认只监听 `127.0.0.1`，API Key 存于数据目录，绝不外发。

## 11. 维护与发布（给贡献者）

**版本号只有一个事实源**：`workbuddy-bridge/server/package.json` 的 `version`。
`plugin.json`、两份 `marketplace.json`、安装器 `version.txt` 都以它为准，不要再手改。

```bash
# 仓库根目录（workbuddy-bridge-market）
npm run build:market   # 重建离线市场副本 + 市场清单 + 根 README
npm run check:market   # 只校验（CI 用）：副本/清单/README 与源码不一致则退出码 1
npm run verify         # 单元测试 + 发布物一致性，发布前跑这一个就够
npm run test           # 等价于 workbuddy-bridge/server 下的 npm test
```

改完源码**不要手工复制** `client/market`，也不要单独编辑根 `README.md`
（它是 `workbuddy-bridge/README.md` 的副本，由构建脚本覆盖）。这两处曾是
「源码 0.3.66、离线副本 0.3.46、安装器 0.3.45」的事故来源。
