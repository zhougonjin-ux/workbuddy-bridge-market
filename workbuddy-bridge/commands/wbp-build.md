---
description: 按 Roadmap 批量实现 workbuddy-bridge 插件功能与 bug 修复（参数=编号/批次代号，支持 all/继续；含完整技术约束与发布流程）
---

实现 workbuddy-bridge 插件的待办功能。参数 `$ARGUMENTS` 支持三种写法：

- **功能编号**：`T40 T42`，逗号或空格分隔。
- **批次代号**：`feat` = 做 T40–T47 全部新功能（第三批）。`bug1` 已于 2026-10-03 完成（v0.3.16）；`feat` 在旧语义下指的 T32–T39 也已于 2026-10-03 完成（v0.3.19）。
- **`all`** = 从 T40 到 T47 顺序全做。
- **为空时** = 默认做 T40–T42（第一优先级三项）。

⚠️ **T1–T31（v0.3.14）、B1–B4（v0.3.16/v0.3.18）、T32–T39（v0.3.19）全部已完成，都不要再做。** 0.3.22（2026-10-04）已完成任务列表防闪重构 + 任务页布局整理。当前待办只剩 **T40–T47 第三批新功能**，详见下方「第三批」与项目记忆。

## 检查点纪律（all/批量模式必读）

1. **开工前**：先读项目记忆 workbuddy-bridge-plugin.md 里最近的「/wbp-build 进度」段——里面记录了已完成编号、当前版本号、最后 commit。若记忆里有未完成清单，从清单第一个继续，不要重做已完成的。
2. **每个功能完成后**：立即在项目记忆追加/更新一段「/wbp-build 进度」：✅已完成编号列表、当前版本号、最新 commit、⏳剩余编号。这是断点——任何时刻会话断了，用户开新会话再跑 `/wbp-build all`（或剩余编号）就能续上。
3. **每完成 6 个功能**：主动提醒用户「已稳定发布到 vX.Y.Z，建议开新会话继续：/wbp-build all」——长会话每轮都背着全部上下文，越跑越贵。
4. 其余按下面的统一收尾流程执行。

## 项目位置与硬约束（违反会断线/丢数据）

