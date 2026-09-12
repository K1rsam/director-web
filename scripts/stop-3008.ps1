$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $projectRoot 'runtime-3008\service.json'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host 'No 3008 service record.'; exit 0 }
$record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
$process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if ($process) {
 $recordedStart = if ($record.started -is [datetime]) { $record.started.ToUniversalTime() } else { [datetime]::Parse($record.started, [cultureinfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() }
 if ($process.StartTime.ToUniversalTime().Ticks -ne $recordedStart.Ticks) { throw 'PID reused; refusing to stop unrelated process.' }
 $all = @(Get-CimInstance Win32_Process)
 function Stop-OwnedTree([int]$targetPid) { foreach ($child in $all | Where-Object ParentProcessId -eq $targetPid) { Stop-OwnedTree ([int]$child.ProcessId) }; Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue }
 Stop-OwnedTree ([int]$record.pid)
}
Remove-Item -LiteralPath $pidFile -Force
Write-Host '3008 stopped.'
