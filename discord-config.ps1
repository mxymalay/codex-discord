Set-StrictMode -Version Latest

function Test-DiscordBotTokenShape {
    [CmdletBinding()]
    param([AllowNull()][string]$Token)

    if ([string]::IsNullOrWhiteSpace($Token)) {
        return $false
    }

    return $Token.Trim() -match '\A[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}\z'
}

function Test-DiscordSnowflake {
    [CmdletBinding()]
    param([AllowNull()][string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $false
    }
    return $Value.Trim() -match '\A\d{17,20}\z'
}

function Get-UniqueDiscordSnowflakes {
    [CmdletBinding()]
    param([AllowEmptyCollection()][string[]]$Values = @())

    return @($Values | ForEach-Object { [string]$_ } | Select-Object -Unique)
}

function Set-DiscordConfigProperty {
    param(
        [Parameter(Mandatory)]
        [object]$Config,

        [Parameter(Mandatory)]
        [string]$Name,

        [AllowNull()]
        [object]$Value
    )

    if ($Config.PSObject.Properties[$Name]) {
        $Config.$Name = $Value
    }
    else {
        $Config | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    }
}

function Get-DiscordConfigProperty {
    param([Parameter(Mandatory)][object]$Config, [Parameter(Mandatory)][string]$Name)
    $property = $Config.PSObject.Properties[$Name]
    if ($null -eq $property) { return '' }
    return [string]$property.Value
}

function Remove-DiscordConfigProperty {
    param([Parameter(Mandatory)][object]$Config, [Parameter(Mandatory)][string]$Name)
    if ($Config.PSObject.Properties[$Name]) { [void]$Config.PSObject.Properties.Remove($Name) }
}

function Set-DiscordBotConfiguration {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [object]$Config,
        [Parameter(Mandatory)] [string]$ApplicationId,
        [Parameter(Mandatory)] [string]$GuildId,
        [Parameter(Mandatory)] [string]$AllowedUserId,
        [Parameter(Mandatory)] [string]$TaskChannelId,
        [Parameter(Mandatory)] [string]$ConfirmationChannelId,
        [Parameter(Mandatory)] [string]$QuotaChannelId,
        [Parameter(Mandatory)] [string]$TokenPath
    )

    $copy = ($Config | ConvertTo-Json -Depth 20) | ConvertFrom-Json
    Set-DiscordConfigProperty -Config $copy -Name 'discordApplicationId' -Value $ApplicationId
    Set-DiscordConfigProperty -Config $copy -Name 'discordGuildId' -Value $GuildId
    Set-DiscordConfigProperty -Config $copy -Name 'discordAllowedUserId' -Value $AllowedUserId
    Set-DiscordConfigProperty -Config $copy -Name 'discordTaskChannelId' -Value $TaskChannelId
    Set-DiscordConfigProperty -Config $copy -Name 'discordConfirmationChannelId' -Value $ConfirmationChannelId
    Set-DiscordConfigProperty -Config $copy -Name 'discordQuotaChannelId' -Value $QuotaChannelId
    Set-DiscordConfigProperty -Config $copy -Name 'discordTokenPath' -Value ([System.IO.Path]::GetFullPath($TokenPath))
    foreach ($name in @('endpoint', 'confirmationEndpoint', 'quotaEndpoint', 'legacyDiscordWebhooks')) {
        Remove-DiscordConfigProperty -Config $copy -Name $name
    }
    return $copy
}

function Enable-DiscordBotConfiguration {
    [CmdletBinding()]
    param([Parameter(Mandatory)][object]$Config)

    foreach ($name in @('discordApplicationId', 'discordGuildId', 'discordAllowedUserId', 'discordTaskChannelId', 'discordConfirmationChannelId', 'discordQuotaChannelId', 'discordTokenPath')) {
        if (-not $Config.PSObject.Properties[$name] -or [string]::IsNullOrWhiteSpace([string]$Config.$name)) {
            throw "Discord Bot 配置缺少 $name"
        }
    }
    $copy = ($Config | ConvertTo-Json -Depth 20) | ConvertFrom-Json
    Set-DiscordConfigProperty -Config $copy -Name 'provider' -Value 'discord-bot'
    Set-DiscordConfigProperty -Config $copy -Name 'discordCodexPath' -Value 'codex'
    foreach ($name in @('endpoint', 'confirmationEndpoint', 'quotaEndpoint', 'legacyDiscordWebhooks')) {
        Remove-DiscordConfigProperty -Config $copy -Name $name
    }
    return $copy
}
