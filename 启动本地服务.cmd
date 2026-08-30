@echo off
setlocal
cd /d "%~dp0"

title Director Workbench - Launcher

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local-service.ps1"
set "LAUNCHER_EXIT=%ERRORLEVEL%"

if not "%LAUNCHER_EXIT%"=="0" (
  echo.
  echo Local service startup failed.
  pause
)

exit /b %LAUNCHER_EXIT%
