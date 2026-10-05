---
description: WorkBuddy 交互面板：渲染总览并给出可点选的操作菜单（回复编号即执行，无需浏览器）
---

在当前会话里渲染 WorkBuddy 桥接的**交互式面板**：总览 + 操作菜单。用户回复菜单编号（如「2」或「2 3」），你执行对应操作后**重渲染整个面板**。

## 第一步：采集数据（并行调，全部失败才提示启动）

1. `wb_status`（MCP 工具）→ 调度策略 + 各账号余额/到期
2. `wb_tasks_status` → 今日签到/连登管家/成长任务/白嫖统计
3. Bash：`curl -s -H "Authorization: Bearer $(node -pe "JSON.parse(require('fs').readFileSync(process.env.USERPROFILE+'/.zcode/workbuddy-bridge/config.json','utf8')).apiKey")" http://127.0.0.1:8788/console/api/usage` → 今日用量
4. Bash：同上请求 `/console/api/recent-requests` → 最近请求 tok/s
5. Bash：同上请求 `/console/api/doctor` → 体检摘要（summary 计数 + fail/warn 项）

## 第二步：渲染面板

```
### 📊 WorkBuddy 总览

**策略** expiry-first ｜ **体检** ✅12 通过 · ⚠️1 提醒 ｜ **今日** 23 次调用 · 0.9 积分 · 42.5 tok/s

| # | 账号 | 状态 | 余额 | 最早到期 |
|---|------|------|------|----------|
| 1 | 周火火 | 🟢使用中 | 3177 | 10-07（4天） |
| 2 | 公瑾 | 可用 | 4660 | 11-30 |

**今日任务**：签到 ✓×2 ｜ 连登 🔗3天·下一档7d差4 ｜ 成长 +12 分 ｜ 猫猫 🐾旅行中
**最近请求**：02:27 glm-5.3-flash 62.4 tok/s（7.3s）· 02:25 …

⚠️ 如有异常（余额≤200 / 7天内到期且余量>500 / 401 / 体检 fail 项）在这行列出
```

## 第三步：操作菜单（面板固定结尾）

```
**操作**（回复编号执行）：
 1. 刷新积分明细          2. 立即签到+连登巡检       3. 成长任务扫描+领奖
 4. 猫猫旅行巡逻          5. 连登管家巡检            6. 切换调度策略
 7. 固定/解固定账号       8. 跑一轮模型巡检          9. 一键诊断（完整报告）
10. 打开控制台（/wbp-console）
```

数据是陈旧的、用户说「刷新」、或执行完任何操作后：重新采集并重渲染。

## 操作执行细则（对应编号）

1. **刷新积分**：调 `wb_refresh_credits`，汇报每个账号最新余额。
2. **立即签到**：调 `wb_tasks_run`（kind=checkin），汇报成功/已签/失败——kind=checkin 会自动搭车跑连登管家（补签/兑换/抽奖），一并汇报连登天数与档位变化。
3. **成长任务**：调 `wb_tasks_run`（kind=growth），汇报报名数、代打次数、领奖与积分。
4. **猫猫巡逻**：调 `wb_tasks_run`（kind=travel），汇报派出/领奖/进行中（到站领奖后会自动再次出发）。
5. **连登管家巡检**：调 `wb_tasks_run`（kind=streak），汇报连登天数、补签、兑换档位、抽奖结果。
6. **切换策略**：列出五策略（expiry-first/balance-first/round-robin/free-first/pinned）+ 一句说明，**等用户选择**后调 `wb_switch`，成功后汇报并重渲染。
7. **固定账号**：列出账号（含 #号），等用户选；`wb_switch`（policy=pinned, accountId=…）。当前已 pinned 时先问「解固定恢复自动调度？」。
8. **模型巡检**：Bash POST `/console/api/health/scan`（同 apiKey 头，需 10~30 秒），汇报可用数与前三名性价比。
9. **完整诊断**：Bash GET `/console/api/doctor`，把 checks 按级别分组渲染成表（✅/⚠️/❌），fail 项附操作建议。
10. **打开控制台**：按 /wbp-console 的方式输出控制台地址让用户点击。

## 约束

- 采集失败（代理没起）→ 输出一句「代理未运行，回复 0 启动」；用户回 0 时走 /wbp-start。
- 菜单动作里凡是「等用户选择」的（6/7），不要自作主张替用户挑。
- 所有改动类操作执行后必须汇报结果（成功条数/失败原因），再重渲染面板。

$ARGUMENTS
