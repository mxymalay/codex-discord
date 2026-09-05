[CmdletBinding()]
param(
    [switch]$FromClipboard,
    [switch]$FromStdin,
    [switch]$UseEncryptedToken,
    [string]$AllowedUserId = '',
    [switch]$AllowedUserIdFromClipboard,
    [string]$ExpectedApplicationId = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$toolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $toolDir 'config.json'
$tokenPath = Join-Path $toolDir $(if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { 'discord-token.dpapi' } else { 'discord-token.keychain' })
. (Join-Path $toolDir 'discord-secret.ps1')
. (Join-Path $toolDir 'discord-config.ps1')
. (Join-Path $toolDir 'discord-http.ps1')

function Get-MaskedIdentifier {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return '未知'
    }
    if ($Value.Length -le 4) {
        return ('*' * $Value.Length)
    }
    return ('*' * ($Value.Length - 4)) + $Value.Substring($Value.Length - 4)
}

function Invoke-DiscordRead {
    param(
        [Parameter(Mandatory)] [string]$Uri,
        [hashtable]$Headers = @{}
    )

    try {
        return Invoke-RestMethod -Method Get -Uri $Uri -Headers $Headers -TimeoutSec 15
    }
    catch {
        throw 'Discord 验证请求失败；请确认令牌仍有效且网络可用'
    }
}

if (@(@($FromClipboard, $FromStdin, $UseEncryptedToken) | Where-Object { [bool]$_ }).Count -ne 1) {
    throw '令牌来源必须且只能选择 -FromClipboard、-FromStdin 或 -UseEncryptedToken'
}
if (-not (Test-Path -LiteralPath $configPath)) {
    throw '通知配置文件不存在'
}
$config = Get-Content -Raw -LiteralPath $configPath -Encoding UTF8 | ConvertFrom-Json
if ($UseEncryptedToken) {
    $configuredTokenPath = Get-DiscordConfigProperty -Config $config -Name 'discordTokenPath'
    if (-not [string]::IsNullOrWhiteSpace($configuredTokenPath)) { $tokenPath = $configuredTokenPath }
}
if (-not [System.IO.Path]::IsPathRooted($tokenPath)) {
    $tokenPath = [System.IO.Path]::GetFullPath((Join-Path $toolDir $tokenPath))
}

$token = if ($FromClipboard) {
    [string](Get-Clipboard -Raw)
}
elseif ($FromStdin) {
    [Console]::In.ReadToEnd()
}
else {
    Unprotect-DiscordBotToken -Path $tokenPath
}
if (-not (Test-DiscordBotTokenShape -Token $token)) {
    throw '读取到的内容不是有效的 Discord Bot Token'
}
$token = $token.Trim()

if ($AllowedUserIdFromClipboard) {
    if (-not [string]::IsNullOrWhiteSpace($AllowedUserId)) {
        throw '授权用户来源不能同时使用参数和剪贴板'
    }
    $AllowedUserId = ([string](Get-Clipboard -Raw)).Trim()
}
if (-not (Test-DiscordSnowflake -Value $AllowedUserId)) {
    throw '授权用户 ID 无效；请在 Discord 启用开发者模式后复制自己的用户 ID'
}
$AllowedUserId = $AllowedUserId.Trim()

$expectedApplicationId = if ([string]::IsNullOrWhiteSpace($ExpectedApplicationId)) { [string]$config.discordApplicationId } else { $ExpectedApplicationId }
$taskWebhook = Get-DiscordConfigProperty -Config $config -Name 'endpoint'
$confirmationWebhook = Get-DiscordConfigProperty -Config $config -Name 'confirmationEndpoint'
$quotaWebhook = Get-DiscordConfigProperty -Config $config -Name 'quotaEndpoint'

