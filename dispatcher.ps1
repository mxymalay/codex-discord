[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$NotificationJson = '',

    [string]$NotificationFile = '',

    [switch]$MobileOnly,

    [switch]$SkipTaskNotification,

    [switch]$SendQuotaStatus,

    [switch]$FallbackInvocation,

    [switch]$DryRun,

    [ValidateSet('', 'task', 'confirmation', 'quota')]
    [string]$SystemTestEvent = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$toolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$codexRoot = if (-not [string]::IsNullOrWhiteSpace($env:CODEX_HOME) -and [IO.Path]::IsPathRooted($env:CODEX_HOME)) {
    [IO.Path]::GetFullPath($env:CODEX_HOME)
} elseif ((Split-Path -Leaf $toolDir) -eq 'mobile-notify') {
    Split-Path -Parent $toolDir
} else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' }
$configPath = Join-Path $toolDir 'config.json'
$logPath = Join-Path $toolDir 'mobile-notify.log'
$quotaStatePath = Join-Path $toolDir 'quota-state.json'
$discordMessageMapPath = Join-Path $toolDir 'discord-message-map.json'
$discordInboxStatePath = Join-Path $toolDir 'discord-inbox-state.json'
$taskDeliveryStatePath = Join-Path $toolDir 'task-delivery-state.json'
$sessionIndexPath = Join-Path $codexRoot 'session_index.jsonl'
$sessionsPath = Join-Path $codexRoot 'sessions'

$discordSecretModule = Join-Path $toolDir 'discord-secret.ps1'
$discordStateModule = Join-Path $toolDir 'discord-state.ps1'
$discordHttpModule = Join-Path $toolDir 'discord-http.ps1'
$taskDeliveryStateModule = Join-Path $toolDir 'task-delivery-state.ps1'
if (Test-Path -LiteralPath $discordSecretModule) {
    . $discordSecretModule
}
if (Test-Path -LiteralPath $discordStateModule) {
    . $discordStateModule
}
if (Test-Path -LiteralPath $discordHttpModule) {
    . $discordHttpModule
}
if (Test-Path -LiteralPath $taskDeliveryStateModule) {
    . $taskDeliveryStateModule
}

function Write-NotifyLog {
    param([string]$Message)

    try {
        $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
        Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
    }
    catch {
        # A notification failure must never interrupt Codex.
    }
}

function Get-OptionalValue {
    param(
        [object]$Object,
        [string]$Name,
        $DefaultValue
    )

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) {
        return $DefaultValue
    }
    return $property.Value
}

function ConvertTo-DateTimeOffsetValue {
    param([Parameter(Mandatory)][object]$Value)

    if ($Value -is [DateTimeOffset]) {
        return [DateTimeOffset]$Value
    }
    if ($Value -is [DateTime]) {
        return [DateTimeOffset]::new(([DateTime]$Value).ToUniversalTime())
    }
    return [DateTimeOffset]::Parse([string]$Value)
}

function ConvertTo-CompactText {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ''
    }
    return [regex]::Replace($Value, '\s+', ' ').Trim()
}

function Get-LastUserMessage {
    param([object]$Notification)

    $inputMessages = @(Get-OptionalValue -Object $Notification -Name 'input-messages' -DefaultValue @())
    if ($inputMessages.Count -eq 0) {
        return ''
    }

    $message = ConvertTo-CompactText -Value ([string]$inputMessages[$inputMessages.Count - 1])
    $requestMarker = '## My request:'
    $markerIndex = $message.LastIndexOf($requestMarker, [System.StringComparison]::OrdinalIgnoreCase)
    if ($markerIndex -ge 0) {
        $requestOnly = $message.Substring($markerIndex + $requestMarker.Length).Trim()
        if (-not [string]::IsNullOrWhiteSpace($requestOnly)) {
            $message = $requestOnly
        }
    }
    return $message
}

function Test-IsHeartbeatNotification {
    param([object]$Notification)

    $message = Get-LastUserMessage -Notification $Notification
    if ([string]::IsNullOrWhiteSpace($message)) {
        return $false
    }

    return $message -match '(?is)^<heartbeat(?:\s[^>]*)?>.*</heartbeat>\s*$'
}

function Test-IsInternalNotification {
    param([object]$Notification)

    $inputMessages = @(Get-OptionalValue -Object $Notification -Name 'input-messages' -DefaultValue @())
    if ($inputMessages.Count -eq 0) {
        return $true
    }

    $inputText = ($inputMessages | ForEach-Object { [string]$_ }) -join "`n"
    $internalPatterns = @(
        '(?is)You are a helpful assistant\..{0,600}short title for a task',
        '(?is)# Overview\s+Generate 0 to 3 hyperpersonalized suggestions',
        '(?is)You are an expert at upholding safety and compliance standards for Codex ambient suggestions'
    )
    foreach ($pattern in $internalPatterns) {
        if ($inputText -match $pattern) {
            return $true
        }
    }
    return $false
}

function Get-SidebarThreadEntry {
    param([string]$ThreadId)

    if ([string]::IsNullOrWhiteSpace($ThreadId) -or -not (Test-Path -LiteralPath $sessionIndexPath)) {
        return $null
    }

    $matchingEntry = $null
    try {
        foreach ($line in @(Get-Content -LiteralPath $sessionIndexPath -Encoding UTF8 -ErrorAction Stop)) {
            if ([string]::IsNullOrWhiteSpace($line) -or $line -notlike "*$ThreadId*") {
                continue
            }
            try {
                $entry = $line | ConvertFrom-Json
                if ([string](Get-OptionalValue -Object $entry -Name 'id' -DefaultValue '') -ieq $ThreadId) {
                    $matchingEntry = $entry
                }
            }
            catch {
                continue
            }
        }
    }
    catch {
        return $null
    }

    return $matchingEntry
}

function Get-SessionMetadataForThread {
    param([string]$ThreadId)

    if ($ThreadId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
        return $null
    }
    if (-not (Test-Path -LiteralPath $sessionsPath)) {
        return $null
    }

    try {
        $candidates = @(Get-ChildItem -LiteralPath $sessionsPath -Recurse -File -Filter "*$ThreadId*.jsonl" -ErrorAction Stop | Sort-Object LastWriteTimeUtc -Descending)
    }
    catch {
        return $null
    }

    foreach ($candidate in $candidates) {
        try {
            foreach ($line in @(Get-Content -LiteralPath $candidate.FullName -TotalCount 20 -Encoding UTF8 -ErrorAction Stop)) {
                if ([string]::IsNullOrWhiteSpace($line)) {
                    continue
                }
                try {
                    $entry = $line | ConvertFrom-Json
                }
                catch {
                    continue
                }
                if ([string](Get-OptionalValue -Object $entry -Name 'type' -DefaultValue '') -ne 'session_meta') {
                    continue
                }
                $payload = Get-OptionalValue -Object $entry -Name 'payload' -DefaultValue $null
                if ($null -eq $payload) {
                    continue
                }
                if ([string](Get-OptionalValue -Object $payload -Name 'id' -DefaultValue '') -ieq $ThreadId) {
                    return $payload
                }
            }
        }
        catch {
            continue
        }
    }

    return $null
}

function Read-ArchivedRootTurnCandidate {
    param([string]$Path, [string]$ThreadId, [string]$TurnId)

    $before = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($before.PSIsContainer -or ($before.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $before.Length -eq 0) {
        throw 'Archive candidate is not a nonempty regular file.'
    }
    $initialLength = $before.Length
    $initialWriteTicks = $before.LastWriteTimeUtc.Ticks
    $stream = $null
    $lineBuffer = New-Object IO.MemoryStream
    $utf8 = New-Object Text.UTF8Encoding($false, $true)
    $buffer = New-Object byte[] 65536
    $maxLineBytes = 8 * 1024 * 1024
    $lineNumber = 0
    $currentMetadata = $null
    $targetMetadata = $null
    $sawMatchingMetadata = $false
    $targetStarts = 0
    $targetCompletes = 0
    $targetOpen = $false
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        while (($bytesRead = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $offset = 0
            while ($offset -lt $bytesRead) {
                $newline = [Array]::IndexOf($buffer, [byte]10, $offset, $bytesRead - $offset)
                $end = if ($newline -lt 0) { $bytesRead } else { $newline }
                $count = $end - $offset
                if ($lineBuffer.Length + $count -gt $maxLineBytes) { throw 'Archive JSONL line exceeds the size limit.' }
                $lineBuffer.Write($buffer, $offset, $count)
                $offset = $end + 1
                if ($newline -lt 0) { continue }

                $lineNumber++
                $line = $utf8.GetString($lineBuffer.GetBuffer(), 0, [int]$lineBuffer.Length)
                $lineBuffer.SetLength(0)
                if ($lineNumber -eq 1) { $line = $line.TrimStart([char]0xFEFF) }
                if ([string]::IsNullOrWhiteSpace($line)) { continue }
                $entry = $line | ConvertFrom-Json -ErrorAction Stop
                $entryType = [string](Get-OptionalValue -Object $entry -Name 'type' -DefaultValue '')
                if ($entry -isnot [System.Management.Automation.PSCustomObject] -or [string]::IsNullOrWhiteSpace($entryType)) {
                    throw 'Archive JSONL entry cannot be classified.'
                }
                $payload = Get-OptionalValue -Object $entry -Name 'payload' -DefaultValue $null
                if ($entryType -eq 'session_meta') {
                    if ($targetOpen) { throw 'Session metadata changed inside the archived target turn.' }
                    if ($payload -isnot [System.Management.Automation.PSCustomObject]) { throw 'Archive session metadata is invalid.' }
                    $currentMetadata = $payload
                    if ([string](Get-OptionalValue -Object $payload -Name 'id' -DefaultValue '') -ieq $ThreadId) { $sawMatchingMetadata = $true }
                    continue
                }
                if ($entryType -ne 'event_msg') { continue }
                if ($payload -isnot [System.Management.Automation.PSCustomObject]) { throw 'Archive event payload is invalid.' }
                $eventType = [string](Get-OptionalValue -Object $payload -Name 'type' -DefaultValue '')
                $eventTurnId = [string](Get-OptionalValue -Object $payload -Name 'turn_id' -DefaultValue '')
                if ($eventType -eq 'task_started') {
                    if ($targetOpen) { throw 'Another turn start interrupted the archived target turn.' }
                    if ($eventTurnId -ine $TurnId) { continue }
                    $targetStarts++
                    if ($targetStarts -ne 1 -or [string](Get-OptionalValue -Object $currentMetadata -Name 'id' -DefaultValue '') -ine $ThreadId) {
                        throw 'Archived target turn does not have unique matching session metadata.'
                    }
                    $targetMetadata = $currentMetadata
                    $targetOpen = $true
                }
                elseif ($eventType -eq 'task_complete') {
                    if ($targetOpen -and $eventTurnId -ine $TurnId) { throw 'Another completion interrupted the archived target turn.' }
                    if ($eventTurnId -ine $TurnId) { continue }
                    $targetCompletes++
                    if (-not $targetOpen -or $targetCompletes -ne 1) { throw 'Archived target completion does not have a unique start.' }
                    $targetOpen = $false
                }
            }
        }
        if ($lineBuffer.Length -ne 0 -or $targetOpen -or -not $sawMatchingMetadata) {
            throw 'Archive candidate is incomplete or lacks matching session metadata.'
        }
        $after = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if (($after.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $after.Length -ne $initialLength -or $after.LastWriteTimeUtc.Ticks -ne $initialWriteTicks) {
            throw 'Archive candidate changed while being read.'
        }
        return [pscustomobject]@{ HasTurn = ($targetStarts -eq 1 -and $targetCompletes -eq 1); Metadata = $targetMetadata }
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
        $lineBuffer.Dispose()
    }
}

function Get-ArchivedSessionMetadataForTurn {
    param([string]$ThreadId, [string]$TurnId)

    $uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    if ($ThreadId -notmatch $uuidPattern -or $TurnId -notmatch $uuidPattern) { return $null }
    try {
        # Only the controlled sibling of sessions is searched; notification paths are never trusted.
        $archiveRoot = Join-Path (Split-Path -Parent $sessionsPath) 'archived_sessions'
        $root = Get-Item -LiteralPath $archiveRoot -Force -ErrorAction Stop
        if (-not $root.PSIsContainer -or ($root.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $null }
        $directories = New-Object 'System.Collections.Generic.Stack[string]'
        $directories.Push($root.FullName)
        $metadata = $null
        $claimants = 0
        $candidatePattern = '(?i)(?:^|[-_])' + [regex]::Escape($ThreadId) + '$'
        while ($directories.Count -gt 0) {
            $directory = Get-Item -LiteralPath $directories.Pop() -Force -ErrorAction Stop
            if (-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $null }
            foreach ($candidate in @(Get-ChildItem -LiteralPath $directory.FullName -Force -ErrorAction Stop)) {
                if ($candidate.PSIsContainer) {
                    # An unreadable or linked subtree could conceal a second claimant.
                    if (($candidate.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $null }
                    $directories.Push($candidate.FullName)
                    continue
                }
                if ($candidate.Extension -ine '.jsonl' -or $candidate.BaseName -notmatch $candidatePattern) { continue }
                $result = Read-ArchivedRootTurnCandidate -Path $candidate.FullName -ThreadId $ThreadId -TurnId $TurnId
                if ($result.HasTurn) {
                    $claimants++
                    if ($claimants -gt 1) { return $null }
                    $metadata = $result.Metadata
                }
            }
        }
        if ($claimants -eq 1) { return $metadata }
    }
    catch {
        # Any candidate that cannot be classified leaves uniqueness unproven.
        return $null
    }
    return $null
}

function Get-TaskNotificationEligibility {
    param([object]$Notification)

    $threadId = [string](Get-OptionalValue -Object $Notification -Name 'thread-id' -DefaultValue '')
    if ([string]::IsNullOrWhiteSpace($threadId)) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'missing thread id' }
    }

    $sidebarEntry = Get-SidebarThreadEntry -ThreadId $threadId
    if ($null -eq $sidebarEntry) {
        $discordOrigin = Get-VerifiedDiscordTurnOriginRecord -Notification $Notification
        if ($null -eq $discordOrigin) {
            return [pscustomobject]@{ Allowed = $false; Reason = 'thread is not present in the sidebar task index or trusted Discord origin state' }
        }
        return Get-ExactDiscordRootTurnEligibility -Notification $Notification
    }

    $metadata = Get-SessionMetadataForThread -ThreadId $threadId
    if ($null -eq $metadata) {
        $turnId = [string](Get-OptionalValue -Object $Notification -Name 'turn-id' -DefaultValue '')
        $metadata = Get-ArchivedSessionMetadataForTurn -ThreadId $threadId -TurnId $turnId
    }
    if ($null -eq $metadata) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'matching session metadata is unavailable' }
    }

    $metadataId = [string](Get-OptionalValue -Object $metadata -Name 'id' -DefaultValue '')
    if ($metadataId -ine $threadId) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'session metadata id does not match the completed thread' }
    }

    $threadSource = [string](Get-OptionalValue -Object $metadata -Name 'thread_source' -DefaultValue '')
    if ($threadSource -ieq 'subagent') {
        return [pscustomobject]@{ Allowed = $false; Reason = 'thread_source marks this turn as a subagent' }
    }
    if (-not [string]::IsNullOrWhiteSpace($threadSource) -and $threadSource -ine 'user') {
        return [pscustomobject]@{ Allowed = $false; Reason = 'thread_source is not a recognized user task' }
    }

    $source = Get-OptionalValue -Object $metadata -Name 'source' -DefaultValue $null
    if ($null -ne $source) {
        $subagentProperty = $source.PSObject.Properties['subagent']
        if ($null -ne $subagentProperty -and $null -ne $subagentProperty.Value) {
            return [pscustomobject]@{ Allowed = $false; Reason = 'session source contains subagent spawn metadata' }
        }
    }

    $parentThreadId = [string](Get-OptionalValue -Object $metadata -Name 'parent_thread_id' -DefaultValue '')
    if (-not [string]::IsNullOrWhiteSpace($parentThreadId)) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'session has a parent thread' }
    }

    $sessionId = [string](Get-OptionalValue -Object $metadata -Name 'session_id' -DefaultValue '')
    if (-not [string]::IsNullOrWhiteSpace($sessionId) -and $sessionId -ine $threadId) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'session id belongs to a parent task' }
    }

    return [pscustomobject]@{ Allowed = $true; Reason = 'user-visible sidebar root task' }
}

