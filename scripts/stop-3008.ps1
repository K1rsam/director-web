$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'stop-web-preserve-workers.ps1')
$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $projectRoot 'runtime-3008\service.json'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host 'No 3008 service record.'; exit 0 }
$record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
$process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if ($process) {
 $recordedStart = if ($record.started -is [datetime]) { $record.started.ToUniversalTime() } else { [datetime]::Parse($record.started, [cultureinfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() }
 Stop-WebTreePreservingFoundationWorkers -RootPid ([int]$record.pid) -Started $recordedStart -ProjectRoot $projectRoot
}
Remove-Item -LiteralPath $pidFile -Force
Write-Host '3008 web service stopped; foundation workers and their children were preserved.'
