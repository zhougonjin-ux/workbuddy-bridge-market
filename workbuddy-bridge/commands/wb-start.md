---
description: 启动 WorkBuddy 本地代理（ZCode 模型源）
---

帮用户启动 workbuddy-bridge 本地代理并确认可用。步骤：

1. 先探测代理是否已在运行：用 Bash 运行 `node -e "fetch('http://127.0.0.1:8788/health',{signal:AbortSignal.timeout(2000)}).then(r=>r.json()).then(j=>console.log('RUNNING',j.status)).catch(()=>console.log('DOWN'))"`。
2. 若输出 RUNNING：告知用户代理已在运行，并列出 health 返回的登录状态，结束。
3. 若输出 DOWN：后台启动代理——Bash 运行（Windows）：
   `cd /d "<插件目录>/server" && set WB_CONFIG_DIR=%USERPROFILE%\.zcode\workbuddy-bridge&& start /b node server.mjs`
   等待 2 秒后再次探测 /health 确认。
   `<插件目录>` 是本插件安装目录下的 `server` 文件夹。
4. 确认后告知用户：
   - OpenAI 兼容端点：`http://127.0.0.1:8788/v1`（Anthropic 兼容：`http://127.0.0.1:8788`）
   - API Key 在数据目录的 config.json（`%USERPROFILE%\.zcode\workbuddy-bridge\config.json`）里，字段 `apiKey`
   - 网页控制台：http://127.0.0.1:8788/console
   - 若还没有账号，提示运行 /wb-login 添加 WorkBuddy 账号
