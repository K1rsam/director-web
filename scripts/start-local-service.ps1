param(
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$serviceUrl = "http://localhost:3000/"
$pidFile = Join-Path ([System.IO.Path]::GetTempPath()) "director-workbench-local-service.pid"
$workerScript = Join-Path $PSScriptRoot "run-local-service.ps1"

function Write-RunMessage([string]$message, [ConsoleColor]$color = [ConsoleColor]::Gray) {
  Write-Host $message -ForegroundColor $color
}

function Test-ServiceReady {
  try {
    $response = Invoke-WebRequest -Uri $serviceUrl -UseBasicParsing -TimeoutSec 2
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
  }
  catch {
    return $false
  }
}

try {
  $powershell = Get-Command powershell.exe -ErrorAction SilentlyContinue
  $commandShell = Get-Command cmd.exe -ErrorAction SilentlyContinue
  if (-not $powershell -or -not $commandShell) {
    throw "The Windows command shells required by the launcher were not found."
  }

  if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw "npm was not found. Install Node.js and run this launcher again."
  }

  if (-not (Test-Path -LiteralPath $workerScript)) {
    throw "The local service worker was not found: $workerScript"
  }

  $existing = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)
  if ($existing.Count -gt 0) {
    $owners = ($existing | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
    Write-RunMessage "Port 3000 is already in use (PID: $owners)." Yellow
    Write-RunMessage "The launcher will not start a duplicate service; this launcher can now close." Cyan
    if (-not $NoBrowser) { Start-Process $serviceUrl }
    exit 0
  }

  Set-Location $projectRoot
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue

  $startCommand = 'start "Director Workbench - Local Service" /d "{0}" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{1}"' -f $projectRoot, $workerScript
  $startResult = Start-Process `
    -FilePath $commandShell.Source `
    -ArgumentList @('/d', '/c', $startCommand) `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -PassThru

  if (-not $startResult) {
    throw "The local service launcher could not be created."
  }

  $ready = $false
  for ($attempt = 1; $attempt -le 20; $attempt += 1) {
    if (Test-ServiceReady) {
      $ready = $true
      break
    }

    Start-Sleep -Seconds 1
  }

  if (-not $ready) {
    throw "The local service window was started, but port 3000 did not become ready within 20 seconds."
  }

  if (-not $NoBrowser) { Start-Process $serviceUrl }
  Write-RunMessage "Local service started in its own window. This launcher can now close." Green
  Write-RunMessage "URL: $serviceUrl" Cyan
  Write-RunMessage "Stop with the stop launcher; closing the service window stops the service." Yellow
  exit 0
}
catch {
  Write-RunMessage "Startup failed: $($_.Exception.Message)" Red
  exit 1
}