function Read-SharedUtf8Lines {
    param([string]$Path)

    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $true)
    try {
        while (-not $reader.EndOfStream) {
            Write-Output -NoEnumerate $reader.ReadLine()
        }
    }
    finally {
        $reader.Dispose()
    }
}

function Add-NotificationTurnSupport {
    param([object]$Notification)

    $model = ([string](Get-OptionalValue -Object $Notification -Name 'model' -DefaultValue '')).Trim()
    $effort = ([string](Get-OptionalValue -Object $Notification -Name 'reasoning-effort' -DefaultValue '')).Trim()
    if ($model -match '\A[A-Za-z0-9._-]{1,80}\z' -and $effort -match '\A[A-Za-z0-9._-]{1,40}\z') {
        return $Notification
    }

    $threadId = [string](Get-OptionalValue -Object $Notification -Name 'thread-id' -DefaultValue '')
    $turnId = [string](Get-OptionalValue -Object $Notification -Name 'turn-id' -DefaultValue '')
    $uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    if ($threadId -notmatch $uuidPattern -or $turnId -notmatch $uuidPattern -or -not (Test-Path -LiteralPath $sessionsPath -PathType Container)) {
        return $Notification
    }

    try {
        $escapedThreadId = [regex]::Escape($threadId)
        $candidates = @(Get-ChildItem -LiteralPath $sessionsPath -Recurse -File -Filter "*$threadId*.jsonl" -ErrorAction Stop |
            Where-Object {
                $_.BaseName -match "(?i)(?:^|[-_])$escapedThreadId$" -and
                ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0 -and
                $_.Length -gt 0
            })
        if ($candidates.Count -ne 1) {
            return $Notification
        }

        $matchingContext = $null
        foreach ($line in (Read-SharedUtf8Lines -Path $candidates[0].FullName)) {
            if ([string]::IsNullOrWhiteSpace($line)) {
                continue
            }
            try {
                $entry = $line | ConvertFrom-Json
            }
            catch {
                continue
            }
            if ([string](Get-OptionalValue -Object $entry -Name 'type' -DefaultValue '') -ne 'turn_context') {
                continue
            }
            $payload = Get-OptionalValue -Object $entry -Name 'payload' -DefaultValue $null
            if ($null -ne $payload -and [string](Get-OptionalValue -Object $payload -Name 'turn_id' -DefaultValue '') -ceq $turnId) {
                $matchingContext = $payload
            }
        }
        if ($null -eq $matchingContext) {
            return $Notification
        }

        $rolloutModel = ([string](Get-OptionalValue -Object $matchingContext -Name 'model' -DefaultValue '')).Trim()
        $rolloutEffort = ([string](Get-OptionalValue -Object $matchingContext -Name 'effort' -DefaultValue '')).Trim()
        if ($rolloutModel -notmatch '\A[A-Za-z0-9._-]{1,80}\z' -or $rolloutEffort -notmatch '\A[A-Za-z0-9._-]{1,40}\z') {
            return $Notification
        }
        $Notification | Add-Member -NotePropertyName 'model' -NotePropertyValue $rolloutModel -Force
        $Notification | Add-Member -NotePropertyName 'reasoning-effort' -NotePropertyValue $rolloutEffort -Force
    }
    catch {
        return $Notification
    }
    return $Notification
}

function Get-ExactDiscordRootTurnEligibility {
    param([object]$Notification)

    $threadId = [string](Get-OptionalValue -Object $Notification -Name 'thread-id' -DefaultValue '')
    $turnId = [string](Get-OptionalValue -Object $Notification -Name 'turn-id' -DefaultValue '')
    $uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    if ($threadId -notmatch $uuidPattern -or $turnId -notmatch $uuidPattern -or -not (Test-Path -LiteralPath $sessionsPath -PathType Container)) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'Discord origin does not identify an exact persisted root turn' }
    }

    try {
        $escapedThreadId = [regex]::Escape($threadId)
        $candidates = @(Get-ChildItem -LiteralPath $sessionsPath -Recurse -File -Filter "*$threadId*.jsonl" -ErrorAction Stop |
            Where-Object { $_.BaseName -match "(?i)(?:^|[-_])$escapedThreadId$" })
    }
    catch {
        return [pscustomobject]@{ Allowed = $false; Reason = 'Discord root rollout lookup failed' }
    }

    $claimants = @()
    foreach ($candidate in $candidates) {
        try {
            if (($candidate.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $candidate.Length -le 0) {
                continue
            }
            $matchingMetadata = @()
            $hasExactTurn = $false
            foreach ($line in (Read-SharedUtf8Lines -Path $candidate.FullName)) {
                if ([string]::IsNullOrWhiteSpace($line)) {
                    continue
                }
                try {
                    $entry = $line | ConvertFrom-Json
                }
                catch {
                    continue
                }
                $entryType = [string](Get-OptionalValue -Object $entry -Name 'type' -DefaultValue '')
                $payload = Get-OptionalValue -Object $entry -Name 'payload' -DefaultValue $null
                if ($null -eq $payload) {
                    continue
                }
                if ($entryType -eq 'session_meta' -and [string](Get-OptionalValue -Object $payload -Name 'id' -DefaultValue '') -ceq $threadId) {
                    $matchingMetadata += $payload
                    continue
                }
                if ($entryType -eq 'event_msg' -and
                    [string](Get-OptionalValue -Object $payload -Name 'type' -DefaultValue '') -ceq 'task_started' -and
                    [string](Get-OptionalValue -Object $payload -Name 'turn_id' -DefaultValue '') -ceq $turnId) {
                    $hasExactTurn = $true
                }
            }
            if ($matchingMetadata.Count -eq 0) {
                continue
            }
            $claimants += [pscustomobject]@{
                Metadata = if ($matchingMetadata.Count -eq 1) { $matchingMetadata[0] } else { $null }
                HasExactTurn = $hasExactTurn
            }
        }
        catch {
            return [pscustomobject]@{ Allowed = $false; Reason = 'Discord root rollout could not be verified' }
        }
    }

    if ($claimants.Count -ne 1 -or $null -eq $claimants[0].Metadata -or -not [bool]$claimants[0].HasExactTurn) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'Discord origin rollout is missing, ambiguous, or does not contain the exact turn' }
    }

    $metadata = $claimants[0].Metadata
    $threadSource = [string](Get-OptionalValue -Object $metadata -Name 'thread_source' -DefaultValue '')
    $parentThreadId = [string](Get-OptionalValue -Object $metadata -Name 'parent_thread_id' -DefaultValue '')
    $sessionId = [string](Get-OptionalValue -Object $metadata -Name 'session_id' -DefaultValue '')
    if ((-not [string]::IsNullOrWhiteSpace($threadSource) -and $threadSource -ine 'user') -or
        -not [string]::IsNullOrWhiteSpace($parentThreadId) -or
        (-not [string]::IsNullOrWhiteSpace($sessionId) -and $sessionId -ine $threadId)) {
        return [pscustomobject]@{ Allowed = $false; Reason = 'Discord origin rollout is not a root user task' }
    }
    $source = Get-OptionalValue -Object $metadata -Name 'source' -DefaultValue $null
    if ($null -ne $source -and $source -isnot [string]) {
        $subagentProperty = $source.PSObject.Properties |
            Where-Object { $_.Name -ieq 'subagent' } |
            Select-Object -First 1
        if ($null -ne $subagentProperty -and $null -ne $subagentProperty.Value) {
            return [pscustomobject]@{ Allowed = $false; Reason = 'Discord origin rollout contains subagent metadata' }
        }
    }

    return [pscustomobject]@{ Allowed = $true; Reason = 'trusted Discord origin maps to an exact root task turn' }
}

function Get-TaskName {
    param(
        [object]$Notification,
        [string]$TaskMessage
    )

    $threadId = [string](Get-OptionalValue -Object $Notification -Name 'thread-id' -DefaultValue '')
    if (-not [string]::IsNullOrWhiteSpace($threadId)) {
        $matchingEntry = Get-SidebarThreadEntry -ThreadId $threadId
        if ($null -ne $matchingEntry) {
            $threadName = ConvertTo-CompactText -Value ([string](Get-OptionalValue -Object $matchingEntry -Name 'thread_name' -DefaultValue ''))
            if (-not [string]::IsNullOrWhiteSpace($threadName)) {
                return $threadName
            }
        }
    }

    if ([string]::IsNullOrWhiteSpace($TaskMessage)) {
        return '未命名任务'
    }
    if ($TaskMessage.Length -gt 30) {
        return $TaskMessage.Substring(0, 30) + '…'
    }
    return $TaskMessage
}

