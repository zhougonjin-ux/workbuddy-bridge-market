---
description: 在客户端内置浏览器里打开 WorkBuddy 可视化管理台
---

在 **ZCode 客户端的内置浏览器**里打开 workbuddy-bridge 管理台（http://127.0.0.1:8788/console）：

1. 先探测代理是否在运行：Bash 运行 `node -e "fetch('http://127.0.0.1:8788/health',{signal:AbortSignal.timeout(2000)}).then(r=>r.json()).then(j=>console.log('UP',j.status)).catch(()=>console.log('DOWN'))"`。
   若 DOWN：按 /wbp-start 的流程先把代理启动起来。
2. 使用你的**浏览器控制能力**（browser-use / control-browser 技能）打开界面：
   - 初始化浏览器运行时，选 `getForUrl("http://127.0.0.1:8788/console")`
   - 新建标签页 `goto` 该地址，`waitForLoadState domcontentloaded` 后等 1~2 秒渲染
   - 截一张图确认页面正常，然后把标签页 `markDeliverable()` 留给用户
3. 降级：若当前环境没有浏览器控制能力，用 Bash `start http://127.0.0.1:8788/console` 在系统默认浏览器打开，并告知用户原因。
4. 告知用户五个面板：账号与积分（调度策略/账号卡片/积分批次到期倒计时/微信扫码/导入本机账号）、模型（倍率/上下文/多模态能力表）、自动任务、用量、日志。

$ARGUMENTS