$authHeaders = New-DiscordBotHeaders -Token $token
$botIdentity = Invoke-DiscordRead -Uri 'https://discord.com/api/v10/users/@me' -Headers $authHeaders
$applicationId = [string]$botIdentity.id
if (-not [bool]$botIdentity.bot -or [string]::IsNullOrWhiteSpace($applicationId) -or
    (-not [string]::IsNullOrWhiteSpace($expectedApplicationId) -and $applicationId -ne $expectedApplicationId)) {
    throw '剪贴板中的令牌不属于本次创建的 Codex Bridge 应用'
}

$existingIds = @(
    [string]$config.discordGuildId,
    [string]$config.discordTaskChannelId,
    [string]$config.discordConfirmationChannelId,
    [string]$config.discordQuotaChannelId
)
$alreadyMigrated = @($existingIds | Where-Object { Test-DiscordSnowflake -Value $_ }).Count -eq 4 -and
    @(Get-UniqueDiscordSnowflakes -Values $existingIds[1..3]).Count -eq 3

if ($alreadyMigrated) {
    $guildIds = @($existingIds[0])
    $channelIds = @($existingIds[1], $existingIds[2], $existingIds[3])
}
else {
    if (@(@($taskWebhook, $confirmationWebhook, $quotaWebhook) | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0) {
        throw '旧 Discord 三路配置不完整，无法安全自动迁移'
    }
    $taskMetadata = Invoke-DiscordRead -Uri $taskWebhook
    $confirmationMetadata = Invoke-DiscordRead -Uri $confirmationWebhook
    $quotaMetadata = Invoke-DiscordRead -Uri $quotaWebhook

    $guildIds = @(Get-UniqueDiscordSnowflakes -Values @([string]$taskMetadata.guild_id, [string]$confirmationMetadata.guild_id, [string]$quotaMetadata.guild_id))
    if ($guildIds.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$guildIds[0])) {
        throw '三条旧通知不属于同一个 Discord 服务器，已停止迁移'
    }

    $channelIds = @([string]$taskMetadata.channel_id, [string]$confirmationMetadata.channel_id, [string]$quotaMetadata.channel_id)
    if (@(Get-UniqueDiscordSnowflakes -Values $channelIds).Count -ne 3 -or @($channelIds | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0) {
        throw '三条通知频道无法唯一确定，已停止迁移'
    }
}

Protect-DiscordBotToken -Token $token -Path $tokenPath
$updated = Set-DiscordBotConfiguration `
    -Config $config `
    -ApplicationId $applicationId `
    -GuildId ([string]$guildIds[0]) `
    -AllowedUserId $AllowedUserId `
    -TaskChannelId $channelIds[0] `
    -ConfirmationChannelId $channelIds[1] `
    -QuotaChannelId $channelIds[2] `
    -TokenPath $tokenPath

$json = $updated | ConvertTo-Json -Depth 20
$temporaryPath = Join-Path $toolDir ('.config.json.discord-bot-{0}.tmp' -f $PID)
try {
    [System.IO.File]::WriteAllText($temporaryPath, $json, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $configPath -Force
}
finally {
    if (Test-Path -LiteralPath $temporaryPath) {
        Remove-Item -LiteralPath $temporaryPath -Force
    }
}

$token = $null
[System.GC]::Collect()

if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    Write-Output 'Bot Token 已使用 Windows DPAPI 加密保存。'
} else {
    Write-Output 'Bot Token 已使用 AES-256-GCM 加密保存；加密密钥保存在 macOS Keychain。'
}
Write-Output ('应用：{0}；服务器：{1}；授权用户：{2}' -f (Get-MaskedIdentifier $applicationId), (Get-MaskedIdentifier ([string]$guildIds[0])), (Get-MaskedIdentifier $AllowedUserId))
Write-Output ('三个频道：{0} / {1} / {2}' -f (Get-MaskedIdentifier $channelIds[0]), (Get-MaskedIdentifier $channelIds[1]), (Get-MaskedIdentifier $channelIds[2]))
if ([string]$updated.provider -eq 'discord-bot') {
    Write-Output 'Discord Bot 通知与双向回复配置保持启用。'
}
else {
    Write-Output '当前仍使用旧通知通道，待 Bot 收发实测通过后再切换。'
}
