@echo off
rem ============================================================
rem  Sync Tool: local data  <->  Cloudflare cloud data
rem  Keep this file ASCII-only: cmd.exe reads .bat with the system
rem  codepage, so UTF-8 Chinese here would break command parsing.
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"
title Sync Data

where node >nul 2>nul
if not errorlevel 1 goto usenode

echo.
echo  [ERROR] Node.js was not found on this PC.
echo          This tool needs Node.js: https://nodejs.org/
echo.
pause
exit /b 1

:usenode
node sync_data.js
echo.
pause
exit /b 0
