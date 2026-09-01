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
    param([string]$AssistantMessage)

    $notification = [ordered]@{
        type = 'agent-turn-complete'
        'thread-id' = $script:threadId
        'turn-id' = [guid]::NewGuid().ToString()
        cwd = 'C:\workspace\demo-project'
        'input-messages' = @('处理 Discord Bot 通知')
        'last-assistant-message' = $AssistantMessage
    }
    $raw = $notification | ConvertTo-Json -Depth 8 -Compress
    $output = @(& $script:dispatcher $raw -MobileOnly -DryRun)
    return ((($output | ForEach-Object { [string]$_ }) -join "`n").Trim() | ConvertFrom-Json)
}

try {
    $toolDir = Join-Path $tempRoot 'mobile-notify'
    [void](New-Item -ItemType Directory -Path $toolDir -Force)
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'dispatcher.ps1') -Destination (Join-Path $toolDir 'dispatcher.ps1')
    foreach ($moduleName in @('discord-secret.ps1', 'discord-state.ps1')) {
        $modulePath = Join-Path $sourceRoot $moduleName
        if (Test-Path -LiteralPath $modulePath) {
            Copy-Item -LiteralPath $modulePath -Destination (Join-Path $toolDir $moduleName)
        }
    }
    $dispatcher = Join-Path $toolDir 'dispatcher.ps1'

    $taskChannelId = '444444444444444444'
    $confirmationChannelId = '555555555555555555'
    $quotaChannelId = '666666666666666666'
    $threadId = '11111111-1111-4111-8111-111111111111'
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

    Write-Output 'PASS: Discord Bot dispatcher routing and embeds'
}
finally {
    if ((Test-Path -LiteralPath $tempRoot) -and $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
