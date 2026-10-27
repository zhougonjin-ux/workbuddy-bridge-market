@echo off
rem Build the three desktop binaries with the built-in .NET Framework csc (no third-party deps).
rem   WorkBuddyBridgeTray.exe   tray client: auto-start proxy, open console, stay resident
rem   WorkBuddyBridgeSetup.exe  installer: %LOCALAPPDATA%\WorkBuddyBridge + shortcuts + uninstall entry
rem   uninstall.exe             uninstaller (Setup.exe --uninstall)
rem
rem C# language level is locked to C# 5 (csc v4.0.30319): no string interpolation, no ?.,
rem no inline out declarations. Keep this file ASCII-only: cmd.exe decodes .cmd files with the
rem system ANSI code page, so UTF-8 Chinese comments here get parsed as garbage commands.
rem
rem Version comes from server/package.json (single source of truth) and is written to version.txt,
rem which Setup.cs reads at runtime. Do not hard-code a version here.
setlocal
set "WB_PKG=%~dp0..\server\package.json"
set "VER="
for /f "delims=" %%v in ('node -p "require(process.env.WB_PKG).version"') do set "VER=%%v"
if not defined VER set "VER=0.0.0"
> "%~dp0version.txt" echo %VER%
echo Version: %VER%

set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" echo Cannot find .NET Framework csc.exe (v4.0.30319). & exit /b 1
set REF=-r:System.dll -r:System.Drawing.dll -r:System.Windows.Forms.dll
"%CSC%" -nologo -target:winexe -out:"%~dp0WorkBuddyBridgeTray.exe" -codepage:65001 %REF% "%~dp0WorkBuddyBridgeTray.cs"
if errorlevel 1 goto fail
"%CSC%" -nologo -target:winexe -out:"%~dp0WorkBuddyBridgeSetup.exe" -codepage:65001 %REF% "%~dp0Setup.cs"
if errorlevel 1 goto fail
copy /y "%~dp0WorkBuddyBridgeSetup.exe" "%~dp0uninstall.exe" >nul
echo Build complete: %~dp0
exit /b 0
:fail
echo Build failed.
exit /b 1