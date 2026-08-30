$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path ([System.IO.Path]::GetTempPath()) "director-workbench-local-service.pid"

function Get-ChildProcessIds([int]$parentId) {
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $parentId" -ErrorAction SilentlyContinue)
  $ids = @()
  foreach ($child in $children) {
    $ids += [int]$child.ProcessId
    $ids += Get-ChildProcessIds -parentId ([int]$child.ProcessId)
  }
  return $ids
}

$rootIds = @()
if (Test-Path -LiteralPath $pidFile) {
  $rawPid = (Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
  $parsedPid = 0
  if ([int]::TryParse($rawPid, [ref]$parsedPid) -and $parsedPid -gt 0) {
    $rootIds += $parsedPid
  }
}

if ($rootIds.Count -eq 0) {
  Write-Host "No service process was recorded by the launcher." -ForegroundColor Yellow
  Write-Host "If the page is still open, press Ctrl+C in its service window." -ForegroundColor Gray
  exit 0
}

$allIds = @()
foreach ($rootId in ($rootIds | Select-Object -Unique)) {
  $allIds += Get-ChildProcessIds -parentId $rootId
  $allIds += $rootId
}

$stopped = @()
$uniqueIds = @($allIds | Select-Object -Unique)
for ($index = $uniqueIds.Count - 1; $index -ge 0; $index -= 1) {
  $processId = [int]$uniqueIds[$index]
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $process) { continue }

  Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  $stopped += "$($process.ProcessName) (PID $processId)"
}

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue

if ($stopped.Count -gt 0) {
  Write-Host "Local service stopped." -ForegroundColor Green
  Write-Host ($stopped -join ", ") -ForegroundColor DarkGray
} else {
  Write-Host "The service process had already ended." -ForegroundColor Yellow
}
