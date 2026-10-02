---
description: 添加一个 WorkBuddy 账号（设备授权登录，多账号入池）
---

引导用户添加一个 WorkBuddy 账号到账号池。

1. 参数 `$ARGUMENTS` 可选：账号备注名（如「小号A」）或站点（`cn-cli` 国内版 / `intl-cli` / `intl-work`）。默认 `cn-cli`。
2. 调用 MCP 工具 `wb_login_start`（site 默认 cn-cli）拿到授权链接；MCP 不可用时用 Bash 请求 `POST http://127.0.0.1:8788/console/api/login/start`（body `{"site":"cn-cli"}`，带 apiKey 的 Authorization 头）。代理未启动则先运行 /wbp-start 的启动步骤。
3. 完成登录的三种方式，按方便程度排序推荐给用户：
   - **推荐**：管理台弹窗扫码 —— 告知用户打开管理台（可用 /wbp-console）点「＋添加账号 → 生成登录二维码」，手机微信直接扫电脑屏幕上的大二维码，无需复制任何链接；
   - 用客户端内置浏览器直接打开 `authUrl`（你用浏览器控制能力 `goto` 该链接），用户在同一屏幕上完成登录；
   - 兜底：把授权链接原样展示，让用户复制到浏览器打开。登录后无需关闭页面。
4. 用 `wb_login_poll`（或轮询 `GET /console/api/login/poll?site=cn-cli&state=<state>`）每 3 秒查询一次，最多等 5 分钟。
5. 成功后：调用 `wb_refresh_credits` 刷新新账号的积分与到期明细，然后展示当前所有账号（wb_status），说明该账号已按当前策略参与调度（默认：积分最早到期的先用）。
6. 提醒：想再加别的账号，重复运行 /wbp-login 即可；同一账号重复登录只会更新不会重复。

$ARGUMENTS