- 源码：`E:\桌面\新建文件夹\plugins\workbuddy-bridge\`（server/src/*.mjs、server/console/index.html、commands/）。**改源码，不改缓存。**
- 数据目录：`%USERPROFILE%\.zcode\workbuddy-bridge\`（config.json 含 apiKey；usage.json/tasks-state.json/learned.json）。
- ⚠️ **绝不允许 taskkill 监听 8788 的 node 进程**——当前会话的模型流量就走它。重启服务只有一种方式：`POST http://127.0.0.1:8788/admin/restart`（带 `Authorization: Bearer <apiKey>`，交棒重启，零断线）。
- ⚠️ **交棒重启（含 /admin/restart 与改完 server.mjs 后的任何重启）之前，必须先在临时目录试启**：`WB_CONFIG_DIR=$(mktemp -d) node server/server.mjs` 起一个隔离实例，`curl /health` 返回 200 且日志无异常堆栈后再动生产——单测不覆盖 server.mjs 监听路径，未声明变量这类「启动即崩」只有真启动才暴露（2026-10-03 20:24 T31 批次就是这么把 8788 打挂、全会话断线的；另有 Windows 看门狗计划任务 wb-bridge-watchdog 每分钟兜底拉起，别依赖它替代试启）。**试启三条硬规矩（0.3.18 血泪换来的）：**(a) `server.mjs` **必须写绝对路径**（`cd X && node server.mjs` 在残留 shell 下会在缓存目录执行、加载旧代码——2026-10-03 22:3x 因此又污染一次生产配置，事后要用 `Get-CimInstance Win32_Process` 核对 cmdline 指向源码还是缓存，别信 cwd）；(b) 端口改在**临时 config.json** 里（`WB_PORT` 环境变量无效）；(c) 起完等 30 秒让 boot+20s 的 provider 同步触发，再核对 `md5sum ~/.zcode/v2/provider_config.json` 与试启前基线一致、临时端口只出现在 `<临时目录>/provider_config.json`（0.3.18 起代码层已强制隔离，变量 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 会被 ZCode 桌面端注入子进程且值恒为生产路径，**别再指望设它来隔离**）。
- 发布：`node C:\Users\87352\.zcode\cli\exec\wb-publish.cjs`（读 `E:/Temp/.wb-pat` 的 PAT；**若文件不存在，停止发布并告知用户**——重建令牌需要 sudo 邮箱验证码，见记忆 github-publishing-workbuddy 的自助流程）。发布后用 `curl -L https://codeload.github.com/zhougonjin-ux/workbuddy-bridge-market/tar.gz/refs/heads/main` 解包覆盖 `~/.zcode/cli/plugins/marketplaces/dev-workbuddy-bridge-local/` 刷新市场快照。
- 控制台 HTML 是 no-store 头，改完让用户刷新页面即可生效；`/console/api/*` 接受 `X-Console-Token`（页面内 `__WB_TOKEN__="..."`）**或** `Authorization: Bearer <apiKey>` 两套鉴权；`/admin/*` 只认 apiKey。
- ⚠️ **「改源码」与「cp 进缓存」必须成对完成再重启**：交棒重启拉起的是**缓存目录**的 `server.mjs`，不是源码目录。2026-10-03 21:1x 因为只改源码就重启，SSE 修复没生效、白白重启一次才发现（token 计数仍是 1）。正确顺序：改源码 → `npm test` → cp 进缓存 → diff 校验一致 → 试启 → 交棒重启。
- ⚠️ **别删已安装缓存的旧版本目录**（`cache/dev-workbuddy-bridge-local/workbuddy-bridge/0.3.3/` 等）：运行中的服务仍从那里启动，`rm -rf` 在 Windows 上不是全有全无（会删到一半报 Device busy，留下半个目录 → 控制台 500）。要清理先确认没有进程从该目录运行。
- 每完成一个功能：`node --check` 全部改动文件 + `npm test`（在 server/ 下跑，当前 61 条必须全过，纯函数新增要补测试）。**只跑 `npm test`，不要裸跑 `node --test`**（后者会把 smoke 测试也执行，2026-10-03 曾污染生产账号池）。

## 每个功能做完后的统一收尾流程

