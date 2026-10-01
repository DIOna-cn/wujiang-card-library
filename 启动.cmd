@echo off
rem ============================================================
rem  WuJiang Card Library - launcher
rem
rem  KEEP THIS FILE PURE ASCII.
rem  cmd.exe parses a .cmd file byte by byte using the system ANSI
rem  code page (GBK on this machine), and `chcp 65001` does NOT
rem  change how an already-loaded batch file is parsed.
rem  Any non-ASCII byte here gets turned into a bogus command,
rem  which aborts the script and makes the window flash and close.
rem  All Chinese text lives in start.ps1 (saved as UTF-8 with BOM).
rem
rem  (Filename itself is Chinese: ShuangJi.cmd = "start.cmd")
rem ============================================================
chcp 65001 >nul
title WuJiang Card Library - Server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto noNode

where pwsh >nul 2>nul
if errorlevel 1 goto useWindowsPowerShell

pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
goto done

:useWindowsPowerShell
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
goto done

:noNode
echo.
echo   Node.js was not found.
echo   Please install it first: https://nodejs.org/
echo.
pause
exit /b 1

:done
echo.
pause
