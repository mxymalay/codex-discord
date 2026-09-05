[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $sourceRoot 'discord-config.ps1')
$testTokenPath = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) 'codex-config-test/discord-token.dpapi'))

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
    -TokenPath $testTokenPath

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
if ([string]$result.discordTokenPath -ne $testTokenPath) {
    throw 'Encrypted token path was not saved'
}
foreach ($name in @('endpoint', 'confirmationEndpoint', 'quotaEndpoint', 'legacyDiscordWebhooks')) {
    if ($result.PSObject.Properties[$name]) {
        throw "Credential-bearing property persisted after Bot migration: $name"
    }
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
foreach ($name in @('endpoint', 'confirmationEndpoint', 'quotaEndpoint', 'legacyDiscordWebhooks')) {
    if ($activated.PSObject.Properties[$name]) {
        throw "Credential-bearing property persisted after activation: $name"
    }
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
foreach ($name in @('endpoint', 'confirmationEndpoint', 'quotaEndpoint', 'legacyDiscordWebhooks')) {
    if ($rotated.PSObject.Properties[$name]) {
        throw "Credential-bearing property persisted after token rotation: $name"
    }
}

$example = Get-Content -Raw -LiteralPath (Join-Path $sourceRoot 'config.example.json') -Encoding UTF8 | ConvertFrom-Json
$exampleMigrated = Set-DiscordBotConfiguration `
    -Config $example `
    -ApplicationId '111111111111111111' `
    -GuildId '222222222222222222' `
    -AllowedUserId '333333333333333333' `
    -TaskChannelId '444444444444444444' `
    -ConfirmationChannelId '555555555555555555' `
    -QuotaChannelId '666666666666666666' `
    -TokenPath 'C:\safe\discord-token.dpapi'
if ([string]$exampleMigrated.discordApplicationId -ne '111111111111111111') {
    throw 'Example configuration could not be migrated under StrictMode'
}

Write-Output 'PASS: Discord Bot configuration migration'
