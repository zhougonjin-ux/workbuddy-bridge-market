---
description: 切换 WorkBuddy 调度策略或固定使用某个账号
---

切换 WorkBuddy 多账号的调度策略。

参数 `$ARGUMENTS` 可以是：策略名（`expiry-first` / `balance-first` / `round-robin` / `pinned`），或 `pinned:账号名`。

1. 先调用 `wb_status` 拿到账号列表（id、label、余额、到期时间）。
2. 解析参数：
   - 直接给了策略名 → 调用 `wb_switch`（policy=该策略；pinned 时还需要 accountId）
   - `pinned:xxx` → 在账号列表里按 label 或 id 模糊匹配 `xxx`，找到后调用 `wb_switch`（policy=pinned, accountId=匹配的 id）
   - 参数为空 → 列出当前策略与各账号（含 id），请用户选择，不要擅自切换
3. 切换成功后，用一句话总结新的排序规则，并展示切换后各账号的余额/到期情况。

$ARGUMENTS
