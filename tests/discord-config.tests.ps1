[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $sourceRoot 'discord-config.ps1')

$config = [pscustomobject][ordered]@{
    enabled = $true
    provider = 'discord'
    endpoint = 'https://discord.com/api/webhooks/111111/task-secret'
    confirmationEndpoint = 'https://discord.com/api/webhooks/222222/confirmation-secret'
    quotaEndpoint = 'https://discord.com/api/webhooks/333333/quota-secret'
    includeAssistantMessage = $true
}

$result = Set-DiscordBotConfiguration `
    -Config $config `
    -ApplicationId '100000000000000001' `
    -GuildId '100000000000000002' `
    -AllowedUserId '100000000000000003' `
    -TaskChannelId '100000000000000004' `
    -ConfirmationChannelId '100000000000000005' `
    -QuotaChannelId '100000000000000006' `
    -TokenPath 'C:\safe\discord-token.dpapi'

if ([string]$result.provider -ne 'discord') {
    throw 'Configuration was activated before live verification'
}
if ([string]$result.discordApplicationId -ne '100000000000000001') {
    throw 'Application ID was not saved'
}
if ([string]$result.discordAllowedUserId -ne '100000000000000003') {
    throw 'Allowed user ID was not saved'
}
if ([string]$result.discordTaskChannelId -ne '100000000000000004' -or
    [string]$result.discordConfirmationChannelId -ne '100000000000000005' -or
    [string]$result.discordQuotaChannelId -ne '100000000000000006') {
    throw 'Discord channel routing was not saved'
}
if ([string]$result.discordTokenPath -ne 'C:\safe\discord-token.dpapi') {
    throw 'Encrypted token path was not saved'
}
if ([string]$result.legacyDiscordWebhooks.task -ne [string]$config.endpoint -or
    [string]$result.legacyDiscordWebhooks.confirmation -ne [string]$config.confirmationEndpoint -or
    [string]$result.legacyDiscordWebhooks.quota -ne [string]$config.quotaEndpoint) {
    throw 'Legacy webhooks were not preserved for rollback'
}

$validToken = 'AAAAAAAAAAAAAAAAAAAAAAAA.BBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCCC'
if (-not (Test-DiscordBotTokenShape -Token $validToken)) {
    throw 'Valid Discord token shape was rejected'
}
if (Test-DiscordBotTokenShape -Token 'not-a-token') {
    throw 'Invalid Discord token shape was accepted'
}
if (-not (Test-DiscordSnowflake -Value '222222222222222222')) {
    throw 'Valid Discord Snowflake was rejected'
}
if (Test-DiscordSnowflake -Value 'xyxyxy_15591') {
    throw 'Invalid Discord Snowflake was accepted'
}
$uniqueGuildIds = @(Get-UniqueDiscordSnowflakes -Values @('222222222222222222', '222222222222222222', '222222222222222222'))
if ($uniqueGuildIds.Count -ne 1 -or $uniqueGuildIds[0] -ne '222222222222222222') {
    throw 'Unique Snowflake collection was not normalized to an array'
}

$activated = Enable-DiscordBotConfiguration -Config $result
if ([string]$activated.provider -ne 'discord-bot') {
    throw 'Discord Bot provider was not activated'
}
if (-not [string]::IsNullOrWhiteSpace([string]$activated.endpoint) -or
    -not [string]::IsNullOrWhiteSpace([string]$activated.confirmationEndpoint) -or
    -not [string]::IsNullOrWhiteSpace([string]$activated.quotaEndpoint)) {
    throw 'Active Discord webhook endpoints were not cleared'
}
if ([string]$activated.legacyDiscordWebhooks.task -ne 'https://discord.com/api/webhooks/111111/task-secret') {
    throw 'Discord webhook rollback data was lost during activation'
}

$rotated = Set-DiscordBotConfiguration `
    -Config $activated `
    -ApplicationId '100000000000000001' `
    -GuildId '100000000000000002' `
    -AllowedUserId '100000000000000003' `
    -TaskChannelId '100000000000000004' `
    -ConfirmationChannelId '100000000000000005' `
    -QuotaChannelId '100000000000000006' `
    -TokenPath 'C:\safe\discord-token-rotated.dpapi'
if ([string]$rotated.legacyDiscordWebhooks.task -ne 'https://discord.com/api/webhooks/111111/task-secret' -or
    [string]$rotated.legacyDiscordWebhooks.confirmation -ne 'https://discord.com/api/webhooks/222222/confirmation-secret' -or
    [string]$rotated.legacyDiscordWebhooks.quota -ne 'https://discord.com/api/webhooks/333333/quota-secret') {
    throw 'Rotating an already migrated Bot token overwrote legacy rollback webhooks'
}

Write-Output 'PASS: Discord Bot configuration migration'
