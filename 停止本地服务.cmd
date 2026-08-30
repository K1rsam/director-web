@echo off
setlocal
cd /d "%~dp0"

title Director Workbench - Stop Local Service
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-local-service.ps1"

echo.
pause
