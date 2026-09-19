@echo off
rem ============================================================
rem  Lab Inventory Launcher
rem  NOTE: keep this file ASCII-only. cmd.exe reads .bat with the
rem  system codepage (GBK on Chinese Windows), so UTF-8 Chinese
rem  text here would be garbled and break command parsing.
rem  Chinese messages are printed by server.js / lab_inventory.py.
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"
title Lab Inventory

where node >nul 2>nul
if not errorlevel 1 goto usenode

where python >nul 2>nul
if not errorlevel 1 goto usepython

echo.
echo  [ERROR] Neither Node.js nor Python was found on this PC.
echo          Install either one, then double-click this file again:
echo.
echo            Node.js : https://nodejs.org/
echo            Python  : https://www.python.org/downloads/
echo                      (remember to tick "Add Python to PATH")
echo.
pause
exit /b 1

:usenode
node server.js --host 0.0.0.0 --open
echo.
echo  Server stopped.
pause
exit /b 0

:usepython
python lab_inventory.py --host 0.0.0.0 --open
echo.
echo  Server stopped.
pause
exit /b 0
