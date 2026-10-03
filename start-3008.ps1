$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$nodePath = (Get-Command node -ErrorAction Stop).Source
$runtimePath = Join-Path $projectRoot 'runtime-3008'
$listener = Get-NetTCPConnection -State Listen -LocalPort 3008 -ErrorAction SilentlyContinue
if ($listener) {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener[0].OwningProcess)"
    if ($processInfo.CommandLine -notlike "*$projectRoot*") {
        throw '3008端口已被其他程序使用，请先检查。'
    }
    Write-Output '3008已经运行：http://127.0.0.1:3008/login'
    exit 0
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.next/BUILD_ID'))) {
    throw '请先在此目录完成 npm ci、数据库迁移和 npm run build。'
}
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
$nextPath = Join-Path $projectRoot 'node_modules/next/dist/bin/next'
$process = Start-Process -FilePath $nodePath -ArgumentList @("`"$nextPath`"", 'start', '--hostname', '127.0.0.1', '--port', '3008') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'production.stdout.log') -RedirectStandardError (Join-Path $runtimePath 'production.stderr.log') -PassThru
Write-Output "3008正在启动：http://127.0.0.1:3008/login（进程 $($process.Id)）"
