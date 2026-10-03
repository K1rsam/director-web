param(
    [Parameter(Mandatory = $true)][string]$LockFile,
    [Parameter(Mandatory = $true)][int]$ParentPid
)
$ErrorActionPreference = 'Stop'
# Native handles, not an expiring marker file or a machine-wide mutex name.
# Share mode zero also denies deletion/renaming while the permanent inode is held.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DirectorRuntimeLeaseNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct FileInfo {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
        public System.Runtime.InteropServices.ComTypes.FILETIME Access;
        public System.Runtime.InteropServices.ComTypes.FILETIME Write;
        public uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFileW(string name, uint access, uint sharing,
        IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetFileInformationByHandle(IntPtr handle, out FileInfo info);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint GetFileType(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);
}
'@
$parentHandle = [IntPtr]::Zero
$lockHandle = [IntPtr]::Zero
$resultCode = 76
try {
    if ($ParentPid -le 0 -or -not [IO.Path]::IsPathRooted($LockFile)) { throw 'Invalid lock arguments' }
    $parentHandle = [DirectorRuntimeLeaseNative]::OpenProcess(0x00100000, $false, [uint32]$ParentPid)
    if ($parentHandle -eq [IntPtr]::Zero -or [DirectorRuntimeLeaseNative]::WaitForSingleObject($parentHandle, 0) -ne 258) { throw 'Parent is unavailable' }
    # OPEN_ALWAYS preserves existing bytes. OPEN_REPARSE_POINT lets us reject a
    # symlink/reparse point itself, rather than accidentally locking its target.
    $lockHandle = [DirectorRuntimeLeaseNative]::CreateFileW($LockFile, [uint32]3221225472, 0,
        [IntPtr]::Zero, 4, 0x00200080, [IntPtr]::Zero)
    if ($lockHandle -eq [IntPtr]::new(-1)) {
        $lastError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $lockHandle = [IntPtr]::Zero
        if ($lastError -eq 32 -or $lastError -eq 33) { $resultCode = 75 }
        throw 'Kernel lock unavailable'
    }
    $info = New-Object DirectorRuntimeLeaseNative+FileInfo
    if (-not [DirectorRuntimeLeaseNative]::GetFileInformationByHandle($lockHandle, [ref]$info) -or
        ($info.Attributes -band 0x410) -ne 0 -or $info.Links -ne 1 -or
        [DirectorRuntimeLeaseNative]::GetFileType($lockHandle) -ne 1) { throw 'Lock must be a regular non-reparse file' }
    $stdin = [Console]::OpenStandardInput()
    $buffer = New-Object byte[] 1
    $read = $stdin.ReadAsync($buffer, 0, 1)
    if ([DirectorRuntimeLeaseNative]::WaitForSingleObject($parentHandle, 0) -ne 258) { throw 'Parent exited before handshake' }
    [Console]::Out.Write("LOCKED`n")
    [Console]::Out.Flush()
    while (-not $read.IsCompleted) {
        $status = [DirectorRuntimeLeaseNative]::WaitForSingleObject($parentHandle, 50)
        if ($status -eq 0) { break }
        if ($status -ne 258) { throw 'Parent handle cannot be verified' }
    }
    $resultCode = 0
} catch {
    [Console]::Error.WriteLine('Native runtime lease unavailable')
} finally {
    if ($lockHandle -ne [IntPtr]::Zero) { [void][DirectorRuntimeLeaseNative]::CloseHandle($lockHandle) }
    if ($parentHandle -ne [IntPtr]::Zero) { [void][DirectorRuntimeLeaseNative]::CloseHandle($parentHandle) }
}
exit $resultCode