function Get-NotificationProjectName {
    param([object]$Notification)

    $origin = Get-VerifiedDiscordTurnOriginRecord -Notification $Notification
    if ($null -ne $origin) {
        $persistedName = ConvertTo-CompactText -Value ([string](Get-OptionalValue -Object $origin -Name 'projectName' -DefaultValue ''))
        if (-not [string]::IsNullOrWhiteSpace($persistedName)) {
            return $persistedName
        }
    }
    $cwd = [string](Get-OptionalValue -Object $Notification -Name 'cwd' -DefaultValue '')
    if ([string]::IsNullOrWhiteSpace($cwd)) {
        return '任务'
    }
    return Split-Path -Leaf $cwd.TrimEnd('\', '/')
}

function Assert-CurrentProjectNotificationsEnabled {
    # A dispatcher may outlive the console stop that changed its initial config.
    # Re-read at each actual outbound boundary, including Discord's fallback route.
    try {
        $item = Get-Item -LiteralPath $configPath -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Invalid notification configuration' }
        $current = [Text.Json.JsonDocument]::Parse([IO.File]::ReadAllText($configPath))
        try {
            $enabled = [Text.Json.JsonElement]::new()
            if ($current.RootElement.ValueKind -eq [Text.Json.JsonValueKind]::Object -and
                $current.RootElement.TryGetProperty('enabled', [ref]$enabled) -and
                $enabled.ValueKind -eq [Text.Json.JsonValueKind]::True) { return }
        } finally { $current.Dispose() }
    } catch {}
    throw [OperationCanceledException]::new('Project notifications are disabled or configuration is unavailable')
}

function Invoke-JsonPost {
    param(
        [string]$Uri,
        [object]$Payload,
        [int]$TimeoutSeconds
    )

    $json = $Payload | ConvertTo-Json -Depth 8 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    Assert-CurrentProjectNotificationsEnabled
    Invoke-RestMethod -Method Post -Uri $Uri -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec $TimeoutSeconds | Out-Null
}

function Limit-DiscordText {
    param(
        [string]$Value,
        [int]$MaximumLength
    )

    if ([string]::IsNullOrEmpty($Value) -or $Value.Length -le $MaximumLength) {
        return $Value
    }
    if ($MaximumLength -le 1) {
        return $Value.Substring(0, $MaximumLength)
    }
    return $Value.Substring(0, $MaximumLength - 1) + '…'
}

function ConvertTo-DiscordMarkdownValue {
    param([string]$Value)

    if ([string]::IsNullOrEmpty($Value)) {
        return $Value
    }
    return [regex]::Replace(
        $Value,
        '[\\`*_{}\[\]()<>#+\-.!|~>]',
        [System.Text.RegularExpressions.MatchEvaluator]{ param($match) '\' + $match.Value }
    )
}

function ConvertTo-DiscordMarkdownBody {
    param([string]$Value)

    if ([string]::IsNullOrEmpty($Value)) {
        return $Value
    }
    $lines = $Value -split '\r?\n'
    $escaped = foreach ($line in $lines) {
        $labelMatch = [regex]::Match($line, '\A([^：\r\n]{1,24})：(.*)\z')
        if ($labelMatch.Success) {
            $label = ConvertTo-DiscordMarkdownValue -Value $labelMatch.Groups[1].Value
            $content = ConvertTo-DiscordMarkdownValue -Value $labelMatch.Groups[2].Value
            "**$label：**$content"
        }
        else {
            ConvertTo-DiscordMarkdownValue -Value $line
        }
    }
    return $escaped -join "`n"
}

function Get-NotificationSupportLine {
    param([object]$Notification)

    $model = ([string](Get-OptionalValue -Object $Notification -Name 'model' -DefaultValue '')).Trim()
    $effort = ([string](Get-OptionalValue -Object $Notification -Name 'reasoning-effort' -DefaultValue '')).Trim()
    if ($model -notmatch '\A[A-Za-z0-9._-]{1,80}\z' -or $effort -notmatch '\A[A-Za-z0-9._-]{1,40}\z') {
        return ''
    }
    $modelName = $model -replace '(?i)^gpt-', ''
    $modelName = (($modelName -split '-') | ForEach-Object {
        if ($_ -match '^\d') { $_ }
        elseif ($_.Length -gt 0) { $_.Substring(0, 1).ToUpperInvariant() + $_.Substring(1) }
    }) -join ' '
    $effortName = switch ($effort.ToLowerInvariant()) {
        'xhigh' { 'XHigh'; break }
        default { $effort.Substring(0, 1).ToUpperInvariant() + $effort.Substring(1) }
    }
    return "由 $modelName $effortName 支持"
}

function New-DiscordWebhookPayload {
    param(
        [string]$Title,
        [string]$Body,
        [string]$EventName
    )

    $color = switch ($EventName) {
        'user-task-complete' { 3066993; break }
        'user-task-confirmation-required' { 15965202; break }
        { $_ -like 'quota-*' } { 3447003; break }
        default { 9807270 }
    }

    $embed = [ordered]@{
        title = Limit-DiscordText -Value (ConvertTo-DiscordMarkdownValue -Value $Title) -MaximumLength 256
        color = $color
    }

    $supportLine = ''
    $bodyWithoutSupport = $Body
    $supportMatch = [regex]::Match($Body, '(?s)\r?\n\r?\n(由 [^\r\n]{1,160} 支持)\z')
    if ($supportMatch.Success) {
        $supportLine = $supportMatch.Groups[1].Value
        $bodyWithoutSupport = $Body.Substring(0, $supportMatch.Index)
    }

    $taskBodyPattern = '(?s)\A项目名：([^\r\n]*)\r?\n任务名：([^\r\n]*)(?:\r?\n\r?\n任务：(.*?))?(?:\r?\n\r?\n(结果|待确认)：(.*))?\z'
    $taskBodyMatch = [regex]::Match($bodyWithoutSupport, $taskBodyPattern)
    if ($taskBodyMatch.Success) {
        $fields = @(
            [ordered]@{
                name = '项目名'
                value = Limit-DiscordText -Value (ConvertTo-DiscordMarkdownValue -Value $taskBodyMatch.Groups[1].Value) -MaximumLength 1024
                inline = $true
            },
            [ordered]@{
                name = '任务名'
                value = Limit-DiscordText -Value (ConvertTo-DiscordMarkdownValue -Value $taskBodyMatch.Groups[2].Value) -MaximumLength 1024
                inline = $true
            }
        )
        if ($taskBodyMatch.Groups[3].Success -and -not [string]::IsNullOrWhiteSpace($taskBodyMatch.Groups[3].Value)) {
            $fields += [ordered]@{
                name = '任务'
                value = Limit-DiscordText -Value (ConvertTo-DiscordMarkdownValue -Value $taskBodyMatch.Groups[3].Value) -MaximumLength 1024
                inline = $false
            }
        }
        if ($taskBodyMatch.Groups[4].Success -and -not [string]::IsNullOrWhiteSpace($taskBodyMatch.Groups[5].Value)) {
            $fields += [ordered]@{
                name = $taskBodyMatch.Groups[4].Value
                value = Limit-DiscordText -Value (ConvertTo-DiscordMarkdownValue -Value $taskBodyMatch.Groups[5].Value) -MaximumLength 1024
                inline = $false
            }
        }
        $embed.fields = $fields
    }
    else {
        $markdownBody = ConvertTo-DiscordMarkdownBody -Value $bodyWithoutSupport
        $embed.description = Limit-DiscordText -Value $markdownBody -MaximumLength 4096
    }
    if (-not [string]::IsNullOrWhiteSpace($supportLine)) {
        $embed.footer = [ordered]@{ text = Limit-DiscordText -Value $supportLine -MaximumLength 2048 }
    }

    return [ordered]@{
        username = '码驿 · CodexRelay 通知'
        allowed_mentions = [ordered]@{
            parse = @()
        }
        embeds = @($embed)
    }
}

function New-DiscordBotPayload {
    param(
        [string]$Title,
        [string]$Body,
        [string]$EventName
    )

    $payload = New-DiscordWebhookPayload -Title $Title -Body $Body -EventName $EventName
    [void]$payload.Remove('username')
    return $payload
}

function Get-DiscordBotChannelId {
    param(
        [object]$Config,
        [string]$EventName
    )

    $propertyName = switch ($EventName) {
        'user-task-complete' { 'discordTaskChannelId'; break }
        'user-task-confirmation-required' { 'discordConfirmationChannelId'; break }
        { $_ -like 'quota-*' } { 'discordQuotaChannelId'; break }
        default { '' }
    }
    if ([string]::IsNullOrWhiteSpace($propertyName)) {
        return ''
    }
    return [string](Get-OptionalValue -Object $Config -Name $propertyName -DefaultValue '')
}

function Test-IsJsonObject {
    param([object]$Value)

    return $null -ne $Value -and $Value -is [pscustomobject]
}

function Test-IsIntegralJsonNumber {
    param([object]$Value)

    return $Value -is [byte] -or $Value -is [sbyte] -or
        $Value -is [int16] -or $Value -is [uint16] -or
        $Value -is [int32] -or $Value -is [uint32] -or
        $Value -is [int64] -or $Value -is [uint64]
}

function Test-JsonObjectProperties {
    param(
        [object]$Value,
        [string[]]$Allowed,
        [string[]]$Required = @()
    )

    if (-not (Test-IsJsonObject -Value $Value)) {
        return $false
    }
    $names = @($Value.PSObject.Properties | ForEach-Object { [string]$_.Name })
    foreach ($name in $names) {
        if ($name -cnotin $Allowed) {
            return $false
        }
    }
    foreach ($name in $Required) {
        if ($name -cnotin $names) {
            return $false
        }
    }
    return $true
}

function Test-OptionalJsonString {
    param(
        [object]$Value,
        [string]$Name
    )

    $property = $Value.PSObject.Properties | Where-Object { $_.Name -ceq $Name } | Select-Object -First 1
    return $null -eq $property -or $property.Value -is [string]
}

function Test-JsonTimestamp {
    param([object]$Value)

    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) {
        return $false
    }
    $parsed = [DateTimeOffset]::MinValue
    return [DateTimeOffset]::TryParse($Value, [ref]$parsed)
}

function Test-DiscordTurnOriginRecord {
    param([object]$Value)

    $allowed = @(
        'threadId', 'guildId', 'channelId', 'source', 'createdAt', 'projectId', 'projectName',
        'rolloutCursor', 'deliveredEventIds', 'deliveryState', 'deliveredAt', 'lastMessageId',
        'rolloutFingerprint', 'terminalEventId', 'progressDispatch', 'messageIds'
    )
    $required = @(
        'threadId', 'guildId', 'channelId', 'source', 'createdAt',
        'rolloutCursor', 'deliveredEventIds', 'deliveryState'
    )
    if (-not (Test-JsonObjectProperties -Value $Value -Allowed $allowed -Required $required)) {
        return $false
    }
    if ($Value.threadId -isnot [string] -or [string]::IsNullOrWhiteSpace($Value.threadId) -or
        $Value.guildId -isnot [string] -or $Value.guildId -notmatch '\A[0-9]{17,20}\z' -or
        $Value.channelId -isnot [string] -or $Value.channelId -notmatch '\A[0-9]{17,20}\z' -or
        $Value.source -isnot [string] -or $Value.source -cnotin @('new-task', 'slash', 'reply') -or
        -not (Test-JsonTimestamp -Value $Value.createdAt) -or
        -not (Test-IsIntegralJsonNumber -Value $Value.rolloutCursor) -or [int64]$Value.rolloutCursor -lt 0 -or
        $Value.deliveredEventIds -isnot [System.Array] -or @($Value.deliveredEventIds).Count -gt 128 -or
        $Value.deliveryState -isnot [string] -or
        $Value.deliveryState -cnotin @('pending', 'terminal-dispatching', 'terminal-delivered')) {
        return $false
    }
    foreach ($eventId in @($Value.deliveredEventIds)) {
        if ($eventId -isnot [string] -or [string]::IsNullOrWhiteSpace($eventId)) {
            return $false
        }
    }
    $messageIds = $Value.PSObject.Properties | Where-Object { $_.Name -ceq 'messageIds' } | Select-Object -First 1
    if ($null -ne $messageIds) {
        if ($messageIds.Value -isnot [System.Array] -or @($messageIds.Value).Count -gt 128) {
            return $false
        }
        foreach ($messageId in @($messageIds.Value)) {
            if ($messageId -isnot [string] -or $messageId -cnotmatch '\A[0-9]{17,20}\z') {
                return $false
            }
        }
    }
    foreach ($name in @('projectId', 'projectName', 'lastMessageId', 'rolloutFingerprint', 'terminalEventId')) {
        if (-not (Test-OptionalJsonString -Value $Value -Name $name)) {
            return $false
        }
    }
    foreach ($name in @('rolloutFingerprint', 'terminalEventId')) {
        $property = $Value.PSObject.Properties | Where-Object { $_.Name -ceq $name } | Select-Object -First 1
        if ($null -ne $property -and $property.Value -cnotmatch '\A[a-f0-9]{64}\z') {
            return $false
        }
    }
    $deliveredAt = $Value.PSObject.Properties | Where-Object { $_.Name -ceq 'deliveredAt' } | Select-Object -First 1
    if ($null -ne $deliveredAt -and -not (Test-JsonTimestamp -Value $deliveredAt.Value)) {
        return $false
    }
    $progress = $Value.PSObject.Properties | Where-Object { $_.Name -ceq 'progressDispatch' } | Select-Object -First 1
    if ($null -ne $progress) {
        $dispatch = $progress.Value
        if (-not (Test-JsonObjectProperties -Value $dispatch `
            -Allowed @('eventId', 'nonce', 'start', 'end', 'kind', 'rolloutFingerprint') `
            -Required @('eventId', 'nonce', 'start', 'end', 'kind', 'rolloutFingerprint')) -or
            $dispatch.eventId -isnot [string] -or $dispatch.eventId -cnotmatch '\A[a-f0-9]{64}\z' -or
            $dispatch.nonce -isnot [string] -or $dispatch.nonce -cnotmatch '\A[0-9]{1,25}\z' -or
            -not (Test-IsIntegralJsonNumber -Value $dispatch.start) -or [int64]$dispatch.start -lt 0 -or
            -not (Test-IsIntegralJsonNumber -Value $dispatch.end) -or [int64]$dispatch.end -le [int64]$dispatch.start -or
            $dispatch.kind -isnot [string] -or $dispatch.kind -cnotin @('started', 'commentary', 'tool-start', 'tool-complete', 'tool-failed') -or
            $dispatch.rolloutFingerprint -isnot [string] -or $dispatch.rolloutFingerprint -cnotmatch '\A[a-f0-9]{64}\z') {
            return $false
        }
    }
    return $true
}

function Read-VerifiedDiscordTurnOrigins {
    if (-not (Test-Path -LiteralPath $discordInboxStatePath -PathType Leaf)) {
        return $null
    }

    try {
        $file = Get-Item -LiteralPath $discordInboxStatePath -ErrorAction Stop
        if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            $file.Length -le 0 -or $file.Length -gt 16MB) {
            return $null
        }
        $state = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8) |
            ConvertFrom-Json -DateKind String
        $allowed = @(
            'version', 'initialized', 'cursors', 'processedMessageIds', 'pendingContinuations',
            'processedInteractions', 'createdTasksByInteraction', 'discordTurnOrigins'
        )
        if (-not (Test-JsonObjectProperties -Value $state -Allowed $allowed -Required $allowed) -or
            -not (Test-IsIntegralJsonNumber -Value $state.version) -or [int64]$state.version -ne 2 -or
            $state.initialized -isnot [bool] -or
            -not (Test-IsJsonObject -Value $state.cursors) -or
            $state.processedMessageIds -isnot [System.Array] -or
            -not (Test-IsJsonObject -Value $state.pendingContinuations) -or
            $state.processedInteractions -isnot [System.Array] -or
            -not (Test-IsJsonObject -Value $state.createdTasksByInteraction) -or
            -not (Test-IsJsonObject -Value $state.discordTurnOrigins)) {
            return $null
        }
        $originProperties = @($state.discordTurnOrigins.PSObject.Properties)
        if ($originProperties.Count -gt 2000) {
            return $null
        }
        foreach ($property in $originProperties) {
            if ([string]::IsNullOrWhiteSpace([string]$property.Name) -or
                -not (Test-DiscordTurnOriginRecord -Value $property.Value)) {
                return $null
            }
        }
        return $state.discordTurnOrigins
    }
    catch {
        return $null
    }
}

