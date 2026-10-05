param()
$ErrorActionPreference = 'Stop'
# The Windows builder is linked by https://ffmpeg.org/download.html.
# Pins must be reviewed together when upgrading; never accept a changed floating package.
$mediaVersion = '9.0.2'
$mediaArchiveSha256 = '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
$mediaArchiveUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
$mediaProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$mediaToolRoot = [IO.Path]::GetFullPath((Join-Path $mediaProjectRoot 'tools\ffprobe'))
$mediaExecutable = Join-Path $mediaToolRoot 'ffprobe.exe'
$mediaReceipt = Join-Path $mediaToolRoot 'download-receipt.json'
if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') { throw 'This setup installs the Windows x64 build; configure ffprobePath or PATH on macOS.' }
New-Item -ItemType Directory -Path $mediaToolRoot -Force | Out-Null
if (Test-Path -LiteralPath $mediaExecutable) {
    if (-not (Test-Path -LiteralPath $mediaReceipt)) { throw 'An unrecognized ffprobe already exists; it will not be overwritten.' }
    $mediaExisting = Get-Content -LiteralPath $mediaReceipt -Raw | ConvertFrom-Json
    $mediaCurrentHash = (Get-FileHash -LiteralPath $mediaExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($mediaExisting.archiveSha256 -ne $mediaArchiveSha256 -or $mediaExisting.executableSha256 -ne $mediaCurrentHash) { throw 'Existing ffprobe provenance differs from the pinned receipt; it will not be overwritten.' }
    Write-Output "Verified installed ffprobe $($mediaExisting.version)"
    exit 0
}
$mediaInstallRoot = [IO.Path]::GetFullPath((Join-Path $mediaToolRoot ('.install-' + [Guid]::NewGuid().ToString('N'))))
if (-not $mediaInstallRoot.StartsWith($mediaToolRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid installation target.' }
New-Item -ItemType Directory -Path $mediaInstallRoot | Out-Null
try {
    $mediaRemoteHashBody = (Invoke-WebRequest -Uri ($mediaArchiveUrl + '.sha256') -UseBasicParsing -TimeoutSec 30).Content
    if ($mediaRemoteHashBody -is [byte[]]) { $mediaRemoteHashBody = [Text.Encoding]::UTF8.GetString($mediaRemoteHashBody) }
    $mediaRemoteVersionBody = (Invoke-WebRequest -Uri ($mediaArchiveUrl + '.ver') -UseBasicParsing -TimeoutSec 30).Content
    if ($mediaRemoteVersionBody -is [byte[]]) { $mediaRemoteVersionBody = [Text.Encoding]::UTF8.GetString($mediaRemoteVersionBody) }
    if ($mediaRemoteHashBody.Trim().Split(' ')[0].ToLowerInvariant() -ne $mediaArchiveSha256 -or $mediaRemoteVersionBody.Trim() -ne $mediaVersion) { throw 'Upstream release changed. Review the version and checksum pins before upgrading.' }
    $mediaArchive = Join-Path $mediaInstallRoot 'release.zip'
    Invoke-WebRequest -Uri $mediaArchiveUrl -OutFile $mediaArchive -UseBasicParsing -TimeoutSec 600
    if ((Get-FileHash -LiteralPath $mediaArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $mediaArchiveSha256) { throw 'FFmpeg archive SHA256 verification failed.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $mediaZip = [IO.Compression.ZipFile]::OpenRead($mediaArchive)
    try {
        $mediaEntries = @($mediaZip.Entries | Where-Object { $_.FullName -match '/bin/ffprobe\.exe$' })
        if ($mediaEntries.Count -ne 1) { throw 'The verified package does not contain exactly one ffprobe binary.' }
        $mediaCandidate = Join-Path $mediaInstallRoot 'ffprobe.exe'
        [IO.Compression.ZipFileExtensions]::ExtractToFile($mediaEntries[0], $mediaCandidate, $false)
        foreach ($mediaLicense in @($mediaZip.Entries | Where-Object { $_.FullName -match '/(LICENSE|COPYING|README)(\.[^/]+)?$' })) {
            $mediaLicenseName = [IO.Path]::GetFileName($mediaLicense.FullName)
            $mediaLicenseTarget = Join-Path $mediaInstallRoot $mediaLicenseName
            if (-not (Test-Path -LiteralPath $mediaLicenseTarget)) { [IO.Compression.ZipFileExtensions]::ExtractToFile($mediaLicense, $mediaLicenseTarget, $false) }
        }
    } finally { $mediaZip.Dispose() }
    $mediaProcessInfo = [Diagnostics.ProcessStartInfo]::new()
    $mediaProcessInfo.FileName = $mediaCandidate
    $mediaProcessInfo.Arguments = '-version'
    $mediaProcessInfo.UseShellExecute = $false
    $mediaProcessInfo.CreateNoWindow = $true
    $mediaProcessInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $mediaProcessInfo.RedirectStandardOutput = $true
    $mediaProcessInfo.RedirectStandardError = $true
    $mediaProcess = [Diagnostics.Process]::Start($mediaProcessInfo)
    $mediaStdout = $mediaProcess.StandardOutput.ReadToEndAsync()
    $mediaStderr = $mediaProcess.StandardError.ReadToEndAsync()
    if (-not $mediaProcess.WaitForExit(60000)) { $mediaProcess.Kill(); $mediaProcess.WaitForExit(); throw 'ffprobe version verification timed out.' }
    $mediaVersionLine = $mediaStdout.Result.Split([char]10)[0].Trim()
    if ($mediaProcess.ExitCode -ne 0 -or -not $mediaVersionLine.StartsWith('ffprobe version ' + $mediaVersion + '-')) { throw 'Extracted executable version does not match the pinned release.' }
    $mediaProcess.Dispose()
    $mediaExecutableHash = (Get-FileHash -LiteralPath $mediaCandidate -Algorithm SHA256).Hash.ToLowerInvariant()
    $mediaProvenance = [ordered]@{
        installedAt = [DateTime]::UtcNow.ToString('o')
        platform = 'windows-x64'
        version = $mediaVersion
        versionLine = $mediaVersionLine
        officialRecommendation = 'https://ffmpeg.org/download.html'
        builder = 'https://www.gyan.dev/ffmpeg/builds/'
        archiveUrl = $mediaArchiveUrl
        archiveSha256 = $mediaArchiveSha256
        executableSha256 = $mediaExecutableHash
        sourceUrl = 'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz'
        checksumEvidence = 'Pinned archive SHA256 matches downloaded bytes and the builder HTTPS checksum sidecar; this is not a publisher signature.'
        license = 'GPL-3.0-or-later (Gyan static essentials build)'
    }
    Move-Item -LiteralPath $mediaCandidate -Destination $mediaExecutable
    foreach ($mediaNotice in @(Get-ChildItem -LiteralPath $mediaInstallRoot -File | Where-Object { $_.Name -match '^(LICENSE|COPYING|README)(\.|$)' })) {
        $mediaNoticeDestination = Join-Path $mediaToolRoot $mediaNotice.Name
        if (-not (Test-Path -LiteralPath $mediaNoticeDestination)) { Move-Item -LiteralPath $mediaNotice.FullName -Destination $mediaNoticeDestination }
    }
    $mediaProvenance | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $mediaReceipt -Encoding utf8
    Write-Output "Installed and verified $mediaVersionLine"
    Write-Output "ffprobe SHA256: $mediaExecutableHash"
} finally {
    # Only remove the verified, unique temporary directory within tools/ffprobe.
    $mediaCleanupTarget = [IO.Path]::GetFullPath($mediaInstallRoot)
    if ($mediaCleanupTarget.StartsWith($mediaToolRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($mediaCleanupTarget).StartsWith('.install-')) {
        Remove-Item -LiteralPath $mediaCleanupTarget -Recurse -Force -ErrorAction SilentlyContinue
    }
}
