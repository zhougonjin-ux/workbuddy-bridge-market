---
description: 他人在 ZCode 里安装 WorkBuddy 积分桥插件（GitHub 市场源）的完整步骤
---

帮用户在你的 ZCode 客户端里安装 workbuddy-bridge 插件（来源：GitHub 市场仓库 `zhougonjin-ux/workbuddy-bridge-market`）。

## 安装步骤（引导用户在客户端 UI 操作，或由你代为执行 CLI）

**方式 A：客户端 UI（推荐给普通用户）**
1. 打开 ZCode → 左侧「插件市场」→ 添加（+）→ 选择「从 GitHub 添加 / Add from GitHub」
2. 填入仓库：`zhougonjin-ux/workbuddy-bridge-market`
3. 添加成功后，在「个人 / Personal」分组找到「WorkBuddy 积分桥」（workbuddy-bridge），点「安装 / Install」
4. 安装后确认插件处于启用状态（设置 → 插件）

**方式 B：命令行（已装 ZCode CLI 的环境）**

```bash
node "C:\Program Files\ZCode\resources\glm\zcode.cjs" plugins marketplace add zhougonjin-ux/workbuddy-bridge-market
node "C:\Program Files\ZCode\resources\glm\zcode.cjs" plugins install workbuddy-bridge@workbuddy-bridge-market
```

（Windows 路径不同则替换 zcode.cjs 路径；macOS/Linux 通常在应用包内 resources/glm/zcode.cjs）

## 安装后的初始化（重要，全部自动完成，用户只需了解）

- SessionStart 钩子会自动：启动本地代理（127.0.0.1:8788）+ 把 WorkBuddy 模型注册进 ZCode 模型选择器
- 首次需要登录 WorkBuddy/CodeBuddy 账号（三选一或多个）：
  - **导入本机账号**（最简单）：本机装过 CodeBuddy 客户端且已登录 → 命令 `/wb-import` 一键导入，免扫码
  - **微信扫码**：`/wb-login`（设备授权登录）
  - 都不做的话代理只缺账号，不影响安装本身
- 验证：模型选择器出现「WorkBuddy」分组（17 个模型，ID 带倍率如 `glm-5.3-flash (x0.06)`）→ 选一个发消息即消耗 WorkBuddy 积分

## 日常使用入口

- `/wbp` —— 会话内总览面板（积分/到期/任务/用量，免浏览器）
- `/wb-console` —— 图形管理台（点账号卡片固定使用、切策略、扫码、自动任务）
- `/wb-status` `/wb-switch` `/wb-startup` 等 —— 状态查询 / 切换账号 / 开机自启

## 风险提示（必须告知使用者）

通过非官方接口调用 WorkBuddy/CodeBuddy，违反其服务条款，有封号风险，请自行评估。积分归属本人账号，插件只做本地代理与调度，不上传任何数据（除上游官方 API 调用外）。

$ARGUMENTS
