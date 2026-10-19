@echo off
rem Double-click to start the WochIt host (if it is not running), publish the tailnet link and
rem open the host console in its own window. Runs scripts\wochit-console.ps1; any arguments are
rem passed through (for example: wochit-console.cmd -NoOpen). The window stays open on an error
rem so the message can be read.
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0wochit-console.ps1" %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo wochit-console.ps1 exited with code %CODE%.
  pause
)
exit /b %CODE%
