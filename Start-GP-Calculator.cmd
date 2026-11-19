@echo off
setlocal
chcp 65001 >nul
node "%~dp0start.cjs" %*
if errorlevel 1 pause
