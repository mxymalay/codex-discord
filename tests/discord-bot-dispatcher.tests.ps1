[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = [System.IO.Path]::GetFullPath((Join-Path $tempBase ('codex-discord-bot-dispatcher-tests-{0}' -f [guid]::NewGuid().ToString('N'))))
if (-not $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe temporary test path: $tempRoot"
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Content)

    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) {
        [void](New-Item -ItemType Directory -Path $parent -Force)
    }
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Invoke-TaskCase {
    param(
        [string]$AssistantMessage,
        [string]$OriginChannelId = '',
        [string]$OriginGuildId = '',
        [string]$TurnId = $script:turnId,
        [string]$ThreadId = $script:threadId,
        [string]$TaskMessage = '处理 Discord Bot 通知',
        [string]$Cwd = 'C:\workspace\demo-project',
        [switch]$SyntheticTest,
        [switch]$LiveSend
    )

    $notification = [ordered]@{
        type = 'agent-turn-complete'
        'thread-id' = $ThreadId
        'turn-id' = $TurnId
        cwd = $Cwd
        'input-messages' = @($TaskMessage)
        'last-assistant-message' = $AssistantMessage
    }
    if (-not [string]::IsNullOrWhiteSpace($OriginChannelId)) {
        $notification['discord-origin-channel-id'] = $OriginChannelId
    }
    if (-not [string]::IsNullOrWhiteSpace($OriginGuildId)) {
        $notification['discord-guild-id'] = $OriginGuildId
    }
    if ($SyntheticTest) {
        $notification['synthetic-test'] = $true
    }
    $raw = $notification | ConvertTo-Json -Depth 8 -Compress
    if ($LiveSend) {
        [void](& $script:dispatcher $raw -MobileOnly)
        return
    }
    $output = @(& $script:dispatcher $raw -MobileOnly -DryRun)
    return ((($output | ForEach-Object { [string]$_ }) -join "`n").Trim() | ConvertFrom-Json)
}

function Write-InboxOriginState {
    param(
        [string]$ChannelId = $script:originChannelId,
        [string]$TurnId = $script:turnId,
        [string]$ThreadId = $script:threadId,
        [hashtable]$OriginOverrides = @{},
        [hashtable]$StateOverrides = @{}
    )

    $origin = [ordered]@{
        threadId = $ThreadId
        guildId = '888888888888888888'
        channelId = $ChannelId
        source = 'slash'
        createdAt = '2026-08-31T00:00:00.000Z'
        rolloutCursor = 0
        deliveredEventIds = @()
        deliveryState = 'pending'
    }
    foreach ($key in $OriginOverrides.Keys) { $origin[$key] = $OriginOverrides[$key] }
    $origins = [ordered]@{}
    $origins[$TurnId] = $origin
    $state = [ordered]@{
        version = 2
        initialized = $true
        cursors = [ordered]@{}
        processedMessageIds = @()
        pendingContinuations = [ordered]@{}
        processedInteractions = @()
        createdTasksByInteraction = [ordered]@{}
        discordTurnOrigins = $origins
    }
    foreach ($key in $StateOverrides.Keys) { $state[$key] = $StateOverrides[$key] }
    Write-Utf8NoBom -Path (Join-Path $script:toolDir 'discord-inbox-state.json') -Content ($state | ConvertTo-Json -Depth 12)
}

