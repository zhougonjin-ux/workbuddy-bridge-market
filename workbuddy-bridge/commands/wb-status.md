---
description: 查询 WorkBuddy 各账号积分余额与到期时间、当前调度策略
---

展示 WorkBuddy 桥接的账号、积分与到期情况。

1. 调用 MCP 工具 `wb_status`（若 MCP 工具不可用，改为用 Bash 请求 `http://127.0.0.1:8788/admin/bridge`，请求头带 `Authorization: Bearer <数据目录 config.json 里的 apiKey>`；代理未启动则提示先运行 /wb-start）。
2. 把结果整理成一张表给用户：账号名 | 余额 | 最早到期时间 | 状态（可用/耗尽/禁用），并注明当前调度策略（expiry-first / balance-first / round-robin / pinned）。
3. 如果所有账号都显示「未知余额」，提示这是还没刷新过积分明细，询问是否调用 `wb_refresh_credits` 立即刷新。

$ARGUMENTS
