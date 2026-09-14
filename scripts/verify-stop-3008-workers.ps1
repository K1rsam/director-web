$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'stop-web-preserve-workers.ps1')
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('director stop fixture ' + [guid]::NewGuid().ToString('N'))
$resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
$projectRoot = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe).Source
New-Item -ItemType Directory -Path (Join-Path $fixtureRoot 'scripts') -Force | Out-Null
@'
const fs=require('fs'),cp=require('child_process'),path=require('path');
const dir=__dirname,log=path.join(dir,'processes.jsonl');
const record=(kind,pid)=>fs.appendFileSync(log,JSON.stringify({kind,pid})+'\n');
if(process.argv[2]==='root') {
 record('root',process.pid);
 const web=cp.spawn(process.execPath,[__filename,'web',String(process.pid)],{detached:true,stdio:'ignore',windowsHide:true});web.unref();
} else {
 record('web',process.pid);
 let late=false;
 const worker=(tag)=>{const child=cp.spawn(process.execPath,['--import','tsx',path.join(dir,'scripts/run-foundation-delivery.ts'),'fixture-project',tag,'fixture-token'],{detached:true,stdio:'ignore',windowsHide:true});record('spawn-'+tag,child.pid);child.unref();};
 worker('early');
 setInterval(()=>{try{process.kill(Number(process.argv[3]),0)}catch{if(!late){late=true;worker('late')}}},5);
}
setInterval(()=>{},1000);
'@ | Set-Content -LiteralPath (Join-Path $fixtureRoot 'web.cjs') -Encoding UTF8
@'
const fs=require('fs'),cp=require('child_process'),path=require('path');
const dir=path.dirname(__dirname),tag=process.argv[3];
const child=cp.spawn(process.execPath,[path.join(dir,'cli.cjs')],{detached:true,stdio:'ignore',windowsHide:true});child.unref();
fs.appendFileSync(path.join(dir,'processes.jsonl'),JSON.stringify({kind:'worker-'+tag,pid:process.pid,cliPid:child.pid})+'\n');
setInterval(()=>{},1000);
'@ | Set-Content -LiteralPath (Join-Path $fixtureRoot 'scripts\run-foundation-delivery.ts') -Encoding UTF8
'setInterval(()=>{},1000);' | Set-Content -LiteralPath (Join-Path $fixtureRoot 'cli.cjs') -Encoding UTF8
$service = $null
function Read-FixtureRecords { if (Test-Path -LiteralPath (Join-Path $fixtureRoot 'processes.jsonl')) { @(Get-Content -LiteralPath (Join-Path $fixtureRoot 'processes.jsonl') | ForEach-Object { $_ | ConvertFrom-Json }) } }
try {
    $scriptPath = Join-Path $fixtureRoot 'scripts\run-foundation-delivery.ts'
    $sample = @{ Name='node.exe'; CommandLine=('node.exe --import tsx "' + $scriptPath + '" project task token') }
    if (-not (Test-OwnedFoundationWorker $sample $fixtureRoot)) { throw 'Exact worker was not recognized.' }
    foreach ($bad in @($sample.CommandLine + ' extra', $sample.CommandLine.Replace('run-foundation-delivery.ts','run-foundation-delivery.ts.bak'), $sample.CommandLine.Replace('--import tsx','-e tsx'))) {
        if (Test-OwnedFoundationWorker @{ Name='node.exe'; CommandLine=$bad } $fixtureRoot) { throw 'Imprecise worker command was accepted.' }
    }
    if (Test-OwnedFoundationWorker $sample $projectRoot) { throw 'Other repository worker was accepted.' }
    $service = Start-Process -FilePath $node -ArgumentList @(('"' + (Join-Path $fixtureRoot 'web.cjs') + '"'),'root') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
    $deadline = [datetime]::UtcNow.AddSeconds(15)
    while (-not (@(Read-FixtureRecords | Where-Object kind -eq 'worker-early').Count)) {
        if ([datetime]::UtcNow -gt $deadline) { throw 'Early fixture worker did not initialize.' }
        Start-Sleep -Milliseconds 50
    }
    $rejected = $false
    try { Stop-WebTreePreservingFoundationWorkers $service.Id $service.StartTime.AddSeconds(-1) $fixtureRoot } catch { $rejected = $true }
    if (-not $rejected -or -not (Get-Process -Id $service.Id -ErrorAction SilentlyContinue)) { throw 'PID-reuse guard failed.' }
    Stop-WebTreePreservingFoundationWorkers $service.Id $service.StartTime $fixtureRoot
    $deadline = [datetime]::UtcNow.AddSeconds(15)
    while (-not (@(Read-FixtureRecords | Where-Object kind -eq 'worker-late').Count)) {
        if ([datetime]::UtcNow -gt $deadline) { throw 'Late fixture worker did not survive shutdown.' }
        Start-Sleep -Milliseconds 50
    }
    $records = @(Read-FixtureRecords)
    foreach ($entry in $records | Where-Object { $_.kind -in @('root','web') }) {
        if (Get-Process -Id $entry.pid -ErrorAction SilentlyContinue) { throw "Web process $($entry.pid) survived." }
    }
    foreach ($entry in $records | Where-Object { $_.kind -like 'worker-*' }) {
        if (-not (Get-Process -Id $entry.pid -ErrorAction SilentlyContinue) -or -not (Get-Process -Id $entry.cliPid -ErrorAction SilentlyContinue)) { throw "Worker/CLI subtree $($entry.kind) was stopped." }
    }
    Write-Host 'PASS exact worker matching; PID identity guard; web tree stopped; early and post-parent-exit workers plus CLI children survived; no AI/database/service restart.'
} finally {
    # Only processes bearing this unique, exact fixture directory are ours.
    $owned = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($fixtureRoot) })
    foreach ($entry in $owned) {
        $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($entry.ProcessId)"
        if ($current -and $current.CreationDate -eq $entry.CreationDate) { Stop-Process -Id $entry.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    if ([IO.Path]::GetDirectoryName($resolvedFixture).TrimEnd('\') -ine [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') -or -not [IO.Path]::GetFileName($resolvedFixture).StartsWith('director stop fixture ')) { throw 'Unsafe fixture cleanup path.' }
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}
