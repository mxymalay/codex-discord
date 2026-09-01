[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceDispatcher = Join-Path (Split-Path -Parent $PSScriptRoot) 'dispatcher.ps1'
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = [System.IO.Path]::GetFullPath((Join-Path $tempBase ('codex-quota-state-tests-{0}' -f [guid]::NewGuid().ToString('N'))))

if (-not $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe temporary test path: $tempRoot"
}

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )

    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) {
        [void](New-Item -ItemType Directory -Path $parent -Force)
    }
    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-Value {
    param(
        [object]$Object,
        [string]$Name,
        $DefaultValue
    )

    if ($null -eq $Object) {
        return $DefaultValue
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) {
        return $DefaultValue
    }
    return $property.Value
}

function Set-BaselineState {
    param(
        [double]$Remaining,
        [string]$ObservedAt,
        [int64]$ResetsAt,
        [string]$LastChangeAt = $ObservedAt,
        [object]$LastRate = 1.0
    )

    $limit = [ordered]@{
        key = 'codex|primary|10080'
        name = 'weekly'
        slot = 'primary'
        windowMinutes = 10080
        usedPercent = [Math]::Round(100 - $Remaining, 2)
        remainingPercent = $Remaining
        resetsAt = $ResetsAt
        lastChangeAt = $LastChangeAt
        lastAcceptedObservedAt = $ObservedAt
        lastUsageRatePerHour = $LastRate
        lastAccelerationPerHourSquared = $null
        pendingIncreaseRemainingPercent = $null
        pendingIncreaseFirstObservedAt = $null
        pendingIncreaseLastObservedAt = $null
        pendingIncreaseConfirmations = 0
        pendingIncreaseSawMainTask = $false
    }
    $state = [ordered]@{
        observedAt = $ObservedAt
        limitId = 'codex'
        limits = @($limit)
    }
    Write-Utf8NoBom -Path $quotaStatePath -Content ($state | ConvertTo-Json -Depth 12)
}

function Add-SnapshotFixture {
    param(
        [string]$ThreadId,
        [double]$Remaining,
        [string]$ObservedAt,
        [int64]$ResetsAt,
        [switch]$MainTask
    )

    if ($MainTask) {
        $metadata = [ordered]@{
            id = $ThreadId
            session_id = $ThreadId
            parent_thread_id = $null
            thread_source = 'user'
            source = 'vscode'
        }
        $indexEntry = [ordered]@{ id = $ThreadId; thread_name = 'quota state root'; updated_at = $ObservedAt }
        $existingIndex = if (Test-Path -LiteralPath $sessionIndexPath) { Get-Content -Raw -LiteralPath $sessionIndexPath -Encoding UTF8 } else { '' }
        Write-Utf8NoBom -Path $sessionIndexPath -Content ($existingIndex + ($indexEntry | ConvertTo-Json -Compress) + "`n")
    }
    else {
        $parentId = [guid]::NewGuid().ToString()
        $metadata = [ordered]@{
            id = $ThreadId
            session_id = $parentId
            parent_thread_id = $parentId
            thread_source = 'subagent'
            source = @{ subagent = @{ thread_spawn = @{ parent_thread_id = $parentId; depth = 1 } } }
        }
    }

    $metaEntry = [ordered]@{ timestamp = $ObservedAt; type = 'session_meta'; payload = $metadata }
    $rateEntry = [ordered]@{
        timestamp = $ObservedAt
        type = 'event_msg'
        payload = [ordered]@{
            type = 'token_count'
            rate_limits = [ordered]@{
                limit_id = 'codex'
                primary = [ordered]@{
                    used_percent = [Math]::Round(100 - $Remaining, 2)
                    window_minutes = 10080
                    resets_at = $ResetsAt
                }
            }
        }
    }
    $content = (($metaEntry | ConvertTo-Json -Depth 12 -Compress) + "`n" + ($rateEntry | ConvertTo-Json -Depth 12 -Compress) + "`n")
    $path = Join-Path $sessionsPath "rollout-$ThreadId.jsonl"
    Write-Utf8NoBom -Path $path -Content $content
}

