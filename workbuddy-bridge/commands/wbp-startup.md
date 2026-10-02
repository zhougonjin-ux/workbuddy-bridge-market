---
description: 管理代理的开机自启（登录时自动运行，签到任务不再漏）
---

管理 WorkBuddy 代理的开机自启（Windows 计划任务，当前用户登录时触发，无需管理员权限）。
装了自启后：即使当天没打开 ZCode，代理也在运行，自动签到/成长任务不会漏；ZCode 的会话
钩子检测到代理已存活就不会重复拉起，互不冲突。

参数 `$ARGUMENTS`：`install`（默认）/ `remove` / `status`。

**第一步：定位代理入口**（安装市场后插件路径会变，必须动态取）：

```bash
node -e "console.log(process.env.CLAUDE_PLUGIN_ROOT||'')"
```

- 有值 → 入口 = `<该目录>/server/server.mjs`
- 为空 → 在 `C:\Users\87352\.zcode\cli\plugins\cache` 下递归找 `workbuddy-bridge\server\server.mjs`（用 `dir /s /b`），找到最近修改的那个
- 都找不到 → 告知用户无法定位，请先安装插件

**install：**
1. 用 `process.execPath` 拿 node.exe 完整路径，构造命令（路径都有空格，必须整体加引号）：

```
schtasks /create /tn "WorkBuddyBridge" /tr "\"<node.exe 完整路径>\" \"<server.mjs 完整路径>\"" /sc onlogon /f
```

2. 立即验证：`schtasks /query /tn "WorkBuddyBridge"`，成功后告知用户：
   - 下次开机登录后代理自动运行（可用 `schtasks /run /tn "WorkBuddyBridge"` 立即试跑）
   - 数据目录不变（~\.zcode\workbuddy-bridge），账号/配置不受影响

**remove：**
```
schtasks /delete /tn "WorkBuddyBridge" /f
```
并确认删除成功。

**status：**
```
schtasks /query /tn "WorkBuddyBridge" /v /fo list
```
展示是否存在、上次/下次运行时间；同时探测 `http://127.0.0.1:8788/health` 告知当前代理是否在跑。

$ARGUMENTS
