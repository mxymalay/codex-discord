Set-StrictMode -Version Latest

function Get-ControlPathHash {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    $normalized = [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/')).ToUpperInvariant()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($normalized)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Initialize-BridgeJobNative {
    if ('CodexBridgeJobNative' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CodexBridgeJobNative {
 [StructLayout(LayoutKind.Sequential)] public struct Basic { public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass,SchedulingClass; }
 [StructLayout(LayoutKind.Sequential)] public struct Io { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] public struct Extended { public Basic basic; public Io io; public UIntPtr process,job; public UIntPtr peakProcess,peakJob; }
 [StructLayout(LayoutKind.Sequential)] public struct Accounting { public long TotalUserTime,TotalKernelTime,ThisPeriodTotalUserTime,ThisPeriodTotalKernelTime; public uint TotalPageFaultCount,TotalProcesses,ActiveProcesses,TotalTerminatedProcesses; }
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr a,string n);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] public static extern IntPtr OpenJobObject(uint access,bool inherit,string n);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr j,int c,ref Extended i,int l);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr j,int c,out Accounting i,int l,IntPtr r);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool IsProcessInJob(IntPtr p,IntPtr j,out bool v);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool TerminateJobObject(IntPtr j,uint e);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
}
'@
}
function Get-BridgeJobName { param([Parameter(Mandatory)][string]$ToolDir) return ('Local\CodexDiscordBridgeJob-' + (Get-ControlPathHash $ToolDir)) }
function New-BridgeExtendedLimitInformation { Initialize-BridgeJobNative; $info=New-Object CodexBridgeJobNative+Extended; $info.basic.LimitFlags=0x2000; return $info }
function New-BridgeSupervisorJob {
 param([Parameter(Mandatory)][string]$ToolDir,[Parameter(Mandatory)][System.Diagnostics.Process]$Process)
 Initialize-BridgeJobNative; $job=[CodexBridgeJobNative]::CreateJobObject([IntPtr]::Zero,(Get-BridgeJobName $ToolDir)); if($job -eq [IntPtr]::Zero){throw 'bridge-job-create-failed'}
 try { $info=New-BridgeExtendedLimitInformation; if(-not [CodexBridgeJobNative]::SetInformationJobObject($job,9,[ref]$info,[Runtime.InteropServices.Marshal]::SizeOf($info))){throw 'bridge-job-configure-failed'}; [void]$Process.Handle; if(-not [CodexBridgeJobNative]::AssignProcessToJobObject($job,$Process.Handle)){throw 'bridge-job-assign-failed'}; return $job } catch { [CodexBridgeJobNative]::CloseHandle($job)|Out-Null; throw }
}
function Close-BridgeJob { param([IntPtr]$Handle) if($Handle -ne [IntPtr]::Zero){[CodexBridgeJobNative]::CloseHandle($Handle)|Out-Null} }

function ConvertTo-BridgeRuntimeTimeUtc {
    [CmdletBinding()]
    param([AllowNull()][object]$Value)

    if ($Value -is [DateTimeOffset]) {
        return $Value.ToUniversalTime()
    }
    if ($Value -is [DateTime]) {
        return ([DateTimeOffset]$Value).ToUniversalTime()
    }
    try {
        return [DateTimeOffset]::Parse([string]$Value, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
    }
    catch {
        return $null
    }
}

function Get-BridgeRuntimeProcessProperty {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Process,
        [Parameter(Mandatory)][string[]]$Names
    )

    foreach ($name in $Names) {
        $property = $Process.PSObject.Properties[$name]
        if ($null -ne $property) {
            return $property.Value
        }
    }
    return $null
}

