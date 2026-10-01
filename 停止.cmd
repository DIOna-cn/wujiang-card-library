@echo off
rem ============================================================
rem  WuJiang Card Library - stop server
rem
rem  KEEP THIS FILE PURE ASCII (same reason as the launcher .cmd:
rem  cmd.exe parses batch files with the system ANSI code page,
rem  so non-ASCII bytes here break the script).
rem
rem  (Filename itself is Chinese: TingZhi.cmd = "stop.cmd")
rem ============================================================
chcp 65001 >nul
title Stop WuJiang Card Library
cd /d "%~dp0"

where pwsh >nul 2>nul
if errorlevel 1 goto useWindowsPowerShell

pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1" %*
goto done

:useWindowsPowerShell
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1" %*
goto done

:done
echo.
pause