1. 版本号 +1（patch）：`.zcode-plugin/plugin.json`、`server/package.json`、`plugins/marketplace.json` 三处 + 已安装缓存 `C:\Users\87352\.zcode\cli\plugins\cache\dev-workbuddy-bridge-local\workbuddy-bridge\0.3.3\`（最高版本目录，`installed_plugins.json` 的 installPath 指向它）里同步改。
2. 改动的源文件逐个 cp 进上面的缓存目录（**不要**整目录覆盖——缓存里有 `.tmp` 之类的东西别动）。
3. 改 `wb-publish.cjs` 里的版本号与提交说明（该脚本顶部注释即用法），跑一次发布。
4. 刷新市场快照（见上）。
5. `POST /admin/restart` 交棒重启，等 5 秒，curl `/health` 200 确认。
6. 逐功能在线验证（下面每项都写了验证方法），把结果汇报给用户。
7. 全部做完后更新项目记忆（workbuddy-bridge-plugin.md 追加一段）。

## 功能清单（编号即参数）

### ✅ 第一批 T1–T31 已完成（v0.3.10–v0.3.14，commit `0cf4a19`）

T1 接入页 / T2 free-first 路由 / T3 最近请求表 / T4 积分预警条 / T5 夜猫子代打 / T6 事件时间线 / T7 小时分布图 / T8 模型健康巡检 / T9 credit 异常检测 / T10 压缩统计 / T11 Windows toast / T12 失败重试 / T13 每日预算 / T14 任务中心 / T15 签到日历 / T16 活动扩展框架 / T17 账号健康面板 / T18 多 apiKey / T19 路由规则 UI / T20 按时段路由 / T21 配置导出导入 / T22 自更新检查 / T23 控制台 PIN / T24 /wbp-doctor / T25 /wbp 交互面板 / T26 MCP 工具补齐 / T27 流式心跳 / T28 会话压缩记忆 / T29 SSE 推送 / T30 上游 429 协调 / T31 积分缓存 TTL 自适应。

**下面保留原始描述仅作历史参考，不要重做。**

<details>
<summary>T1–T31 原始描述（点击展开，已完成）</summary>

### T1 ⚡ 多客户端接入指南页
控制台新增「接入」标签页：本代理是 OpenAI(=/v1) 与 Anthropic(=/) 兼容端点，给每个常见客户端一段**现成可复制**的配置（Claude Code env、Cline、Cherry Studio、Dify、openai SDK python/js），Base URL + apiKey（从 config.json 读，按钮一键复制，复用页面已有的 copy() 函数）。验证：切到该页能看到配置且复制可用。

### T2 ⚡ 免费模型优先路由
调度策略新增 `free-first`：选站点/选账号排序时，若存在倍率为 0（parseMultiplier=0，"x0.00 credits"）的站点拥有该模型且账号可用，优先走免费站点/模型。落点：router.mjs 的 rankSiteCandidates 附近 + pool.mjs pickAccount 不动（账号层不变，站点层排序加规则）；config 默认不加，用户手动切换。验证：切 free-first 后请求 `auto` 模型，日志看落在免费模型上。

### T3 ⚡ 请求明细列表
控制台「用量」页底部加「最近请求」表：时间/模型/模式/思考档位（若有）/tok_s/耗时/账号（数据源：`GET /console/api/recent-requests`，已存在，返回 reqRing 最近 50 条结构化记录）。列可省略空值。验证：发一个请求后刷新页面表格出现新行。

### T4 ⚡ 积分预警常驻条
控制台所有页签顶部（header 区）常驻预警条，数据源 `GET /console/api/bridge`（已有）：① 任一账号 remain ≤ 阈值（默认 200，写死即可）→ 红「余额不足」；② creditDetail 里有 7 天内到期且余量 > 500 的批次 → 橙「X 天内到期还有 N 积分」；③ 账号 last_error 含 401 → 红「登录态失效」。无命中不渲染。逻辑参考 commands/wbp.md 的提醒区。验证：改阈值临时值看条出现。

### T5 ⚡ 夜猫子任务（black_cat）夜间代打
tasks.mjs 的 autoCompleteChatTasks 扩展：任务 code === 'black_cat'（参与夜间折扣活动，target 3）时，仅在本地时间 22:00–02:00 窗口内代打（其他时段跳过），次数同 maxChatsPerTask，模型用 defaultModel。growth 扫描窗口（growthTimes）不变，夜间窗口由 growth 扫描本身命中即可（若扫描发生在窗口外则本轮跳过该任务并记 msg）。验证：临时把窗口条件改宽跑一次 growth，看 history 里 autoChats 增加。

### T6 🔧 事件时间线
### T7 ⚡ 用量小时分布图
### T8 🔧 模型健康巡检（定时极小请求测全部模型，性价比榜）
### T9 ⚡ credit 异常检测（单次消耗超今日均值 5 倍标红）
### T10 ⚡ 上下文压缩统计可视化
### T11 🔧 Windows toast 通知（猫猫归来/签到失败/账号失效）
### T12 ⚡ 任务失败自动重试一次
### T13 🔧 每日积分预算（超限提醒或自动切免费）
### T14 🔧 成长任务中心视图（全任务进度条 + 单任务手动代打）
### T15 ⚡ 签到日历 + 累计白嫖统计
### T16 🏗️ 活动类型扩展框架
### T17 🔧 账号健康面板（401/冷却/耗尽时间线）
### T18 🔧 多 apiKey 管理 UI
### T19 🔧 路由规则 UI（modelRoutes/aliases/excludeModels 界面化）
### T20 ⚡ 按时段路由（白天/夜里不同模型）
### T21 🔧 配置导出/导入（config+pool+learned 打包）
### T22 ⚡ 插件自更新检查（对比 GitHub 版本，控制台提示）
### T23 🔧 控制台访问 PIN
### T24 ⚡ /wbp-doctor 一键诊断命令
### T25 🔧 /wbp 交互面板（渲染带操作按钮，agent 执行）
### T26 ⚡ MCP 工具补齐（wb_travel_patrol / wb_recent_requests / 单任务代打）
### T27 ⚡ 流式心跳（长思考时发 SSE 注释帧防超时断流）
### T28 🏗️ 会话压缩进度记忆（同会话二次撞限从上次压缩点继续）
### T29 🔧 控制台改 SSE 推送替代轮询
### T30 🔧 上游 429 全局限流协调
### T31 🔧 积分明细缓存 TTL 自适应

</details>

---

## ✅ 第二批 BUG 修复（`/wbp-build bug1`）——**已于 2026-10-03 完成并发布 v0.3.16（commit `b05dfb8`），不要重做**

三个 bug 的根因分析保留在下方供追溯，**实现已完成**（B1 GET /console 下发 cookie + 前端 onerror 带 /health 守卫自动 reload；B2 /service/stop 与 /admin/shutdown 统一走 doStop/gracefulExit，活跃请求返回 409；B3 /bridge 改 redact）。单测 50/50，浏览器内实测 EventSource 由直接 CLOSED 变为 OPEN。

### B1 🔴 SSE 推送在浏览器里从未生效（EventSource 鉴权死锁）

**根因（三方核实）**：
1. 前端 `new EventSource('/console/api/stream')` 是**裸连**（`server/console/index.html:1589`），而 EventSource 这类 API **不支持自定义请求头**。
2. 服务端 `consoleAuthorized`（`server/server.mjs:134-142`）只认三条路：X-Console-Token 头、wbConsoleToken cookie、`Authorization: Bearer <apiKey>` 头。**EventSource 后两条都做不到**（cookie 那条见下）。
3. cookie `wbConsoleToken` **只在 PIN 解锁成功时才种**（`server/server.mjs:373-375` 的 `/console/api/unlock`），而 PIN 功能默认关闭（config 无 `consolePin` 时锁屏页压根不出现）→ **浏览器永远拿不到 cookie** → SSE 永远 401。
   证据：`server.log` 里有 8 条 `WARN 控制台接口鉴权失败：GET /console/api/stream`；curl 带 apiKey 能通是因为走了第三条路，浏览器走不了。

**连带症状**：`CONSOLE_TOKEN = crypto.randomBytes(16)`（server.mjs:52）**每次启动都变** → 每次交棒重启后，所有开着的控制台旧页签以约 30 秒一次频率刷 401 WARN，直到用户手动刷新页面。

**修法（一套治三个症状）**：
- 服务 `GET /console`（真页面，非锁屏页）时顺带下发 `Set-Cookie: wbConsoleToken=<CONSOLE_TOKEN>; Path=/; SameSite=Strict; HttpOnly`。安全前提已成立：页面是 no-store、token 本来就内联在 HTML 里给前端用，cookie 只是让浏览器**自动携带**同一个值，不新增暴露面。
- 前端 `startConsoleStream` 的 `es.onerror` 里，若 `es.readyState === EventSource.CLOSED`（即鉴权 401 导致连接被服务端关闭，不是网络抖动）→ 带一个 `/health` 探测守卫（确认服务活着才 reload，防服务真挂时无限刷新）地 `location.reload()`。
- 验证：`curl -c` 模拟带 cookie 请求 `/console/api/stream` 应能持续收到 `event: bridge` 帧；重启服务后不手动刷新页面，观察 WARN 是否归零、页面数据是否自动继续更新。

### B2 🔴 控制台「停止服务」会掐断在途请求 + 跳过落盘

`/console/api/service/stop`（`server/src/console-api.mjs:762-767`）直接 `process.exit(0)`，而 `/admin/shutdown`（server.mjs:492+）有「活跃请求 >0 时拒绝（除非 force=1）」的保护。后果：① 杀掉正在跑的模型请求（**可能包含用户当前会话自己的流量** → 断线）；② 跳过 `flushUsage()` 之外的 gracefulExit 流程，events.json / learned.json 可能丢最后一次落盘。
**修法**：改为调用 `lifecycle-impl.mjs` 的 `gracefulExit({ waitIdle: true, reason: '控制台停止' })`（与 `/admin/restart` 同源），并在有活跃请求时返回 409 + 明确提示（让用户看到「有 N 个请求在进行中，完成后再停，或用强制停止」）。前端按钮二次确认文案同步改。
**验证**：发起一个长请求 → 点停止 → 断言返回 409；无活跃请求时点停止 → 服务在最后请求完成后退出且 usage/events 落盘完整。

### B3 🟡 `/bridge` 接口仍在返回 accessToken/refreshToken 明文

SSE 通道已在 0.3.14 脱敏（`bridgeStatus(cfg, {redact:true})`），但**轮询用的 `/console/api/bridge`（console-api.mjs:259）仍走默认不脱敏**，每 20 秒把两个账号的凭据发给浏览器。
**核查结论**：前端**没有任何地方**读 `accessToken` 字段（接入页用的是 `apiKey`，不是账号 token）——所以 B3 可以直接脱敏，不影响任何功能。
**修法**：`/console/api/bridge` 改传 `bridgeStatus(cfg, { redact: true })`；确认 `/console/api/*` 其余返回账号对象的地方（`/pool`、`/task-center` 等）是否也需要同样处理——**逐一 grep 确认前端是否消费 token 字段后再脱敏**。`/backup` 导出含 token 是功能本意，**保留不脱敏**。

## ✅ 第二批新功能 T32–T39 —— **已于 2026-10-03 完成并发布 v0.3.19（commit `8e23365`），不要重做**

按价值排序，建议顺序实现。数据源尽量复用已有接口，别新造轮子。

### T32 ⚡ 积分耗尽预测（最贴合本插件核心使命）
`expiry-first` 只解决「先烧哪批」，没解决「哪批烧不完」。取近 7 日日均消耗（`usage.json` 的 day.credit）对比各 creditDetail 批次的到期日与余量，算出：「X 批次还剩 N 分、M 天后过期、按当前速率只会用掉 K 分」→ 预警条 + 账号卡上的批次行加「预计用不完」标记与建议（「建议 3 天内集中跑长任务」）。纯计算，零风险。验证：构造 creditDetail 数据调 `predictBurnout()` 纯函数（补单测），真实账号上出一次报告。

### T33 ⚡ 通知通道扩展（Webhook / Bark / Server酱）
`notify.mjs` 已有事件抽象 + 5 分钟节流，现在只有 Windows toast。config `notify.channels: [{type:'webhook'|'bark'|'serverchan', url, enabled}]`，用 `notifyTask` 的同一批事件分发。用途：人不在电脑前也能收「猫猫归来 / 余额不足 / 登录态失效」。验证：`notify.shouldNotify` 节流纯函数补单测 + 真发一个测试 webhook 看返回 200。

### T34 🔧 T4 预警阈值可配置
把 200 分 / 7 天 / 500 分三个写死值挪进 `config.alerts { lowBalance:200, expiryDays:7, expiryMinAmount:500 }`，validateConfig 校验，控制台预警条旁加个设置入口。

### T35 🔧 巡检省钱模式
T8 每轮全量巡检 17 个模型是真实消耗（约 0.1~0.5 积分/天）。config `healthCheck.only: [modelId...]` 白名单（或 `onlyFree: true` 只巡 x0 免费模型），控制台巡检卡加勾选。

### T36 ⚡ 用量报表导出 CSV
近 7/30 天按 模型/账号/日期 三个维度导出。`/console/api/usage?days=30` 数据已全，控制台加个下载按钮 + 前端 CSV 拼装（或后端返回 text/csv）。

### T37 🔧 预算 pause 模式
`budget.mode` 现在只有 `warn`（提醒）和 `free`（改道免费）。加 `pause`：超限时直接拒绝新请求（429 + 明确 JSON 错误），防失控烧积分。config 校验枚举 + console-api /budget 支持该值。

### T38 🔧 控制台移动端适配
配合 T33 的手机推送，用媒体查询让控制台在窄屏可读（卡片单列、表格横向滚动、导航折叠）。

### T39 🔧 协议漂移自检
长期风险：上游 WorkBuddy 改版。`doctor.mjs` 加一项：比对 `.ref/` 参考仓库的关键端点签名与当前实际响应结构（如 `/v2/chat/completions` 是否仍返回预期字段），改版时提前告警。

## 🚀 第三批新功能（`/wbp-build feat`，T40 起）—— 2026-10-04 添加

0.3.22 已落地：任务列表防闪（服务端缓存 + 每日 listTimes 三次预取 + 手动刷新）、全控制台 `paint()` 防闪、任务页布局整理。**重构时必须保留 paint 机制与任务中心缓存语义**（有单测守着）。以下按价值排序：

### T40 ⚡ 控制台信息架构重构（UI 乱的最大一刀）
现状 8 个页签每页 6-10 张卡片纵向堆叠，设置类内容分散在任务页/模型页/健康页三处。改法：①新增「设置」页签，把所有配置卡（任务时点/预算/预警阈值/巡检范围/按时段路由/通知通道/PIN）集中分小节；②业务页只留状态与操作；③`<details>` 折叠用于所有 set-and-forget 配置。渲染函数签名不变、只挪 DOM 结构，paint 防闪不受影响。
### T41 ⚡ 任务中心多账号总览
当前一次只能看一个账号（下拉切换）。加「全部账号」视图：每账号一行（名称/任务数/达标待领/可代打数/数据时间），点击行展开该账号详情。数据源：taskCenterView 缓存已就位，遍历启用账号即可（预取时已缓存，零额外上游请求；未预取过的账号按需拉一次）。
### T42 🔧 自动任务开关 UI（总开关 + 分类开关）
cfg.tasks.enabled/checkin/growth 目前只有徽标展示没有切换入口。在任务页操作行加三个开关（/tasks/config 扩展 enabled/checkin/growth 字段，校验后热生效——startTaskLoop 每 60s tick 现读 cfg）。
### T43 ⚡ SSE 推送降频：数据 hash 变了才推
服务端 SSE bridge(20s)/tasks(30s)/usage(60s) 固定节奏推送，多数轮次数据没变。改为对 payload 做浅 hash，变化才发事件（积分余额/任务状态本就低频变化）。前端零改动，服务端省流量。
### T44 🔧 账号卡「按当前速率还能用 N 天」
burnout.mjs（T32）已有按 7 日日均的批次耗尽预测，把账号级「预计还能用 N 天 / 到期前用不完的量」直接显示在账号卡与顶栏 KPI（数据源 /console/api/burnout 已有，前端加渲染）。
### T45 ⚡ 亮色主题 + 主题切换
CSS 变量已集中在 :root（--panel/--line/--text/...），加 `[data-theme="light"]` 一组变量 + 顶栏切换按钮 + localStorage `wbTheme` 记忆 + `prefers-color-scheme` 跟随系统。
### T46 🔧 用量周报（通知通道已就绪）
每周一 09:00（可配 listTimes 同款校验）把上周用量汇总（总调用/积分/按模型 Top5/按账号/异常次数）生成 events 记录并走 notify 通道推送（T33 多通道已有）。纯读数，零消耗。
### T47 🔧 控制台 index.html 拆分（工程项，放最后）
单文件 ~1900 行。拆成 style.css / app.js 两个静态文件由 /console/* 继续服务（保持零依赖 + no-store + token 内联注入方式）。纯维护性重构，功能零变化，谨慎做（改坏 UI 的回退成本高）。

## 成本纪律

- 用 TodoWrite 追踪进度；每个功能独立完成+验证后再做下一个。
- 不要为了"顺便"重构无关代码。
- 全部做完输出一份总结：每个功能一段（改了什么/怎么验证的/commit 号）。