function Resolve-DiscordOriginRoute {
    param(
        [string]$TurnId,
        [string]$ThreadId,
        [string]$GuildId,
        [string]$ChannelId,
        [string]$OriginTurnId,
        [object]$Origin
    )

    if ($null -eq $Origin -or [string]::IsNullOrWhiteSpace($TurnId) -or [string]::IsNullOrWhiteSpace($ThreadId) -or
        $GuildId -notmatch '\A[0-9]{17,20}\z' -or $ChannelId -notmatch '\A[0-9]{17,20}\z' -or
        $TurnId -cne $OriginTurnId -or $ThreadId -cne [string]$Origin.threadId -or
        $GuildId -cne [string]$Origin.guildId -or $ChannelId -cne [string]$Origin.channelId) {
        return $null
    }
    return $Origin
}

function Get-VerifiedDiscordTurnOriginRecord {
    param([object]$Notification)

    if ($null -eq $Notification) {
        return $null
    }
    $turnProperty = $Notification.PSObject.Properties | Where-Object { $_.Name -ceq 'turn-id' } | Select-Object -First 1
    $threadProperty = $Notification.PSObject.Properties | Where-Object { $_.Name -ceq 'thread-id' } | Select-Object -First 1
    if ($null -eq $turnProperty -or $turnProperty.Value -isnot [string] -or [string]::IsNullOrWhiteSpace($turnProperty.Value) -or
        $null -eq $threadProperty -or $threadProperty.Value -isnot [string] -or [string]::IsNullOrWhiteSpace($threadProperty.Value)) {
        return $null
    }

    $origins = Read-VerifiedDiscordTurnOrigins
    if ($null -eq $origins) {
        return $null
    }
    $originProperty = $origins.PSObject.Properties |
        Where-Object { $_.Name -ceq [string]$turnProperty.Value } |
        Select-Object -First 1
    if ($null -eq $originProperty) {
        return $null
    }

    $resolvedChannelId = [string]$originProperty.Value.channelId
    $notificationChannel = $Notification.PSObject.Properties |
        Where-Object { $_.Name -ceq 'discord-origin-channel-id' } |
        Select-Object -First 1
    if ($null -ne $notificationChannel) {
        if ($notificationChannel.Value -isnot [string] -or $notificationChannel.Value -notmatch '\A[0-9]{17,20}\z') {
            return $null
        }
        $resolvedChannelId = [string]$notificationChannel.Value
    }

    $resolvedGuildId = [string]$originProperty.Value.guildId
    $notificationGuild = $Notification.PSObject.Properties |
        Where-Object { $_.Name -ceq 'discord-guild-id' } |
        Select-Object -First 1
    if ($null -ne $notificationGuild) {
        if ($notificationGuild.Value -isnot [string] -or $notificationGuild.Value -notmatch '\A[0-9]{17,20}\z') {
            return $null
        }
        $resolvedGuildId = [string]$notificationGuild.Value
    }

    return Resolve-DiscordOriginRoute `
        -TurnId ([string]$turnProperty.Value) `
        -ThreadId ([string]$threadProperty.Value) `
        -GuildId $resolvedGuildId `
        -ChannelId $resolvedChannelId `
        -OriginTurnId ([string]$originProperty.Name) `
        -Origin $originProperty.Value
}

function Get-DiscordOriginChannelId {
    param(
        [object]$Notification,
        [string]$EventName
    )

    if ($EventName -notin @('user-task-complete', 'user-task-confirmation-required')) {
        return ''
    }
    $origin = Get-VerifiedDiscordTurnOriginRecord -Notification $Notification
    if ($null -eq $origin) {
        return ''
    }
    return [string]$origin.channelId
}

function Get-DiscordTerminalNonce {
    param([object]$Notification)

    if ($null -eq $Notification) {
        return ''
    }
    $turnId = [string](Get-OptionalValue -Object $Notification -Name 'turn-id' -DefaultValue '')
    $threadId = [string](Get-OptionalValue -Object $Notification -Name 'thread-id' -DefaultValue '')
    if ([string]::IsNullOrWhiteSpace($turnId) -or [string]::IsNullOrWhiteSpace($threadId)) {
        return ''
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $seed = $turnId + [char]0 + $threadId + [char]0 + 'terminal'
        $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($seed))
        $prefix = ([BitConverter]::ToString($hash) -replace '-', '').Substring(0, 16)
        return [Convert]::ToUInt64($prefix, 16).ToString([System.Globalization.CultureInfo]::InvariantCulture)
    }
    finally {
        $sha.Dispose()
    }
}

function Send-DiscordBotMessage {
    param(
        [object]$Config,
        [string]$ChannelId,
        [object]$Payload,
        [int]$TimeoutSeconds
    )

    if ($ChannelId -notmatch '\A\d{17,20}\z') {
        throw 'Discord Bot channel ID is invalid'
    }
    if (-not (Get-Command -Name Unprotect-DiscordBotToken -ErrorAction SilentlyContinue)) {
        throw 'Discord Bot secret module is unavailable'
    }
    if (-not (Get-Command -Name New-DiscordBotHeaders -ErrorAction SilentlyContinue)) {
        throw 'Discord Bot HTTP module is unavailable'
    }

    $tokenPath = [string](Get-OptionalValue -Object $Config -Name 'discordTokenPath' -DefaultValue '')
    if ([string]::IsNullOrWhiteSpace($tokenPath)) {
        throw 'Discord Bot token path is empty'
    }
    if (-not [System.IO.Path]::IsPathRooted($tokenPath)) {
        $tokenPath = [System.IO.Path]::GetFullPath((Join-Path $toolDir $tokenPath))
    }

    $botToken = Unprotect-DiscordBotToken -Path $tokenPath
    try {
        $json = $Payload | ConvertTo-Json -Depth 8 -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        $headers = New-DiscordBotHeaders -Token $botToken
        $uri = "https://discord.com/api/v10/channels/$ChannelId/messages"
        Assert-CurrentProjectNotificationsEnabled
        return Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec $TimeoutSeconds
    }
    finally {
        $botToken = $null
    }
}

