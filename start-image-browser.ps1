param([string]$BridgeHome = (Join-Path $env:LOCALAPPDATA 'Programs\Director-3008-ChatGPT-Bridge\671815e'))
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$nodePath = (Get-Command node -ErrorAction Stop).Source
$bridgeEntry = Join-Path $BridgeHome 'src\index.js'
if (-not (Test-Path -LiteralPath $bridgeEntry)) { throw '请先安装文档指定的 ChatGPT Bridge 固定版本。' }
$actualCommit = & git -C $BridgeHome rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $actualCommit -ne '671815e1939db9effb556ea7ef67673fc21e4121') { throw '桥接源码版本不匹配，未启动。' }
& $nodePath (Join-Path $projectRoot 'scripts\install-image-bridge-fix.mjs') $BridgeHome
if ($LASTEXITCODE -ne 0) { throw '桥接页面身份修复未通过，未启动。' }
& $nodePath (Join-Path $projectRoot 'scripts\install-image-download-fix.mjs') $BridgeHome
if ($LASTEXITCODE -ne 0) { throw '原图下载兼容校验未通过，未启动。' }
& $nodePath (Join-Path $projectRoot 'scripts\install-image-record-proof.mjs') $BridgeHome
if ($LASTEXITCODE -ne 0) { throw '原生图片记录校验未通过，未启动。' }
& $nodePath (Join-Path $projectRoot 'scripts\install-image-background-transfer-fix.mjs') $BridgeHome
if ($LASTEXITCODE -ne 0) { throw '后台图片传输与输入协议校验未通过，未启动。' }
$runtimePath = Join-Path $projectRoot 'runtime-3008\image-browser'
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
$bridgeEnv = Join-Path $runtimePath 'bridge.env'
$bridgeData = Join-Path $runtimePath 'bridge-data'
if (-not (Test-Path -LiteralPath $bridgeEnv)) {
    @("HOST=127.0.0.1", "PORT=53179", "PUBLIC_BASE_URL=http://127.0.0.1:53179", "DATA_DIR=$bridgeData", 'PAYLOAD_DEBUG=0', 'ATTACHMENT_TRANSPORT=url', 'ANSWER_TIMEOUT_MS=900000') | Set-Content -LiteralPath $bridgeEnv -Encoding utf8
}
$listener = Get-NetTCPConnection -State Listen -LocalPort 53179 -ErrorAction SilentlyContinue
if ($listener) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener[0].OwningProcess)"
    $saved = Get-Content -LiteralPath (Join-Path $runtimePath 'processes.json') -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
    if ($owner.CommandLine -notlike "*$bridgeEntry*" -or -not $saved -or $saved.bridgePid -ne $owner.ProcessId) { throw '53179端口不是本项目桥接服务，未启动。' }
    $bridgePid = $owner.ProcessId
} else {
    $previousEnvFile = $env:ENV_FILE
    $previousDataDir = $env:DATA_DIR
    try {
        $env:ENV_FILE = $bridgeEnv
        $env:DATA_DIR = $bridgeData
        $bridgeProcess = Start-Process -FilePath $nodePath -ArgumentList @("`"$bridgeEntry`"", '--server') -WorkingDirectory $BridgeHome -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'bridge.stdout.log') -RedirectStandardError (Join-Path $runtimePath 'bridge.stderr.log') -PassThru
        $bridgePid = $bridgeProcess.Id
    } finally {
        $env:ENV_FILE = $previousEnvFile
        $env:DATA_DIR = $previousDataDir
    }
}
$workerScript = Join-Path $projectRoot 'scripts\asset-image-browser-worker.ts'
$runningWorker = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*$workerScript*" }
if ($runningWorker) { $workerPid = $runningWorker[0].ProcessId } else {
    $tsxLoader = [System.Uri]::new((Join-Path $projectRoot 'node_modules\tsx\dist\loader.mjs')).AbsoluteUri
    $envPath = Join-Path $projectRoot '.env'
    $worker = Start-Process -FilePath $nodePath -ArgumentList @("--env-file=`"$envPath`"", '--import', "`"$tsxLoader`"", "`"$workerScript`"") -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'worker.stdout.log') -RedirectStandardError (Join-Path $runtimePath 'worker.stderr.log') -PassThru
    $workerPid = $worker.Id
}
@{ bridgePid=$bridgePid; workerPid=$workerPid; startedAt=(Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimePath 'processes.json') -Encoding utf8
Write-Output '后台桥接与执行器已启动。首次请在 Chrome 加载扩展并打开 http://127.0.0.1:53179/setup。项目未启用时不会发起生图。'
