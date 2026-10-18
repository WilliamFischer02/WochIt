@echo off
rem WochIt host launcher.
rem
rem   Double-click this file, or run it from a terminal:  scripts\start-host.cmd
rem   It changes to the repo root, runs "pnpm host" in this window, and waits for a key when
rem   the host stops, so any error stays on screen. Stop the host with Ctrl+C.
rem
rem   /hidden   Used by the "WochIt Host" logon task (scripts\install-autostart.ps1).
rem             No pause; everything the host prints goes to %LOCALAPPDATA%\WochIt\host.log
rem             (overwritten at each start) because nobody can see the window.

setlocal EnableExtensions

if /i "%~1"=="/hidden" (
  if not exist "%LOCALAPPDATA%\WochIt" mkdir "%LOCALAPPDATA%\WochIt"
  call "%~f0" /logged > "%LOCALAPPDATA%\WochIt\host.log" 2>&1
  exit /b
)

set "NOPAUSE="
if /i "%~1"=="/logged" set "NOPAUSE=1"

cd /d "%~dp0.."
if errorlevel 1 (
  echo Could not change to the repo folder: %~dp0..
  goto :fail
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm was not found on PATH. Install pnpm, open a new window, and try again.
  goto :fail
)

if not exist "host\dist\index.js" (
  echo The host is not built yet. In %CD% run:  pnpm install  then  pnpm build
  echo Or run:  powershell -ExecutionPolicy Bypass -File scripts\start-host.ps1 -Build
  goto :fail
)

if not exist ".env" echo Note: there is no .env in %CD%. Copy .env.example to .env and fill it in. Starting with defaults.

title WochIt host
echo [%DATE% %TIME%] WochIt host starting in %CD%
if not defined NOPAUSE echo Stop it with Ctrl+C.
echo.

call pnpm host
set "CODE=%ERRORLEVEL%"

echo.
echo [%DATE% %TIME%] WochIt host stopped, exit code %CODE%.
if not defined NOPAUSE pause
exit /b %CODE%

:fail
echo.
echo WochIt host did not start.
if not defined NOPAUSE pause
exit /b 1