function Invoke-WithBridgeRuntimeIdentityLock {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][scriptblock]$Action
    )

    $mutex = [System.Threading.Mutex]::new($false, ('Local\CodexDiscordBridgeRuntime-' + (Get-ControlPathHash -Path $Path)))
    $hasLock = $false
    try {
        $hasLock = $mutex.WaitOne([TimeSpan]::FromSeconds(5))
        if (-not $hasLock) { throw 'Bridge runtime identity lock timed out' }
        return & $Action
    }
    finally {
        if ($hasLock) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Write-BridgeRuntimeIdentity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][ValidateSet('scheduled', 'temporary')][string]$Mode,
        [Parameter(Mandatory)][ValidateRange(1, [int]::MaxValue)][int]$ProcessId,
        [Parameter(Mandatory)][object]$CreationTimeUtc,
        [Parameter(Mandatory)][string]$ToolDir
    )

    $creationTime = ConvertTo-BridgeRuntimeTimeUtc -Value $CreationTimeUtc
    if ($null -eq $creationTime) {
        throw 'Bridge runtime identity requires a valid creation time'
    }
    $identity = [ordered]@{
        version = 1
        processId = $ProcessId
        creationTimeUtc = $creationTime.ToString('o')
        mode = $Mode
        toolDirHash = Get-ControlPathHash -Path $ToolDir
    }
    return Invoke-WithBridgeRuntimeIdentityLock -Path $Path -Action {
        $directory = Split-Path -Parent $Path
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
            throw 'Bridge runtime identity directory is missing'
        }
        $temporaryPath = Join-Path $directory ('.' + [System.IO.Path]::GetFileName($Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
        [System.IO.File]::WriteAllText($temporaryPath, ($identity | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
        try {
            [System.IO.File]::Move($temporaryPath, $Path, $true)
        }
        finally {
            if (Test-Path -LiteralPath $temporaryPath) {
                Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
            }
        }
        return [pscustomobject]$identity
    }
}

function Read-ValidatedBridgeRuntimeIdentity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Processes,
        [Parameter(Mandatory)][string]$ToolDir
    )

    try {
        $identity = Read-BridgeRuntimeIdentityCandidate -Path $Path -ToolDir $ToolDir
        if ($null -eq $identity) { return $null }
        $processId = [int]$identity.processId
        $identityCreationTime = ConvertTo-BridgeRuntimeTimeUtc -Value $identity.creationTimeUtc
        foreach ($process in @($Processes)) {
            if ($null -eq $process) { continue }
            $candidateId = 0
            $candidateValue = Get-BridgeRuntimeProcessProperty -Process $process -Names @('ProcessId', 'Id')
            if (-not [int]::TryParse([string]$candidateValue, [ref]$candidateId) -or $candidateId -ne $processId) { continue }
            $candidateTime = ConvertTo-BridgeRuntimeTimeUtc -Value (Get-BridgeRuntimeProcessProperty -Process $process -Names @('CreationTimeUtc', 'StartTimeUtc', 'CreationDate', 'StartTime'))
            if ($null -ne $candidateTime -and $candidateTime.UtcDateTime.Ticks -eq $identityCreationTime.UtcDateTime.Ticks) {
                return [pscustomobject][ordered]@{
                    version = 1
                    processId = $processId
                    creationTimeUtc = $identityCreationTime.ToString('o')
                    mode = [string]$identity.mode
                    toolDirHash = [string]$identity.toolDirHash
                }
            }
        }
    }
    catch {}
    return $null
}

function Read-BridgeRuntimeIdentityCandidate {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$ToolDir
    )

    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
        $identity = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
        $processId = 0
        if ($identity.version -ne 1 -or -not [int]::TryParse([string]$identity.processId, [ref]$processId) -or $processId -le 0 -or $identity.mode -notin @('scheduled', 'temporary')) { return $null }
        $creationTime = ConvertTo-BridgeRuntimeTimeUtc -Value $identity.creationTimeUtc
        if ($null -eq $creationTime -or $identity.toolDirHash -cne (Get-ControlPathHash -Path $ToolDir)) { return $null }
        return [pscustomobject][ordered]@{ version=1; processId=$processId; creationTimeUtc=$creationTime.ToString('o'); mode=[string]$identity.mode; toolDirHash=[string]$identity.toolDirHash }
    }
    catch { return $null }
}

function Remove-BridgeRuntimeIdentity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][ValidateRange(1, [int]::MaxValue)][int]$ExpectedProcessId
    )

    try {
        return Invoke-WithBridgeRuntimeIdentityLock -Path $Path -Action {
            if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
            $identity = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
            $processId = 0
            if (-not [int]::TryParse([string]$identity.processId, [ref]$processId) -or $processId -ne $ExpectedProcessId) { return $false }
            Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
            return $true
        }
    }
    catch { return $false }
}

function ConvertTo-ScheduledTaskArgument {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Value)

    return '"' + $Value.Replace('"', '""') + '"'
}

function Get-DiscordBridgeTaskDefinition {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ToolDir,
        [Parameter(Mandatory)][string]$PowerShellPath
    )

    $fullToolDir = [System.IO.Path]::GetFullPath($ToolDir)
    $startupPath = Join-Path $fullToolDir 'start-discord-bridge.ps1'
    return [pscustomobject][ordered]@{
        TaskName = 'Codex Discord Bridge'
        Execute = [System.IO.Path]::GetFullPath($PowerShellPath)
        Arguments = '-NoProfile -File ' + (ConvertTo-ScheduledTaskArgument -Value $startupPath)
        WorkingDirectory = $fullToolDir
    }
}

function Format-BridgeGuardLogEntry {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Category,
        [Nullable[int]]$ExitCode,
        [Nullable[long]]$DurationMs,
        [DateTimeOffset]$Timestamp = [DateTimeOffset]::UtcNow
    )

    $allowedCategories = @('guard-started', 'bridge-exited', 'bridge-launch-failed', 'guard-event')
    $stableCategory = if ($allowedCategories -ccontains $Category) { $Category } else { 'guard-event' }
    $parts = @(
        $Timestamp.ToUniversalTime().ToString('o'),
        ('event={0}' -f $stableCategory)
    )
    if ($null -ne $ExitCode) {
        $parts += 'exitCode={0}' -f [int]$ExitCode
    }
    if ($null -ne $DurationMs) {
        $parts += 'durationMs={0}' -f [Math]::Max(0, [long]$DurationMs)
    }
    return $parts -join ' '
}