function Invoke-Snapshot {
    param(
        [string]$ThreadId,
        [switch]$Dry
    )

    $notification = [ordered]@{
        type = 'agent-turn-complete'
        'thread-id' = $ThreadId
        'turn-id' = [guid]::NewGuid().ToString()
        cwd = 'C:\workspace\quota-state-test'
        'input-messages' = @('quota state test')
        'last-assistant-message' = 'complete'
    }
    $raw = $notification | ConvertTo-Json -Depth 8 -Compress
    if ($Dry) {
        return ((@(& $testDispatcher $raw -MobileOnly -SkipTaskNotification -DryRun) | ForEach-Object { [string]$_ }) -join "`n").Trim()
    }
    return ((@(& $testDispatcher $raw -MobileOnly -SkipTaskNotification) | ForEach-Object { [string]$_ }) -join "`n").Trim()
}

function Get-StateLimit {
    $state = Get-Content -Raw -LiteralPath $quotaStatePath -Encoding UTF8 | ConvertFrom-Json
    return @($state.limits)[0]
}

function Assert-Equal {
    param(
        [string]$Name,
        $Expected,
        $Actual
    )

    $normalizedExpected = [string]$Expected
    $normalizedActual = if ($normalizedExpected -match 'Z\z' -and $Actual -is [DateTime]) {
        ([DateTime]$Actual).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    }
    elseif ($normalizedExpected -match 'Z\z' -and $Actual -is [DateTimeOffset]) {
        ([DateTimeOffset]$Actual).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    }
    else {
        [string]$Actual
    }

    if ($normalizedExpected -ne $normalizedActual) {
        throw "[$Name] expected '$Expected', got '$Actual'"
    }
}

