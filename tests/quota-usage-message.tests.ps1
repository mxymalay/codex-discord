[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceDispatcher = Join-Path (Split-Path -Parent $PSScriptRoot) 'dispatcher.ps1'
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = [System.IO.Path]::GetFullPath((Join-Path $tempBase ('codex-quota-message-tests-{0}' -f [guid]::NewGuid().ToString('N'))))

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

function From-Base64Utf8 {
    param([string]$Value)
    return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}

function Assert-ContainsText {
    param(
        [string]$CaseName,
        [string]$Body,
        [string]$Expected
    )

    if ($Body.IndexOf($Expected, [System.StringComparison]::Ordinal) -lt 0) {
        throw "[$CaseName] missing expected text: $Expected`nActual body:`n$Body"
    }
}

function Invoke-QuotaCase {
    param(
        [string]$Name,
        [double]$PreviousRemaining,
        [double]$CurrentUsed,
        [string]$PreviousChangeAt,
        [object]$PreviousRate,
        [string]$CurrentObservedAt,
        [string]$PreviousResetAt,
        [string]$CurrentResetAt,
        [string[]]$ExpectedTexts,
        [switch]$ConfirmedIncrease
    )

    $threadId = [guid]::NewGuid().ToString()
    $previousResetUnix = [DateTimeOffset]::Parse($PreviousResetAt).ToUnixTimeSeconds()
    $currentResetUnix = [DateTimeOffset]::Parse($CurrentResetAt).ToUnixTimeSeconds()
    $previousUsed = [Math]::Round(100 - $PreviousRemaining, 2)
    $key = 'codex|primary|10080'

    $previousLimit = [ordered]@{
        key = $key
        name = 'weekly'
        slot = 'primary'
        windowMinutes = 10080
        usedPercent = $previousUsed
        remainingPercent = $PreviousRemaining
        previousRemainingPercent = $PreviousRemaining
        resetsAt = $previousResetUnix
        lastChangeAt = $PreviousChangeAt
        lastAcceptedObservedAt = $PreviousChangeAt
        lastUsageRatePerHour = $PreviousRate
        lastAccelerationPerHourSquared = $null
        pendingIncreaseRemainingPercent = $null
        pendingIncreaseFirstObservedAt = $null
        pendingIncreaseLastObservedAt = $null
        pendingIncreaseConfirmations = 0
        pendingIncreaseSawMainTask = $false
    }
    if ($ConfirmedIncrease) {
        $pendingAt = [DateTimeOffset]::Parse($CurrentObservedAt).AddSeconds(-31).ToString('o')
        $previousLimit.pendingIncreaseRemainingPercent = [Math]::Round(100 - $CurrentUsed, 2)
        $previousLimit.pendingIncreaseFirstObservedAt = $pendingAt
        $previousLimit.pendingIncreaseLastObservedAt = $pendingAt
        $previousLimit.pendingIncreaseConfirmations = 1
    }
    $previousState = [ordered]@{
        observedAt = $PreviousChangeAt
        limitId = 'codex'
        limits = @($previousLimit)
    }
    Write-Utf8NoBom -Path $quotaStatePath -Content ($previousState | ConvertTo-Json -Depth 10)

    $rateLimits = [ordered]@{
        limit_id = 'codex'
        primary = [ordered]@{
            used_percent = $CurrentUsed
            window_minutes = 10080
            resets_at = $currentResetUnix
        }
    }
    $metadata = [ordered]@{
        timestamp = $CurrentObservedAt
        type = 'session_meta'
        payload = [ordered]@{
            id = $threadId
            session_id = $threadId
            parent_thread_id = $null
            thread_source = 'user'
            source = 'vscode'
        }
    }
    $event = [ordered]@{
        timestamp = $CurrentObservedAt
        type = 'event_msg'
        payload = [ordered]@{
            type = 'token_count'
            rate_limits = $rateLimits
        }
    }
    $sessionPath = Join-Path $sessionsPath "rollout-$threadId.jsonl"
    Write-Utf8NoBom -Path $sessionPath -Content (($metadata | ConvertTo-Json -Depth 12 -Compress) + "`n" + ($event | ConvertTo-Json -Depth 12 -Compress) + "`n")
    $indexEntry = [ordered]@{ id = $threadId; thread_name = 'quota message root'; updated_at = $CurrentObservedAt }
    $existingIndex = if (Test-Path -LiteralPath $sessionIndexPath) { Get-Content -Raw -LiteralPath $sessionIndexPath -Encoding UTF8 } else { '' }
    Write-Utf8NoBom -Path $sessionIndexPath -Content ($existingIndex + ($indexEntry | ConvertTo-Json -Compress) + "`n")

    $notification = [ordered]@{
        type = 'agent-turn-complete'
        'thread-id' = $threadId
        'turn-id' = [guid]::NewGuid().ToString()
        cwd = 'C:\workspace\quota-test'
        'input-messages' = @('quota message test')
        'last-assistant-message' = 'complete'
    }
    $raw = $notification | ConvertTo-Json -Depth 8 -Compress
    $result = ((@(& $testDispatcher $raw -MobileOnly -SkipTaskNotification -DryRun) | ForEach-Object { [string]$_ }) -join "`n").Trim()
    if ([string]::IsNullOrWhiteSpace($result)) {
        $testLogPath = Join-Path $toolDir 'mobile-notify.log'
        $diagnostic = if (Test-Path -LiteralPath $testLogPath) { Get-Content -Raw -LiteralPath $testLogPath -Encoding UTF8 } else { 'no dispatcher log' }
        throw "[$Name] dispatcher emitted no quota notification. Diagnostic: $diagnostic"
    }
    $message = $result | ConvertFrom-Json
    if ([string]$message.event -ne 'quota-changed') {
        throw "[$Name] expected event=quota-changed, got $($message.event)"
    }
    if ($script:expectedProvider -eq 'discord') {
        if ([string]$message.endpoint -ne 'https://discord.com/api/webhooks/333333/quota-secret') {
            throw "[$Name] expected Discord quota webhook, got $($message.endpoint)"
        }
    }
    elseif ($script:expectedProvider -eq 'discord-bot') {
        if ([string]$message.provider -ne 'discord-bot' -or [string]$message.channelId -ne '666666666666666666') {
            throw "[$Name] expected Discord Bot quota channel, got provider=$($message.provider), channel=$($message.channelId)"
        }
    }
    if ([int]$message.payload.embeds[0].color -ne 3447003) {
        throw "[$Name] expected blue Discord embed 3447003, got $($message.payload.embeds[0].color)"
    }
    $description = [string]$message.payload.embeds[0].description
    foreach ($label in @('额度', '距上次变化', '使用速度', '距下次更新还有', '按当前速度', '按重置至今平均速度')) {
        Assert-ContainsText -CaseName $Name -Body $description -Expected "**$label：**"
    }
    foreach ($expected in $ExpectedTexts) {
        Assert-ContainsText -CaseName $Name -Body ([string]$message.body) -Expected $expected
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
        provider = 'discord'
        endpoint = 'https://discord.com/api/webhooks/111111/task-secret'
        confirmationEndpoint = 'https://discord.com/api/webhooks/222222/confirmation-secret'
        quotaEndpoint = 'https://discord.com/api/webhooks/333333/quota-secret'
        token = ''
        includeAssistantMessage = $true
        quotaNotifications = $true
        timeoutSeconds = 1
        previousNotify = @()
    }
    Write-Utf8NoBom -Path (Join-Path $toolDir 'config.json') -Content ($config | ConvertTo-Json -Depth 8)
    $expectedProvider = 'discord'

    $observedAt = '2026-08-31T12:00:00Z'
    $resetAt = '2026-09-05T00:00:00Z'
    $previousResetAt = '2026-09-05T00:00:00Z'

    Invoke-QuotaCase -Name 'faster usage and exact estimates' `
        -PreviousRemaining 90 -CurrentUsed 12 -PreviousChangeAt '2026-08-31T10:00:00Z' -PreviousRate 0.5 `
        -CurrentObservedAt $observedAt -PreviousResetAt $previousResetAt -CurrentResetAt $resetAt `
        -ExpectedTexts @(
            (From-Base64Utf8 '6aKd5bqm77yaOTAlIOKGkiA4OCU='),
            (From-Base64Utf8 '6Led5LiK5qyh5Y+Y5YyW77yaMuWwj+aXtg=='),
            (From-Base64Utf8 '6L+Z5qyh5q+U5LiK5qyh55So5b6X5pu05b+r77yB'),
            (From-Base64Utf8 '6Led5LiL5qyh5pu05paw6L+Y5pyJ77yaNOWkqTEy5bCP5pe2'),
            (From-Base64Utf8 '5oyJ5b2T5YmN6YCf5bqm77ya5bCG5LqOM+WkqTE25bCP5pe25ZCO55So5a6M44CC'),
            (From-Base64Utf8 '5oyJ6YeN572u6Iez5LuK5bmz5Z2H6YCf5bqm77ya5bCG5LqOMTjlpKk45bCP5pe25ZCO55So5a6M44CC'),
            (From-Base64Utf8 '6K+l5pe26Ze05pma5LqO5LiL5qyh5pu05paw77yM5pys5ZGo5pyf6aKE6K6h55So5LiN5a6M44CC')
        )

    Invoke-QuotaCase -Name 'slower usage' `
        -PreviousRemaining 90 -CurrentUsed 11 -PreviousChangeAt '2026-08-31T10:00:00Z' -PreviousRate 1.0 `
        -CurrentObservedAt $observedAt -PreviousResetAt $previousResetAt -CurrentResetAt $resetAt `
        -ExpectedTexts @((From-Base64Utf8 '6L+Z5qyh5q+U5LiK5qyh55So5b6X5pu05oWi77yB'))

    Invoke-QuotaCase -Name 'stable usage' `
        -PreviousRemaining 90 -CurrentUsed 12 -PreviousChangeAt '2026-08-31T10:00:00Z' -PreviousRate 1.0 `
        -CurrentObservedAt $observedAt -PreviousResetAt $previousResetAt -CurrentResetAt $resetAt `
        -ExpectedTexts @((From-Base64Utf8 '6L+Z5qyh5ZKM5LiK5qyh5L2/55So6YCf5bqm5Z+65pys5LiA6Ie044CC'))

    Invoke-QuotaCase -Name 'small quantization noise is stable' `
        -PreviousRemaining 90 -CurrentUsed 31 -PreviousChangeAt '2026-08-31T10:00:00Z' -PreviousRate 10.0 `
        -CurrentObservedAt $observedAt -PreviousResetAt $previousResetAt -CurrentResetAt $resetAt `
        -ExpectedTexts @((From-Base64Utf8 '6L+Z5qyh5ZKM5LiK5qyh5L2/55So6YCf5bqm5Z+65pys5LiA6Ie044CC'))

    Invoke-QuotaCase -Name 'quota increase restarts current speed' `
        -PreviousRemaining 88 -CurrentUsed 5 -PreviousChangeAt '2026-08-31T10:00:00Z' -PreviousRate 1.0 `
        -CurrentObservedAt $observedAt -PreviousResetAt $previousResetAt -CurrentResetAt $resetAt `
        -ConfirmedIncrease `
        -ExpectedTexts @(
            (From-Base64Utf8 '5pys5qyh6aKd5bqm5aKe5Yqg77yM5L2/55So6YCf5bqm6YeN5paw6YeH5qC377yB'),
            (From-Base64Utf8 '5oyJ5b2T5YmN6YCf5bqm77ya5pqC5pe25peg5rOV5Lyw566X5L2V5pe255So5a6M44CC')
        )

    Invoke-QuotaCase -Name 'window switch restarts sampling' `
        -PreviousRemaining 90 -CurrentUsed 0 -PreviousChangeAt '2026-08-31T10:00:00Z' -PreviousRate 1.0 `
        -CurrentObservedAt $observedAt -PreviousResetAt '2026-09-04T00:00:00Z' -CurrentResetAt $resetAt `
        -ExpectedTexts @(
            (From-Base64Utf8 '5pys5qyh6aKd5bqm5ZGo5pyf5bey5pu05paw77yM5L2/55So6YCf5bqm6YeN5paw6YeH5qC377yB'),
            (From-Base64Utf8 '5oyJ6YeN572u6Iez5LuK5bmz5Z2H6YCf5bqm77ya5pqC5pe25peg5rOV5Lyw566X5L2V5pe255So5a6M44CC')
        )

    Invoke-QuotaCase -Name 'depleted quota is explicit' `
        -PreviousRemaining 1 -CurrentUsed 100 -PreviousChangeAt '2026-08-31T10:00:00Z' -PreviousRate 1.0 `
        -CurrentObservedAt $observedAt -PreviousResetAt $previousResetAt -CurrentResetAt $resetAt `
        -ExpectedTexts @(
            (From-Base64Utf8 '5oyJ5b2T5YmN6YCf5bqm77ya6aKd5bqm5bey57uP55So5a6M44CC'),
            (From-Base64Utf8 '5oyJ6YeN572u6Iez5LuK5bmz5Z2H6YCf5bqm77ya6aKd5bqm5bey57uP55So5a6M44CC')
        )

    Invoke-QuotaCase -Name 'unknown reset time is explicit' `
        -PreviousRemaining 90 -CurrentUsed 12 -PreviousChangeAt '2026-08-31T10:00:00Z' -PreviousRate 0.5 `
        -CurrentObservedAt $observedAt -PreviousResetAt '1970-01-01T00:00:00Z' -CurrentResetAt '1970-01-01T00:00:00Z' `
        -ExpectedTexts @(
            (From-Base64Utf8 '6Led5LiL5qyh5pu05paw6L+Y5pyJ77ya5pyq55+l'),
            (From-Base64Utf8 '5oyJ6YeN572u6Iez5LuK5bmz5Z2H6YCf5bqm77ya5pqC5pe25peg5rOV5Lyw566X5L2V5pe255So5a6M44CC')
        )

    Invoke-QuotaCase -Name 'expired reset time is explicit' `
        -PreviousRemaining 90 -CurrentUsed 12 -PreviousChangeAt '2026-08-31T10:00:00Z' -PreviousRate 0.5 `
        -CurrentObservedAt $observedAt -PreviousResetAt '2026-08-31T11:00:00Z' -CurrentResetAt '2026-08-31T11:00:00Z' `
        -ExpectedTexts @(
            (From-Base64Utf8 '6Led5LiL5qyh5pu05paw6L+Y5pyJ77ya5LiN6LazMeWIhumSnw=='),
            (From-Base64Utf8 '5oyJ6YeN572u6Iez5LuK5bmz5Z2H6YCf5bqm77ya5pqC5pe25peg5rOV5Lyw566X5L2V5pe255So5a6M44CC')
        )

    Invoke-QuotaCase -Name 'first speed compares with cycle average' `
        -PreviousRemaining 90 -CurrentUsed 12 -PreviousChangeAt '2026-08-31T10:00:00Z' -PreviousRate $null `
        -CurrentObservedAt $observedAt -PreviousResetAt $previousResetAt -CurrentResetAt $resetAt `
        -ExpectedTexts @((From-Base64Utf8 '6L+Z5qyh5q+U5pys5ZGo5pyf5bmz5Z2H6YCf5bqm5pu05b+r77yB'))

    $config.provider = 'discord-bot'
    $config.endpoint = ''
    $config.confirmationEndpoint = ''
    $config.quotaEndpoint = ''
    $config | Add-Member -NotePropertyName 'discordTaskChannelId' -NotePropertyValue '444444444444444444'
    $config | Add-Member -NotePropertyName 'discordConfirmationChannelId' -NotePropertyValue '555555555555555555'
    $config | Add-Member -NotePropertyName 'discordQuotaChannelId' -NotePropertyValue '666666666666666666'
    $config | Add-Member -NotePropertyName 'discordTokenPath' -NotePropertyValue 'C:\safe\discord-token.dpapi'
    Write-Utf8NoBom -Path (Join-Path $toolDir 'config.json') -Content ($config | ConvertTo-Json -Depth 8)
    $expectedProvider = 'discord-bot'
    Invoke-QuotaCase -Name 'Discord Bot quota route' `
        -PreviousRemaining 90 -CurrentUsed 12 -PreviousChangeAt '2026-08-31T10:00:00Z' -PreviousRate 0.5 `
        -CurrentObservedAt $observedAt -PreviousResetAt $previousResetAt -CurrentResetAt $resetAt `
        -ExpectedTexts @((From-Base64Utf8 '6aKd5bqm77yaOTAlIOKGkiA4OCU='))

    Write-Output 'PASS: 11 quota usage message cases'
}
finally {
    if ((Test-Path -LiteralPath $tempRoot) -and $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
