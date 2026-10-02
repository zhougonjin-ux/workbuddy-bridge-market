---
description: 在会话里直接渲染 WorkBuddy 总览面板（策略/账号/积分到期/任务/用量，无需浏览器）
---

在当前会话里渲染 WorkBuddy 桥接的完整总览面板（不打开浏览器）。

按顺序调用以下 MCP 工具并**把结果整合成一份 markdown 面板**输出给用户：

1. `wb_status` → 调度策略 + 各账号状态
2. `wb_credit_plan` → 消耗顺序
3. `wb_tasks_status` → 今日签到/成长任务
4. 用 Bash 请求 `GET http://127.0.0.1:8788/console/api/usage`（带 apiKey 的 `X-Console-Token` 或 `Authorization` 头；apiKey 在 `%USERPROFILE%\.zcode\workbuddy-bridge\config.json`）→ 今日用量

**⚠️ 提醒区（放在面板最顶部，仅在有命中项时显示，没有则整段省略）：**
- 🔴 **7 天内到期的积分批次**还有大量余量 → 建议立刻用 `expiry-first` 策略消耗（列出：账号/批次/余量/到期日）
- 🟠 账号额度耗尽或登录态失效（exhausted / last_error 含 401）→ 提示重置、重新 /wb-import 或 /wb-login
- 🟡 今日签到还没做的账号 → 提示可 `wb_tasks_run`

**输出格式要求**（用 markdown 表格，不要贴原始 JSON）：

```
### 📊 WorkBuddy 总览

（⚠️ 提醒区，如有）

**调度策略**：expiry-first（积分最早到期优先）｜ 代理：运行中，已运行 x 分

**账号与积分**（按消耗顺序）
| # | 账号 | 状态 | 余额 | 最早到期 |
|---|------|------|------|----------|

**积分批次明细**
| 账号 | 批次 | 余量 | 到期 |
|------|------|------|------|
（所有账号的所有批次，按到期时间升序）

**今日任务**：签到 ✓/✗/未执行 × N 个账号 ｜ 成长任务 领奖 N 个 +M 积分
**今日用量**：调用 N 次 ｜ 输入/输出 tokens ｜ 消耗积分 N

提示：改策略/切账号/加账号直接说，或 /wb-console 打开图形面板。
```

若代理未运行：先按 /wb-start 启动再渲染。

$ARGUMENTS
