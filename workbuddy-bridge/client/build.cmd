@echo off
rem 编译 WorkBuddy 积分桥桌面客户端三件套：用系统自带的 .NET Framework csc，零第三方依赖。
rem   WorkBuddyBridgeTray.exe  托盘客户端（双击即用：自动拉起服务 + 打开控制台 + 托盘常驻）
rem   WorkBuddyBridgeSetup.exe 安装向导（装到 %LOCALAPPDATA%\WorkBuddyBridge + 快捷方式 + 控制面板可卸载）
rem   uninstall.exe            卸载器（Setup 的 --uninstall 副本）
rem 语言版本锁定 C# 5（csc v4.0.30319 上限）：禁字符串插值 / ?. / out 内联声明。
setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" echo 未找到 .NET Framework 的 csc.exe（v4.0.30319）。 && exit /b 1
set REF=-r:System.dll -r:System.Drawing.dll -r:System.Windows.Forms.dll
"%CSC%" -nologo -target:winexe -out:"%~dp0WorkBuddyBridgeTray.exe" -codepage:65001 %REF% "%~dp0WorkBuddyBridgeTray.cs"
if errorlevel 1 goto fail
"%CSC%" -nologo -target:winexe -out:"%~dp0WorkBuddyBridgeSetup.exe" -codepage:65001 %REF% "%~dp0Setup.cs"
if errorlevel 1 goto fail
copy /y "%~dp0WorkBuddyBridgeSetup.exe" "%~dp0uninstall.exe" >nul
echo 编译完成：%~dp0（WorkBuddyBridgeTray.exe / WorkBuddyBridgeSetup.exe / uninstall.exe）
exit /b 0
:fail
echo 编译失败。
exit /b 1
