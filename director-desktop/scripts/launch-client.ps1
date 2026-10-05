$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$clientPath = Join-Path $projectRoot 'src-tauri\target\release\director-desktop.exe'
if (-not (Test-Path -LiteralPath $clientPath -PathType Leaf)) {
    throw '尚无桌面构建，请在项目目录执行 npm run desktop:update。'
}
Start-Process -FilePath $clientPath -WorkingDirectory $projectRoot
