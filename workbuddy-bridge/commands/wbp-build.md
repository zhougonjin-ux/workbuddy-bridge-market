---
description: 按 Roadmap 批量实现 workbuddy-bridge 插件功能与 bug 修复（参数=编号/批次代号，支持 all/继续；含完整技术约束与发布流程）
---

实现 workbuddy-bridge 插件的待办功能。参数 `$ARGUMENTS` 支持三种写法：

- **功能编号**：`T50 T52`，逗号或空格分隔。
- **批次代号**：`feat` = 做 T50–T54 全部新功能（第五批，2026-10-05 添加）。旧语义已作废：T42–T49（第三批）已于 2026-10-04 完成（v0.3.26，commit f4a085c）；T32–T39 于 2026-10-03 完成（v0.3.19）；bug1 于 2026-10-03 完成（v0.3.16）。
- **`all`** = 从 T50 到 T54 顺序全做（T51 并入 T50 同一次扫描实现，实际执行序 T50(+T51) → T52 → T53 → T54）。
- **为空时** = 默认做全部 T50–T54（体量不大，一次会话可完成；上次会话曾连做 T42–T49 共 8 项）。

📋 **当前待办：第五批 T50–T54（2026-10-05 添加，全部细节已调查完毕——端点/参数/行为语义/实测数据齐全，零调查成本直接开工，清单见「第五批」一节）。** 已完成历史：T1–T31、B1–B4、T32–T39、T40/T41（0.3.24 吸收）、T42–T49（v0.3.26，commit f4a085c）。新会话先读项目记忆 workbuddy-bridge-plugin.md 最近的「/wbp-build 进度」段核对进度，不要重做已完成编号。

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
- 每完成一个功能：`node --check` 全部改动文件 + `npm test`（在 server/ 下跑，当前 88 条必须全过，纯函数新增要补测试）。**只跑 `npm test`，不要裸跑 `node --test`**（后者会把 smoke 测试也执行，2026-10-03 曾污染生产账号池）。

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

## 🚀 第三批新功能（`/wbp-build feat`，T42–T49）—— 2026-10-04 添加，同日修订

已落地：0.3.22 任务列表防闪；0.3.23 总览大屏；0.3.24 **无页签大屏架构**（大屏=控制台本体，子页面下钻 + hash 路由 —— 原 T40 整体被它吃掉、T41 的大屏摘要部分也已完成）；0.3.25 健康面板字段修复。**重构时必须保留 paint 机制与任务中心缓存语义**（有单测守着），子页面一律从大屏下钻进入、不做页签。剩余 8 项按价值排序：

