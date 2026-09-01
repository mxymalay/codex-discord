[CmdletBinding()]
param(
    [string]$ThreadId = '',
    [string]$Cwd = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ThreadId) -or [string]::IsNullOrWhiteSpace($Cwd)) {
    throw 'ThreadId and Cwd are required for live Discord Bot tests'
}

$toolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $toolDir 'config.json'
$dispatcherPath = Join-Path $toolDir 'dispatcher.ps1'
$mappingPath = Join-Path $toolDir 'discord-message-map.json'
. (Join-Path $toolDir 'discord-secret.ps1')
. (Join-Path $toolDir 'discord-http.ps1')

function Write-ConfigAtomically {
    param([object]$Config)
    $temporaryPath = Join-Path $toolDir ('.config.json.live-test-{0}.tmp' -f $PID)
    try {
        [System.IO.File]::WriteAllText($temporaryPath, ($Config | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporaryPath -Destination $configPath -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
    }
}

function New-TestNotification {
    param([string]$AssistantMessage, [string]$UserMessage)
    return [ordered]@{
        type = 'agent-turn-complete'
        'thread-id' = $ThreadId
        'turn-id' = [guid]::NewGuid().ToString()
        cwd = $Cwd
        'input-messages' = @($UserMessage)
        'last-assistant-message' = $AssistantMessage
    }
}

function Get-LatestBotMessage {
    param([string]$ChannelId, [string]$Token)
    $messages = Invoke-RestMethod `
        -Method Get `
        -Uri ("https://discord.com/api/v10/channels/{0}/messages?limit=1" -f $ChannelId) `
        -Headers (New-DiscordBotHeaders -Token $Token) `
        -TimeoutSec 15
    return @($messages)[0]
}

$originalRaw = [System.IO.File]::ReadAllText($configPath)
$config = $originalRaw | ConvertFrom-Json
$token = Unprotect-DiscordBotToken -Path ([string]$config.discordTokenPath)

try {
    $config.quotaNotifications = $false
    Write-ConfigAtomically -Config $config

    $complete = New-TestNotification -UserMessage '验证 Discord Bot 任务完成通知' -AssistantMessage '已完成 Discord Bot 任务完成通知实机验证。'
    & $dispatcherPath ($complete | ConvertTo-Json -Depth 8 -Compress) -MobileOnly
    $completeMessage = Get-LatestBotMessage -ChannelId ([string]$config.discordTaskChannelId) -Token $token
    if ([string]$completeMessage.author.id -ne [string]$config.discordApplicationId -or [int]$completeMessage.embeds[0].color -ne 3066993) {
        throw '任务完成频道的 Bot 实机消息验证失败'
    }

    $confirmation = New-TestNotification -UserMessage '验证 Discord Bot 待确认通知' -AssistantMessage '这里是任务待确认测试。现在继续执行，可以吗？'
    & $dispatcherPath ($confirmation | ConvertTo-Json -Depth 8 -Compress) -MobileOnly
    $confirmationMessage = Get-LatestBotMessage -ChannelId ([string]$config.discordConfirmationChannelId) -Token $token
    if ([string]$confirmationMessage.author.id -ne [string]$config.discordApplicationId -or [int]$confirmationMessage.embeds[0].color -ne 15965202) {
        throw '任务待确认频道的 Bot 实机消息验证失败'
    }

    $mapping = Get-Content -Raw -LiteralPath $mappingPath -Encoding UTF8 | ConvertFrom-Json
    if (-not $mapping.messages.PSObject.Properties[[string]$completeMessage.id] -or
        -not $mapping.messages.PSObject.Properties[[string]$confirmationMessage.id]) {
        throw '实机通知没有保存到 Discord 消息任务映射'
    }
}
finally {
    $token = $null
    [System.IO.File]::WriteAllText($configPath, $originalRaw, [System.Text.UTF8Encoding]::new($false))
}

$quotaNotification = [ordered]@{
    type = 'agent-turn-complete'
    'thread-id' = $ThreadId
    'turn-id' = [guid]::NewGuid().ToString()
    cwd = $Cwd
    'input-messages' = @('发送 Discord Bot 额度状态测试')
    'last-assistant-message' = '已发送额度状态测试。'
}
& $dispatcherPath ($quotaNotification | ConvertTo-Json -Depth 8 -Compress) -MobileOnly -SkipTaskNotification -SendQuotaStatus

$restored = Get-Content -Raw -LiteralPath $configPath -Encoding UTF8 | ConvertFrom-Json
$token = Unprotect-DiscordBotToken -Path ([string]$restored.discordTokenPath)
try {
    $quotaMessage = Get-LatestBotMessage -ChannelId ([string]$restored.discordQuotaChannelId) -Token $token
    if ([string]$quotaMessage.author.id -ne [string]$restored.discordApplicationId -or [int]$quotaMessage.embeds[0].color -ne 3447003) {
        throw '额度变化频道的 Bot 实机消息验证失败'
    }
}
finally {
    $token = $null
}

Write-Output 'PASS: 三类 Discord Bot 实机通知、颜色与任务映射'
