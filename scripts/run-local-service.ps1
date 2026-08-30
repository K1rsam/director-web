$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path ([System.IO.Path]::GetTempPath()) "director-workbench-local-service.pid"
$exitCode = 1

try {
  Set-Location $projectRoot
  Set-Content -LiteralPath $pidFile -Value ([string]$PID) -Encoding ascii
  try {
    $Host.UI.RawUI.WindowTitle = "Director Workbench - Local Service"
  }
  catch {
    # The service can still run when the host does not expose a window title.
  }

  Write-Host "========================================" -ForegroundColor DarkGray
  Write-Host "    Director Workbench - Local Service" -ForegroundColor Cyan
  Write-Host "========================================" -ForegroundColor DarkGray
  Write-Host "Project: $projectRoot" -ForegroundColor DarkGray
  Write-Host "Command: npm run dev" -ForegroundColor DarkGray
  Write-Host "URL: http://localhost:3000/" -ForegroundColor Cyan
  Write-Host "Stop with the stop launcher or Ctrl+C in this window." -ForegroundColor Yellow
  Write-Host ""

  $npm = Get-Command npm.cmd -ErrorAction Stop
  & $npm.Source run dev
  $exitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
}
catch {
  Write-Host "Local service failed: $($_.Exception.Message)" -ForegroundColor Red
  $exitCode = 1
}
finally {
  if (Test-Path -LiteralPath $pidFile) {
    $recordedPid = (Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ($recordedPid -eq [string]$PID) {
      Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    }
  }
}

exit $exitCode