function ConvertTo-WindowsCommandLineArgument {
    param([string]$Value)

    if ($null -eq $Value) {
        return '""'
    }

    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $backslashCount = 0

    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashCount++
            continue
        }

        if ($character -eq '"') {
            [void]$builder.Append(('\' * (($backslashCount * 2) + 1)))
            [void]$builder.Append('"')
            $backslashCount = 0
            continue
        }

        if ($backslashCount -gt 0) {
            [void]$builder.Append(('\' * $backslashCount))
            $backslashCount = 0
        }
        [void]$builder.Append($character)
    }

    if ($backslashCount -gt 0) {
        [void]$builder.Append(('\' * ($backslashCount * 2)))
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Invoke-PreviousNotifier {
    param(
        [object]$Config,
        [string]$RawNotification
    )

    $previous = @(Get-OptionalValue -Object $Config -Name 'previousNotify' -DefaultValue @())
    if ($previous.Count -eq 0) {
        return
    }

    $executable = [string]$previous[0]
    if (-not (Test-Path -LiteralPath $executable)) {
        $command = Get-Command -Name $executable -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $command) { $executable = $command.Source }
    }
    if (-not (Test-Path -LiteralPath $executable)) {
        $replacement = $null
        if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT -and -not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
            $runtimeRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes\cua_node'
            $runtimePattern = Join-Path $runtimeRoot '*\bin\node_modules\@oai\sky\bin\windows\codex-computer-use.exe'
            $replacement = Get-ChildItem -Path $runtimePattern -File -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 1
        }
        if ($null -eq $replacement) {
            Write-NotifyLog "Previous notifier is missing: $executable"
            return
        }
        $executable = $replacement.FullName
        Write-NotifyLog "Previous notifier moved; using: $executable"
    }

    $arguments = @()
    if ($previous.Count -gt 1) {
        $arguments = @($previous[1..($previous.Count - 1)] | ForEach-Object { [string]$_ })
    }

    try {
        $allArguments = @($arguments) + @($RawNotification)
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $executable
        if ($null -ne $startInfo.PSObject.Properties['ArgumentList']) {
            foreach ($argument in $allArguments) { [void]$startInfo.ArgumentList.Add([string]$argument) }
        } else {
            $startInfo.Arguments = (@($allArguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument -Value ([string]$_) }) -join ' ')
        }
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true

        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $startInfo
        [void]$process.Start()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            Write-NotifyLog "Previous notifier exited with code $($process.ExitCode)"
        }
        $process.Dispose()
    }
    catch {
        Write-NotifyLog "Previous notifier failed: $($_.Exception.Message)"
    }
}

function Send-MobileMessage {
    param(
        [object]$Config,
        [string]$Title,
        [string]$Body,
        [int]$Priority = 3,
        [string[]]$Tags = @('computer'),
        [string]$EventName = 'agent-turn-complete',
        [object]$Notification = $null,
        [string]$EndpointOverride = ''
    )

    if (-not [bool](Get-OptionalValue -Object $Config -Name 'enabled' -DefaultValue $false)) {
        return
    }

    $provider = ([string](Get-OptionalValue -Object $Config -Name 'provider' -DefaultValue '')).ToLowerInvariant()
    $endpoint = [string](Get-OptionalValue -Object $Config -Name 'endpoint' -DefaultValue '')
    if (-not [string]::IsNullOrWhiteSpace($EndpointOverride)) {
        $endpoint = $EndpointOverride
    }
    $token = [string](Get-OptionalValue -Object $Config -Name 'token' -DefaultValue '')
    $timeoutSeconds = [int](Get-OptionalValue -Object $Config -Name 'timeoutSeconds' -DefaultValue 8)
    $providerPayload = if ($provider -eq 'discord') {
        New-DiscordWebhookPayload -Title $Title -Body $Body -EventName $EventName
    }
    elseif ($provider -eq 'discord-bot') {
        New-DiscordBotPayload -Title $Title -Body $Body -EventName $EventName
    }
    else {
        $null
    }
    $fixedChannelId = if ($provider -eq 'discord-bot') {
        Get-DiscordBotChannelId -Config $Config -EventName $EventName
    }
    else {
        ''
    }
    $originChannelId = if ($provider -eq 'discord-bot') {
        Get-DiscordOriginChannelId -Notification $Notification -EventName $EventName
    }
    else {
        ''
    }
    $channelId = if (-not [string]::IsNullOrWhiteSpace($originChannelId)) { $originChannelId } else { $fixedChannelId }
    if ($provider -eq 'discord-bot' -and -not [string]::IsNullOrWhiteSpace($originChannelId)) {
        $terminalNonce = Get-DiscordTerminalNonce -Notification $Notification
        if (-not [string]::IsNullOrWhiteSpace($terminalNonce)) {
            $providerPayload['nonce'] = $terminalNonce
            $providerPayload['enforce_nonce'] = $true
        }
    }
    $usesOriginChannel = $provider -eq 'discord-bot' -and
        -not [string]::IsNullOrWhiteSpace($originChannelId) -and
        $originChannelId -ne $fixedChannelId
    $syntheticTest = $false
    if ($null -ne $Notification) {
        $syntheticTest = [bool](Get-OptionalValue -Object $Notification -Name 'synthetic-test' -DefaultValue $false)
    }
    $saveTaskMapping = $provider -eq 'discord-bot' -and
        $EventName -in @('user-task-complete', 'user-task-confirmation-required') -and
        $null -ne $Notification -and
        -not $syntheticTest

    if ($DryRun) {
        [pscustomobject]@{
            provider = $provider
            endpoint = $endpoint
            channelId = $channelId
            title = $Title
            body = $Body
            priority = $Priority
            tags = $Tags
            event = $EventName
            payload = $providerPayload
            syntheticTest = $syntheticTest
            saveTaskMapping = $saveTaskMapping
        } | ConvertTo-Json -Depth 6
        return
    }

    switch ($provider) {
        'ntfy' {
            if ([string]::IsNullOrWhiteSpace($endpoint)) {
                throw 'ntfy endpoint is empty'
            }
            $uri = [Uri]$endpoint
            $topic = $uri.AbsolutePath.Trim('/')
            if ([string]::IsNullOrWhiteSpace($topic)) {
                throw 'ntfy endpoint must include a topic'
            }
            $server = '{0}://{1}' -f $uri.Scheme, $uri.Authority
            Invoke-JsonPost -Uri $server -TimeoutSeconds $timeoutSeconds -Payload @{
                topic = $topic
                title = $Title
                message = $Body
                priority = $Priority
                tags = $Tags
            }
        }
        'bark' {
            if ([string]::IsNullOrWhiteSpace($endpoint)) {
                throw 'Bark endpoint is empty'
            }
            Invoke-JsonPost -Uri $endpoint -TimeoutSeconds $timeoutSeconds -Payload @{
                title = $Title
                body = $Body
                group = 'Codex'
                sound = 'minuet'
            }
        }
        'pushplus' {
            if ([string]::IsNullOrWhiteSpace($token)) {
                throw 'PushPlus token is empty'
            }
            $pushPlusEndpoint = if ([string]::IsNullOrWhiteSpace($endpoint)) { 'https://www.pushplus.plus/send' } else { $endpoint }
            Invoke-JsonPost -Uri $pushPlusEndpoint -TimeoutSeconds $timeoutSeconds -Payload @{
                token = $token
                title = $Title
                content = $Body
                template = 'txt'
            }
        }
        'webhook' {
            if ([string]::IsNullOrWhiteSpace($endpoint)) {
                throw 'Webhook endpoint is empty'
            }
            $threadId = ''
            $turnId = ''
            $cwd = ''
            if ($null -ne $Notification) {
                $threadId = [string](Get-OptionalValue -Object $Notification -Name 'thread-id' -DefaultValue '')
                $turnId = [string](Get-OptionalValue -Object $Notification -Name 'turn-id' -DefaultValue '')
                $cwd = [string](Get-OptionalValue -Object $Notification -Name 'cwd' -DefaultValue '')
            }
            Invoke-JsonPost -Uri $endpoint -TimeoutSeconds $timeoutSeconds -Payload @{
                event = $EventName
                title = $Title
                body = $Body
                threadId = $threadId
                turnId = $turnId
                cwd = $cwd
            }
        }
        'discord' {
            if ([string]::IsNullOrWhiteSpace($endpoint)) {
                throw 'Discord webhook endpoint is empty'
            }
            Invoke-JsonPost -Uri $endpoint -TimeoutSeconds $timeoutSeconds -Payload $providerPayload
        }
        'discord-bot' {
            try {
                $response = Send-DiscordBotMessage -Config $Config -ChannelId $channelId -Payload $providerPayload -TimeoutSeconds $timeoutSeconds
            }
            catch {
                if (-not $usesOriginChannel) {
                    throw
                }

                $fallbackPayload = New-DiscordBotPayload -Title $Title -Body $Body -EventName $EventName
                $fallbackPayload.embeds[0]['description'] = '**路由提示：** 原任务频道发送失败，已转到固定通知频道。'
                if ($providerPayload.Contains('nonce')) {
                    $fallbackPayload['nonce'] = $providerPayload['nonce']
                    $fallbackPayload['enforce_nonce'] = $true
                }
                $response = Send-DiscordBotMessage -Config $Config -ChannelId $fixedChannelId -Payload $fallbackPayload -TimeoutSeconds $timeoutSeconds
                $channelId = $fixedChannelId
                Write-NotifyLog "Discord origin route failed; notification sent to the fixed $EventName channel"
            }
            if ($saveTaskMapping) {
                if (-not (Get-Command -Name Save-DiscordTaskMapping -ErrorAction SilentlyContinue)) {
                    throw 'Discord task mapping module is unavailable'
                }
                $messageId = [string](Get-OptionalValue -Object $response -Name 'id' -DefaultValue '')
                $threadId = [string](Get-OptionalValue -Object $Notification -Name 'thread-id' -DefaultValue '')
                $cwd = [string](Get-OptionalValue -Object $Notification -Name 'cwd' -DefaultValue '')
                Save-DiscordTaskMapping -Path $discordMessageMapPath -MessageId $messageId -ThreadId $threadId -Cwd $cwd -ChannelId $channelId -EventName $EventName
            }
        }
        default {
            throw "Unsupported provider: $provider"
        }
    }

    Write-NotifyLog "Mobile notification sent through $provider ($EventName)"
}

function Test-MatchesAnyPattern {
    param(
        [string]$Value,
        [string[]]$Patterns
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $false
    }

    foreach ($pattern in $Patterns) {
        if ($Value -match $pattern) {
            return $true
        }
    }
    return $false
}

function Remove-QuotedClassificationExamples {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ''
    }

    $text = [regex]::Replace($Value, '(?s)```.*?```', ' ')
    $text = [regex]::Replace($text, '`[^`\r\n]{0,500}`', ' ')
    $text = [regex]::Replace($text, '“[^”\r\n]{0,300}”', ' ')
    $text = [regex]::Replace($text, '「[^」\r\n]{0,300}」', ' ')
    $text = [regex]::Replace($text, '『[^』\r\n]{0,300}』', ' ')
    $text = [regex]::Replace($text, '"[^"\r\n]{0,300}"', ' ')
    $text = [regex]::Replace($text, '(?m)^\s*>\s?.*$', ' ')
    return $text
}

function Get-TaskNotificationKind {
    param([object]$Notification)

    $taskMessage = Get-LastUserMessage -Notification $Notification
    $rawAssistantMessage = [string](Get-OptionalValue -Object $Notification -Name 'last-assistant-message' -DefaultValue '')
    $classificationSource = Remove-QuotedClassificationExamples -Value $rawAssistantMessage
    $assistantMessage = ConvertTo-CompactText -Value $classificationSource
    $paragraphs = @([regex]::Split($classificationSource.Trim(), '(?:\r?\n\s*){2,}') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $terminalAssistantMessage = if ($paragraphs.Count -eq 0) {
        $assistantMessage
    }
    else {
        ConvertTo-CompactText -Value ([string]$paragraphs[$paragraphs.Count - 1])
    }

    $explicitConfirmationPatterns = @(
        '(?i)(?:请|需要你|请你).{0,16}(?:确认|选择|决定|回复|提供|授权|批准|同意)',
        '(?i)你回复.{0,40}(?:我就|即可|之后|以后|后再|后就)',
        '(?i)(?:按|照).{0,50}(?:方案|计划).{0,20}(?:修改|执行|继续|实施).{0,10}(?:可以吗|是否可以|行吗|好不好|[？?])',
        '(?i)(?:按|照).{0,40}(?:方向|思路|方案|计划).{0,20}(?:查|核对|分析|调查|检查|诊断|研究|推进|处理|做|执行|实施|修改).{0,10}(?:可以吗|是否可以|行吗|好不好|[？?])',
        '(?i)(?:按|照|这样|这么|这版|这个版本).{0,50}(?:直接)?(?:改|做|查|核对|分析|调查|检查|诊断|研究|继续|推进|处理|执行|实施|修复|安装|合并|提交|推送).{0,10}(?:可以吗|是否可以|行吗|好不好|[？?])',
        '(?i)(?:是否|要不要|需不需要|可以(?:直接)?|能否).{0,24}(?:继续|开始|修改|执行|实施|安装|合并|提交|推送|删除|创建|授权).{0,8}(?:[？?]|$)',
        '(?i)(?:选哪个|选择哪|哪个选项|哪一个选项|which option)',
        '(?i)what would you like (?:me )?to do',
        '(?i)would you like me to|do you want me to|should i|shall i',
        '(?i)please\s+(?:confirm|choose|select|approve|reply|provide|authorize)',
        '(?i)(?:等待|待).{0,16}(?:确认|选择|回复|授权|批准)'
    )
    if (Test-MatchesAnyPattern -Value $terminalAssistantMessage -Patterns $explicitConfirmationPatterns) {
        return 'confirmation'
    }

    # A genuine completion opening wins over a merely explanatory question at
    # the end (for example, "已完成……结果说明清楚了吗？"). Explicit requests for
    # a choice or authorization are handled above and therefore still require
    # confirmation even when the response starts with "已完成".
    $completedOpeningPatterns = @(
        '(?i)^(?:已完成|已经完成|任务已完成|已修复|已经修复|已实现|已经实现|已处理完成|implementation complete\b|completed\b)'
    )
    if (Test-MatchesAnyPattern -Value $assistantMessage -Patterns $completedOpeningPatterns) {
        return 'complete'
    }

    # In normal Codex replies, a terminal question means the main task is
    # waiting for the user rather than finally complete.
    if ($terminalAssistantMessage -match '[？?]\s*$') {
        return 'confirmation'
    }

    $preparatoryWorkPatterns = @(
        '(?i)(?:我|我们)?(?:准备|打算|计划|接下来(?:会|要)?|下一步(?:会|要)?).{0,32}(?:核对|查|调查|分析|检查|诊断|研究|验证|处理|修改|实施|执行|推进)',
        '(?i)(?:先不|暂不|暂时不|目前不|当前不).{0,16}(?:修改|改|改动|动代码|碰代码).{0,80}(?:随后|然后|之后|接下来|下一步|准备|打算|计划).{0,32}(?:核对|查|调查|分析|检查|诊断|研究|验证|处理|修改|实施|执行|推进)'
    )
    if (Test-MatchesAnyPattern -Value $terminalAssistantMessage -Patterns $preparatoryWorkPatterns) {
        return 'confirmation'
    }

    $analysisOnlyPatterns = @(
        '(?i)(?:只|仅)(?:需要|做|进行)?(?:分析|诊断|解释|检查|审计|调查|评估).{0,50}(?:不要|无需|不需要).{0,24}(?:修改|改动|执行|实现|安装|打包|重新打包)',
        '(?i)(?:只|仅).{0,20}(?:方案|建议|计划).{0,40}(?:不要|无需|不需要).{0,24}(?:执行|实施|修改|改动|实现|开始)',
        '(?i)(?:analysis|diagnosis|review|audit)\s+only.{0,50}(?:do not|without).{0,24}(?:change|modify|implement|install|build)'
    )
    if (Test-MatchesAnyPattern -Value $taskMessage -Patterns $analysisOnlyPatterns) {
        return 'complete'
    }

    $notExecutedPatterns = @(
        '(?i)(?:尚未|还没有|目前没有|当前没有|并未|未曾|未|没有)(?:实际)?(?:修改|改动|改|执行|实施|开始|安装|提交|合并|推送|发布|部署|重新打包|打包)',
        '(?i)(?:尚未|还没有|目前没有|当前没有|并未|未曾|未|没有).{0,8}(?:动过?|碰过?)代码',
        '(?i)(?:当前|目前)?(?:我)?只(?:做了?|进行了?|完成了?)?(?:只读|read[- ]only)?(?:诊断|分析|审计|检查|调查)',
        '(?i)(?:尚|仍|还)(?:需|需要|待).{0,24}(?:修改|实施|执行|处理|验证|安装|选择|确认|合并|提交|推送)',
        "(?i)(?:not|has not|have not|hasn't|haven't|did not|didn't)\s+(?:yet\s+)?(?:modified|changed|implemented|executed|installed|merged|committed|pushed|deployed|built)",
        '(?i)(?:no code|no files?).{0,20}(?:changed|modified)|no changes (?:have been|were) made|read[- ]only (?:diagnosis|analysis|review)|still need to'
    )
    $actionablePlanPatterns = @(
        '(?i)(?:修改方案|解决方案|实施方案|优化方案|建议(?:按|先|采用|使用|将|把)|下一步)',
        '(?i)(?:需要|需)(?:让|把|将|先|修改|实现|安装|配置|验证|执行|处理|合并|提交|推送)',
        '(?i)(?:可以|可)(?:先|通过|使用|改为|将|把|直接)',
        '(?i)(?:recommend|suggest|proposal|implementation plan|next step|need to|needs to|should|could)'
    )
    $hasPendingExecution = Test-MatchesAnyPattern -Value $assistantMessage -Patterns $notExecutedPatterns
    $hasActionablePlan = Test-MatchesAnyPattern -Value $assistantMessage -Patterns $actionablePlanPatterns
    if ($hasPendingExecution -and $hasActionablePlan) {
        return 'confirmation'
    }

    $executionIntentPatterns = @(
        '(?i)(?:修复|修改|改进|优化|实现|添加|增加|创建|生成|构建|打包|启动|安装|配置|部署|迁移|合并|提交|推送|删除|清理|重构|验证|测试)',
        '(?i)\b(?:fix|change|improve|optimize|implement|add|create|generate|build|start|install|configure|deploy|migrate|merge|commit|push|delete|clean|refactor|verify|test)\b'
    )
    $completionEvidencePatterns = @(
        '(?i)(?:已|已经)(?:完成|修复|修改|改好|实现|添加|增加|创建|生成|构建|打包|安装|配置|部署|迁移|合并|提交|推送|删除|清理|重构|验证|测试)',
        '(?i)(?:测试|验证|构建|打包).{0,16}(?:全部)?(?:通过|成功|完成)',
        '(?i)\b(?:completed|implemented|fixed|changed|built|installed|configured|deployed|migrated|merged|committed|pushed|deleted|verified)\b|tests? passed|verification passed'
    )
    $taskRequestsExecution = Test-MatchesAnyPattern -Value $taskMessage -Patterns $executionIntentPatterns
    $hasCompletionEvidence = Test-MatchesAnyPattern -Value $assistantMessage -Patterns $completionEvidencePatterns
    if ($taskRequestsExecution -and $hasActionablePlan -and -not $hasCompletionEvidence) {
        return 'confirmation'
    }

    return 'complete'
}

function Invoke-ConfirmationNotifier {
    param(
        [object]$Config,
        [object]$Notification
    )

    if (-not [bool](Get-OptionalValue -Object $Config -Name 'enabled' -DefaultValue $false)) {
        return
    }

    $provider = ([string](Get-OptionalValue -Object $Config -Name 'provider' -DefaultValue '')).ToLowerInvariant()
    $confirmationEndpoint = [string](Get-OptionalValue -Object $Config -Name 'confirmationEndpoint' -DefaultValue '')
    if ($provider -eq 'ntfy' -and [string]::IsNullOrWhiteSpace($confirmationEndpoint)) {
        Write-NotifyLog 'Task confirmation notification skipped because confirmationEndpoint is empty'
        return
    }

    $project = Get-NotificationProjectName -Notification $Notification

    $taskMessage = Get-LastUserMessage -Notification $Notification
    $taskName = Get-TaskName -Notification $Notification -TaskMessage $taskMessage
    $title = 'Codex 任务待确认'
    $body = "项目名：$project`n任务名：$taskName`n`n打开 Codex 查看并确认后续操作。"

    $includeAssistantMessage = [bool](Get-OptionalValue -Object $Config -Name 'includeAssistantMessage' -DefaultValue $false)
    if ($includeAssistantMessage) {
        if ($taskMessage.Length -gt 400) {
            $taskMessage = $taskMessage.Substring(0, 400) + '…'
        }

        $assistantMessage = ConvertTo-CompactText -Value ([string](Get-OptionalValue -Object $Notification -Name 'last-assistant-message' -DefaultValue ''))
        if ($assistantMessage.Length -gt 1200) {
            $assistantMessage = $assistantMessage.Substring(0, 1200) + '…'
        }

        $taskBody = if ([string]::IsNullOrWhiteSpace($taskMessage)) { '未取得本轮用户输入' } else { $taskMessage }
        $confirmationBody = if ([string]::IsNullOrWhiteSpace($assistantMessage)) { 'Codex 正在等待你的确认，请打开任务查看。' } else { $assistantMessage }
        $body = "项目名：$project`n任务名：$taskName`n`n任务：$taskBody`n`n待确认：$confirmationBody"
    }
    $supportLine = Get-NotificationSupportLine -Notification $Notification
    if (-not [string]::IsNullOrWhiteSpace($supportLine)) { $body += "`n`n$supportLine" }

    $endpointOverride = if ($provider -in @('ntfy', 'discord')) { $confirmationEndpoint } else { '' }
    Send-MobileMessage -Config $Config -Title $title -Body $body -Priority 4 -Tags @('question') -EventName 'user-task-confirmation-required' -Notification $Notification -EndpointOverride $endpointOverride
}

function Invoke-MobileNotifier {
    param(
        [object]$Config,
        [object]$Notification
    )

    if (-not [bool](Get-OptionalValue -Object $Config -Name 'enabled' -DefaultValue $false)) {
        return
    }

    $includeAssistantMessage = [bool](Get-OptionalValue -Object $Config -Name 'includeAssistantMessage' -DefaultValue $false)

    $project = Get-NotificationProjectName -Notification $Notification

    $taskMessage = Get-LastUserMessage -Notification $Notification
    $taskName = Get-TaskName -Notification $Notification -TaskMessage $taskMessage
    $title = 'Codex 任务已完成'
    $body = "项目名：$project`n任务名：$taskName"
    if ($includeAssistantMessage) {
        if ($taskMessage.Length -gt 400) {
            $taskMessage = $taskMessage.Substring(0, 400) + '…'
        }

        $assistantMessage = ConvertTo-CompactText -Value ([string](Get-OptionalValue -Object $Notification -Name 'last-assistant-message' -DefaultValue ''))
        if ($assistantMessage.Length -gt 1200) {
            $assistantMessage = $assistantMessage.Substring(0, 1200) + '…'
        }

        $taskBody = if ([string]::IsNullOrWhiteSpace($taskMessage)) { '未取得本轮用户输入' } else { $taskMessage }
        $resultBody = if ([string]::IsNullOrWhiteSpace($assistantMessage)) { '任务已结束，但未取得最终回复正文' } else { $assistantMessage }
        $body = "项目名：$project`n任务名：$taskName`n`n任务：$taskBody`n`n结果：$resultBody"
    }
    $supportLine = Get-NotificationSupportLine -Notification $Notification
    if (-not [string]::IsNullOrWhiteSpace($supportLine)) { $body += "`n`n$supportLine" }

    Send-MobileMessage -Config $Config -Title $title -Body $body -Priority 3 -Tags @('white_check_mark') -EventName 'user-task-complete' -Notification $Notification
}

function Get-RateLimitName {
    param(
        [int]$WindowMinutes,
        [string]$SlotName
    )

    switch ($WindowMinutes) {
        300 { return '5小时额度' }
        1440 { return '每日额度' }
        10080 { return '每周额度' }
        default {
            if ($WindowMinutes -gt 0) {
                return "$WindowMinutes 分钟额度"
            }
            return "$SlotName 额度"
        }
    }
}

function Get-LastRateLimitLine {
    param([string]$Path)

    $stream = $null
    try {
        $stream = New-Object System.IO.FileStream(
            $Path,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::ReadWrite
        )
        $maxBytes = 4 * 1024 * 1024
        $bytesToRead = [int][Math]::Min([int64]$maxBytes, $stream.Length)
        if ($bytesToRead -le 0) {
            return ''
        }
        $startPosition = $stream.Length - $bytesToRead
        [void]$stream.Seek($startPosition, [System.IO.SeekOrigin]::Begin)
        $buffer = New-Object byte[] $bytesToRead
        $offset = 0
        while ($offset -lt $bytesToRead) {
            $readCount = $stream.Read($buffer, $offset, $bytesToRead - $offset)
            if ($readCount -le 0) {
                break
            }
            $offset += $readCount
        }
        $text = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $offset)
        $markerIndex = $text.LastIndexOf('"rate_limits"', [System.StringComparison]::Ordinal)
        if ($markerIndex -lt 0) {
            return ''
        }
        $lineStart = $text.LastIndexOf("`n", $markerIndex)
        if ($lineStart -lt 0) {
            $lineStart = 0
        }
        else {
            $lineStart++
        }
        $lineEnd = $text.IndexOf("`n", $markerIndex)
        if ($lineEnd -lt 0) {
            $lineEnd = $text.Length
        }
        return $text.Substring($lineStart, $lineEnd - $lineStart).Trim()
    }
    catch {
        return ''
    }
    finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
    }
}

