param(
    [switch]$PublishOnly,
    [string]$CandidatePath,
    [string]$ReleaseDirectory
)
$ErrorActionPreference = 'Stop'
function Get-ClientHash([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { return [System.BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '') }
    finally { $hasher.Dispose(); $stream.Dispose() }
}
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $ReleaseDirectory) { $ReleaseDirectory = Join-Path $projectRoot 'src-tauri\target\release' }
$releaseRoot = [System.IO.Path]::GetFullPath($ReleaseDirectory)
$currentPath = Join-Path $releaseRoot 'director-desktop.exe'
$previousPath = Join-Path $releaseRoot 'director-desktop-previous.exe'
$stagedPath = Join-Path $releaseRoot 'director-desktop.update.tmp'
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
try { $updateLease = [System.IO.File]::Open((Join-Path $releaseRoot '.client-update.lock'), [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None) }
catch { throw '此目录已有更新正在执行，请等待该次更新完成。' }
try {

if (-not $PublishOnly) {
    Push-Location $projectRoot
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw '界面构建失败，当前版与备用版未更改。' }
        $cargo = Get-Command cargo -ErrorAction SilentlyContinue
        $cargoPath = if ($cargo) { $cargo.Source } else { Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe' }
        & $cargoPath rustc --locked --manifest-path src-tauri/Cargo.toml --release --features desktop,custom-protocol --bin director-desktop -- -C extra-filename=-candidate
        if ($LASTEXITCODE -ne 0) { throw '客户端构建失败，当前版与备用版未更改。' }
        $CandidatePath = Join-Path $projectRoot 'src-tauri\target\release\deps\director_desktop-candidate.exe'
    } finally { Pop-Location }
}
if (-not $CandidatePath -or -not (Test-Path -LiteralPath $CandidatePath -PathType Leaf)) { throw '请提供已经验证的候选程序。' }
$candidate = (Resolve-Path -LiteralPath $CandidatePath).Path
if ($candidate -eq $currentPath -or $candidate -eq $previousPath -or $candidate -eq $stagedPath) { throw '候选程序必须独立于当前版和备用版。' }
$candidateHash = Get-ClientHash $candidate
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
if ((Test-Path -LiteralPath $currentPath) -and (Get-ClientHash $currentPath) -eq $candidateHash) {
    Write-Output '当前程序已是此版本，备用版保持不变。'
    return
}

# Refuse rotation when a retained executable is in use. Never terminate the user client.
$leases = @()
try {
    foreach ($path in @($currentPath, $previousPath)) {
        if (Test-Path -LiteralPath $path) {
            try { $leases += [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None) }
            catch { throw '当前版或备用版正在使用，请关闭后再更新；两份程序均未轮换。' }
        }
    }
} finally { foreach ($lease in $leases) { $lease.Dispose() } }

try {
    Copy-Item -LiteralPath $candidate -Destination $stagedPath -Force
    if ((Get-ClientHash $stagedPath) -ne $candidateHash) { throw '新程序复制校验失败。' }
    if (Test-Path -LiteralPath $currentPath) {
        # One atomic replacement: old current becomes the sole backup; older backup is replaced.
        [System.IO.File]::Replace($stagedPath, $currentPath, $previousPath)
    } else {
        [System.IO.File]::Move($stagedPath, $currentPath)
    }
    if ((Get-ClientHash $currentPath) -ne $candidateHash) { throw '发布后程序校验失败，请保留备用版。' }
    Write-Output '已更新 director-desktop.exe；上一轮保留为 director-desktop-previous.exe。'
} finally {
    if (Test-Path -LiteralPath $stagedPath) { Remove-Item -LiteralPath $stagedPath }
}
} finally { $updateLease.Dispose() }
