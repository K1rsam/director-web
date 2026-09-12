param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $projectRoot 'runtime-3008'
New-Item -ItemType Directory -Force $runtime | Out-Null
if (@(Get-NetTCPConnection -LocalPort 3008 -State Listen -ErrorAction SilentlyContinue).Count) { throw 'Port 3008 already occupied. Use stop-3008.ps1 before restart.' }
$env:DATABASE_URL = 'file:' + ($projectRoot.Replace('\','/')) + '/prisma/dev.db'
$env:DIRECTOR_SESSION_COOKIE_NAME = 'director_session_3008'
$env:DIRECTOR_STAGE1_ONLY = '1'
$env:TEMP = Join-Path $runtime 'temp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
$node = (Get-Command node.exe -ErrorAction Stop).Source
$entry = Join-Path $projectRoot 'scripts\launch-3008.cjs'
$process = Start-Process -FilePath $node -ArgumentList @(('"' + $entry + '"')) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'stdout.log') -RedirectStandardError (Join-Path $runtime 'stderr.log') -PassThru
@{ pid=$process.Id; started=$process.StartTime.ToUniversalTime().ToString('o'); root=$projectRoot } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'service.json')
Write-Host '3008 starting: http://127.0.0.1:3008/login ; logs: runtime-3008'
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:3008/login' }