function Get-LatestRateLimitSnapshot {
    param([string]$ThreadId = '')

    if (-not (Test-Path -LiteralPath $sessionsPath)) {
        return $null
    }

    $latestTimestamp = [DateTimeOffset]::MinValue
    $latestRateLimits = $null
    if (-not [string]::IsNullOrWhiteSpace($ThreadId) -and $ThreadId -match '^[0-9a-fA-F-]{36}$') {
        $sessionFiles = @(Get-ChildItem -LiteralPath $sessionsPath -Filter "*$ThreadId*.jsonl" -File -Recurse -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc -Descending)
    }
    else {
        $sessionFiles = @(Get-ChildItem -LiteralPath $sessionsPath -Filter 'rollout-*.jsonl' -File -Recurse -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc -Descending |
            Select-Object -First 12)
    }

    foreach ($sessionFile in $sessionFiles) {
        $candidateLine = Get-LastRateLimitLine -Path $sessionFile.FullName
        if ([string]::IsNullOrWhiteSpace($candidateLine)) {
            continue
        }
        try {
            $entry = $candidateLine | ConvertFrom-Json
            if ([string](Get-OptionalValue -Object $entry -Name 'type' -DefaultValue '') -ne 'event_msg') {
                continue
            }
            $payload = Get-OptionalValue -Object $entry -Name 'payload' -DefaultValue $null
            if ($null -eq $payload -or [string](Get-OptionalValue -Object $payload -Name 'type' -DefaultValue '') -ne 'token_count') {
                continue
            }
            $rateLimits = Get-OptionalValue -Object $payload -Name 'rate_limits' -DefaultValue $null
            if ($null -eq $rateLimits) {
                continue
            }
            $candidateLimitId = [string](Get-OptionalValue -Object $rateLimits -Name 'limit_id' -DefaultValue '')
            if ($candidateLimitId -ne 'codex') {
                Write-NotifyLog "Ignored non-OpenAI quota snapshot: $candidateLimitId"
                continue
            }
            $timestampValue = Get-OptionalValue -Object $entry -Name 'timestamp' -DefaultValue ''
            $timestamp = ConvertTo-DateTimeOffsetValue -Value $timestampValue
            if ($timestamp -gt $latestTimestamp) {
                $latestTimestamp = $timestamp
                $latestRateLimits = $rateLimits
            }
        }
        catch {
            continue
        }
    }

    if ($null -eq $latestRateLimits) {
        return $null
    }

    $limitId = [string](Get-OptionalValue -Object $latestRateLimits -Name 'limit_id' -DefaultValue 'codex')
    $limits = @()
    foreach ($slotName in @('primary', 'secondary')) {
        $slot = Get-OptionalValue -Object $latestRateLimits -Name $slotName -DefaultValue $null
        if ($null -eq $slot) {
            continue
        }
        $usedValue = Get-OptionalValue -Object $slot -Name 'used_percent' -DefaultValue $null
        if ($null -eq $usedValue) {
            continue
        }

        $usedPercent = [double]$usedValue
        $windowMinutes = [int](Get-OptionalValue -Object $slot -Name 'window_minutes' -DefaultValue 0)
        $resetsAt = [int64](Get-OptionalValue -Object $slot -Name 'resets_at' -DefaultValue 0)
        $remainingPercent = [Math]::Round([Math]::Max(0, [Math]::Min(100, 100 - $usedPercent)), 2)
        $limits += [pscustomobject]@{
            key = "$limitId|$slotName|$windowMinutes"
            name = Get-RateLimitName -WindowMinutes $windowMinutes -SlotName $slotName
            slot = $slotName
            windowMinutes = $windowMinutes
            usedPercent = [Math]::Round($usedPercent, 2)
            remainingPercent = $remainingPercent
            resetsAt = $resetsAt
        }
    }

    if ($limits.Count -eq 0) {
        return $null
    }
    return [pscustomobject]@{
        observedAt = $latestTimestamp.ToString('o')
        limitId = $limitId
        limits = $limits
    }
}

function Read-QuotaState {
    if (-not (Test-Path -LiteralPath $quotaStatePath)) {
        return $null
    }
    try {
        return Get-Content -Raw -LiteralPath $quotaStatePath -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        Write-NotifyLog "Quota state could not be read: $($_.Exception.Message)"
        return $null
    }
}

