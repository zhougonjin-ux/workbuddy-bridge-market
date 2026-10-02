---
description: 自动导入本机已登录的 WorkBuddy/CodeBuddy 客户端账号（免扫码）
---

从本机已登录的 WorkBuddy / CodeBuddy 客户端提取登录态并加入账号池：

1. 调用 MCP 工具 `wb_import_local`（或用 Bash 请求 `POST http://127.0.0.1:8788/admin/local/import`，带 apiKey 的 Authorization 头；代理未启动先按 /wb-start 启动）。
2. 把结果整理给用户：新增/更新/跳过了哪些账号、各 token 有效期。
3. 导入成功后调用 `wb_refresh_credits` 拉一次积分与到期明细，再用 `wb_status` 展示完整账号列表。
4. 说明边界：本机导入的账号没有 refreshToken，token 到期后（客户端会自动续期）重新运行本命令即可；若该账号已用扫码登录过（有自动续期），不会被覆盖。
5. 若结果为空：说明本机没装客户端或客户端未登录，引导用户改用 /wb-login 扫码。

$ARGUMENTS
