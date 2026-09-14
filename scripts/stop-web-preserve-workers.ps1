# Web-service shutdown only. Explicit task cancellation has its own process tool.
function Test-OwnedFoundationWorker($Entry, [string]$ProjectRoot) {
    if ($Entry.Name -ine 'node.exe' -or -not $Entry.CommandLine) { return $false }
    $tokens = @([regex]::Matches($Entry.CommandLine, '"([^"]*)"|([^\s"]+)') | ForEach-Object {
        if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value }
    })
    if ($tokens.Count -ne 7 -or $tokens[1] -cne '--import' -or $tokens[2] -cne 'tsx') { return $false }
    $expected = [IO.Path]::GetFullPath((Join-Path $ProjectRoot 'scripts\run-foundation-delivery.ts'))
    if (-not [IO.Path]::IsPathRooted($tokens[3])) { return $false }
    try { $actual = [IO.Path]::GetFullPath($tokens[3]) } catch { return $false }
    return $actual -ieq $expected -and $tokens[4] -match '^\S+$' -and $tokens[5] -match '^\S+$' -and $tokens[6] -match '^\S+$'
}

function Stop-WebTreePreservingFoundationWorkers([int]$RootPid, [datetime]$Started, [string]$ProjectRoot) {
    $rootProcess = Get-Process -Id $RootPid -ErrorAction SilentlyContinue
    if (-not $rootProcess) { return }
    $null = $rootProcess.Handle
    if ($rootProcess.StartTime.ToUniversalTime().Ticks -ne $Started.ToUniversalTime().Ticks) { throw 'PID reused; refusing to stop unrelated process.' }
    $rootEntry = Get-CimInstance Win32_Process -Filter "ProcessId = $RootPid"
    if (-not $rootEntry) { return }
    if ([math]::Abs(($rootProcess.StartTime.ToUniversalTime() - $rootEntry.CreationDate.ToUniversalTime()).Ticks) -ge 10) { throw 'Root PID identity changed; refusing shutdown.' }
    $seen = @{}
    function Stop-WebBranch($Entry) {
        $target = [int]$Entry.ProcessId
        $identity = "$target/$($Entry.CreationDate.ToUniversalTime().Ticks)"
        if ($seen.ContainsKey($identity)) { return }
        $seen[$identity] = $true
        # Evaluate every newly observed child, not just a pre-stop global snapshot.
        if (Test-OwnedFoundationWorker $Entry $ProjectRoot) { return }
        $current = Get-CimInstance Win32_Process -Filter "ProcessId = $target"
        if (-not $current -or $current.CreationDate -ne $Entry.CreationDate) { return }
        if (-not $current.CommandLine) { throw "Cannot verify process $target; leaving its subtree running." }
        if (Test-OwnedFoundationWorker $current $ProjectRoot) { return }
        $handle = Get-Process -Id $target -ErrorAction SilentlyContinue
        if (-not $handle) { return }
        $null = $handle.Handle
        # Get-Process opens a handle; compare its creation time with the CIM
        # identity (CIM precision is microseconds) before killing through it.
        if ([math]::Abs(($handle.StartTime.ToUniversalTime() - $current.CreationDate.ToUniversalTime()).Ticks) -ge 10) { throw "Process $target identity changed; refusing shutdown." }
        $before = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $target")
        if (-not $handle.HasExited) { $handle.Kill(); if (-not $handle.WaitForExit(10000)) { throw "Process $target did not stop." } }
        $parentExited = $handle.ExitTime.ToUniversalTime()
        # Parent is now unable to spawn: this second observation closes the
        # gap in which a detached worker could appear during service shutdown.
        $after = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $target")
        foreach ($child in @($before) + @($after)) {
            if ($child.CreationDate -ge $Entry.CreationDate -and $child.CreationDate.ToUniversalTime() -le $parentExited) { Stop-WebBranch $child }
        }
    }
    Stop-WebBranch $rootEntry
}
