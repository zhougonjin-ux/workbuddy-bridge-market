---
description: 编译并启动桌面托盘客户端（WorkBuddyBridge.exe）：双击即用的控制台，托盘常驻 + 服务自启
---

把 workbuddy-bridge 的**桌面托盘客户端**跑起来：托盘常驻、双击图标打开网页控制台、
启动时自动确保本地代理在运行（与「打开智能体就能直接启动服务」同一套保证）。

## 流程

1. **定位源码与产物**：插件目录下的 `client/WorkBuddyBridgeTray.cs`（源码）、
   `client/build.cmd`（构建脚本）、`client/WorkBuddyBridge.exe`（产物，随插件分发）。
2. **产物缺失或源码更新时编译**（用系统自带 .NET Framework csc，约 5 秒，零依赖）：
   Bash 运行（注意 Git Bash 下直接调 csc，**不要经 build.cmd 的续行符**）：
   ```bash
   CSC="C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe"
   [ -f "$CSC" ] || CSC="C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe"
   cd "<插件目录>/client" && "$CSC" -nologo -target:winexe -out:WorkBuddyBridge.exe -codepage:65001 \
     -r:System.dll -r:System.Drawing.dll -r:System.Windows.Forms.dll WorkBuddyBridgeTray.cs
   ```
   编译失败时排查语言版本（csc v4 上限 C# 5：禁字符串插值 / ?. / out 内联声明）。
3. **已在运行就直接告知**：`tasklist | grep -i WorkBuddyBridge` 有输出 = 托盘已常驻，
   双击任务栏托盘图标即可打开控制台，无需重复启动。
4. **启动**：Bash `cd "<插件目录>/client" && (./WorkBuddyBridge.exe &) `——它自己会：
   - 读 `~/.zcode/workbuddy-bridge/config.json` 拿端口与 apiKey；
   - 健康检查不过就用 PATH 里的 node 拉起 `../server/server.mjs`（最多等 15 秒）；
   - 打开默认浏览器进入网页控制台；托盘常驻（绿点=运行中，30 秒轮询）。
5. **可选：创建桌面快捷方式**（用户要求时）：
   ```powershell
   powershell -NoProfile -Command "$ws=New-Object -ComObject WScript.Shell; $lnk=$ws.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\WorkBuddy 积分桥.lnk'); $lnk.TargetPath='<插件目录>\client\WorkBuddyBridge.exe'; $lnk.WorkingDirectory='<插件目录>\client'; $lnk.Save()"
   ```
6. **汇报**：托盘已常驻（菜单：打开控制台/启动/停止/重启/退出），双击托盘图标 = 打开控制台；
   退出托盘会询问是否一并停止服务。三形态提醒：对话面板（/wbp）、桌面托盘（本命令）、
   网页控制台（/wbp-console），随用户喜好随时切换。

## 约束

- exe 以**自身位置**定位服务（`client\..\server\server.mjs`）——不要把 exe 单独复制到别处运行，
  除非连 `server/` 一起复制。
- 停止服务是危险动作（智能体会话断模型）：托盘菜单里做了二次确认，agent 不要代用户点。
- 单实例互斥：第二次启动 exe 只会再开一个控制台页，不会出两个托盘。

$ARGUMENTS