try {
    $toolDir = Join-Path $tempRoot 'mobile-notify'
    $sessionsPath = Join-Path $tempRoot 'sessions'
    $sessionIndexPath = Join-Path $tempRoot 'session_index.jsonl'
    $quotaStatePath = Join-Path $toolDir 'quota-state.json'
    [void](New-Item -ItemType Directory -Path $toolDir -Force)
    [void](New-Item -ItemType Directory -Path $sessionsPath -Force)
    Copy-Item -LiteralPath $sourceDispatcher -Destination (Join-Path $toolDir 'dispatcher.ps1')
    $testDispatcher = Join-Path $toolDir 'dispatcher.ps1'

    $config = [ordered]@{
        enabled = $true
        provider = 'ntfy'
        endpoint = 'https://ntfy.invalid/task-topic'
        quotaEndpoint = 'https://ntfy.invalid/quota-topic'
        token = ''
        includeAssistantMessage = $true
        quotaNotifications = $true
        timeoutSeconds = 1
        previousNotify = @()
    }
    Write-Utf8NoBom -Path (Join-Path $toolDir 'config.json') -Content ($config | ConvertTo-Json -Depth 8)

    $stableReset = [DateTimeOffset]::Parse('2026-09-05T00:00:00Z').ToUnixTimeSeconds()

    # A one-second reset jitter must not create a new cycle or alter the stable reset.
    Set-BaselineState -Remaining 51 -ObservedAt '2026-08-31T10:00:00Z' -ResetsAt $stableReset -LastChangeAt '2026-08-31T09:50:00Z' -LastRate 2.0
    $jitterThread = [guid]::NewGuid().ToString()
    Add-SnapshotFixture -ThreadId $jitterThread -Remaining 51 -ObservedAt '2026-08-31T10:01:00Z' -ResetsAt ($stableReset + 1) -MainTask
    $jitterOutput = Invoke-Snapshot -ThreadId $jitterThread -Dry
    Assert-Equal -Name 'reset jitter output' -Expected '' -Actual $jitterOutput
    $jitterState = Get-StateLimit
    Assert-Equal -Name 'stable reset after jitter' -Expected $stableReset -Actual $jitterState.resetsAt
    Assert-Equal -Name 'last change preserved after jitter' -Expected '2026-08-31T09:50:00Z' -Actual $jitterState.lastChangeAt
    Assert-Equal -Name 'rate preserved after jitter' -Expected 2 -Actual $jitterState.lastUsageRatePerHour

    # A child-only rollback becomes a pending increase, then disappears without a notification.
    Set-BaselineState -Remaining 51 -ObservedAt '2026-08-31T10:01:32Z' -ResetsAt $stableReset -LastChangeAt '2026-08-31T10:01:32Z' -LastRate 6.143
    $rollbackChild = [guid]::NewGuid().ToString()
    Add-SnapshotFixture -ThreadId $rollbackChild -Remaining 52 -ObservedAt '2026-08-31T10:01:46Z' -ResetsAt $stableReset
    $candidateOutput = Invoke-Snapshot -ThreadId $rollbackChild
    Assert-Equal -Name 'first increase candidate output' -Expected '' -Actual $candidateOutput
    $candidateState = Get-StateLimit
    Assert-Equal -Name 'candidate keeps accepted remaining' -Expected 51 -Actual $candidateState.remainingPercent
    Assert-Equal -Name 'candidate remaining stored separately' -Expected 52 -Actual $candidateState.pendingIncreaseRemainingPercent
    Assert-Equal -Name 'candidate confirmation count' -Expected 1 -Actual $candidateState.pendingIncreaseConfirmations
    Assert-Equal -Name 'child candidate has no main confirmation' -Expected False -Actual $candidateState.pendingIncreaseSawMainTask

    $rollbackMain = [guid]::NewGuid().ToString()
    Add-SnapshotFixture -ThreadId $rollbackMain -Remaining 51 -ObservedAt '2026-08-31T10:02:20Z' -ResetsAt $stableReset -MainTask
    $rollbackOutput = Invoke-Snapshot -ThreadId $rollbackMain
    Assert-Equal -Name 'rollback recovery output' -Expected '' -Actual $rollbackOutput
    $rollbackState = Get-StateLimit
    Assert-Equal -Name 'rollback accepted remaining' -Expected 51 -Actual $rollbackState.remainingPercent
    Assert-Equal -Name 'rollback clears pending remaining' -Expected '' -Actual (Get-Value -Object $rollbackState -Name 'pendingIncreaseRemainingPercent' -DefaultValue '')
    Assert-Equal -Name 'rollback preserves rate' -Expected 6.143 -Actual $rollbackState.lastUsageRatePerHour

    # A sidebar main task confirms an increase immediately; no later task is required.
    Set-BaselineState -Remaining 51 -ObservedAt '2026-08-31T10:30:00Z' -ResetsAt $stableReset -LastChangeAt '2026-08-31T10:00:00Z' -LastRate 1.0
    $singleMainIncrease = [guid]::NewGuid().ToString()
    Add-SnapshotFixture -ThreadId $singleMainIncrease -Remaining 60 -ObservedAt '2026-08-31T10:30:10Z' -ResetsAt $stableReset -MainTask
    $singleMainOutput = Invoke-Snapshot -ThreadId $singleMainIncrease -Dry
    if ([string]::IsNullOrWhiteSpace($singleMainOutput)) {
        throw '[single main increase] expected an immediate quota notification'
    }
    $singleMainMessage = $singleMainOutput | ConvertFrom-Json
    Assert-Equal -Name 'single main increase event' -Expected 'quota-changed' -Actual $singleMainMessage.event

    # A full 100 percent reset is definitive even when its first snapshot comes from a child.
    Set-BaselineState -Remaining 51 -ObservedAt '2026-08-31T10:40:00Z' -ResetsAt $stableReset -LastChangeAt '2026-08-31T10:30:00Z' -LastRate 1.0
    $fullResetChild = [guid]::NewGuid().ToString()
    Add-SnapshotFixture -ThreadId $fullResetChild -Remaining 100 -ObservedAt '2026-08-31T10:40:10Z' -ResetsAt ($stableReset + 604800)
    $fullResetOutput = Invoke-Snapshot -ThreadId $fullResetChild -Dry
    if ([string]::IsNullOrWhiteSpace($fullResetOutput)) {
        throw '[full reset child] expected an immediate quota reset notification'
    }
    $fullResetMessage = $fullResetOutput | ConvertFrom-Json
    Assert-Equal -Name 'full reset child event' -Expected 'quota-changed' -Actual $fullResetMessage.event

    # A child candidate is accepted as soon as the current sidebar main task confirms it.
    Set-BaselineState -Remaining 51 -ObservedAt '2026-08-31T11:00:00Z' -ResetsAt $stableReset -LastChangeAt '2026-08-31T10:30:00Z' -LastRate 1.0
    $confirmChild = [guid]::NewGuid().ToString()
    Add-SnapshotFixture -ThreadId $confirmChild -Remaining 60 -ObservedAt '2026-08-31T11:00:10Z' -ResetsAt $stableReset
    $firstConfirmOutput = Invoke-Snapshot -ThreadId $confirmChild
    Assert-Equal -Name 'real increase first observation output' -Expected '' -Actual $firstConfirmOutput
    $confirmMain = [guid]::NewGuid().ToString()
    Add-SnapshotFixture -ThreadId $confirmMain -Remaining 59 -ObservedAt '2026-08-31T11:00:15Z' -ResetsAt $stableReset -MainTask
    $confirmedOutput = Invoke-Snapshot -ThreadId $confirmMain -Dry
    if ([string]::IsNullOrWhiteSpace($confirmedOutput)) {
        throw '[confirmed increase] expected one quota notification after confirmation'
    }
    $confirmedMessage = $confirmedOutput | ConvertFrom-Json
    Assert-Equal -Name 'confirmed increase event' -Expected 'quota-changed' -Actual $confirmedMessage.event

    # An older snapshot must neither notify nor modify state.
    Set-BaselineState -Remaining 50 -ObservedAt '2026-08-31T12:00:00Z' -ResetsAt $stableReset -LastChangeAt '2026-08-31T11:30:00Z' -LastRate 1.5
    $beforeStaleHash = (Get-FileHash -LiteralPath $quotaStatePath -Algorithm SHA256).Hash
    $staleThread = [guid]::NewGuid().ToString()
    Add-SnapshotFixture -ThreadId $staleThread -Remaining 49 -ObservedAt '2026-08-31T11:59:00Z' -ResetsAt $stableReset -MainTask
    $staleOutput = Invoke-Snapshot -ThreadId $staleThread -Dry
    Assert-Equal -Name 'stale snapshot output' -Expected '' -Actual $staleOutput
    $afterStaleHash = (Get-FileHash -LiteralPath $quotaStatePath -Algorithm SHA256).Hash
    Assert-Equal -Name 'dry stale snapshot leaves state unchanged' -Expected $beforeStaleHash -Actual $afterStaleHash

    # DryRun must not persist a pending candidate.
    $dryCandidateThread = [guid]::NewGuid().ToString()
    Add-SnapshotFixture -ThreadId $dryCandidateThread -Remaining 55 -ObservedAt '2026-08-31T12:01:00Z' -ResetsAt $stableReset
    $beforeDryHash = (Get-FileHash -LiteralPath $quotaStatePath -Algorithm SHA256).Hash
    $dryCandidateOutput = Invoke-Snapshot -ThreadId $dryCandidateThread -Dry
    Assert-Equal -Name 'dry candidate output' -Expected '' -Actual $dryCandidateOutput
    $afterDryHash = (Get-FileHash -LiteralPath $quotaStatePath -Algorithm SHA256).Hash
    Assert-Equal -Name 'dry candidate leaves state unchanged' -Expected $beforeDryHash -Actual $afterDryHash

    Write-Output 'PASS: quota snapshot state machine cases'
}
finally {
    if ((Test-Path -LiteralPath $tempRoot) -and $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
