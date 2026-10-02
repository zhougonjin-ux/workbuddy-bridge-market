---
name: workbuddy-bridge
description: Use when the user asks about WorkBuddy/CodeBuddy credits (积分), credit expiry scheduling, WorkBuddy accounts, switching WorkBuddy accounts, check-in tasks, or using WorkBuddy models as ZCode's model provider via the local proxy. Covers wb_* MCP tools, /wb-* commands, and the local proxy admin API.
---

# WorkBuddy Bridge

这个插件把腾讯 WorkBuddy/CodeBuddy（国内版 copilot.tencent.com）的积分与模型桥接进 ZCode：

- **本地代理**（端口 8788）暴露 OpenAI 兼容 `/v1/chat/completions` 与 Anthropic 兼容 `/v1/messages`，ZCode 的自定义模型供应商指向它即可消耗 WorkBuddy 积分。
- **多账号池**：多个 WorkBuddy 账号存在 `~/.zcode/workbuddy-bridge/auth.cn-cli.pool.json`。
- **积分到期优先调度**（默认 `expiry-first`）：每 30 分钟后台刷新各账号的积分批次明细（含到期时间），调度时优先消耗「最早到期且有余额」的账号；账号额度耗尽/失败会自动切换到下一个。
- **自动任务**：每日签到 + 成长任务自动报名/领奖（可在 config.json `tasks` 关闭）。

## 何时做什么

- 用户问积分、余额、到期时间、先用哪个积分 → `wb_status` / `wb_credit_plan`
- 用户要切换账号或排序策略 → `wb_switch`（expiry-first / balance-first / round-robin / pinned）
- 用户要加账号 → `wb_login_start` → 把 authUrl 给用户浏览器授权 → `wb_login_poll`
- 对话报「上游 402/429」或积分不足 → `wb_status` 看哪个账号还有余额，必要时 `wb_refresh_credits` 后重试
- 自动任务状态 → `wb_tasks_status`；手动跑 → `wb_tasks_run`

## 关键路径

- 代理入口：`<插件目录>/server/server.mjs`（数据目录 `~/.zcode/workbuddy-bridge`，环境变量 `WB_CONFIG_DIR` 可覆盖）
- 控制台：http://127.0.0.1:8788/console —— 可视化管理台，五个面板：账号与积分（策略切换/账号卡片/每批积分到期倒计时/微信扫码登录/消耗顺序）、模型（倍率/上下文容量/图片·工具·推理能力表/设默认）、自动任务、用量、日志。用户要「可视化」「界面」「扫码」时引导运行 /wb-console
- 斜杠命令：`/wb`（会话内总览面板，免浏览器）· `/wb-start` · `/wb-status` · `/wb-switch` · `/wb-login` · `/wb-import` · `/wb-startup`（开机自启管理）· `/wb-console`
- ZCode 接入：模型 ID 填 `default`（跟随管理台「设为默认」变化），Base URL `http://127.0.0.1:8788/v1`，key 用控制台顶栏「⧉ 复制 ZCode 配置」一键取
- 本机自动导入：`wb_import_local` 工具 / 「导入本机账号」按钮 —— 从 `~/.codebuddy/settings*.json` 的 `env.CODEBUDDY_AUTH_TOKEN` 提取本机客户端登录态（服务启动时也自动重扫）；无 refreshToken，到期后重跑导入即跟上客户端续期
- 配置：`~/.zcode/workbuddy-bridge/config.json`（`pool.policy`、`pool.pinnedAccountId`、`tasks`、`apiKey`、`port`）
- 手填到期兜底：在 `auth.cn-cli.pool.json` 的账号条目加 `"manualExpireAt": "2026-10-15"`（接口拿不到到期明细时生效）

## 排障

- 工具报「本地代理没有响应」→ 先运行 `/wb-start`
- 上游 401 反复出现 → 该账号登录态失效，在控制台删除后重新 /wb-login
- 积分明细里 expireAt 全是 null → 上游字段口径变化，把 `/admin/bridge` 的原始输出发给用户核对，或手填 manualExpireAt 兜底
