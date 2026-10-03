# Run explicitly for the initial interactive Chrome login/extension setup.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'start-image-browser.ps1')
$chromePath = Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'
if (-not (Test-Path -LiteralPath $chromePath)) { throw 'Chrome is not installed at the standard location.' }
$profilePath = Join-Path $PSScriptRoot 'runtime-3008\image-browser\chrome-profile'
New-Item -ItemType Directory -Path $profilePath -Force | Out-Null
Start-Process -FilePath $chromePath -ArgumentList @("--user-data-dir=`"$profilePath`"", '--no-first-run', '--no-default-browser-check', 'http://127.0.0.1:53179/setup', 'https://chatgpt.com/', 'chrome://extensions') -WindowStyle Normal
