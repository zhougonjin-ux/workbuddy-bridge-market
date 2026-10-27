# dsh-xdpool 扫码登录十三家厂商 · 来源与移植评估

> 2026-10-27 调研结论（读 dsh-xdpool 源码所得）。背景：v0.3.64/65 已把「扫码登录」做成一级入口，
> 其中 CodeArts / LobsterAI / Qoder×2 / TRAE / Cline 六家目前按 XD Pool 目录展示为「未接入」置灰卡。
> 本文记录它们能不能接、怎么接。

## 十三家的真实来源

dsh-xdpool 自己没有实现任何一家。它在 `vendor/channel-pack/` 打包携带了
**[dsh-codearts-auth](https://gitee.com/iJetLi/deepseek-harness-codearts)**（MIT 许可，
吸收提交 `345f0a0`，2026-10-06）的完整运行时：

- `pack.js`：69,149 行 esbuild 单文件 bundle（jose/undici 内联），运行时实际加载的代码；
- `qoder-auth-wasm.wasm`：Qoder 加密推理的 WASM，必须与 pack.js 同目录；
- NOTICE 说明：覆盖 codearts / buddy(WorkBuddy 国内) / workbuddy(WorkBuddy 国际) / qoder /
  qodercn / lobsterai / trae / cline / loomy / raccoon / minimax / zcode / gemini 十三家渠道的
  登录流程、账号池、积分领取、模型黑名单与本地 OpenAI 网关。

**TypeScript 源码在上游 gitee 仓库**（dsh-xdpool 里只发 bundle 不超文件上限）。每家一个
`<vendor>-auth.ts` + `<vendor>-adapter.ts`（+ `models.ts`），另带 `openai-gateway/`
（可自暴露 OpenAI 兼容口）。移植时应从上游源码入手，不要读 bundle。

## 为什么不能把整包直接搬进本插件

这个包是 **DSH 宿主的 cordis 插件**，不是独立库：

- 每家适配器 `class XxxAdapter extends LlmAdapter`（宿主基类），由宿主
  `llm.registerAdapter([product.id], adapter)` 收编；dsh-xdpool 的 channel-lane 再把
  OpenAI 请求翻译成宿主流词汇（`block-start | text-delta | … | usage | finish`）；
- 凭证存取全走宿主 `ctx.credentials` 服务（bundle 内 169 处调用）；
- 插件 inject 声明 `["credentials", "commands", "llm"]`，运行中还用
  `ctx.connection`（RPC）、`ctx.agents`、`ctx.fiber`、`ctx.effect`、`ctx.zcodeAuth`；
- 宿主依赖 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-credentials`、`@deepseek-ai/cordis`、
  `@deepseek-ai/schemastery` 四个模块——**缺任何一个整包降级为 failed**。

本插件（workbuddy-bridge）是普通 Node HTTP 服务，没有这套宿主。

## 两条路

### 路 A：写「迷你 DSH 宿主」垫片挂整包 — 不推荐

要把 dsh-llm（LlmAdapter 基类 + LlmError/错误码/枚举 + registerAdapter/stream/listModels 分发）、
dsh-credentials（credentialRef 存储）、cordis（Service 生命周期）、schemastery 四个模块都仿出来。
69,149 行对契约细节极敏感（dsh-xdpool 自己的 channel-lane 注释里就有两个「宿主不报错但行为错误」的坑：
图片必须走宿主附件存储、裸 string content 被宿主校验拒绝），错一处十三家全挂，且上游每次更新都要跟。

### 路 B：逐家移植进本插件架构（推荐）

本插件已有账号池、设备授权登录、模型目录、按站点调度，缺的只是「非 WorkBuddy 协议」的站点层。
从上游 TS 源码把 `<vendor>-auth.ts` / `<vendor>-adapter.ts` 的登录握手、模型目录、对话流解析
重写为本插件的站点适配器：

- **第一家最贵**（打通骨架，估 1–2 天）：建议 **CodeArts**（华为云，DeepSeek·GLM·openPangu
  每日免费额度，上游验证最充分、XD Pool 实测成熟）；
- 后续每家几小时~一天：LobsterAI（有道签到积分）、Cline（绑 GitHub 送额度）较顺；
- **Qoder 最麻烦**：加密推理端点，必须连 `qoder-auth-wasm.wasm` 一起移植绑定。

## 提醒

- 这类适配本质是逆向厂商协议；上游仓库公开着同样暴露。厂商改协议/改额度政策就要跟着修。
- 免费额度归厂商所有，随时会变；不要把任何业务建立在单家免费层上。
- 本地分析用的 dsh-xdpool 克隆是一次性的；需要再看时
  `git clone --depth 1 https://gh-proxy.com/https://github.com/XDTrees/dsh-xdpool` 即可。
