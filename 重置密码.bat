@echo off
rem ============================================================
rem  Reset Password Tool
rem  Keep this file ASCII-only: cmd.exe reads .bat with the system
rem  codepage, so UTF-8 Chinese here would break command parsing.
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"
title Reset Password

where node >nul 2>nul
if not errorlevel 1 goto usenode

echo.
echo  [ERROR] Node.js was not found on this PC.
echo          This tool needs Node.js: https://nodejs.org/
echo.
pause
exit /b 1

:usenode
node reset_password.js %*
exit /b 0
