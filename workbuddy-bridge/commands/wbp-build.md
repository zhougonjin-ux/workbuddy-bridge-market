---
description: 按 Roadmap 批量实现 workbuddy-bridge 插件功能（参数=功能编号，支持 all/继续；含完整技术约束与发布流程）
---

实现 workbuddy-bridge 插件的待办功能。参数 `$ARGUMENTS` 是要做的功能编号（如 `T2 T14`，逗号或空格分隔）；`all` = 从 T1 到 T31 顺序全部做；**为空时默认做 T1 T2 T3 T4 T5（推荐包）**。

## 检查点纪律（all/批量模式必读）

1. **开工前**：先读项目记忆 workbuddy-bridge-plugin.md 里最近的「/wbp-build 进度」段——里面记录了已完成编号、当前版本号、最后 commit。若记忆里有未完成清单，从清单第一个继续，不要重做已完成的。
2. **每个功能完成后**：立即在项目记忆追加/更新一段「/wbp-build 进度」：✅已完成编号列表、当前版本号、最新 commit、⏳剩余编号。这是断点——任何时刻会话断了，用户开新会话再跑 `/wbp-build all`（或剩余编号）就能续上。
3. **每完成 6 个功能**：主动提醒用户「已稳定发布到 vX.Y.Z，建议开新会话继续：/wbp-build all」——长会话每轮都背着全部上下文，越跑越贵。
4. 其余按下面的统一收尾流程执行。

## 项目位置与硬约束（违反会断线/丢数据）

- 源码：`E:\桌面\新建文件夹\plugins\workbuddy-bridge\`（server/src/*.mjs、server/console/index.html、commands/）。**改源码，不改缓存。**
- 数据目录：`%USERPROFILE%\.zcode\workbuddy-bridge\`（config.json 含 apiKey；usage.json/tasks-state.json/learned.json）。
- ⚠️ **绝不允许 taskkill 监听 8788 的 node 进程**——当前会话的模型流量就走它。重启服务只有一种方式：`POST http://127.0.0.1:8788/admin/restart`（带 `Authorization: Bearer <apiKey>`，交棒重启，零断线）。
- 发布：`node C:\Users\87352\.zcode\cli\exec\wb-publish.cjs`（读 `E:/Temp/.wb-pat` 的 PAT；**若文件不存在，停止发布并告知用户**——重建令牌需要 sudo 邮箱验证码，见记忆 github-publishing-workbuddy 的自助流程）。发布后用 `curl -L https://codeload.github.com/zhougonjin-ux/workbuddy-bridge-market/tar.gz/refs/heads/main` 解包覆盖 `~/.zcode/cli/plugins/marketplaces/dev-workbuddy-bridge-local/` 刷新市场快照。
- 控制台 HTML 是 no-store 头，改完让用户刷新页面即可生效；`/console/api/*` 接受 `X-Console-Token`（页面内 `__WB_TOKEN__="..."`）**或** `Authorization: Bearer <apiKey>` 两套鉴权；`/admin/*` 只认 apiKey。
- 每完成一个功能：`node --check` 全部改动文件 + `npm test`（在 server/ 下跑，当前 27 条必须全过，纯函数新增要补测试）。

## 每个功能做完后的统一收尾流程

1. 版本号 +1（patch）：`.zcode-plugin/plugin.json`、`server/package.json`、`plugins/marketplace.json` 三处 + 已安装缓存 `C:\Users\87352\.zcode\cli\plugins\cache\dev-workbuddy-bridge-local\workbuddy-bridge\0.3.3\`（最高版本目录，`installed_plugins.json` 的 installPath 指向它）里同步改。
2. 改动的源文件逐个 cp 进上面的缓存目录（**不要**整目录覆盖——缓存里有 `.tmp` 之类的东西别动）。
3. 改 `wb-publish.cjs` 里的版本号与提交说明（该脚本顶部注释即用法），跑一次发布。
4. 刷新市场快照（见上）。
5. `POST /admin/restart` 交棒重启，等 5 秒，curl `/health` 200 确认。
6. 逐功能在线验证（下面每项都写了验证方法），把结果汇报给用户。
7. 全部做完后更新项目记忆（workbuddy-bridge-plugin.md 追加一段）。

## 功能清单（编号即参数）

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

（T6+ 目前只有一句话描述：实现时先读源码相关区域，按项目现有代码风格设计，拿不准的设计先问用户。）

## 成本纪律

- 用 TodoWrite 追踪进度；每个功能独立完成+验证后再做下一个。
- 不要为了"顺便"重构无关代码。
- 全部做完输出一份总结：每个功能一段（改了什么/怎么验证的/commit 号）。