### T40 ✅ 控制台信息架构重构 —— 已由 0.3.24 完成（无页签架构 + 设置子页面合并接入/健康/日志），不要重做
### T41 ✅ 任务中心多账号总览（大屏摘要部分）—— 已由 0.3.24 完成（tcSummary 每账号待领/可代打上大屏）；**子页面内的全账号视图并入 T48**
### T42 🔧 自动任务开关 UI（总开关 + 分类开关）
cfg.tasks.enabled/checkin/growth 目前只有徽标展示没有切换入口。在大屏「今日自动任务」面板与任务中心子页面的操作行加三个开关（/tasks/config 扩展 enabled/checkin/growth 字段，校验后热生效——startTaskLoop 每 60s tick 现读 cfg）。
### T43 ⚡ SSE 推送降频：数据 hash 变了才推
服务端 SSE bridge(20s)/tasks(30s)/usage(60s) 固定节奏推送，多数轮次数据没变。改为对 payload 做浅 hash，变化才发事件（积分余额/任务状态本就低频变化）。前端零改动，服务端省流量。
### T44 🔧 大屏与账号卡显示「按当前速率还能用 N 天」
burnout.mjs（T32）已有按 7 日日均的批次耗尽预测，把账号级「预计还能用 N 天 / 到期前用不完的量」直接显示在大屏积分面板的账号行、账号管理子页面的账号卡与顶栏 KPI（数据源 /console/api/burnout 已有，前端加渲染）。
### T45 ⚡ 亮色主题 + 主题切换
CSS 变量已集中在 :root（--panel/--line/--text/...），加 `[data-theme="light"]` 一组变量 + 大屏快捷入口处切换按钮 + localStorage `wbTheme` 记忆 + `prefers-color-scheme` 跟随系统。
### T46 🔧 用量周报（通知通道已就绪）
每周一 09:00（可配 listTimes 同款校验）把上周用量汇总（总调用/积分/按模型 Top5/按账号/异常次数）生成 events 记录并走 notify 通道推送（T33 多通道已有）。纯读数，零消耗。
### T48 ⚡ 子页面大屏化第二批（含原 T41 剩余）
三个子页面还是页签时代的纵向堆叠布局，按大屏思维重排：①任务中心子页面——顶部加「全部账号」总览网格（每账号一行：任务数/达标待领/可代打/数据时间，点击展开该账号详情，数据走 taskCenterView 服务端缓存）；②账号管理子页面——策略卡收进折叠、账号卡网格化；③用量子页面——KPI 与图表分区精简；④设置子页面——接入/通知/路由/PIN/备份/诊断/日志分小节 + `<details>` 折叠，默认只展开接入。
### T49 🔧 下钻精定位
大屏账号行/任务摘要行点击进入子页面后，自动滚动并高亮定位到对应账号卡/任务块（module 变量传 focus id，目标 render 完成后 scrollIntoView + 2s 高亮描边）。
### T47 🔧 控制台 index.html 拆分（工程项，放最后）
单文件 ~2000 行。拆成 style.css / app.js 两个静态文件由 /console/* 继续服务（保持零依赖 + no-store + token 内联注入方式）。纯维护性重构，功能零变化，谨慎做（改坏 UI 的回退成本高）。

## 🚀 第五批（`/wbp-build feat` 或 `all` 或空参数，T50–T54）—— 2026-10-05 添加

**来源**：对比 Go 参考项目 `.ref\workbuddy2api-panel-main`（比插件当时参考的版本新，2026-09 新逆向）+ 生产账号实测。**全部只读端点已于 2026-10-05 用公瑾账号实测 200 通过**；POST 端点未实发（会改变账号状态），行为语义引自 Go 项目三账号验证结论。参考实现：`internal/upstream/streak.go`（端点+字段）、`internal/upstream/blackcat.go`（礼包/补偿/补签/热力图）、`internal/upstream/profile.go`（昵称）、`internal/upstream/global_models.go`（v3/config）、`internal/scheduler/streak.go`（调度流程）。

**growth 域请求形态（与猫猫旅行同构，tasks.mjs 已有同域先例）**：`{chatBase}`（copilot.tencent.com，**不带 /v2 前缀**）+ billingHeaders 鉴权 + `X-User-Id`，信封 `{code:0,msg,data}`。billing 域 = `{billingBase}`（www.codebuddy.cn）同款头。

### T50 🔧 连登管家（连登状态+补签卡+档位兑换+自动抽奖）—— 本批最大项，T51 并入实现
端点组（growth 域）：
- `GET /activity/growth/streak` → `data`: `{streak:{days, month_total_days, next_tier, next_tier_remaining, makeup_dates[]}, makeup_cards:{balance, max:4}, redemption_status:{tier_7d_status, tier_14d_status, tier_28d_status, remaining_days, tiers:[{tier,days,credit,energy,cards,chances}]}}`。**实测（2026-10-05 公瑾）**：days=2、三档全 locked、补签卡 0/4。档位奖励：7d→credit 0/能量 2/卡 1/抽奖 1；14d→+50c/能量 3/卡 1/抽奖 1；28d→+150c/能量 5/卡 1/抽奖 1。
- `POST /activity/growth/redeem` body `{tier:"7d"|"14d"|"28d", client_token:<uuid>}`；未解锁 HTTP 403「连续登录天数不足」（幂等跳过）；`tier_7d_status` 等 ∈ locked/可兑/claimed。
- `GET /activity/growth/lottery/summary` → `data:{chances, module:{enabled}}`（实测 chances=0、enabled=true）。
- `POST /activity/growth/lottery/draw` body `{client_token:<uuid>}`——每次耗 1 chance，prize 形状由活动期决定，透传记录即可。
- `GET /activity/growth/heatmap` → `data.cells[] {date:"YYYY-MM-DD", score, has_new_buddy}`（一整年）。
- `POST /activity/growth/makeup-cards/use` body `{target_date:"YYYY-MM-DD"}`——无卡/已签返回业务错误静默跳过。
- client_token = 前端 randomUUID 同款幂等令牌（Go 用 crypto/rand 16 字节 hex 拼接，`crypto.randomUUID()` 等价）。
- **流程（照抄 scheduler/streak.go 的 streakBonusAccount）**：签到排程后同轮执行 → ①heatmap 查昨日 score==0 且 makeup_cards.balance>0 → 补签保连登（连登一断要重攒 7 天）→ ②T51 礼包/补偿 → ③GET streak → 逐档 status 非 locked/claimed 就 redeem → ④lottery/summary → chances>0 循环 draw。
- 落点：tasks.mjs 新 kind='streak'（受 tasks.enabled 总开关门控，时点复用 checkinTimes 之后顺延；幂等可一天多跑）；tasks-state.json 新 streak 段 + record() 事件 + gainedTotal 白嫖统计累计；config 无需新字段（复用 tasks.enabled/checkinTimes）。
- UI：大屏「今日自动任务」tile 加连登块（x 天 · 下一档差 N 天 · 补签卡 b/max · chances），任务页任务总览行同步。
- ⚠️**验收纪律（0.3.20/0.3.21 血泪，领奖类功能必犯）**：不能只看请求 200——redeem 验收看 redemption_status 从可兑变 claimed；draw 验收看 chances 递减且 summary 回读减少；补签验收看 heatmap/makeup_dates 变化。**带目标值的操作必须看目标值本身的变化。**

### T51 🔧 新手礼包 + 活动补偿自动领取（并入 T50 流程步骤②）
- `POST {billing}/billing/meter/claim-gift` body `{}` → `data:{credit}`——新手礼包每号一次，已领返回业务错误静默跳过。
- `POST {billing}/billing/meter/claim-compensation` body `{}` → `data:{credit}`——有则领无则业务错误。
- 注意是 **billing 域**不是 growth 域；领到 credit 时事件 + notify（「🎊 新手礼包 +Nc」样式）+ 白嫖统计累计。

### T52 🔧 官方打卡热力图上屏
- 数据源 T50 已接的 heatmap。console-api 新增 `/console/api/heatmap?site=&account=`，服务端带 TTL 缓存（参照 taskCenterView 模式，6h 或随任务刷新失效）。
- UI：任务中心子页面与本地 checkinDays 日历（T15）并排显示官方热力图（约 53 周×7 格，score 分级着色，hover=日期+score+has_new_buddy）。官方=权威全历史（从账号注册日起算），本地=插件启用日起算，两者并存并注明口径。

### T53 🔧 账号昵称同步（改上游昵称后免手动改备注）
- `GET {billing}/console/account`，头：Bearer + `x-client-platform: web` + Origin/Referer `https://www.workbuddy.cn`（profile.go 同款，实测 200）。
- **隐私边界（强制）**：响应含 phoneNumber/wechatOpenId 等敏感字段——代码**只解析 uid 与 nickname 两个字段**，其余不解析、不落日志、不透传；只在用户手动触发时调用（账号卡或账号管理页加「同步昵称」动作），**不进任何定时轮询**。
- uid 与池内账号不一致报错防串号；成功更新显示名并落池。

### T54 🔧 /v3/config 模型目录对账
- `GET https://copilot.tencent.com/v3/config`（CN 域实测 200）→ `data.agents[]`（每个含 name/models[]/modelTags，cli agent 是主目标）。
- 用途一：protocol.mjs 加签名项（v3/config agents 里 cli models 非空且含当前 defaultModel）。
- 用途二（可选）：模型目录并集补缺——Go 项目实测 global 域有模型只在企业端点下发（gpt-5.3-codex 只在 /v2 家族）；CN 域增量先实测对比现有 /console/enterprises/personal/models 目录，无增量就只做签名不做并集。

## 成本纪律

- 用 TodoWrite 追踪进度；每个功能独立完成+验证后再做下一个。
- 不要为了"顺便"重构无关代码。
- 全部做完输出一份总结：每个功能一段（改了什么/怎么验证的/commit 号）。
