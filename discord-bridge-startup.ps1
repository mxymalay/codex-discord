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
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            return $null
        }
        $identity = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
        $processId = 0
        if ($identity.version -ne 1 -or -not [int]::TryParse([string]$identity.processId, [ref]$processId) -or $processId -le 0 -or $identity.mode -notin @('scheduled', 'temporary')) {
            return $null
        }
        $identityCreationTime = ConvertTo-BridgeRuntimeTimeUtc -Value $identity.creationTimeUtc
        if ($null -eq $identityCreationTime -or $identity.toolDirHash -cne (Get-ControlPathHash -Path $ToolDir)) {
            return $null
        }
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
