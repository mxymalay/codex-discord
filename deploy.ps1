[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$SourceRoot,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$LiveRoot,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$DesktopPath,
    [switch]$SkipLiveActions,
    [ValidateSet('none','after-third-commit','before-live-actions')]
    [string]$FailureInjectionStep = 'none',
    [Parameter(DontShow)][switch]$InjectCleanupFailure,
    [Parameter(DontShow)][hashtable]$TestHooks,
    [Parameter(DontShow)][ValidateRange(500,120000)][int]$RegistrationDeadlineMilliseconds = 30000,
    [Parameter(DontShow)][ValidateRange(1024,1048576)][int]$RegistrationOutputLimitBytes = 65536
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# This is the complete source/runtime bundle. Runtime state and secrets are deliberately absent.
$script:DeployFileAllowlist = @(
    'discord-bridge.mjs',
    'discord-bridge-lib.mjs',
    'discord-runtime-lib.mjs',
    'discord-paths-lib.mjs',
    'discord-commands-lib.mjs',
    'discord-interactions.mjs',
    'discord-gateway-lib.mjs',
    'discord-health-lib.mjs',
    'discord-task-create-lib.mjs',
    'discord-task-index-lib.mjs',
    'deploy-live-probe.ps1',
    'rollout-completion-watcher-lib.mjs',
    'codex-takeover-lib.mjs',
    'discord-control-client.mjs',
    'dispatcher.ps1',
    'discord-config.ps1',
    'discord-secret.ps1',
    'discord-notification-control.ps1',
    'discord-migration.ps1',
    'export-discord-migration.ps1',
    'import-discord-migration.ps1',
    'discord-state.ps1',
    'discord-http.ps1',
    'task-delivery-state.ps1',
    'get-discord-token.ps1',
    'protect-discord-pending-reply.ps1',
    'unprotect-discord-pending-reply.ps1',
    'save-discord-token.ps1',
    'activate-discord-bot.ps1',
    'setup.ps1',
    'repair-notify.ps1',
    'watch-notify.ps1',
    'codex-control-lib.ps1',
    'codex-control.ps1',
    'discord-bridge-startup.ps1',
    'start-discord-bridge.ps1',
    'install-discord-bridge-task.ps1',
    'build-control-app.ps1',
    'install-control-app.ps1',
    'control-app\CodexDiscordControl.cs',
    'assets\codex-discord-control.png',
    'assets\codex-discord-control.ico'
)
$script:GeneratedDeployFiles = @('CodexDiscordControl.exe')
$script:ForbiddenDeployNames = @(
    'config.json', 'discord-token.dpapi', 'discord-inbox-state.json',
    'discord-message-map.json', 'discord-task-index.json', 'discord-gateway-state.json',
    'quota-state.json', 'rollout-watcher-state.json', 'task-delivery-state.json',
    'discord-bridge-runtime.json', 'discord-bridge-health.json',
    'discord-bridge.log', 'mobile-notify.log', 'notify-guard.log'
)

if (-not ('CodexDeployBoundedProcess' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

public sealed class CodexDeployBoundedProcessResult
{
    public bool Success { get; set; }
    public bool TimedOut { get; set; }
    public bool OutputLimitExceeded { get; set; }
    public int ExitCode { get; set; }
}

public static class CodexDeployBoundedProcess
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public IntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private sealed class DrainState
    {
        public long Count;
        public int LimitExceeded;
        public int Failed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static async Task DrainAsync(Stream stream, int limit, DrainState state)
    {
        byte[] buffer = new byte[4096];
        try
        {
            while (true)
            {
                int count = await stream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
                if (count == 0) break;
                long total = Interlocked.Add(ref state.Count, count);
                if (total > limit) Volatile.Write(ref state.LimitExceeded, 1);
            }
        }
        catch { Volatile.Write(ref state.Failed, 1); }
    }

    private static int RemainingMilliseconds(Stopwatch clock, int deadline)
    {
        long remaining = deadline - clock.ElapsedMilliseconds;
        return remaining <= 0 ? 0 : (int)Math.Min(Int32.MaxValue, remaining);
    }

    private static void TerminateTree(IntPtr job, Process process)
    {
        try { if (job != IntPtr.Zero) TerminateJobObject(job, 197); } catch { }
        try { if (!process.HasExited) process.Kill(true); } catch { }
    }

    public static CodexDeployBoundedProcessResult Run(
        string executable, string script, int deadlineMilliseconds, int outputLimitBytes)
    {
        Stopwatch clock = Stopwatch.StartNew();
        IntPtr job = IntPtr.Zero;
        Process process = null;
        Task stdoutTask = null;
        Task stderrTask = null;
        DrainState stdoutState = new DrainState();
        DrainState stderrState = new DrainState();
        bool timedOut = false;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new InvalidOperationException("job unavailable");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                throw new InvalidOperationException("job limits unavailable");

            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = Path.GetFullPath(executable);
            start.ArgumentList.Add(Path.GetFullPath(script));
            start.ArgumentList.Add("--register-commands");
            start.ArgumentList.Add("--once");
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            process = new Process { StartInfo = start };
            if (!process.Start()) throw new InvalidOperationException("process did not start");
            if (!AssignProcessToJobObject(job, process.Handle))
            {
                TerminateTree(job, process);
                throw new InvalidOperationException("job assignment failed");
            }

            stdoutTask = DrainAsync(process.StandardOutput.BaseStream, outputLimitBytes, stdoutState);
            stderrTask = DrainAsync(process.StandardError.BaseStream, outputLimitBytes, stderrState);
            int cleanupReserve = Math.Min(1000, Math.Max(100, deadlineMilliseconds / 4));
            long runDeadline = deadlineMilliseconds - cleanupReserve;
            while (!process.HasExited &&
                   Volatile.Read(ref stdoutState.LimitExceeded) == 0 &&
                   Volatile.Read(ref stderrState.LimitExceeded) == 0 &&
                   clock.ElapsedMilliseconds < runDeadline)
                Thread.Sleep(10);

            bool limitExceeded = Volatile.Read(ref stdoutState.LimitExceeded) != 0 ||
                Volatile.Read(ref stderrState.LimitExceeded) != 0;
            if (!process.HasExited)
            {
                timedOut = !limitExceeded;
                TerminateTree(job, process);
            }
            int remaining = RemainingMilliseconds(clock, deadlineMilliseconds);
            if (!process.HasExited && remaining > 0) process.WaitForExit(remaining);
            if (!process.HasExited) TerminateTree(job, process);

            remaining = RemainingMilliseconds(clock, deadlineMilliseconds);
            Task[] readers = new Task[] { stdoutTask, stderrTask };
            bool drained = remaining > 0 && Task.WaitAll(readers, remaining);
            if (!drained)
            {
                try { process.StandardOutput.Close(); } catch { }
                try { process.StandardError.Close(); } catch { }
                foreach (Task reader in readers)
                    if (reader != null) reader.ContinueWith(t => { var ignored = t.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
            }
            limitExceeded = limitExceeded || Volatile.Read(ref stdoutState.LimitExceeded) != 0 ||
                Volatile.Read(ref stderrState.LimitExceeded) != 0;
            bool readerFailed = Volatile.Read(ref stdoutState.Failed) != 0 ||
                Volatile.Read(ref stderrState.Failed) != 0 || !drained;
            int exitCode = process.HasExited ? process.ExitCode : -1;
            return new CodexDeployBoundedProcessResult {
                Success = !timedOut && !limitExceeded && !readerFailed && exitCode == 0,
                TimedOut = timedOut,
                OutputLimitExceeded = limitExceeded,
                ExitCode = exitCode
            };
        }
        finally
        {
            try { if (process != null && !process.HasExited) TerminateTree(job, process); } catch { }
            if (job != IntPtr.Zero) CloseHandle(job);
            if (process != null) process.Dispose();
        }
    }
}
'@
}

if (-not ('CodexDeployPhysicalDirectory' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public sealed class CodexDeployPhysicalDirectoryResult
{
    public string FinalPath { get; set; }
    public ulong VolumeSerialNumber { get; set; }
    public string FileId { get; set; }
}

public static class CodexDeployPhysicalDirectory
{
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_NAME_NORMALIZED = 0x0;
    private const uint VOLUME_NAME_NT = 0x2;
    private const int FileIdInfo = 18;

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_ID_INFO
    {
        public ulong VolumeSerialNumber;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
        public byte[] FileId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName, uint desiredAccess, FileShare shareMode, IntPtr securityAttributes,
        uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(
        SafeFileHandle handle, StringBuilder path, uint capacity, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle handle, int infoClass, out FILE_ID_INFO info, uint size);

    public static CodexDeployPhysicalDirectoryResult Inspect(string path)
    {
        using (SafeFileHandle handle = CreateFileW(
            path, 0, FileShare.Read | FileShare.Write | FileShare.Delete, IntPtr.Zero,
            OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero))
        {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());

            uint capacity = 512;
            string finalPath;
            while (true)
            {
                StringBuilder buffer = new StringBuilder((int)capacity);
                uint length = GetFinalPathNameByHandleW(
                    handle, buffer, capacity, FILE_NAME_NORMALIZED | VOLUME_NAME_NT);
                if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (length < capacity) { finalPath = buffer.ToString(); break; }
                capacity = checked(length + 1);
            }

            FILE_ID_INFO info;
            uint infoSize = checked((uint)Marshal.SizeOf(typeof(FILE_ID_INFO)));
            if (!GetFileInformationByHandleEx(handle, FileIdInfo, out info, infoSize))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (info.FileId == null || info.FileId.Length != 16)
                throw new InvalidOperationException("Directory identity is unavailable");

            return new CodexDeployPhysicalDirectoryResult {
                FinalPath = finalPath,
                VolumeSerialNumber = info.VolumeSerialNumber,
                FileId = BitConverter.ToString(info.FileId).Replace("-", "")
            };
        }
    }
}
'@
}

function Resolve-DeployDirectory {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)

    try { $fullPath = [System.IO.Path]::GetFullPath($Path) }
    catch { throw "$Label is invalid" }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) { throw "$Label is not an existing directory" }
    $cursor = $fullPath
    while ($true) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label cannot traverse a reparse point" }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent.Equals($cursor, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = $parent
    }
    try { $physical = [CodexDeployPhysicalDirectory]::Inspect($fullPath) }
    catch { throw "$Label physical identity is unavailable" }
    if ([string]::IsNullOrWhiteSpace($physical.FinalPath) -or [string]::IsNullOrWhiteSpace($physical.FileId)) {
        throw "$Label physical identity is unavailable"
    }
    return [pscustomobject][ordered]@{
        Label = $Label
        CanonicalPath = $fullPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
        PhysicalPath = $physical.FinalPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
        VolumeSerialNumber = [uint64]$physical.VolumeSerialNumber
        FileId = $physical.FileId
    }
}

function Test-DeployDirectoryIdentityEqual {
    param([Parameter(Mandatory)]$First, [Parameter(Mandatory)]$Second)
    return ($First.VolumeSerialNumber -eq $Second.VolumeSerialNumber -and $First.FileId.Equals($Second.FileId, [System.StringComparison]::OrdinalIgnoreCase))
}

function Assert-DeployDirectoryIdentity {
    param([Parameter(Mandatory)]$Expected)
    $actual = Resolve-DeployDirectory -Path $Expected.CanonicalPath -Label $Expected.Label
    if (-not (Test-DeployDirectoryIdentityEqual -First $Expected -Second $actual) -or
        -not $Expected.PhysicalPath.Equals($actual.PhysicalPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$($Expected.Label) physical identity changed"
    }
}

function Assert-DeployStageIdentity {
    param(
        [Parameter(Mandatory)]$LiveIdentity,
        [Parameter(Mandatory)]$StageIdentity
    )

    Assert-DeployDirectoryIdentity -Expected $LiveIdentity
    Assert-DeployDirectoryIdentity -Expected $StageIdentity
    $separatorIndex = $StageIdentity.PhysicalPath.LastIndexOf([System.IO.Path]::DirectorySeparatorChar)
    if ($separatorIndex -le 0) { throw 'deployment stage physical parent is unavailable' }
    $physicalParent = $StageIdentity.PhysicalPath.Substring(0, $separatorIndex).TrimEnd('\','/')
    if (-not $physicalParent.Equals($LiveIdentity.PhysicalPath.TrimEnd('\','/'), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'deployment stage physical parent does not match LiveRoot'
    }
    if (Test-DeployDirectoryIdentityEqual -First $LiveIdentity -Second $StageIdentity) {
        throw 'deployment stage cannot be LiveRoot'
    }
}

function Assert-DeployDirectChildIdentity {
    param(
        [Parameter(Mandatory)]$ParentIdentity,
        [Parameter(Mandatory)]$ChildIdentity,
        [Parameter(Mandatory)][string]$Label
    )

    Assert-DeployDirectoryIdentity -Expected $ParentIdentity
    Assert-DeployDirectoryIdentity -Expected $ChildIdentity
    $separatorIndex = $ChildIdentity.PhysicalPath.LastIndexOf([System.IO.Path]::DirectorySeparatorChar)
    if ($separatorIndex -le 0) { throw "$Label physical parent is unavailable" }
    $physicalParent = $ChildIdentity.PhysicalPath.Substring(0, $separatorIndex).TrimEnd('\','/')
    if (-not $physicalParent.Equals($ParentIdentity.PhysicalPath.TrimEnd('\','/'), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label physical parent identity changed"
    }
}

function Assert-DeployDescendantIdentity {
    param(
        [Parameter(Mandatory)]$RootIdentity,
        [Parameter(Mandatory)]$DescendantIdentity,
        [Parameter(Mandatory)][string]$Label
    )

    Assert-DeployDirectoryIdentity -Expected $RootIdentity
    Assert-DeployDirectoryIdentity -Expected $DescendantIdentity
    if (-not (Test-DeployPathContains -Root $RootIdentity.PhysicalPath -Candidate $DescendantIdentity.PhysicalPath)) {
        throw "$Label physical identity is outside LiveRoot"
    }
}

function Invoke-DeployTestHook {
    param([string]$Name, [object]$Context)
    if ($null -eq $TestHooks -or -not $TestHooks.ContainsKey($Name)) { return }
    if ($TestHooks[$Name] -isnot [scriptblock]) { throw "invalid deployment test hook: $Name" }
    & $TestHooks[$Name] $Context
}

function Test-DeployPathIsRoot {
    param([Parameter(Mandatory)][string]$Path)
    $root = [System.IO.Path]::GetPathRoot($Path)
    return $Path.TrimEnd('\','/').Equals($root.TrimEnd('\','/'), [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-DeployPathContains {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Candidate)
    $normalizedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\','/')
    $normalizedCandidate = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\','/')
    if ($normalizedCandidate.Equals($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $normalizedCandidate.StartsWith($normalizedRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-DeployDirectoriesSeparate {
    param([Parameter(Mandatory)]$Source, [Parameter(Mandatory)]$Live, [Parameter(Mandatory)]$Desktop)

    foreach ($entry in @(
        [pscustomobject]@{ Label='SourceRoot'; Path=$Source.CanonicalPath },
        [pscustomobject]@{ Label='LiveRoot'; Path=$Live.CanonicalPath },
        [pscustomobject]@{ Label='DesktopPath'; Path=$Desktop.CanonicalPath }
    )) {
        if (Test-DeployPathIsRoot -Path $entry.Path) { throw "$($entry.Label) cannot be a filesystem root" }
    }
    foreach ($pair in @(
        @('SourceRoot',$Source,'LiveRoot',$Live),
        @('SourceRoot',$Source,'DesktopPath',$Desktop),
        @('LiveRoot',$Live,'DesktopPath',$Desktop)
    )) {
        $samePhysical = Test-DeployDirectoryIdentityEqual -First $pair[1] -Second $pair[3]
        $physicalOverlap = (Test-DeployPathContains -Root $pair[1].PhysicalPath -Candidate $pair[3].PhysicalPath) -or
            (Test-DeployPathContains -Root $pair[3].PhysicalPath -Candidate $pair[1].PhysicalPath)
        if ($samePhysical -or $physicalOverlap) {
            throw "$($pair[0]) and $($pair[2]) cannot overlap"
        }
    }
}

function Assert-DeployPathBoundary {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-DeployPathContains -Root $Root -Candidate $fullPath) -or $fullPath.Equals($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label escapes its trusted root"
    }
    $relative = [System.IO.Path]::GetRelativePath($Root, $fullPath)
    $cursor = $Root
    foreach ($segment in ($relative -split '[\\/]')) {
        if ([string]::IsNullOrWhiteSpace($segment)) { continue }
        $cursor = Join-Path $cursor $segment
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label traverses a reparse point" }
        }
    }
    return $fullPath
}

function Get-DeployHash {
    param([Parameter(Mandatory)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}

function New-DeployParentDirectories {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)]$RootIdentity,
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$CreatedDirectories
    )

    $parent = Split-Path -Parent $Path
    if (Test-Path -LiteralPath $parent -PathType Container) {
        if ([System.IO.Path]::GetFullPath($parent).TrimEnd('\','/').Equals([System.IO.Path]::GetFullPath($Root).TrimEnd('\','/'), [System.StringComparison]::OrdinalIgnoreCase)) { return }
        [void](Assert-DeployPathBoundary -Root $Root -Path $parent -Label 'destination parent')
        return
    }
    $relative = [System.IO.Path]::GetRelativePath($Root, $parent)
    $cursor = $Root
    foreach ($segment in ($relative -split '[\\/]')) {
        if ([string]::IsNullOrWhiteSpace($segment)) { continue }
        $cursor = Join-Path $cursor $segment
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'destination parent is unsafe'
            }
        }
        else {
            New-Item -ItemType Directory -Path $cursor | Out-Null
            $createdIdentity = Resolve-DeployDirectory -Path $cursor -Label 'created destination parent'
            Assert-DeployDescendantIdentity -RootIdentity $RootIdentity -DescendantIdentity $createdIdentity -Label 'created destination parent'
            $CreatedDirectories.Add($createdIdentity)
        }
    }
}

function Copy-DeployFileVerified {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)][string]$ExpectedHash
    )
    [System.IO.File]::Copy($Source, $Destination, $false)
    if ((Get-DeployHash -Path $Destination) -cne $ExpectedHash) { throw 'staged file hash mismatch' }
}

function Assert-DeployRecordIdentities {
    param(
        [Parameter(Mandatory)][object]$Record,
        [Parameter(Mandatory)]$LiveIdentity,
        [Parameter(Mandatory)]$BackupParentIdentity,
        [Parameter(Mandatory)]$BackupRootIdentity
    )

    Assert-DeployDescendantIdentity -RootIdentity $LiveIdentity -DescendantIdentity $Record.ParentIdentity -Label "destination parent $($Record.RelativePath)"
    Assert-DeployDirectChildIdentity -ParentIdentity $LiveIdentity -ChildIdentity $BackupParentIdentity -Label 'deployment backup parent'
    Assert-DeployDirectChildIdentity -ParentIdentity $BackupParentIdentity -ChildIdentity $BackupRootIdentity -Label 'deployment backup root'
    [void](Assert-DeployPathBoundary -Root $BackupRootIdentity.CanonicalPath -Path $Record.BackupPath -Label 'backup file')
}

function Test-DeployDestinationMatchesSnapshot {
    param([Parameter(Mandatory)][object]$Record)
    $exists = Test-Path -LiteralPath $Record.DestinationPath -PathType Leaf
    if ([bool]$Record.HadOriginal -ne [bool]$exists) { return $false }
    if (-not $exists) { return $true }
    return (Get-DeployHash -Path $Record.DestinationPath) -ceq $Record.OriginalHash
}

function Restore-DeployRecord {
    param(
        [Parameter(Mandatory)][object]$Record,
        [Parameter(Mandatory)][string]$TransactionId,
        [Parameter(Mandatory)]$LiveIdentity,
        [Parameter(Mandatory)]$BackupParentIdentity,
        [Parameter(Mandatory)]$BackupRootIdentity
    )

    if (-not $Record.Committed) { return }
    Assert-DeployRecordIdentities -Record $Record -LiveIdentity $LiveIdentity -BackupParentIdentity $BackupParentIdentity -BackupRootIdentity $BackupRootIdentity
    if (-not (Test-Path -LiteralPath $Record.DestinationPath -PathType Leaf) -or
        (Get-DeployHash -Path $Record.DestinationPath) -cne $Record.ExpectedHash) {
        throw 'deployment rollback refused concurrent destination bytes'
    }
    if ($Record.HadOriginal) {
        if (-not (Test-Path -LiteralPath $Record.BackupPath -PathType Leaf)) { throw 'deployment backup is unavailable' }
        if ((Get-DeployHash -Path $Record.BackupPath) -cne $Record.OriginalHash) { throw 'deployment backup changed before rollback' }
        $restorePath = Join-Path (Split-Path -Parent $Record.DestinationPath) ('.codex-discord-deploy.' + $TransactionId + '.rollback')
        [System.IO.File]::Copy($Record.BackupPath, $restorePath, $false)
        try {
            Invoke-DeployTestHook -Name 'BetweenRollbackPrecheckAndReplace' -Context $Record
            Assert-DeployRecordIdentities -Record $Record -LiveIdentity $LiveIdentity -BackupParentIdentity $BackupParentIdentity -BackupRootIdentity $BackupRootIdentity
            if ((Get-DeployHash -Path $Record.BackupPath) -cne $Record.OriginalHash -or (Get-DeployHash -Path $restorePath) -cne $Record.OriginalHash) {
                throw 'deployment backup changed before rollback'
            }
            $displacedPath = $restorePath + '.displaced'
            [System.IO.File]::Replace($restorePath, $Record.DestinationPath, $displacedPath, $true)
            $displacedHash = if (Test-Path -LiteralPath $displacedPath -PathType Leaf) { Get-DeployHash -Path $displacedPath } else { $null }
            if ([string]::IsNullOrWhiteSpace($displacedHash) -or $displacedHash -cne $Record.ExpectedHash) {
                if (-not [string]::IsNullOrWhiteSpace($displacedHash) -and
                    (Test-Path -LiteralPath $Record.DestinationPath -PathType Leaf) -and
                    (Get-DeployHash -Path $Record.DestinationPath) -ceq $Record.OriginalHash) {
                    $transactionQuarantine = $displacedPath + '.transaction'
                    [System.IO.File]::Replace($displacedPath, $Record.DestinationPath, $transactionQuarantine, $true)
                    if ((Get-DeployHash -Path $Record.DestinationPath) -ceq $displacedHash -and
                        (Get-DeployHash -Path $transactionQuarantine) -ceq $Record.OriginalHash) {
                        Remove-Item -LiteralPath $transactionQuarantine -Force
                    }
                }
                throw 'deployment rollback compare-and-swap failed'
            }
            Remove-Item -LiteralPath $displacedPath -Force
        }
        finally {
            if (Test-Path -LiteralPath $restorePath -PathType Leaf) { Remove-Item -LiteralPath $restorePath -Force -ErrorAction SilentlyContinue }
        }
        if ((Get-DeployHash -Path $Record.DestinationPath) -cne $Record.OriginalHash) { throw 'deployment rollback hash mismatch' }
    }
    else {
        Invoke-DeployTestHook -Name 'BetweenRollbackPrecheckAndReplace' -Context $Record
        Assert-DeployRecordIdentities -Record $Record -LiveIdentity $LiveIdentity -BackupParentIdentity $BackupParentIdentity -BackupRootIdentity $BackupRootIdentity
        $quarantinePath = Join-Path (Split-Path -Parent $Record.DestinationPath) ('.codex-discord-deploy.' + $TransactionId + '.rollback-delete')
        [System.IO.File]::Move($Record.DestinationPath, $quarantinePath)
        if ((Get-DeployHash -Path $quarantinePath) -cne $Record.ExpectedHash) {
            if (-not (Test-Path -LiteralPath $Record.DestinationPath)) { [System.IO.File]::Move($quarantinePath, $Record.DestinationPath) }
            throw 'deployment rollback delete compare-and-swap failed'
        }
        Remove-Item -LiteralPath $quarantinePath -Force
    }
}

function Remove-DeployStage {
    param(
        [Parameter(Mandatory)]$LiveIdentity,
        [Parameter(Mandatory)]$StageIdentity,
        [switch]$InjectFailure
    )

    if ($null -eq $LiveIdentity -or $null -eq $StageIdentity) { throw 'deployment stage identity is unavailable for cleanup' }
    $Stage = $StageIdentity.CanonicalPath
    if (-not (Test-Path -LiteralPath $Stage)) { return }
    Assert-DeployStageIdentity -LiveIdentity $LiveIdentity -StageIdentity $StageIdentity
    $fullStage = [System.IO.Path]::GetFullPath($StageIdentity.CanonicalPath)
    $item = Get-Item -LiteralPath $fullStage -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'refusing reparse-point deployment stage cleanup' }
    if ($InjectFailure) { throw 'injected deployment stage cleanup failure' }
    Remove-Item -LiteralPath $fullStage -Recurse -Force
}

function Invoke-DeployControl {
    param([Parameter(Mandatory)][string]$PowerShellPath, [Parameter(Mandatory)][string]$ControlPath, [Parameter(Mandatory)][string]$Action)

    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $lines = @(& $PowerShellPath -NoProfile -File $ControlPath -Action $Action 2>&1 | ForEach-Object { [string]$_ })
        $exitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedPreference }
    if ($lines.Count -ne 1) { throw 'control action returned an invalid response' }
    try { $response = $lines[0] | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'control action returned invalid JSON' }
    if ($exitCode -ne 0 -or $response.ok -ne $true) { throw "control action failed: $Action" }
    return $response
}

function Test-DeployBridgeStateEqual {
    param([Parameter(Mandatory)][object]$Actual, [Parameter(Mandatory)][object]$Expected)

    if ([bool]$Actual.taskInstalled -ne [bool]$Expected.taskInstalled) { return $false }
    if ([bool]$Actual.autoStartEnabled -ne [bool]$Expected.autoStartEnabled) { return $false }
    if ([bool]$Actual.taskRunning -ne [bool]$Expected.taskRunning) { return $false }
    if ([bool]$Actual.running -ne [bool]$Expected.running) { return $false }
    $actualMode = if ([string]::IsNullOrWhiteSpace([string]$Actual.mode)) { 'unknown' } else { [string]$Actual.mode }
    $expectedMode = if ([string]::IsNullOrWhiteSpace([string]$Expected.mode)) { 'unknown' } else { [string]$Expected.mode }
    return $actualMode.Equals($expectedMode, [System.StringComparison]::OrdinalIgnoreCase)
}

function Restore-DeployBridgeState {
    param(
        [Parameter(Mandatory)][string]$PowerShellPath,
        [Parameter(Mandatory)][string]$ProbePath,
        [Parameter(Mandatory)][string]$ToolDir,
        [Parameter(Mandatory)][object]$Expected,
        [string]$ControlPath
    )

    $invokeAction = {
        param([string]$Action)
        if (-not [string]::IsNullOrWhiteSpace($ControlPath) -and (Test-Path -LiteralPath $ControlPath -PathType Leaf)) {
            [void](Invoke-DeployControl -PowerShellPath $PowerShellPath -ControlPath $ControlPath -Action $Action)
        }
        else {
            [void](Invoke-DeployServiceProbe -PowerShellPath $PowerShellPath -ProbePath $ProbePath -Action $Action -ToolDir $ToolDir)
        }
    }

    if ([bool]$Expected.running) {
        if ([string]$Expected.mode -eq 'scheduled' -or [bool]$Expected.taskRunning) {
            & $invokeAction 'enable-long-term'
        }
        elseif ([string]$Expected.mode -eq 'temporary') {
            & $invokeAction 'start-temporary'
        }
        else { throw 'bridge owner mode is unavailable for exact restoration' }
    }
    elseif ([bool]$Expected.autoStartEnabled) {
        # enable-long-term intentionally starts the scheduled instance; the following temporary
        # stop returns to the exact enabled-but-stopped state without changing the long-term flag.
        & $invokeAction 'enable-long-term'
        & $invokeAction 'stop-temporary'
    }
    else {
        # Older consoles stopped only the bridge, leaving native notify hooks enabled.
        # Reapply stop through the updated controller so these hooks are muted too; this
        # action neither installs a missing task nor changes the existing startup choice.
        & $invokeAction 'stop-temporary'
    }

    $final = Invoke-DeployServiceProbe -PowerShellPath $PowerShellPath -ProbePath $ProbePath -Action 'status' -ToolDir $ToolDir
    if (-not (Test-DeployBridgeStateEqual -Actual $final.service -Expected $Expected)) {
        throw 'bridge state restoration did not match the pre-deployment snapshot'
    }
    return $final
}

function Test-DeployGuardStateEqual {
    param([Parameter(Mandatory)][object]$Actual, [Parameter(Mandatory)][object]$Expected)

    return (
        [bool]$Actual.exists -eq [bool]$Expected.exists -and
        [bool]$Actual.enabled -eq [bool]$Expected.enabled -and
        [bool]$Actual.running -eq [bool]$Expected.running -and
        (-not [bool]$Actual.exists -or (
            [bool]$Actual.trusted -and
            -not [string]::IsNullOrWhiteSpace([string]$Actual.definitionHash) -and
            ([string]$Actual.definitionHash).Equals([string]$Expected.definitionHash, [System.StringComparison]::OrdinalIgnoreCase)
        ))
    )
}

function Restore-DeployGuardState {
    param(
        [Parameter(Mandatory)][string]$PowerShellPath,
        [Parameter(Mandatory)][string]$ProbePath,
        [Parameter(Mandatory)][string]$ToolDir,
        [Parameter(Mandatory)][object]$Expected
    )

    $current = Invoke-DeployServiceProbe -PowerShellPath $PowerShellPath -ProbePath $ProbePath -Action 'guard-status' -ToolDir $ToolDir
    if (-not [bool]$Expected.exists) {
        if ([bool]$current.guard.exists) { throw 'notification guard appeared during deployment' }
        return $current
    }
    if (-not [bool]$current.guard.exists -or -not [bool]$current.guard.trusted) { throw 'notification guard is unavailable for exact restoration' }
    if ([string]::IsNullOrWhiteSpace([string]$Expected.definitionHash) -or
        -not ([string]$current.guard.definitionHash).Equals([string]$Expected.definitionHash, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'notification guard definition changed during deployment'
    }

    if ([bool]$Expected.running -and -not [bool]$current.guard.running) {
        if (-not [bool]$current.guard.enabled) {
            [void](Invoke-DeployServiceProbe -PowerShellPath $PowerShellPath -ProbePath $ProbePath -Action 'guard-enable' -ToolDir $ToolDir)
        }
        [void](Invoke-DeployServiceProbe -PowerShellPath $PowerShellPath -ProbePath $ProbePath -Action 'guard-start' -ToolDir $ToolDir)
        if (-not [bool]$Expected.enabled) {
            [void](Invoke-DeployServiceProbe -PowerShellPath $PowerShellPath -ProbePath $ProbePath -Action 'guard-disable' -ToolDir $ToolDir)
        }
    }
    elseif (-not [bool]$Expected.running -and [bool]$current.guard.running) {
        [void](Invoke-DeployServiceProbe -PowerShellPath $PowerShellPath -ProbePath $ProbePath -Action 'guard-stop' -ToolDir $ToolDir)
    }

    $current = Invoke-DeployServiceProbe -PowerShellPath $PowerShellPath -ProbePath $ProbePath -Action 'guard-status' -ToolDir $ToolDir
    if ([bool]$current.guard.enabled -ne [bool]$Expected.enabled) {
        $toggle = if ([bool]$Expected.enabled) { 'guard-enable' } else { 'guard-disable' }
        [void](Invoke-DeployServiceProbe -PowerShellPath $PowerShellPath -ProbePath $ProbePath -Action $toggle -ToolDir $ToolDir)
        $current = Invoke-DeployServiceProbe -PowerShellPath $PowerShellPath -ProbePath $ProbePath -Action 'guard-status' -ToolDir $ToolDir
    }
    if (-not (Test-DeployGuardStateEqual -Actual $current.guard -Expected $Expected)) {
        throw 'notification guard state restoration did not match the pre-deployment snapshot'
    }
    return $current
}

function Invoke-DeployServiceProbe {
    param(
        [Parameter(Mandatory)][string]$PowerShellPath,
        [Parameter(Mandatory)][string]$ProbePath,
        [Parameter(Mandatory)][ValidateSet(
            'status','stop-temporary','start-temporary','enable-long-term',
            'guard-status','guard-stop','guard-start','guard-enable','guard-disable'
        )][string]$Action,
        [Parameter(Mandatory)][string]$ToolDir
    )

    $probeAction = @{
        status='bridge-status'; 'stop-temporary'='bridge-stop'; 'start-temporary'='bridge-start'; 'enable-long-term'='bridge-enable'
        'guard-status'='guard-status'; 'guard-stop'='guard-stop'; 'guard-start'='guard-start'; 'guard-enable'='guard-enable'; 'guard-disable'='guard-disable'
    }[$Action]
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $lines = @(& $PowerShellPath -NoProfile -File $ProbePath -Action $probeAction -ToolDir $ToolDir 2>&1 | ForEach-Object { [string]$_ })
        $exitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedPreference }
    if ($lines.Count -ne 1) { throw 'service probe returned an invalid response' }
    try { $response = $lines[0] | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'service probe returned invalid JSON' }
    if ($exitCode -ne 0 -or $response.ok -ne $true) { throw "service probe failed: $Action" }
    return $response
}

function Invoke-DeployCommandRegistration {
    param(
        [Parameter(Mandatory)][string]$NodePath,
        [Parameter(Mandatory)][string]$BridgePath,
        [Parameter(Mandatory)][int]$DeadlineMilliseconds,
        [Parameter(Mandatory)][int]$OutputLimitBytes
    )

    try {
        $result = [CodexDeployBoundedProcess]::Run($NodePath, $BridgePath, $DeadlineMilliseconds, $OutputLimitBytes)
    }
    catch { throw 'Discord command registration failed' }
    if ($result.Success -ne $true) { throw 'Discord command registration failed' }
}

if (@($script:DeployFileAllowlist | Where-Object { $script:ForbiddenDeployNames -contains [System.IO.Path]::GetFileName($_) }).Count -gt 0) {
    throw 'Deployment allowlist contains runtime state'
}
if ($script:DeployFileAllowlist.Count -ne @($script:DeployFileAllowlist | Sort-Object -Unique).Count) {
    throw 'Deployment allowlist contains duplicate paths'
}

# Resolve every caller-controlled boundary and every required source before the first write.
$sourceIdentity = Resolve-DeployDirectory -Path $SourceRoot -Label 'SourceRoot'
$liveIdentity = Resolve-DeployDirectory -Path $LiveRoot -Label 'LiveRoot'
$desktopIdentity = Resolve-DeployDirectory -Path $DesktopPath -Label 'DesktopPath'
Assert-DeployDirectoriesSeparate -Source $sourceIdentity -Live $liveIdentity -Desktop $desktopIdentity
$source = $sourceIdentity.CanonicalPath
$live = $liveIdentity.CanonicalPath
$desktop = $desktopIdentity.CanonicalPath

$readmeMarker = Join-Path $source 'README.md'
if (-not (Test-Path -LiteralPath $readmeMarker -PathType Leaf)) { throw 'SourceRoot is missing the repository marker' }
[void](Assert-DeployPathBoundary -Root $source -Path $readmeMarker -Label 'repository marker')
$markerText = [System.IO.File]::ReadAllText($readmeMarker, [System.Text.Encoding]::UTF8)
if (-not $markerText.StartsWith('# Codex Discord 私有命令控制台', [System.StringComparison]::Ordinal)) {
    throw 'SourceRoot repository marker is invalid'
}

$sourceManifest = [System.Collections.Generic.List[object]]::new()
foreach ($relativePath in $script:DeployFileAllowlist) {
    if ([System.IO.Path]::IsPathRooted($relativePath) -or $relativePath -match '(^|[\\/])\.\.([\\/]|$)') { throw 'Deployment allowlist path is unsafe' }
    $sourcePath = Assert-DeployPathBoundary -Root $source -Path (Join-Path $source $relativePath) -Label "source file $relativePath"
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw "SourceRoot is missing a required deployment file: $relativePath" }
    $destinationPath = Assert-DeployPathBoundary -Root $live -Path (Join-Path $live $relativePath) -Label "destination file $relativePath"
    if (Test-Path -LiteralPath $destinationPath) {
        if (-not (Test-Path -LiteralPath $destinationPath -PathType Leaf)) { throw "Live destination is not a file: $relativePath" }
    }
    $sourceManifest.Add([pscustomobject][ordered]@{
        RelativePath = $relativePath
        SourcePath = $sourcePath
        DestinationPath = $destinationPath
        Hash = Get-DeployHash -Path $sourcePath
    })
}
foreach ($relativePath in $script:GeneratedDeployFiles) {
    [void](Assert-DeployPathBoundary -Root $live -Path (Join-Path $live $relativePath) -Label "generated destination $relativePath")
}
$shortcutPath = Join-Path $desktop 'Codex Discord 控制台.lnk'
[void](Assert-DeployPathBoundary -Root $desktop -Path $shortcutPath -Label 'Desktop shortcut')

$transactionId = [guid]::NewGuid().ToString('N')
$timestamp = [DateTimeOffset]::Now.ToString('yyyyMMdd-HHmmss-fffffff')
$stageRoot = Join-Path $live ('.codex-discord-deploy.' + $transactionId + '.stage')
$backupParent = Join-Path $live '.codex-discord-backups'
$backupRoot = Join-Path $backupParent ($timestamp + '-' + $transactionId.Substring(0,8))
[void](Assert-DeployPathBoundary -Root $live -Path $stageRoot -Label 'deployment stage')
[void](Assert-DeployPathBoundary -Root $live -Path $backupParent -Label 'deployment backup parent')
[void](Assert-DeployPathBoundary -Root $live -Path $backupRoot -Label 'deployment backup')
if (Test-Path -LiteralPath $stageRoot) { throw 'Deployment stage already exists' }
if (Test-Path -LiteralPath $backupRoot) { throw 'Deployment backup already exists' }

$records = [System.Collections.Generic.List[object]]::new()
$createdDirectories = [System.Collections.Generic.List[object]]::new()
$priorStatus = $null
$serviceStopped = $false
$shortcutRecord = $null
$deploymentCommitted = $false
$primaryError = $null
$terminalError = $null
$cleanupWarning = $false
$serviceProbePath = $null
$serviceWasActive = $false
$serviceMutationAttempted = $false
$commandRegistrationAttempted = $false
$nodePath = $null
$priorGuardStatus = $null
$guardMutationAttempted = $false
$sourceProbePath = Join-Path $source 'deploy-live-probe.ps1'
$stageIdentity = $null
$backupParentIdentity = $null
$backupRootIdentity = $null

try {
    foreach ($rootIdentity in @($sourceIdentity, $liveIdentity, $desktopIdentity)) {
        Assert-DeployDirectoryIdentity -Expected $rootIdentity
    }
    if (-not $SkipLiveActions) {
        $powerShellPath = (Get-Command pwsh -ErrorAction Stop).Source
        $serviceProbePath = $sourceProbePath
        $guardSnapshot = Invoke-DeployServiceProbe -PowerShellPath $powerShellPath -ProbePath $sourceProbePath -Action 'guard-status' -ToolDir $live
        if ($guardSnapshot.guard.exists -eq $true -and $guardSnapshot.guard.trusted -ne $true) {
            throw 'notification guard identity is untrusted'
        }
        $priorGuardStatus = $guardSnapshot.guard
        if ($priorGuardStatus.exists -eq $true) {
            # Disable before stopping so task triggers and restart-on-failure settings cannot race
            # the deployment. Recovery ownership begins before either trusted action.
            $guardMutationAttempted = $true
            [void](Invoke-DeployServiceProbe -PowerShellPath $powerShellPath -ProbePath $sourceProbePath -Action 'guard-disable' -ToolDir $live)
            [void](Invoke-DeployServiceProbe -PowerShellPath $powerShellPath -ProbePath $sourceProbePath -Action 'guard-stop' -ToolDir $live)
            $frozenGuard = Invoke-DeployServiceProbe -PowerShellPath $powerShellPath -ProbePath $sourceProbePath -Action 'guard-status' -ToolDir $live
            if ($frozenGuard.guard.exists -ne $true -or $frozenGuard.guard.trusted -ne $true -or
                $frozenGuard.guard.running -eq $true -or $frozenGuard.guard.enabled -eq $true -or
                -not ([string]$frozenGuard.guard.definitionHash).Equals([string]$priorGuardStatus.definitionHash, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw 'notification guard freeze was not confirmed'
            }
        }
        $priorStatus = Invoke-DeployServiceProbe -PowerShellPath $powerShellPath -ProbePath $sourceProbePath -Action 'status' -ToolDir $live
        $serviceWasActive = ($priorStatus.service.running -eq $true -or $priorStatus.service.taskRunning -eq $true)
    }

    # Complete staging and hash verification happen before backup or destination mutation.
    foreach ($rootIdentity in @($sourceIdentity, $liveIdentity, $desktopIdentity)) {
        Assert-DeployDirectoryIdentity -Expected $rootIdentity
    }
    New-Item -ItemType Directory -Path $stageRoot | Out-Null
    $stageIdentity = Resolve-DeployDirectory -Path $stageRoot -Label 'deployment stage'
    Assert-DeployStageIdentity -LiveIdentity $liveIdentity -StageIdentity $stageIdentity
    foreach ($entry in $sourceManifest) {
        $stagedPath = Join-Path $stageRoot $entry.RelativePath
        $stagedParent = Split-Path -Parent $stagedPath
        if (-not (Test-Path -LiteralPath $stagedParent -PathType Container)) { New-Item -ItemType Directory -Path $stagedParent -Force | Out-Null }
        Copy-DeployFileVerified -Source $entry.SourcePath -Destination $stagedPath -ExpectedHash $entry.Hash
    }
    & (Join-Path $stageRoot 'build-control-app.ps1') -OutputDirectory $stageRoot | Out-Null
    $stagedExecutable = Join-Path $stageRoot 'CodexDiscordControl.exe'
    if (-not (Test-Path -LiteralPath $stagedExecutable -PathType Leaf)) { throw 'Control app build did not produce an executable' }

    $stageManifest = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $sourceManifest) {
        $stagedPath = Assert-DeployPathBoundary -Root $stageRoot -Path (Join-Path $stageRoot $entry.RelativePath) -Label "staged file $($entry.RelativePath)"
        if (-not (Test-Path -LiteralPath $stagedPath -PathType Leaf) -or (Get-DeployHash -Path $stagedPath) -cne $entry.Hash) {
            throw "Staged deployment verification failed: $($entry.RelativePath)"
        }
        $stageManifest.Add([pscustomobject][ordered]@{
            RelativePath = $entry.RelativePath
            StagedPath = $stagedPath
            DestinationPath = $entry.DestinationPath
            Hash = $entry.Hash
        })
    }
    $executableHash = Get-DeployHash -Path $stagedExecutable
    if ([string]::IsNullOrWhiteSpace($executableHash)) { throw 'Control app hash is unavailable' }
    $stageManifest.Add([pscustomobject][ordered]@{
        RelativePath = 'CodexDiscordControl.exe'
        StagedPath = $stagedExecutable
        DestinationPath = Join-Path $live 'CodexDiscordControl.exe'
        Hash = $executableHash
    })
    foreach ($entry in $stageManifest) {
        if (-not (Test-Path -LiteralPath $entry.StagedPath -PathType Leaf) -or (Get-DeployHash -Path $entry.StagedPath) -cne $entry.Hash) {
            throw "Complete stage verification failed: $($entry.RelativePath)"
        }
    }

    if (-not $SkipLiveActions) { $serviceProbePath = Join-Path $stageRoot 'deploy-live-probe.ps1' }

    Assert-DeployStageIdentity -LiveIdentity $liveIdentity -StageIdentity $stageIdentity
    New-Item -ItemType Directory -Path $backupParent -Force | Out-Null
    $backupParentIdentity = Resolve-DeployDirectory -Path $backupParent -Label 'deployment backup parent'
    Assert-DeployDirectChildIdentity -ParentIdentity $liveIdentity -ChildIdentity $backupParentIdentity -Label 'deployment backup parent'
    Invoke-DeployTestHook -Name 'AfterBackupParentCreated' -Context ([pscustomobject]@{Path=$backupParent;Live=$live})
    Assert-DeployDirectChildIdentity -ParentIdentity $liveIdentity -ChildIdentity $backupParentIdentity -Label 'deployment backup parent'
    New-Item -ItemType Directory -Path $backupRoot | Out-Null
    $backupRootIdentity = Resolve-DeployDirectory -Path $backupRoot -Label 'deployment backup root'
    Assert-DeployDirectChildIdentity -ParentIdentity $backupParentIdentity -ChildIdentity $backupRootIdentity -Label 'deployment backup root'
    Invoke-DeployTestHook -Name 'AfterBackupRootCreated' -Context ([pscustomobject]@{Path=$backupRoot;Parent=$backupParent;Live=$live})

    # Back up every old allowlisted destination before the first file commit.
    Assert-DeployStageIdentity -LiveIdentity $liveIdentity -StageIdentity $stageIdentity
    Assert-DeployDirectChildIdentity -ParentIdentity $backupParentIdentity -ChildIdentity $backupRootIdentity -Label 'deployment backup root'
    foreach ($entry in $stageManifest) {
        $destinationPath = Assert-DeployPathBoundary -Root $live -Path $entry.DestinationPath -Label "commit destination $($entry.RelativePath)"
        New-DeployParentDirectories -Root $live -RootIdentity $liveIdentity -Path $destinationPath -CreatedDirectories $createdDirectories
        $destinationParent = Split-Path -Parent $destinationPath
        $destinationParentIdentity = Resolve-DeployDirectory -Path $destinationParent -Label "destination parent $($entry.RelativePath)"
        Assert-DeployDescendantIdentity -RootIdentity $liveIdentity -DescendantIdentity $destinationParentIdentity -Label "destination parent $($entry.RelativePath)"
        $hadOriginal = Test-Path -LiteralPath $destinationPath -PathType Leaf
        $backupPath = Join-Path $backupRoot $entry.RelativePath
        $originalHash = $null
        if ($hadOriginal) {
            $originalHash = Get-DeployHash -Path $destinationPath
            $backupDirectory = Split-Path -Parent $backupPath
            if (-not (Test-Path -LiteralPath $backupDirectory -PathType Container)) {
                [void](Assert-DeployPathBoundary -Root $backupRoot -Path $backupDirectory -Label 'backup directory')
                New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
            }
            Assert-DeployDirectChildIdentity -ParentIdentity $backupParentIdentity -ChildIdentity $backupRootIdentity -Label 'deployment backup root'
            Assert-DeployDescendantIdentity -RootIdentity $liveIdentity -DescendantIdentity $destinationParentIdentity -Label "destination parent $($entry.RelativePath)"
            [void](Assert-DeployPathBoundary -Root $backupRoot -Path $backupPath -Label 'backup file')
            Invoke-DeployTestHook -Name 'BeforeBackupRead' -Context ([pscustomobject]@{DestinationPath=$destinationPath;BackupPath=$backupPath;RelativePath=$entry.RelativePath})
            Assert-DeployDirectChildIdentity -ParentIdentity $backupParentIdentity -ChildIdentity $backupRootIdentity -Label 'deployment backup root'
            Assert-DeployDescendantIdentity -RootIdentity $liveIdentity -DescendantIdentity $destinationParentIdentity -Label "destination parent $($entry.RelativePath)"
            if (-not (Test-Path -LiteralPath $destinationPath -PathType Leaf) -or (Get-DeployHash -Path $destinationPath) -cne $originalHash) {
                throw 'deployment source changed before backup'
            }
            [System.IO.File]::Copy($destinationPath, $backupPath, $false)
            if ((Get-DeployHash -Path $backupPath) -cne $originalHash) { throw 'Deployment backup hash mismatch' }
        }
        $records.Add([pscustomobject][ordered]@{
            RelativePath = $entry.RelativePath
            StagedPath = $entry.StagedPath
            DestinationPath = $destinationPath
            BackupPath = $backupPath
            ExpectedHash = $entry.Hash
            OriginalHash = $originalHash
            HadOriginal = $hadOriginal
            ParentIdentity = $destinationParentIdentity
            Committed = $false
        })
    }
    Write-Output ("部署备份：{0}" -f $backupRoot)

    if (-not $SkipLiveActions) {
        Assert-DeployStageIdentity -LiveIdentity $liveIdentity -StageIdentity $stageIdentity
        Assert-DeployDirectoryIdentity -Expected $desktopIdentity
        Assert-DeployDirectChildIdentity -ParentIdentity $backupParentIdentity -ChildIdentity $backupRootIdentity -Label 'deployment backup root'
        if ($serviceWasActive) {
            # Treat the state as needing restoration before invoking stop: a trusted control
            # action may report failure after it has already stopped the runtime.
            $serviceStopped = $true
            [void](Invoke-DeployServiceProbe -PowerShellPath $powerShellPath -ProbePath $serviceProbePath -Action 'stop-temporary' -ToolDir $live)
        }
        $shortcutHadOriginal = Test-Path -LiteralPath $shortcutPath -PathType Leaf
        $shortcutBackupPath = Join-Path $backupRoot 'desktop-shortcut\Codex Discord 控制台.lnk'
        if ($shortcutHadOriginal) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $shortcutBackupPath) -Force | Out-Null
            $shortcutOriginalHash = Get-DeployHash -Path $shortcutPath
            [void](Assert-DeployPathBoundary -Root $backupRoot -Path $shortcutBackupPath -Label 'Desktop shortcut backup')
            Assert-DeployDirectoryIdentity -Expected $desktopIdentity
            Assert-DeployDirectChildIdentity -ParentIdentity $backupParentIdentity -ChildIdentity $backupRootIdentity -Label 'deployment backup root'
            [System.IO.File]::Copy($shortcutPath, $shortcutBackupPath, $false)
            if ((Get-DeployHash -Path $shortcutBackupPath) -cne $shortcutOriginalHash) { throw 'Desktop shortcut backup hash mismatch' }
        }
        else { $shortcutOriginalHash = $null }
        $shortcutRecord = [pscustomobject]@{ HadOriginal=$shortcutHadOriginal; BackupPath=$shortcutBackupPath; OriginalHash=$shortcutOriginalHash; DestinationPath=$shortcutPath; MutationAttempted=$false; ChangedByTransaction=$false; ExpectedHash=$null }
    }

    Assert-DeployStageIdentity -LiveIdentity $liveIdentity -StageIdentity $stageIdentity
    $commitCount = 0
    foreach ($record in $records) {
        Assert-DeployStageIdentity -LiveIdentity $liveIdentity -StageIdentity $stageIdentity
        Assert-DeployRecordIdentities -Record $record -LiveIdentity $liveIdentity -BackupParentIdentity $backupParentIdentity -BackupRootIdentity $backupRootIdentity
        Invoke-DeployTestHook -Name 'BeforeCommit' -Context $record
        Assert-DeployRecordIdentities -Record $record -LiveIdentity $liveIdentity -BackupParentIdentity $backupParentIdentity -BackupRootIdentity $backupRootIdentity
        if (-not (Test-DeployDestinationMatchesSnapshot -Record $record)) { throw 'deployment destination changed after backup' }
        $commitTemporary = Join-Path (Split-Path -Parent $record.DestinationPath) ('.codex-discord-deploy.' + $transactionId + '.commit')
        [System.IO.File]::Copy($record.StagedPath, $commitTemporary, $false)
        try {
            if ((Get-DeployHash -Path $commitTemporary) -cne $record.ExpectedHash) { throw 'Deployment commit temporary hash mismatch' }
            Invoke-DeployTestHook -Name 'BetweenPrecheckAndReplace' -Context $record
            Assert-DeployRecordIdentities -Record $record -LiveIdentity $liveIdentity -BackupParentIdentity $backupParentIdentity -BackupRootIdentity $backupRootIdentity
            if ($record.HadOriginal) {
                $displacedPath = $commitTemporary + '.displaced'
                [System.IO.File]::Replace($commitTemporary, $record.DestinationPath, $displacedPath, $true)
                $record.Committed = $true
                $displacedHash = if (Test-Path -LiteralPath $displacedPath -PathType Leaf) { Get-DeployHash -Path $displacedPath } else { $null }
                if ([string]::IsNullOrWhiteSpace($displacedHash) -or $displacedHash -cne $record.OriginalHash) {
                    if ((Test-Path -LiteralPath $record.DestinationPath -PathType Leaf) -and (Get-DeployHash -Path $record.DestinationPath) -ceq $record.ExpectedHash) {
                        $transactionQuarantine = $displacedPath + '.transaction'
                        [System.IO.File]::Replace($displacedPath, $record.DestinationPath, $transactionQuarantine, $true)
                        if ((Get-DeployHash -Path $record.DestinationPath) -ceq $displacedHash -and
                            (Get-DeployHash -Path $transactionQuarantine) -ceq $record.ExpectedHash) {
                            Remove-Item -LiteralPath $transactionQuarantine -Force
                            $record.Committed = $false
                        }
                    }
                    throw 'deployment compare-and-swap detected concurrent destination bytes'
                }
                Remove-Item -LiteralPath $displacedPath -Force
            }
            else {
                [System.IO.File]::Move($commitTemporary, $record.DestinationPath)
                $record.Committed = $true
            }
        }
        finally {
            if (Test-Path -LiteralPath $commitTemporary -PathType Leaf) { Remove-Item -LiteralPath $commitTemporary -Force -ErrorAction SilentlyContinue }
        }
        Assert-DeployRecordIdentities -Record $record -LiveIdentity $liveIdentity -BackupParentIdentity $backupParentIdentity -BackupRootIdentity $backupRootIdentity
        if ((Get-DeployHash -Path $record.DestinationPath) -cne $record.ExpectedHash) { throw 'Deployment destination hash mismatch' }
        $commitCount++
        if ($FailureInjectionStep -ceq 'after-third-commit' -and $commitCount -eq 3) { throw 'injected-deploy-failure:after-third-commit' }
    }
    $deploymentCommitted = $true

    if (-not $SkipLiveActions) {
        Assert-DeployStageIdentity -LiveIdentity $liveIdentity -StageIdentity $stageIdentity
        Assert-DeployDirectoryIdentity -Expected $desktopIdentity
        if ($FailureInjectionStep -ceq 'before-live-actions') { throw 'injected-deploy-failure:before-live-actions' }
        # The installer may write the shortcut and then fail, so recovery ownership begins
        # before the external action rather than after its successful return.
        $shortcutExistsBefore = Test-Path -LiteralPath $shortcutPath -PathType Leaf
        if ($shortcutExistsBefore -ne $shortcutRecord.HadOriginal -or
            ($shortcutExistsBefore -and (Get-DeployHash -Path $shortcutPath) -cne $shortcutRecord.OriginalHash)) {
            throw 'Desktop shortcut changed after backup'
        }
        $shortcutRecord.MutationAttempted = $true
        try {
            & (Join-Path $live 'install-control-app.ps1') -SourceRoot $live -ToolDir $live -DesktopPath $desktop -ShortcutOnly | Out-Null
        }
        finally {
            Assert-DeployDirectoryIdentity -Expected $desktopIdentity
            Assert-DeployDirectChildIdentity -ParentIdentity $backupParentIdentity -ChildIdentity $backupRootIdentity -Label 'deployment backup root'
            if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
                $currentShortcutHash = Get-DeployHash -Path $shortcutPath
                $shortcutRecord.ExpectedHash = $currentShortcutHash
                $shortcutRecord.ChangedByTransaction = (-not $shortcutRecord.HadOriginal -or $currentShortcutHash -cne $shortcutRecord.OriginalHash)
            }
            elseif ($shortcutRecord.HadOriginal) { $shortcutRecord.ChangedByTransaction = $true }
        }
        if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { throw 'Control app shortcut installation failed' }
        foreach ($record in $records) {
            Assert-DeployRecordIdentities -Record $record -LiveIdentity $liveIdentity -BackupParentIdentity $backupParentIdentity -BackupRootIdentity $backupRootIdentity
            if (-not (Test-Path -LiteralPath $record.DestinationPath -PathType Leaf) -or (Get-DeployHash -Path $record.DestinationPath) -cne $record.ExpectedHash) {
                throw "Post-install deployment hash mismatch: $($record.RelativePath)"
            }
        }

        $nodePath = (Get-Command node -ErrorAction Stop).Source
        # Guild PUT can take effect before its local caller reports success, so any attempt owns
        # compensating registration with the restored bridge during rollback.
        $commandRegistrationAttempted = $true
        Invoke-DeployCommandRegistration -NodePath $nodePath -BridgePath (Join-Path $live 'discord-bridge.mjs') -DeadlineMilliseconds $RegistrationDeadlineMilliseconds -OutputLimitBytes $RegistrationOutputLimitBytes

        $newControl = Join-Path $live 'codex-control.ps1'
        $serviceMutationAttempted = (
            $priorStatus.service.running -eq $true -or
            ($priorStatus.service.autoStartEnabled -eq $true -and $priorStatus.service.running -ne $true)
        )
        [void](Restore-DeployBridgeState -PowerShellPath $powerShellPath -ProbePath $serviceProbePath -ToolDir $live -Expected $priorStatus.service -ControlPath $newControl)
        foreach ($record in $records) {
            Assert-DeployRecordIdentities -Record $record -LiveIdentity $liveIdentity -BackupParentIdentity $backupParentIdentity -BackupRootIdentity $backupRootIdentity
            if (-not (Test-Path -LiteralPath $record.DestinationPath -PathType Leaf) -or (Get-DeployHash -Path $record.DestinationPath) -cne $record.ExpectedHash) {
                throw "Final deployment hash mismatch: $($record.RelativePath)"
            }
        }
        # The notification guard is deliberately restored last, after bridge state and every
        # deployed byte are final, so an older two-second repair loop cannot race rollback.
        [void](Restore-DeployGuardState -PowerShellPath $powerShellPath -ProbePath $serviceProbePath -ToolDir $live -Expected $priorGuardStatus)
    }
}
catch {
    $primaryError = $_
    $rollbackFailed = $false
    try { Invoke-DeployTestHook -Name 'BeforeRollback' -Context ([pscustomobject]@{Records=$records;Live=$live;BackupRoot=$backupRoot}) }
    catch { $rollbackFailed = $true }
    if ($serviceMutationAttempted -and $null -ne $serviceProbePath) {
        try {
            # A fixed service action can start the new runtime and still report failure. Stop it
            # through the intact staged control library before replacing its on-disk code.
            [void](Invoke-DeployServiceProbe -PowerShellPath $powerShellPath -ProbePath $serviceProbePath -Action 'stop-temporary' -ToolDir $live)
        }
        catch { $rollbackFailed = $true }
    }
    for ($index = $records.Count - 1; $index -ge 0; $index--) {
        try {
            Invoke-DeployTestHook -Name 'BeforeRollbackRecord' -Context $records[$index]
            Restore-DeployRecord -Record $records[$index] -TransactionId $transactionId -LiveIdentity $liveIdentity -BackupParentIdentity $backupParentIdentity -BackupRootIdentity $backupRootIdentity
        }
        catch { $rollbackFailed = $true }
    }
    for ($index = $createdDirectories.Count - 1; $index -ge 0; $index--) {
        $directoryIdentity = $createdDirectories[$index]
        $directory = $directoryIdentity.CanonicalPath
        if (Test-Path -LiteralPath $directory -PathType Container) {
            try {
                Assert-DeployDescendantIdentity -RootIdentity $liveIdentity -DescendantIdentity $directoryIdentity -Label 'created destination parent'
                if (@(Get-ChildItem -LiteralPath $directory -Force).Count -eq 0) { Remove-Item -LiteralPath $directory -Force }
            }
            catch { $rollbackFailed = $true }
        }
    }
    if ($null -ne $shortcutRecord -and $shortcutRecord.MutationAttempted -and $shortcutRecord.ChangedByTransaction) {
        try {
            Assert-DeployDirectoryIdentity -Expected $desktopIdentity
            Assert-DeployDirectChildIdentity -ParentIdentity $backupParentIdentity -ChildIdentity $backupRootIdentity -Label 'deployment backup root'
            if ([string]::IsNullOrWhiteSpace([string]$shortcutRecord.ExpectedHash) -or
                -not (Test-Path -LiteralPath $shortcutRecord.DestinationPath -PathType Leaf) -or
                (Get-DeployHash -Path $shortcutRecord.DestinationPath) -cne $shortcutRecord.ExpectedHash) {
                throw 'Desktop shortcut rollback refused concurrent bytes'
            }
            if ($shortcutRecord.HadOriginal) {
                if (-not (Test-Path -LiteralPath $shortcutRecord.BackupPath -PathType Leaf) -or
                    (Get-DeployHash -Path $shortcutRecord.BackupPath) -cne $shortcutRecord.OriginalHash) {
                    throw 'Desktop shortcut backup changed before rollback'
                }
                $shortcutRestore = Join-Path $desktop ('.codex-discord-deploy.' + $transactionId + '.shortcut-rollback')
                [System.IO.File]::Copy($shortcutRecord.BackupPath, $shortcutRestore, $false)
                Invoke-DeployTestHook -Name 'BetweenShortcutRollbackPrecheckAndReplace' -Context $shortcutRecord
                Assert-DeployDirectoryIdentity -Expected $desktopIdentity
                Assert-DeployDirectChildIdentity -ParentIdentity $backupParentIdentity -ChildIdentity $backupRootIdentity -Label 'deployment backup root'
                if ((Get-DeployHash -Path $shortcutRecord.BackupPath) -cne $shortcutRecord.OriginalHash -or
                    (Get-DeployHash -Path $shortcutRestore) -cne $shortcutRecord.OriginalHash) {
                    throw 'Desktop shortcut backup changed before rollback'
                }
                $shortcutDisplaced = $shortcutRestore + '.displaced'
                [System.IO.File]::Replace($shortcutRestore, $shortcutRecord.DestinationPath, $shortcutDisplaced, $true)
                $shortcutDisplacedHash = if (Test-Path -LiteralPath $shortcutDisplaced -PathType Leaf) { Get-DeployHash -Path $shortcutDisplaced } else { $null }
                if ([string]::IsNullOrWhiteSpace($shortcutDisplacedHash) -or $shortcutDisplacedHash -cne $shortcutRecord.ExpectedHash) {
                    if (-not [string]::IsNullOrWhiteSpace($shortcutDisplacedHash) -and
                        (Test-Path -LiteralPath $shortcutRecord.DestinationPath -PathType Leaf) -and
                        (Get-DeployHash -Path $shortcutRecord.DestinationPath) -ceq $shortcutRecord.OriginalHash) {
                        $shortcutTransactionQuarantine = $shortcutDisplaced + '.transaction'
                        [System.IO.File]::Replace($shortcutDisplaced, $shortcutRecord.DestinationPath, $shortcutTransactionQuarantine, $true)
                        if ((Get-DeployHash -Path $shortcutRecord.DestinationPath) -ceq $shortcutDisplacedHash -and
                            (Get-DeployHash -Path $shortcutTransactionQuarantine) -ceq $shortcutRecord.OriginalHash) {
                            Remove-Item -LiteralPath $shortcutTransactionQuarantine -Force
                        }
                    }
                    throw 'Desktop shortcut rollback compare-and-swap failed'
                }
                Remove-Item -LiteralPath $shortcutDisplaced -Force
                if ((Get-DeployHash -Path $shortcutRecord.DestinationPath) -cne $shortcutRecord.OriginalHash) { throw 'Desktop shortcut rollback hash mismatch' }
            }
            else {
                Invoke-DeployTestHook -Name 'BetweenShortcutRollbackPrecheckAndReplace' -Context $shortcutRecord
                Assert-DeployDirectoryIdentity -Expected $desktopIdentity
                Assert-DeployDirectChildIdentity -ParentIdentity $backupParentIdentity -ChildIdentity $backupRootIdentity -Label 'deployment backup root'
                $shortcutQuarantine = Join-Path $desktop ('.codex-discord-deploy.' + $transactionId + '.shortcut-delete')
                [System.IO.File]::Move($shortcutRecord.DestinationPath, $shortcutQuarantine)
                if ((Get-DeployHash -Path $shortcutQuarantine) -cne $shortcutRecord.ExpectedHash) {
                    if (-not (Test-Path -LiteralPath $shortcutRecord.DestinationPath)) { [System.IO.File]::Move($shortcutQuarantine, $shortcutRecord.DestinationPath) }
                    throw 'Desktop shortcut rollback delete compare-and-swap failed'
                }
                Remove-Item -LiteralPath $shortcutQuarantine -Force
            }
        }
        catch { $rollbackFailed = $true }
    }
    if ($commandRegistrationAttempted) {
        try {
            if ($null -eq $nodePath) { $nodePath = (Get-Command node -ErrorAction Stop).Source }
            $restoredBridgeRecord = @($records | Where-Object { $_.RelativePath -ceq 'discord-bridge.mjs' }) | Select-Object -First 1
            if ($null -eq $restoredBridgeRecord -or -not $restoredBridgeRecord.HadOriginal) { throw 'Restored bridge is unavailable for command rollback' }
            Assert-DeployRecordIdentities -Record $restoredBridgeRecord -LiveIdentity $liveIdentity -BackupParentIdentity $backupParentIdentity -BackupRootIdentity $backupRootIdentity
            $restoredBridge = Join-Path $live 'discord-bridge.mjs'
            if (-not (Test-Path -LiteralPath $restoredBridge -PathType Leaf) -or
                (Get-DeployHash -Path $restoredBridge) -cne $restoredBridgeRecord.OriginalHash) { throw 'Restored bridge is unavailable for command rollback' }
            Invoke-DeployCommandRegistration -NodePath $nodePath -BridgePath $restoredBridge -DeadlineMilliseconds $RegistrationDeadlineMilliseconds -OutputLimitBytes $RegistrationOutputLimitBytes
        }
        catch { $rollbackFailed = $true }
    }
    if (($serviceStopped -or $serviceMutationAttempted) -and $null -ne $priorStatus) {
        try {
            $powerShellPath = (Get-Command pwsh -ErrorAction Stop).Source
            $restoredControl = Join-Path $live 'codex-control.ps1'
            # A first upgrade may legitimately have no old control entrypoint. In that case the
            # fully hash-verified staged probe remains the trusted recovery path.
            [void](Restore-DeployBridgeState -PowerShellPath $powerShellPath -ProbePath $serviceProbePath -ToolDir $live -Expected $priorStatus.service -ControlPath $restoredControl)
        }
        catch { $rollbackFailed = $true }
    }
    if ($null -ne $priorGuardStatus) {
        try {
            # Always restore/verify the exact pre-deployment Guard state last. The source probe is
            # available even when failure happened before a complete stage existed.
            [void](Restore-DeployGuardState -PowerShellPath $powerShellPath -ProbePath $sourceProbePath -ToolDir $live -Expected $priorGuardStatus)
        }
        catch { $rollbackFailed = $true }
    }
    if ($rollbackFailed) { $terminalError = "Deployment failed and automatic rollback is incomplete; use backup: $backupRoot" }
    else { $terminalError = $primaryError }
}
finally {
    if (Test-Path -LiteralPath $stageRoot) {
        try { Remove-DeployStage -LiveIdentity $liveIdentity -StageIdentity $stageIdentity -InjectFailure:$InjectCleanupFailure }
        catch { $cleanupWarning = $true }
    }
}

if ($cleanupWarning) { Write-Warning 'deployment-stage-cleanup-failed: 部署暂存目录已保留，可安全重试或人工清理。' }
if ($null -ne $terminalError) { throw $terminalError }

Write-Output ("已部署 {0} 个受控文件；私密配置和运行状态保持不变。" -f $records.Count)
if ($SkipLiveActions) { Write-Output '已跳过服务、Discord 命令注册和桌面快捷方式操作。' }
elseif ($deploymentCommitted) { Write-Output 'Discord 桥接部署、控制程序和启动状态已更新。' }
