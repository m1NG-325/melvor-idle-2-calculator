@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul

set "MELVOR_NODE="
for %%I in (node.exe) do set "MELVOR_NODE=%%~$PATH:I"
if not defined MELVOR_NODE (
  for %%I in ("%ProgramW6432%\nodejs\node.exe" "%ProgramFiles%\nodejs\node.exe" "%ProgramFiles(x86)%\nodejs\node.exe" "%LocalAppData%\Programs\nodejs\node.exe") do (
    if not defined MELVOR_NODE if exist "%%~I" set "MELVOR_NODE=%%~I"
  )
)
if not defined MELVOR_NODE (
  echo 找不到 Node.js。请选择下载渠道或退出。安装时请保留 Add to PATH 选项。
  echo [1] Node.js 官网 / Official download
  echo [2] 国内镜像 / China mirror
  echo [0] 暂不下载 / Exit
  "%SystemRoot%\System32\choice.exe" /c 120 /n /m "Choose / 请选择: "
  if not errorlevel 1 exit /b 1
  if errorlevel 4 exit /b 1
  if errorlevel 3 exit /b 0
  if errorlevel 2 (
    start "" "https://npmmirror.com/mirrors/node/"
  ) else (
    start "" "https://nodejs.org/en/download"
  )
  echo 请选择 Windows LTS 安装包，安装后重新打开工具。
  echo Choose the Windows LTS installer and reopen the calculator once installed.
  pause
  exit /b 1
)

"%MELVOR_NODE%" "%~dp0start.cjs" %*
set "MELVOR_EXIT=%ERRORLEVEL%"
if not "%MELVOR_EXIT%"=="0" pause
exit /b %MELVOR_EXIT%