try {
    $toolDir = Join-Path $tempRoot 'mobile-notify'
    [void](New-Item -ItemType Directory -Path $toolDir -Force)
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'dispatcher.ps1') -Destination (Join-Path $toolDir 'dispatcher.ps1')
    foreach ($moduleName in @('discord-secret.ps1', 'discord-state.ps1', 'task-delivery-state.ps1')) {
        $modulePath = Join-Path $sourceRoot $moduleName
        if (Test-Path -LiteralPath $modulePath) {
            Copy-Item -LiteralPath $modulePath -Destination (Join-Path $toolDir $moduleName)
        }
    }
    $dispatcher = Join-Path $toolDir 'dispatcher.ps1'

    $taskChannelId = '444444444444444444'
    $confirmationChannelId = '555555555555555555'
    $quotaChannelId = '666666666666666666'
    $originChannelId = '777777777777777777'
    $threadId = '11111111-1111-4111-8111-111111111111'
    $turnId = '22222222-2222-4222-8222-222222222222'
    $config = [ordered]@{
        enabled = $true
        provider = 'discord-bot'
        endpoint = ''
        confirmationEndpoint = ''
        quotaEndpoint = ''
        discordTaskChannelId = $taskChannelId
        discordConfirmationChannelId = $confirmationChannelId
        discordQuotaChannelId = $quotaChannelId
        discordTokenPath = 'C:\safe\discord-token.dpapi'
        includeAssistantMessage = $true
        quotaNotifications = $false
        timeoutSeconds = 1
        previousNotify = @()
    }
    Write-Utf8NoBom -Path (Join-Path $toolDir 'config.json') -Content ($config | ConvertTo-Json -Depth 8)
    Write-Utf8NoBom -Path (Join-Path $tempRoot 'session_index.jsonl') -Content (([ordered]@{ id=$threadId; thread_name='Discord Bot 测试任务'; updated_at='2026-08-31T00:00:00Z' } | ConvertTo-Json -Compress) + "`n")
    $session = [ordered]@{
        timestamp = '2026-08-31T00:00:00.000Z'
        type = 'session_meta'
        payload = [ordered]@{ id=$threadId; session_id=$threadId; parent_thread_id=$null; thread_source='user'; source='vscode'; originator='Codex Desktop' }
    }
    Write-Utf8NoBom -Path (Join-Path $tempRoot "sessions\2026\08\31\rollout-$threadId.jsonl") -Content (($session | ConvertTo-Json -Depth 12 -Compress) + "`n")

    $completed = Invoke-TaskCase -AssistantMessage '已经完成修改，全部测试通过。'
    if ([string]$completed.provider -ne 'discord-bot' -or [string]$completed.channelId -ne $taskChannelId) {
        throw 'Completed task did not route to the Discord Bot task channel'
    }
    if ([int]$completed.payload.embeds[0].color -ne 3066993) {
        throw 'Completed task Discord embed is not green'
    }
    if ([string]$completed.payload.embeds[0].title -ne 'Codex 任务已完成') { throw 'completed title contains task name or separator' }
    $completedJson = $completed.payload | ConvertTo-Json -Depth 12
    if (-not $completedJson.Contains('Discord Bot 测试任务')) { throw 'task name disappeared from completed body' }
    if (@($completed.payload.allowed_mentions.parse).Count -ne 0) {
        throw 'Discord Bot payload enabled automatic mentions'
    }

    $markdownTaskName = '# heading [task](https://evil.invalid) ``` > quote **bold**'
    Write-Utf8NoBom -Path (Join-Path $tempRoot 'session_index.jsonl') -Content (([ordered]@{ id=$threadId; thread_name=$markdownTaskName; updated_at='2026-08-31T00:00:00Z' } | ConvertTo-Json -Compress) + "`n")
    $markdownCase = Invoke-TaskCase `
        -AssistantMessage '# result [link](https://evil.invalid) ``` > quote **bold**' `
        -TaskMessage '# task [link](https://evil.invalid) ``` > quote **bold**' `
        -Cwd 'C:\workspace\# project [link](evil) ``` > quote **bold**'
    $markdownFields = @{}
    foreach ($field in @($markdownCase.payload.embeds[0].fields)) { $markdownFields[[string]$field.name] = [string]$field.value }
    foreach ($name in @('项目名', '任务名', '任务', '结果')) {
        if (-not $markdownFields.ContainsKey($name)) { throw "Markdown case omitted fixed field heading: $name" }
        $value = $markdownFields[$name]
        if ($value -match '(?m)(^|\s)#\s' -or $value -match '\[[^\]]+\]\(' -or
            $value.Contains('```') -or $value -match '(?m)(^|\s)>\s' -or $value.Contains('**bold**')) {
            throw "Dynamic Discord field retained executable Markdown: $name"
        }
        if (-not $value.Contains('\#') -or -not $value.Contains('\[') -or
            -not $value.Contains('\`') -or -not $value.Contains('\>') -or -not $value.Contains('\*')) {
            throw "Dynamic Discord field was not uniformly Markdown-escaped: $name"
        }
    }
    if (@($markdownCase.payload.allowed_mentions.parse).Count -ne 0) { throw 'Markdown case enabled automatic mentions' }
    Write-Utf8NoBom -Path (Join-Path $tempRoot 'session_index.jsonl') -Content (([ordered]@{ id=$threadId; thread_name='Discord Bot 测试任务'; updated_at='2026-08-31T00:00:00Z' } | ConvertTo-Json -Compress) + "`n")

    $confirmation = Invoke-TaskCase -AssistantMessage '我准备安装依赖并修改配置，可以吗？'
    if ([string]$confirmation.channelId -ne $confirmationChannelId -or [string]$confirmation.event -ne 'user-task-confirmation-required') {
        throw 'Confirmation task did not route to the Discord Bot confirmation channel'
    }
    if ([int]$confirmation.payload.embeds[0].color -ne 15965202) {
        throw 'Confirmation Discord embed is not orange'
    }
    if ([string]$confirmation.payload.embeds[0].title -ne 'Codex 任务待确认') { throw 'confirmation title contains task name or separator' }
    $confirmationJson = $confirmation.payload | ConvertTo-Json -Depth 12
    if (-not $confirmationJson.Contains('Discord Bot 测试任务')) { throw 'task name disappeared from confirmation body' }

    Write-InboxOriginState
    $originCompleted = Invoke-TaskCase -AssistantMessage '已经完成修改，全部测试通过。'
    if ([string]$originCompleted.channelId -ne $originChannelId) {
        throw 'Native Discord-origin completed task did not resolve its persisted exact origin channel'
    }
    if ($originCompleted.payload.enforce_nonce -ne $true -or [string]$originCompleted.payload.nonce -notmatch '\A[0-9]{1,25}\z') {
        throw 'Discord-origin terminal delivery omitted its deterministic idempotency nonce'
    }
    $repeatedOriginCompleted = Invoke-TaskCase -AssistantMessage '已经完成修改，全部测试通过。'
    if ([string]$repeatedOriginCompleted.payload.nonce -cne [string]$originCompleted.payload.nonce) {
        throw 'Discord-origin terminal retry changed its deterministic idempotency nonce'
    }
    if ($completed.payload.PSObject.Properties['nonce'] -or $completed.payload.PSObject.Properties['enforce_nonce']) {
        throw 'Desktop fixed-channel notification unexpectedly received a Discord origin nonce'
    }
    Write-InboxOriginState -OriginOverrides @{ projectId = 'ygf'; projectName = 'ygf' }
    $originWithProject = Invoke-TaskCase -AssistantMessage '已经完成修改，全部测试通过。'
    $projectField = @($originWithProject.payload.embeds[0].fields | Where-Object { [string]$_.name -eq '项目名' })
    if ($projectField.Count -ne 1 -or [string]$projectField[0].value -ne 'ygf') {
        throw 'Discord-origin terminal notification ignored its persisted saved-project identity'
    }
    Write-InboxOriginState
    $originConfirmation = Invoke-TaskCase -AssistantMessage '我准备修改配置，可以吗？'
    if ([string]$originConfirmation.channelId -ne $originChannelId) {
        throw 'Native Discord-origin confirmation did not resolve its persisted exact origin channel'
    }

    $verifiedNotificationChannel = Invoke-TaskCase -AssistantMessage '已经完成修改。' -OriginChannelId $originChannelId
    if ([string]$verifiedNotificationChannel.channelId -ne $originChannelId) {
        throw 'Notification channel matching the exact inbox origin was not accepted'
    }

    $verifiedNotificationGuild = Invoke-TaskCase -AssistantMessage '已经完成修改。' -OriginGuildId '888888888888888888'
    if ([string]$verifiedNotificationGuild.channelId -ne $originChannelId) {
        throw 'Notification guild matching the exact inbox origin was not accepted'
    }
    $crossGuildNotification = Invoke-TaskCase -AssistantMessage '已经完成修改。' -OriginGuildId '999999999999999999'
    if ([string]$crossGuildNotification.channelId -ne $taskChannelId) {
        throw 'Cross-guild notification did not fail closed against the verified inbox origin'
    }
    foreach ($invalidGuild in @('123', '1234567890123456x', '１２３４５６７８９０１２３４５６７')) {
        $invalidGuildNotification = Invoke-TaskCase -AssistantMessage '已经完成修改。' -OriginGuildId $invalidGuild
        if ([string]$invalidGuildNotification.channelId -ne $taskChannelId) {
            throw "Invalid notification guild did not fail closed: $invalidGuild"
        }
    }

    Write-InboxOriginState -OriginOverrides @{
        rolloutFingerprint = ('a' * 64)
        terminalEventId = ('b' * 64)
        deliveryState = 'terminal-dispatching'
    }
    $preparedTerminalOrigin = Invoke-TaskCase -AssistantMessage '已经完成修改。'
    if ([string]$preparedTerminalOrigin.channelId -ne $originChannelId) {
        throw 'Verified watcher-prepared origin metadata prevented exact native routing'
    }
    Write-InboxOriginState

    $untrustedNotificationChannel = Invoke-TaskCase -AssistantMessage '已经完成修改。' -OriginChannelId '999999999999999999'
    if ([string]$untrustedNotificationChannel.channelId -ne $taskChannelId) {
        throw 'Notification channel mismatch did not fail closed against the verified inbox origin'
    }

    $inboxPath = Join-Path $toolDir 'discord-inbox-state.json'
    Remove-Item -LiteralPath $inboxPath -Force
    $missingState = Invoke-TaskCase -AssistantMessage '已经完成修改。'
    if ([string]$missingState.channelId -ne $taskChannelId) { throw 'Missing inbox state did not fail closed' }

    Write-Utf8NoBom -Path $inboxPath -Content '{broken json'
    $corruptState = Invoke-TaskCase -AssistantMessage '已经完成修改。'
    if ([string]$corruptState.channelId -ne $taskChannelId) { throw 'Corrupt inbox state did not fail closed' }

    Write-InboxOriginState -TurnId '33333333-3333-4333-8333-333333333333'
    $wrongTurn = Invoke-TaskCase -AssistantMessage '已经完成修改。'
    if ([string]$wrongTurn.channelId -ne $taskChannelId) { throw 'Non-exact turn origin did not fail closed' }

    Write-InboxOriginState -ThreadId 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    $wrongThread = Invoke-TaskCase -AssistantMessage '已经完成修改。'
    if ([string]$wrongThread.channelId -ne $taskChannelId) { throw 'Non-exact thread origin did not fail closed' }

    Write-InboxOriginState -OriginOverrides @{ unexpectedSecret = 'C:\secret\token.txt' }
    $extraOriginField = Invoke-TaskCase -AssistantMessage '已经完成修改。'
    if ([string]$extraOriginField.channelId -ne $taskChannelId) { throw 'Origin record with an unexpected field did not fail closed' }

    Write-InboxOriginState -OriginOverrides @{ terminalEventId = 'not-a-sha256' }
    $invalidTerminalId = Invoke-TaskCase -AssistantMessage '已经完成修改。'
    if ([string]$invalidTerminalId.channelId -ne $taskChannelId) { throw 'Origin record with invalid terminal metadata did not fail closed' }

    Write-InboxOriginState -StateOverrides @{ unexpected = $true }
    $extraStateField = Invoke-TaskCase -AssistantMessage '已经完成修改。'
    if ([string]$extraStateField.channelId -ne $taskChannelId) { throw 'Inbox state with an unexpected field did not fail closed' }

    Write-InboxOriginState

    foreach ($invalidOrigin in @('123', '1234567890123456x', '１２３４５６７８９０１２３４５６７', '123456789012345678901', ' C:\secret\token.txt ')) {
        $invalidCompleted = Invoke-TaskCase -AssistantMessage '已经完成修改。' -OriginChannelId $invalidOrigin
        if ([string]$invalidCompleted.channelId -ne $taskChannelId) {
            throw "Invalid origin channel did not fail closed for completed task: $invalidOrigin"
        }
        $invalidConfirmation = Invoke-TaskCase -AssistantMessage '现在执行，可以吗？' -OriginChannelId $invalidOrigin
        if ([string]$invalidConfirmation.channelId -ne $confirmationChannelId) {
            throw "Invalid origin channel did not fail closed for confirmation: $invalidOrigin"
        }
        $invalidJson = $invalidCompleted | ConvertTo-Json -Depth 12
        if ($invalidJson.Contains($invalidOrigin)) {
            throw 'Invalid origin channel leaked into the outbound payload'
        }
    }

    $quota = @(& $dispatcher -MobileOnly -DryRun -SystemTestEvent quota) -join "`n" | ConvertFrom-Json
    if ([string]$quota.channelId -ne $quotaChannelId) {
        throw 'Quota event did not remain on the fixed quota channel'
    }
    if (-not [string]$quota.payload.embeds[0].description.Contains('**系统测试通知：**')) {
        throw 'Fixed Discord bold label formatting was lost while escaping dynamic values'
    }
    if (@($quota.payload.allowed_mentions.parse).Count -ne 0) { throw 'Quota payload enabled automatic mentions' }

    $callLogPath = Join-Path $tempRoot 'discord-calls.jsonl'
    $oldCallLog = $env:CODEX_DISCORD_TEST_CALL_LOG
    $oldFailChannel = $env:CODEX_DISCORD_TEST_FAIL_CHANNEL
    try {
        $env:CODEX_DISCORD_TEST_CALL_LOG = $callLogPath
        $env:CODEX_DISCORD_TEST_FAIL_CHANNEL = ''
        Write-Utf8NoBom -Path (Join-Path $toolDir 'discord-secret.ps1') -Content @'
function Unprotect-DiscordBotToken { param([string]$Path) return 'test-token-must-not-leak' }
'@
        Write-Utf8NoBom -Path (Join-Path $toolDir 'discord-http.ps1') -Content @'
function New-DiscordBotHeaders { param([string]$Token) return @{ Authorization = "Bot $Token" } }
function Invoke-RestMethod {
    param([string]$Method, [string]$Uri, [object]$Headers, [string]$ContentType, [byte[]]$Body, [int]$TimeoutSec)
    $channelId = ([regex]::Match($Uri, '/channels/(\d{17,20})/messages')).Groups[1].Value
    $payloadText = [System.Text.Encoding]::UTF8.GetString($Body)
    [System.IO.File]::AppendAllText($env:CODEX_DISCORD_TEST_CALL_LOG, ((@{ channelId = $channelId; payload = $payloadText } | ConvertTo-Json -Compress) + "`n"), [System.Text.UTF8Encoding]::new($false))
    if ($channelId -eq $env:CODEX_DISCORD_TEST_FAIL_CHANNEL) { throw 'simulated sanitized route failure' }
    return [pscustomobject]@{ id = '999999999999999999' }
}
'@

        $discordOnlyTurnId = '22222222-2222-4222-8222-222222222219'
        $taskStarted = [ordered]@{
            timestamp = '2026-08-31T00:00:01.000Z'
            type = 'event_msg'
            payload = [ordered]@{ type = 'task_started'; turn_id = $discordOnlyTurnId }
        }
        Write-Utf8NoBom -Path (Join-Path $tempRoot "sessions\2026\08\31\rollout-$threadId.jsonl") -Content (
            (($session | ConvertTo-Json -Depth 12 -Compress) + "`n") +
            (($taskStarted | ConvertTo-Json -Depth 12 -Compress) + "`n")
        )
        Write-Utf8NoBom -Path (Join-Path $tempRoot 'session_index.jsonl') -Content ''
        Write-InboxOriginState -TurnId $discordOnlyTurnId
        Invoke-TaskCase -AssistantMessage '已经完成 Discord 创建的任务。' -TurnId $discordOnlyTurnId -SyntheticTest -LiveSend
        if (-not (Test-Path -LiteralPath $callLogPath)) {
            $dispatcherLog = Get-Content -Raw -LiteralPath (Join-Path $toolDir 'mobile-notify.log') -Encoding UTF8 -ErrorAction SilentlyContinue
            throw "Discord-created root absent from the sidebar was silently skipped: $dispatcherLog"
        }
        $discordOnlyCalls = @(Get-Content -LiteralPath $callLogPath -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json })
        if ($discordOnlyCalls.Count -ne 1 -or [string]$discordOnlyCalls[0].channelId -ne $originChannelId) {
            throw 'Discord-created root absent from the sidebar did not deliver exactly once to its origin channel'
        }
        Remove-Item -LiteralPath $callLogPath -Force

        $ambiguousTurnId = '22222222-2222-4222-8222-222222222218'
        $ambiguousStart = [ordered]@{
            timestamp = '2026-08-31T00:00:02.000Z'
            type = 'event_msg'
            payload = [ordered]@{ type = 'task_started'; turn_id = $ambiguousTurnId }
        }
        $ambiguousRollout = (($session | ConvertTo-Json -Depth 12 -Compress) + "`n") +
            (($ambiguousStart | ConvertTo-Json -Depth 12 -Compress) + "`n")
        Write-Utf8NoBom -Path (Join-Path $tempRoot "sessions\2026\08\31\rollout-$threadId.jsonl") -Content $ambiguousRollout
        $duplicateRolloutPath = Join-Path $tempRoot "sessions\2026\08\31\rollout-copy-$threadId.jsonl"
        Write-Utf8NoBom -Path $duplicateRolloutPath -Content $ambiguousRollout
        Write-InboxOriginState -TurnId $ambiguousTurnId
        Invoke-TaskCase -AssistantMessage '不应发送这个歧义任务。' -TurnId $ambiguousTurnId -SyntheticTest -LiveSend
        if (Test-Path -LiteralPath $callLogPath) {
            throw 'Ambiguous Discord root rollouts were not rejected before notification delivery'
        }
        Remove-Item -LiteralPath $duplicateRolloutPath -Force

        $childOnlyTurnId = '22222222-2222-4222-8222-222222222217'
        $childSession = [ordered]@{
            timestamp = '2026-08-31T00:00:00.000Z'
            type = 'session_meta'
            payload = [ordered]@{
                id = $threadId
                session_id = $threadId
                parent_thread_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
                thread_source = 'subagent'
                source = [ordered]@{ subagent = [ordered]@{ name = 'worker' } }
            }
        }
        $childStart = [ordered]@{
            timestamp = '2026-08-31T00:00:03.000Z'
            type = 'event_msg'
            payload = [ordered]@{ type = 'task_started'; turn_id = $childOnlyTurnId }
        }
        Write-Utf8NoBom -Path (Join-Path $tempRoot "sessions\2026\08\31\rollout-$threadId.jsonl") -Content (
            (($childSession | ConvertTo-Json -Depth 12 -Compress) + "`n") +
            (($childStart | ConvertTo-Json -Depth 12 -Compress) + "`n")
        )
        Write-InboxOriginState -TurnId $childOnlyTurnId
        Invoke-TaskCase -AssistantMessage '不应发送这个子任务。' -TurnId $childOnlyTurnId -SyntheticTest -LiveSend
        if (Test-Path -LiteralPath $callLogPath) {
            throw 'Discord origin state promoted a child rollout into a user-visible task notification'
        }
        $rejectedNotificationPath = Join-Path $tempRoot 'rejected-origin-notification.json'
        $rejectedNotification = [ordered]@{
            type = 'agent-turn-complete'
            'thread-id' = $threadId
            'turn-id' = $childOnlyTurnId
            cwd = 'C:\workspace\demo-project'
            'input-messages' = @('不应发送子任务')
            'last-assistant-message' = '子任务结果'
            'synthetic-test' = $true
        }
        Write-Utf8NoBom -Path $rejectedNotificationPath -Content ($rejectedNotification | ConvertTo-Json -Depth 8 -Compress)
        & pwsh -NoLogo -NoProfile -File $dispatcher -NotificationFile $rejectedNotificationPath -MobileOnly -FallbackInvocation 2>$null
        if ($LASTEXITCODE -eq 0) {
            throw 'Rejected watcher-origin terminal delivery reported success and could be marked delivered'
        }

        Write-Utf8NoBom -Path (Join-Path $tempRoot "sessions\2026\08\31\rollout-$threadId.jsonl") -Content (
            (($session | ConvertTo-Json -Depth 12 -Compress) + "`n") +
            (($taskStarted | ConvertTo-Json -Depth 12 -Compress) + "`n")
        )
        Write-Utf8NoBom -Path (Join-Path $tempRoot 'session_index.jsonl') -Content (([ordered]@{ id=$threadId; thread_name='Discord Bot 测试任务'; updated_at='2026-08-31T00:00:00Z' } | ConvertTo-Json -Compress) + "`n")

        $successTurnId = '22222222-2222-4222-8222-222222222220'
        Write-InboxOriginState -TurnId $successTurnId
        Invoke-TaskCase -AssistantMessage '已经完成修改，全部测试通过。' -TurnId $successTurnId -SyntheticTest -LiveSend
        if (-not (Test-Path -LiteralPath $callLogPath)) {
            $dispatcherLog = Get-Content -Raw -LiteralPath (Join-Path $toolDir 'mobile-notify.log') -Encoding UTF8 -ErrorAction SilentlyContinue
            throw "Successful origin delivery did not reach the HTTP seam: $dispatcherLog"
        }
        $successCalls = @(Get-Content -LiteralPath $callLogPath -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json })
        if ($successCalls.Count -ne 1 -or [string]$successCalls[0].channelId -ne $originChannelId) {
            throw 'Successful origin delivery unexpectedly fell back or used the wrong channel'
        }

        Write-InboxOriginState -TurnId $successTurnId -OriginOverrides @{
            deliveryState = 'terminal-dispatching'
            terminalEventId = ('c' * 64)
        }
        Invoke-TaskCase -AssistantMessage '已经完成修改，全部测试通过。' -TurnId $successTurnId -SyntheticTest -LiveSend
        $deduplicatedCalls = @(Get-Content -LiteralPath $callLogPath -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json })
        if ($deduplicatedCalls.Count -ne 1) {
            throw 'Native and watcher terminal dispatches were not deduplicated by exact turn ID'
        }

        Remove-Item -LiteralPath $callLogPath -Force
        $env:CODEX_DISCORD_TEST_FAIL_CHANNEL = $originChannelId
        $fallbackTurnId = '22222222-2222-4222-8222-222222222221'
        Write-InboxOriginState -TurnId $fallbackTurnId
        Invoke-TaskCase -AssistantMessage '已经完成修改，全部测试通过。' -TurnId $fallbackTurnId -SyntheticTest -LiveSend
        $fallbackCalls = @(Get-Content -LiteralPath $callLogPath -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json })
        if ($fallbackCalls.Count -ne 2) { throw 'Origin delivery failure did not make exactly one fallback attempt' }
        if ([string]$fallbackCalls[0].channelId -ne $originChannelId -or [string]$fallbackCalls[1].channelId -ne $taskChannelId) {
            throw 'Origin delivery fallback did not use the corresponding fixed task channel'
        }
        $fallbackPayload = [string]$fallbackCalls[1].payload
        if (-not $fallbackPayload.Contains('原任务频道发送失败')) { throw 'Fallback payload omitted the short routing warning' }
        if ($fallbackPayload.Contains('test-token-must-not-leak') -or $fallbackPayload.Contains('C:\secret')) {
            throw 'Fallback payload leaked a token or local path'
        }
        $fallbackObject = $fallbackPayload | ConvertFrom-Json
        if (@($fallbackObject.allowed_mentions.parse).Count -ne 0) { throw 'Fallback payload enabled automatic mentions' }
        if ([string]$fallbackObject.embeds[0].description -notmatch '\*\*[^*]+：\*\*') { throw 'Fallback payload lost Markdown formatting' }

        Remove-Item -LiteralPath $callLogPath -Force
        $confirmationTurnId = '22222222-2222-4222-8222-222222222222'
        Write-InboxOriginState -TurnId $confirmationTurnId
        Invoke-TaskCase -AssistantMessage '我准备修改配置，可以吗？' -TurnId $confirmationTurnId -SyntheticTest -LiveSend
        $confirmationFallbackCalls = @(Get-Content -LiteralPath $callLogPath -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json })
        if ($confirmationFallbackCalls.Count -ne 2) { throw 'Confirmation origin failure did not make exactly one fallback attempt' }
        if ([string]$confirmationFallbackCalls[0].channelId -ne $originChannelId -or [string]$confirmationFallbackCalls[1].channelId -ne $confirmationChannelId) {
            throw 'Confirmation origin failure did not fall back to the fixed confirmation channel'
        }
    }
    finally {
        $env:CODEX_DISCORD_TEST_CALL_LOG = $oldCallLog
        $env:CODEX_DISCORD_TEST_FAIL_CHANNEL = $oldFailChannel
    }

    Write-Output 'PASS: Discord Bot dispatcher routing and embeds'
}
finally {
    if ((Test-Path -LiteralPath $tempRoot) -and $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
