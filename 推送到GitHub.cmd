@echo off
rem ============================================================
rem  Sync the card library to GitHub and push.
rem
rem  KEEP THIS FILE PURE ASCII.
rem  cmd.exe parses .cmd files with the system ANSI code page,
rem  so non-ASCII bytes here get turned into bogus commands and
rem  the window just flashes and closes.
rem  All Chinese text lives in publish\sync-repo.mjs / push.ps1.
rem
rem  (Filename itself is Chinese: TuiSongDaoGitHub.cmd)
rem ============================================================
chcp 65001 >nul
title WuJiang Card Library - Push to GitHub
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto noNode

where pwsh >nul 2>nul
if errorlevel 1 goto useWindowsPowerShell

pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish\push.ps1" %*
goto done

:useWindowsPowerShell
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish\push.ps1" %*
goto done

:noNode
echo.
echo   Node.js was not found. Please install it first:
echo   https://nodejs.org/
echo.
pause
exit /b 1

:done
echo.
pause