function Save-QuotaState {
    param([object]$Snapshot)

    $json = $Snapshot | ConvertTo-Json -Depth 8
    $temporaryPath = "$quotaStatePath.tmp-$PID"
    [System.IO.File]::WriteAllText($temporaryPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporaryPath -Destination $quotaStatePath -Force
}

function Format-QuotaPercent {
    param([double]$Value)
    return $Value.ToString('0.##', [System.Globalization.CultureInfo]::InvariantCulture)
}

function Format-QuotaResetTime {
    param([int64]$UnixSeconds)

    if ($UnixSeconds -le 0) {
        return '未知'
    }
    return [DateTimeOffset]::FromUnixTimeSeconds($UnixSeconds).ToLocalTime().ToString('yyyy-MM-dd HH:mm')
}

function Format-QuotaObservedTime {
    param([DateTimeOffset]$Value)
    return $Value.ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss')
}

function Format-QuotaDuration {
    param([TimeSpan]$Value)

    if ($Value.TotalSeconds -lt 60) {
        return '不足1分钟'
    }

    $parts = @()
    if ($Value.Days -gt 0) {
        $parts += "$($Value.Days)天"
    }
    if ($Value.Hours -gt 0) {
        $parts += "$($Value.Hours)小时"
    }
    if ($Value.Minutes -gt 0 -and $parts.Count -lt 2) {
        $parts += "$($Value.Minutes)分钟"
    }
    return ($parts -join '')
}

function Format-QuotaRate {
    param([double]$Value)
    return $Value.ToString('0.###', [System.Globalization.CultureInfo]::InvariantCulture)
}

function Get-QuotaTimeUntilReset {
    param(
        [int64]$ResetsAt,
        [DateTimeOffset]$ObservedAt
    )

    if ($ResetsAt -le 0) {
        return $null
    }
    try {
        return [DateTimeOffset]::FromUnixTimeSeconds($ResetsAt) - $ObservedAt
    }
    catch {
        return $null
    }
}

function Get-QuotaTimeUntilResetText {
    param(
        [int64]$ResetsAt,
        [DateTimeOffset]$ObservedAt
    )

    $remaining = Get-QuotaTimeUntilReset -ResetsAt $ResetsAt -ObservedAt $ObservedAt
    if ($null -eq $remaining) {
        return '未知'
    }
    if ($remaining.TotalSeconds -le 0) {
        return '不足1分钟'
    }
    return Format-QuotaDuration -Value $remaining
}

function Get-QuotaAverageUsageRatePerHour {
    param(
        [object]$Limit,
        [DateTimeOffset]$ObservedAt
    )

    $resetsAt = [int64](Get-OptionalValue -Object $Limit -Name 'resetsAt' -DefaultValue 0)
    $windowMinutes = [int](Get-OptionalValue -Object $Limit -Name 'windowMinutes' -DefaultValue 0)
    if ($resetsAt -le 0 -or $windowMinutes -le 0) {
        return $null
    }

    try {
        $resetTime = [DateTimeOffset]::FromUnixTimeSeconds($resetsAt)
        if ($ObservedAt -ge $resetTime) {
            return $null
        }
        $windowStart = $resetTime.AddMinutes(-$windowMinutes)
        $elapsed = $ObservedAt - $windowStart
    }
    catch {
        return $null
    }
    if ($elapsed.TotalSeconds -lt 1) {
        return $null
    }

    $usedPercent = [double](Get-OptionalValue -Object $Limit -Name 'usedPercent' -DefaultValue 0)
    $usedPercent = [Math]::Max(0, [Math]::Min(100, $usedPercent))
    if ($usedPercent -le 0) {
        return 0.0
    }
    return $usedPercent / $elapsed.TotalHours
}

function Format-QuotaExhaustionEstimate {
    param(
        [double]$RemainingPercent,
        [object]$RatePerHour,
        [object]$TimeUntilReset
    )

    if ($RemainingPercent -le 0.001) {
        return '额度已经用完。'
    }
    if ($null -eq $RatePerHour) {
        return '暂时无法估算何时用完。'
    }

    $rate = [double]$RatePerHour
    if ($rate -le 0 -or [double]::IsNaN($rate) -or [double]::IsInfinity($rate)) {
        return '暂时无法估算何时用完。'
    }
    $hours = $RemainingPercent / $rate
    if ($hours -le 0 -or [double]::IsNaN($hours) -or [double]::IsInfinity($hours)) {
        return '暂时无法估算何时用完。'
    }
    try {
        $durationText = Format-QuotaDuration -Value ([TimeSpan]::FromHours($hours))
    }
    catch {
        return '暂时无法估算何时用完。'
    }
    $estimate = "将于${durationText}后用完。"
    if ($null -ne $TimeUntilReset -and
        ([TimeSpan]$TimeUntilReset).TotalSeconds -gt 0 -and
        $hours -ge ([TimeSpan]$TimeUntilReset).TotalHours) {
        $estimate += '该时间晚于下次更新，本周期预计用不完。'
    }
    return $estimate
}

function Get-QuotaSpeedTrendText {
    param(
        [object]$CurrentRatePerHour,
        [object]$PreviousRatePerHour,
        [object]$AverageRatePerHour
    )

    if ($null -eq $CurrentRatePerHour) {
        return '本次没有有效消耗速度，暂时无法比较快慢！'
    }
    $currentRate = [double]$CurrentRatePerHour
    $comparisonRate = $null
    $comparisonName = ''
    if ($null -ne $PreviousRatePerHour -and [double]$PreviousRatePerHour -gt 0) {
        $comparisonRate = [double]$PreviousRatePerHour
        $comparisonName = '上次'
    }
    elseif ($null -ne $AverageRatePerHour -and [double]$AverageRatePerHour -gt 0) {
        $comparisonRate = [double]$AverageRatePerHour
        $comparisonName = '本周期平均速度'
    }
    if ($null -eq $comparisonRate) {
        return '这是首次速度样本，暂时无法比较快慢！'
    }

    $difference = $currentRate - [double]$comparisonRate
    $largestRate = [Math]::Max([Math]::Abs($currentRate), [Math]::Abs([double]$comparisonRate))
    $tolerance = [Math]::Max(0.05, $largestRate * 0.10)
    if ([Math]::Abs($difference) -le $tolerance) {
        if ($comparisonName -eq '上次') {
            return '这次和上次使用速度基本一致。'
        }
        return '这次和本周期平均速度基本一致。'
    }
    if ($difference -gt 0) {
        if ($comparisonName -eq '上次') {
            return '这次比上次用得更快！'
        }
        return '这次比本周期平均速度更快！'
    }
    if ($comparisonName -eq '上次') {
        return '这次比上次用得更慢！'
    }
    return '这次比本周期平均速度更慢！'
}

function New-QuotaUsageChangeText {
    param(
        [double]$PreviousRemaining,
        [object]$CurrentLimit,
        [DateTimeOffset]$ObservedAt,
        [TimeSpan]$ElapsedSinceChange,
        [object]$CurrentRatePerHour,
        [object]$PreviousRatePerHour,
        [ValidateSet('decrease', 'increase', 'window')]
        [string]$ChangeKind
    )

    $currentRemaining = [double](Get-OptionalValue -Object $CurrentLimit -Name 'remainingPercent' -DefaultValue 0)
    $oldText = Format-QuotaPercent -Value $PreviousRemaining
    $newText = Format-QuotaPercent -Value $currentRemaining
    $elapsedText = Format-QuotaDuration -Value $ElapsedSinceChange
    $resetsAt = [int64](Get-OptionalValue -Object $CurrentLimit -Name 'resetsAt' -DefaultValue 0)
    $timeUntilReset = Get-QuotaTimeUntilReset -ResetsAt $resetsAt -ObservedAt $ObservedAt
    $untilResetText = Get-QuotaTimeUntilResetText -ResetsAt $resetsAt -ObservedAt $ObservedAt
    $averageRate = Get-QuotaAverageUsageRatePerHour -Limit $CurrentLimit -ObservedAt $ObservedAt

    switch ($ChangeKind) {
        'window' {
            $trendText = '本次额度周期已更新，使用速度重新采样！'
        }
        'increase' {
            $trendText = '本次额度增加，使用速度重新采样！'
        }
        default {
            $trendText = Get-QuotaSpeedTrendText -CurrentRatePerHour $CurrentRatePerHour -PreviousRatePerHour $PreviousRatePerHour -AverageRatePerHour $averageRate
        }
    }

    $currentEstimate = Format-QuotaExhaustionEstimate -RemainingPercent $currentRemaining -RatePerHour $CurrentRatePerHour -TimeUntilReset $timeUntilReset
    $averageEstimate = Format-QuotaExhaustionEstimate -RemainingPercent $currentRemaining -RatePerHour $averageRate -TimeUntilReset $timeUntilReset
    return @(
        "额度：$oldText% → $newText%",
        "距上次变化：$elapsedText",
        "使用速度：$trendText",
        "距下次更新还有：$untilResetText",
        "按当前速度：$currentEstimate",
        "按重置至今平均速度：$averageEstimate"
    ) -join "`n"
}

function Set-QuotaStateProperty {
    param(
        [object]$Object,
        [string]$Name,
        $Value
    )

    if ($null -ne $Object.PSObject.Properties[$Name]) {
        $Object.$Name = $Value
    }
    else {
        $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    }
}

function Copy-QuotaTrackingProperties {
    param(
        [object]$Source,
        [object]$Destination
    )

    foreach ($propertyName in @(
        'previousRemainingPercent',
        'lastChangeAt',
        'lastAcceptedObservedAt',
        'lastUsageRatePerHour',
        'lastAccelerationPerHourSquared',
        'pendingIncreaseRemainingPercent',
        'pendingIncreaseFirstObservedAt',
        'pendingIncreaseLastObservedAt',
        'pendingIncreaseConfirmations',
        'pendingIncreaseSawMainTask'
    )) {
        $property = $Source.PSObject.Properties[$propertyName]
        if ($null -ne $property) {
            Set-QuotaStateProperty -Object $Destination -Name $propertyName -Value $property.Value
        }
    }
    if ($null -eq $Source.PSObject.Properties['previousRemainingPercent'] -or
            $null -eq $Source.PSObject.Properties['previousRemainingPercent'].Value) {
        $currentRemaining = Get-OptionalValue -Object $Destination -Name 'remainingPercent' -DefaultValue $null
        Set-QuotaStateProperty -Object $Destination -Name 'previousRemainingPercent' -Value $currentRemaining
    }
}

function Clear-QuotaPendingIncrease {
    param([object]$Limit)

    Set-QuotaStateProperty -Object $Limit -Name 'pendingIncreaseRemainingPercent' -Value $null
    Set-QuotaStateProperty -Object $Limit -Name 'pendingIncreaseFirstObservedAt' -Value $null
    Set-QuotaStateProperty -Object $Limit -Name 'pendingIncreaseLastObservedAt' -Value $null
    Set-QuotaStateProperty -Object $Limit -Name 'pendingIncreaseConfirmations' -Value 0
    Set-QuotaStateProperty -Object $Limit -Name 'pendingIncreaseSawMainTask' -Value $false
}

function Set-QuotaAcceptedObservation {
    param(
        [object]$Limit,
        [string]$ObservedAt
    )

    Set-QuotaStateProperty -Object $Limit -Name 'lastAcceptedObservedAt' -Value $ObservedAt
    Clear-QuotaPendingIncrease -Limit $Limit
}

function Initialize-QuotaTracking {
    param(
        [object]$Limit,
        [string]$ObservedAt
    )

    $currentRemaining = Get-OptionalValue -Object $Limit -Name 'remainingPercent' -DefaultValue $null
    Set-QuotaStateProperty -Object $Limit -Name 'previousRemainingPercent' -Value $currentRemaining
    Set-QuotaStateProperty -Object $Limit -Name 'lastChangeAt' -Value $ObservedAt
    Set-QuotaStateProperty -Object $Limit -Name 'lastAcceptedObservedAt' -Value $ObservedAt
    Set-QuotaStateProperty -Object $Limit -Name 'lastUsageRatePerHour' -Value $null
    Set-QuotaStateProperty -Object $Limit -Name 'lastAccelerationPerHourSquared' -Value $null
    Clear-QuotaPendingIncrease -Limit $Limit
}

function Restore-QuotaAcceptedLimit {
    param(
        [object]$Source,
        [object]$Destination
    )

    foreach ($propertyName in @('usedPercent', 'remainingPercent', 'resetsAt')) {
        $value = Get-OptionalValue -Object $Source -Name $propertyName -DefaultValue $null
        Set-QuotaStateProperty -Object $Destination -Name $propertyName -Value $value
    }
    Copy-QuotaTrackingProperties -Source $Source -Destination $Destination
}

function Invoke-QuotaNotifier {
    param(
        [object]$Config,
        [object]$Notification
    )

    if (-not [bool](Get-OptionalValue -Object $Config -Name 'enabled' -DefaultValue $false) -or
        -not [bool](Get-OptionalValue -Object $Config -Name 'quotaNotifications' -DefaultValue $false)) {
        return
    }

    $mutex = New-Object System.Threading.Mutex($false, 'Local\CodexMobileNotifyQuota')
    $hasMutex = $false
    try {
        $hasMutex = $mutex.WaitOne(5000)
        if (-not $hasMutex) {
            Write-NotifyLog 'Quota check skipped because another notifier holds the lock'
            return
        }

        $threadId = [string](Get-OptionalValue -Object $Notification -Name 'thread-id' -DefaultValue '')
        $snapshot = Get-LatestRateLimitSnapshot -ThreadId $threadId
        if ($null -eq $snapshot) {
            Write-NotifyLog "Quota check found no official Codex weekly snapshot for thread: $threadId"
            return
        }

        $previousState = Read-QuotaState
        if ($SendQuotaStatus) {
            $statusPreviousByKey = @{}
            if ($null -ne $previousState) {
                foreach ($previousLimit in @(Get-OptionalValue -Object $previousState -Name 'limits' -DefaultValue @())) {
                    $statusPreviousByKey[[string](Get-OptionalValue -Object $previousLimit -Name 'key' -DefaultValue '')] = $previousLimit
                }
            }
            $statusLines = @()
            foreach ($currentLimit in @($snapshot.limits)) {
                if ([int]$currentLimit.windowMinutes -ne 10080) {
                    continue
                }
                $statusKey = [string]$currentLimit.key
                if ($statusPreviousByKey.ContainsKey($statusKey)) {
                    Copy-QuotaTrackingProperties -Source $statusPreviousByKey[$statusKey] -Destination $currentLimit
                }
                else {
                    Initialize-QuotaTracking -Limit $currentLimit -ObservedAt $snapshot.observedAt
                }
                $remainingText = Format-QuotaPercent -Value ([double]$currentLimit.remainingPercent)
                $resetText = Format-QuotaResetTime -UnixSeconds ([int64]$currentLimit.resetsAt)
                $statusLines += "每周额度：当前剩余 $remainingText%`n重置时间：$resetText"
            }
            $quotaEndpoint = [string](Get-OptionalValue -Object $Config -Name 'quotaEndpoint' -DefaultValue '')
            Send-MobileMessage -Config $Config -Title 'Codex 每周额度监控已启用' -Body ($statusLines -join "`n`n") -Priority 3 -Tags @('bar_chart') -EventName 'quota-status' -EndpointOverride $quotaEndpoint
            if (-not $DryRun -and $null -eq $previousState) {
                Save-QuotaState -Snapshot $snapshot
            }
            return
        }

        if ($null -eq $previousState) {
            foreach ($currentLimit in @($snapshot.limits)) {
                Initialize-QuotaTracking -Limit $currentLimit -ObservedAt $snapshot.observedAt
            }
            if (-not $DryRun) {
                Save-QuotaState -Snapshot $snapshot
            }
            Write-NotifyLog 'Quota baseline initialized'
            return
        }

        $previousByKey = @{}
        foreach ($previousLimit in @(Get-OptionalValue -Object $previousState -Name 'limits' -DefaultValue @())) {
            $previousByKey[[string](Get-OptionalValue -Object $previousLimit -Name 'key' -DefaultValue '')] = $previousLimit
        }

        $taskEligibility = Get-TaskNotificationEligibility -Notification $Notification
        $isSidebarMainTask = [bool]$taskEligibility.Allowed
        $changeLines = @()
        $hasIncrease = $false
        $stateWasUpdated = $false
        foreach ($currentLimit in @($snapshot.limits)) {
            if ([int]$currentLimit.windowMinutes -ne 10080) {
                continue
            }

            $key = [string]$currentLimit.key
            if (-not $previousByKey.ContainsKey($key)) {
                Initialize-QuotaTracking -Limit $currentLimit -ObservedAt $snapshot.observedAt
                $stateWasUpdated = $true
                continue
            }

            $previousLimit = $previousByKey[$key]
            Copy-QuotaTrackingProperties -Source $previousLimit -Destination $currentLimit
            $previousRemaining = [double](Get-OptionalValue -Object $previousLimit -Name 'remainingPercent' -DefaultValue $currentLimit.remainingPercent)
            $currentRemaining = [double]$currentLimit.remainingPercent
            $currentObservedAt = ConvertTo-DateTimeOffsetValue -Value $snapshot.observedAt
            $lastAcceptedValue = Get-OptionalValue -Object $previousLimit -Name 'lastAcceptedObservedAt' -DefaultValue (Get-OptionalValue -Object $previousState -Name 'observedAt' -DefaultValue '')
            try {
                $lastAcceptedAt = ConvertTo-DateTimeOffsetValue -Value $lastAcceptedValue
            }
            catch {
                $lastAcceptedAt = [DateTimeOffset]::MinValue
            }
            if ($currentObservedAt -le $lastAcceptedAt) {
                Restore-QuotaAcceptedLimit -Source $previousLimit -Destination $currentLimit
                Write-NotifyLog "Ignored stale quota snapshot for $key at $($snapshot.observedAt)"
                continue
            }

            $previousChangeValue = Get-OptionalValue -Object $previousLimit -Name 'lastChangeAt' -DefaultValue $previousState.observedAt
            try {
                $previousChangeAt = ConvertTo-DateTimeOffsetValue -Value $previousChangeValue
            }
            catch {
                $previousChangeAt = $lastAcceptedAt
            }
            $elapsed = $currentObservedAt - $previousChangeAt
            if ($elapsed.TotalSeconds -le 0) {
                Restore-QuotaAcceptedLimit -Source $previousLimit -Destination $currentLimit
                Write-NotifyLog "Ignored quota snapshot with a non-positive change interval for $key"
                continue
            }

            $previousResetAt = [int64](Get-OptionalValue -Object $previousLimit -Name 'resetsAt' -DefaultValue 0)
            $currentResetAt = [int64]$currentLimit.resetsAt
            $windowChanged = $false
            if ($previousResetAt -gt 0 -and $currentResetAt -le 0) {
                $currentResetAt = $previousResetAt
                Set-QuotaStateProperty -Object $currentLimit -Name 'resetsAt' -Value $previousResetAt
            }
            elseif ($previousResetAt -gt 0 -and $currentResetAt -gt 0) {
                $resetDifferenceSeconds = [Math]::Abs($currentResetAt - $previousResetAt)
                if ($resetDifferenceSeconds -le 60) {
                    $currentResetAt = $previousResetAt
                    Set-QuotaStateProperty -Object $currentLimit -Name 'resetsAt' -Value $previousResetAt
                }
                else {
                    $windowChanged = $true
                }
            }

            $difference = [Math]::Round($currentRemaining - $previousRemaining, 2)
            if ($windowChanged) {
                $isDefinitiveFullReset = $currentRemaining -ge 99.999
                if (-not $isSidebarMainTask -and -not $isDefinitiveFullReset) {
                    Restore-QuotaAcceptedLimit -Source $previousLimit -Destination $currentLimit
                    Write-NotifyLog "Ignored quota cycle change from a non-sidebar task for $key"
                    continue
                }
                $hasIncrease = $true
                Set-QuotaStateProperty -Object $currentLimit -Name 'previousRemainingPercent' -Value $previousRemaining
                Set-QuotaStateProperty -Object $currentLimit -Name 'lastChangeAt' -Value $snapshot.observedAt
                Set-QuotaStateProperty -Object $currentLimit -Name 'lastUsageRatePerHour' -Value $null
                Set-QuotaStateProperty -Object $currentLimit -Name 'lastAccelerationPerHourSquared' -Value $null
                Set-QuotaAcceptedObservation -Limit $currentLimit -ObservedAt $snapshot.observedAt
                $stateWasUpdated = $true
                $changeLines += New-QuotaUsageChangeText `
                    -PreviousRemaining $previousRemaining `
                    -CurrentLimit $currentLimit `
                    -ObservedAt $currentObservedAt `
                    -ElapsedSinceChange $elapsed `
                    -CurrentRatePerHour $null `
                    -PreviousRatePerHour $null `
                    -ChangeKind 'window'
                continue
            }

            if ([Math]::Abs($difference) -lt 0.001) {
                Set-QuotaStateProperty -Object $currentLimit -Name 'lastChangeAt' -Value $previousChangeValue
                Set-QuotaAcceptedObservation -Limit $currentLimit -ObservedAt $snapshot.observedAt
                $stateWasUpdated = $true
                continue
            }

            if ($difference -gt 0) {
                $acceptIncreaseImmediately = $isSidebarMainTask -or $currentRemaining -ge 99.999
                if ($acceptIncreaseImmediately) {
                    $hasIncrease = $true
                    Set-QuotaStateProperty -Object $currentLimit -Name 'previousRemainingPercent' -Value $previousRemaining
                    Set-QuotaStateProperty -Object $currentLimit -Name 'lastChangeAt' -Value $snapshot.observedAt
                    Set-QuotaStateProperty -Object $currentLimit -Name 'lastUsageRatePerHour' -Value $null
                    Set-QuotaStateProperty -Object $currentLimit -Name 'lastAccelerationPerHourSquared' -Value $null
                    Set-QuotaAcceptedObservation -Limit $currentLimit -ObservedAt $snapshot.observedAt
                    $stateWasUpdated = $true
                    $changeLines += New-QuotaUsageChangeText `
                        -PreviousRemaining $previousRemaining `
                        -CurrentLimit $currentLimit `
                        -ObservedAt $currentObservedAt `
                        -ElapsedSinceChange $elapsed `
                        -CurrentRatePerHour $null `
                        -PreviousRatePerHour $null `
                        -ChangeKind 'increase'
                    continue
                }

                $pendingRemainingValue = Get-OptionalValue -Object $previousLimit -Name 'pendingIncreaseRemainingPercent' -DefaultValue $null
                $pendingFirstValue = Get-OptionalValue -Object $previousLimit -Name 'pendingIncreaseFirstObservedAt' -DefaultValue $null
                $pendingLastValue = Get-OptionalValue -Object $previousLimit -Name 'pendingIncreaseLastObservedAt' -DefaultValue $null
                $pendingCount = [int](Get-OptionalValue -Object $previousLimit -Name 'pendingIncreaseConfirmations' -DefaultValue 0)
                $pendingSawMain = [bool](Get-OptionalValue -Object $previousLimit -Name 'pendingIncreaseSawMainTask' -DefaultValue $false)
                $hasPending = $null -ne $pendingRemainingValue -and -not [string]::IsNullOrWhiteSpace([string]$pendingFirstValue)

                if ($hasPending -and -not [string]::IsNullOrWhiteSpace([string]$pendingLastValue)) {
                    try {
                        $pendingLastAt = ConvertTo-DateTimeOffsetValue -Value $pendingLastValue
                    }
                    catch {
                        $pendingLastAt = [DateTimeOffset]::MinValue
                    }
                    if ($currentObservedAt -le $pendingLastAt) {
                        Restore-QuotaAcceptedLimit -Source $previousLimit -Destination $currentLimit
                        Write-NotifyLog "Ignored duplicate/stale quota increase candidate for $key"
                        continue
                    }
                }

                if (-not $hasPending) {
                    Restore-QuotaAcceptedLimit -Source $previousLimit -Destination $currentLimit
                    Set-QuotaStateProperty -Object $currentLimit -Name 'pendingIncreaseRemainingPercent' -Value $currentRemaining
                    Set-QuotaStateProperty -Object $currentLimit -Name 'pendingIncreaseFirstObservedAt' -Value $snapshot.observedAt
                    Set-QuotaStateProperty -Object $currentLimit -Name 'pendingIncreaseLastObservedAt' -Value $snapshot.observedAt
                    Set-QuotaStateProperty -Object $currentLimit -Name 'pendingIncreaseConfirmations' -Value 1
                    Set-QuotaStateProperty -Object $currentLimit -Name 'pendingIncreaseSawMainTask' -Value $isSidebarMainTask
                    $stateWasUpdated = $true
                    Write-NotifyLog "Held quota increase as a candidate for ${key}: $previousRemaining% -> $currentRemaining%"
                    continue
                }

                $pendingCount++
                $pendingSawMain = $pendingSawMain -or $isSidebarMainTask
                Restore-QuotaAcceptedLimit -Source $previousLimit -Destination $currentLimit
                Set-QuotaStateProperty -Object $currentLimit -Name 'pendingIncreaseRemainingPercent' -Value $currentRemaining
                Set-QuotaStateProperty -Object $currentLimit -Name 'pendingIncreaseFirstObservedAt' -Value $pendingFirstValue
                Set-QuotaStateProperty -Object $currentLimit -Name 'pendingIncreaseLastObservedAt' -Value $snapshot.observedAt
                Set-QuotaStateProperty -Object $currentLimit -Name 'pendingIncreaseConfirmations' -Value $pendingCount
                Set-QuotaStateProperty -Object $currentLimit -Name 'pendingIncreaseSawMainTask' -Value $pendingSawMain
                $stateWasUpdated = $true
                Write-NotifyLog "Quota increase candidate is awaiting confirmation for $key"
                continue
            }

            Set-QuotaStateProperty -Object $currentLimit -Name 'previousRemainingPercent' -Value $previousRemaining
            Set-QuotaStateProperty -Object $currentLimit -Name 'lastChangeAt' -Value $snapshot.observedAt
            Set-QuotaAcceptedObservation -Limit $currentLimit -ObservedAt $snapshot.observedAt
            $stateWasUpdated = $true
            $usageRate = [Math]::Abs($difference) / $elapsed.TotalHours
            $previousRateValue = Get-OptionalValue -Object $previousLimit -Name 'lastUsageRatePerHour' -DefaultValue $null
            if ($null -ne $previousRateValue) {
                $previousRate = [double]$previousRateValue
                $acceleration = ($usageRate - $previousRate) / $elapsed.TotalHours
                Set-QuotaStateProperty -Object $currentLimit -Name 'lastAccelerationPerHourSquared' -Value ([Math]::Round($acceleration, 6))
            }
            else {
                Set-QuotaStateProperty -Object $currentLimit -Name 'lastAccelerationPerHourSquared' -Value $null
            }
            Set-QuotaStateProperty -Object $currentLimit -Name 'lastUsageRatePerHour' -Value ([Math]::Round($usageRate, 6))

            $changeLines += New-QuotaUsageChangeText `
                -PreviousRemaining $previousRemaining `
                -CurrentLimit $currentLimit `
                -ObservedAt $currentObservedAt `
                -ElapsedSinceChange $elapsed `
                -CurrentRatePerHour $usageRate `
                -PreviousRatePerHour $previousRateValue `
                -ChangeKind 'decrease'
        }

        if ($changeLines.Count -gt 0) {
            $priority = if ($hasIncrease) { 4 } else { 3 }
            $tag = if ($hasIncrease) { 'chart_with_upwards_trend' } else { 'chart_with_downwards_trend' }
            $quotaEndpoint = [string](Get-OptionalValue -Object $Config -Name 'quotaEndpoint' -DefaultValue '')
            Send-MobileMessage -Config $Config -Title 'Codex 每周额度使用变化' -Body ($changeLines -join "`n`n") -Priority $priority -Tags @($tag) -EventName 'quota-changed' -EndpointOverride $quotaEndpoint
        }

        if (-not $DryRun -and $stateWasUpdated) {
            Save-QuotaState -Snapshot $snapshot
        }
    }
    finally {
        if ($hasMutex) {
            [void]$mutex.ReleaseMutex()
        }
        $mutex.Dispose()
    }
}

try {
    if (-not (Test-Path -LiteralPath $configPath)) {
        Write-NotifyLog 'Configuration file is missing'
        return
    }

    $config = Get-Content -Raw -LiteralPath $configPath -Encoding UTF8 | ConvertFrom-Json
    if (-not [string]::IsNullOrWhiteSpace($SystemTestEvent)) {
        $notification = [pscustomobject]@{
            type = 'agent-turn-complete'
            'synthetic-test' = $true
        }
        switch ($SystemTestEvent) {
            'task' {
                Send-MobileMessage -Config $config -Title '码驿 · CodexRelay 系统测试：任务完成通知' -Body "系统测试通知：任务完成出站链路。`n此消息不可用于回复续接任务。" -Priority 3 -Tags @('test_tube') -EventName 'user-task-complete' -Notification $notification
            }
            'confirmation' {
                Send-MobileMessage -Config $config -Title '码驿 · CodexRelay 系统测试：任务待确认通知' -Body "系统测试通知：任务待确认出站链路。`n此消息不可用于回复续接任务。" -Priority 4 -Tags @('test_tube') -EventName 'user-task-confirmation-required' -Notification $notification
            }
            'quota' {
                Send-MobileMessage -Config $config -Title '码驿 · CodexRelay 系统测试：额度变化通知' -Body "系统测试通知：额度变化出站链路。`n此测试不读取或修改额度历史。" -Priority 3 -Tags @('test_tube') -EventName 'quota-changed' -Notification $notification
            }
        }
        return
    }

    if (-not [string]::IsNullOrWhiteSpace($NotificationFile)) {
        $NotificationJson = [System.IO.File]::ReadAllText([System.IO.Path]::GetFullPath($NotificationFile), [System.Text.Encoding]::UTF8)
    }
    elseif ([string]::IsNullOrWhiteSpace($NotificationJson)) {
        $NotificationJson = [Console]::In.ReadToEnd()
    }
    if ([string]::IsNullOrWhiteSpace($NotificationJson)) {
        throw 'Notification JSON is empty'
    }

    $notification = $NotificationJson | ConvertFrom-Json
    $eventType = [string](Get-OptionalValue -Object $notification -Name 'type' -DefaultValue '')

    if ($eventType -ne 'agent-turn-complete') {
        return
    }

    if (-not $MobileOnly) {
        Invoke-PreviousNotifier -Config $config -RawNotification $NotificationJson
    }

    $isHeartbeat = Test-IsHeartbeatNotification -Notification $notification
    $isInternal = Test-IsInternalNotification -Notification $notification

    if ($SendQuotaStatus -or (-not $isHeartbeat -and -not $isInternal)) {
        try {
            Invoke-QuotaNotifier -Config $config -Notification $notification
        }
        catch {
            Write-NotifyLog "Quota notification failed: $($_.Exception.Message)"
        }
    }

    try {
        if ($SkipTaskNotification) {
            return
        }
        if ($isHeartbeat) {
            Write-NotifyLog 'Heartbeat turn skipped for mobile task notification'
            if ($FallbackInvocation) {
                throw 'Watcher task notification was rejected as heartbeat input'
            }
            return
        }
        if ($isInternal) {
            Write-NotifyLog 'Internal/background turn skipped for mobile task notification'
            if ($FallbackInvocation) {
                throw 'Watcher task notification was rejected as internal input'
            }
            return
        }
        $eligibility = Get-TaskNotificationEligibility -Notification $notification
        if (-not [bool]$eligibility.Allowed) {
            Write-NotifyLog "Non-sidebar/subagent turn skipped for mobile task notification: $($eligibility.Reason)"
            if ($FallbackInvocation) {
                throw 'Watcher task notification root eligibility could not be verified'
            }
            return
        }
        $notification = Add-NotificationTurnSupport -Notification $notification
        $notificationKind = Get-TaskNotificationKind -Notification $notification
        $sendTaskNotification = {
            if ($notificationKind -eq 'confirmation') {
                Invoke-ConfirmationNotifier -Config $config -Notification $notification
            }
            else {
                Invoke-MobileNotifier -Config $config -Notification $notification
            }
        }

        $turnId = [string](Get-OptionalValue -Object $notification -Name 'turn-id' -DefaultValue '')
        if ($DryRun -or [string]::IsNullOrWhiteSpace($turnId)) {
            & $sendTaskNotification
        }
        elseif (-not (Get-Command -Name Invoke-TaskNotificationOnce -ErrorAction SilentlyContinue)) {
            throw 'Task notification delivery state module is unavailable'
        }
        else {
            $wasSent = Invoke-TaskNotificationOnce -Path $taskDeliveryStatePath -TurnId $turnId -Action $sendTaskNotification
            if (-not $wasSent) {
                Write-NotifyLog "Duplicate task notification skipped for turn $turnId"
            }
        }
    }
    catch {
        Write-NotifyLog "Mobile notification failed: $($_.Exception.Message)"
        if ($FallbackInvocation) {
            throw
        }
    }
}
catch {
    Write-NotifyLog "Dispatcher failed: $($_.Exception.Message)"
    if ($FallbackInvocation) {
        Write-Error $_
        exit 1
    }
}

return
