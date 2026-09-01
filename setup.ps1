[CmdletBinding()]
param(
    [ValidateSet('ntfy', 'bark', 'pushplus', 'webhook', 'discord', 'disable')]
    [string]$Provider,

    [string]$Value,

    [string]$ConfirmationValue,

    [string]$QuotaValue,

    [switch]$IncludeMessage,

    [switch]$DisableQuotaNotifications,

    [switch]$SkipTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$toolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $toolDir 'config.json'
$dispatcherPath = Join-Path $toolDir 'dispatcher.ps1'

if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Configuration file not found: $configPath"
}

$config = Get-Content -Raw -LiteralPath $configPath -Encoding UTF8 | ConvertFrom-Json

function Test-IsDiscordWebhook {
    param([string]$Uri)

    return -not [string]::IsNullOrWhiteSpace($Uri) -and $Uri -match '^https://(?:(?:canary|ptb)\.)?discord(?:app)?\.com/api(?:/v\d+)?/webhooks/\d+/[A-Za-z0-9._-]+(?:\?.*)?$'
}

function Set-ConfigValue {
    param(
        [object]$Config,
        [string]$Name,
        $Value
    )

    if ($Config.PSObject.Properties[$Name]) {
        $Config.$Name = $Value
    }
    else {
        $Config | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    }
}

if ([string]::IsNullOrWhiteSpace($Provider)) {
    Write-Host 'Codex 手机通知配置工具'
    Write-Host ''
    Write-Host '用法：'
    Write-Host '  ntfy（安卓/iPhone）： .\setup.ps1 ntfy [主题名或完整订阅地址]'
    Write-Host '  Bark（iPhone）：      .\setup.ps1 bark <Bark Key 或完整地址>'
    Write-Host '  PushPlus（微信）：    .\setup.ps1 pushplus <Token>'
    Write-Host '  Discord 旧Webhook（仅发送）： .\setup.ps1 discord -Value <完成Webhook> -ConfirmationValue <待确认Webhook> -QuotaValue <额度Webhook>'
    Write-Host '  Discord Bot（可双向回复）：  参见 README.md 的“Bot 配置与启动”'
    Write-Host '  通用 Webhook：        .\setup.ps1 webhook <HTTPS 地址>'
    Write-Host '  关闭手机通知：        .\setup.ps1 disable'
    Write-Host ''
    Write-Host '附加 -IncludeMessage 会发送项目名、任务名、本轮任务和最终结果。'
    Write-Host '默认启用额度变化提醒；附加 -DisableQuotaNotifications 可关闭。'
    $quotaEnabled = [bool]($config.PSObject.Properties['quotaNotifications'] -and $config.quotaNotifications)
    Write-Host ("当前状态：enabled={0}, provider={1}, quotaNotifications={2}" -f $config.enabled, $config.provider, $quotaEnabled)
    exit 0
}

if ($Provider -eq 'disable') {
    $config.enabled = $false
    $json = $config | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host '手机通知已关闭；原有 Codex 通知组件仍会照常运行。'
    exit 0
}

$subscription = $null
switch ($Provider) {
    'ntfy' {
        if ([string]::IsNullOrWhiteSpace($Value)) {
            if ($config.PSObject.Properties['ntfyEndpoint'] -and -not [string]::IsNullOrWhiteSpace([string]$config.ntfyEndpoint)) {
                $Value = [string]$config.ntfyEndpoint
            }
            else {
                $Value = 'codex-' + [Guid]::NewGuid().ToString('N')
            }
        }
        if ($Value -match '^https?://') {
            $config.endpoint = $Value.TrimEnd('/')
        }
        else {
            $config.endpoint = 'https://ntfy.sh/' + $Value.Trim('/')
        }
        if ($config.PSObject.Properties['ntfyQuotaEndpoint'] -and -not [string]::IsNullOrWhiteSpace([string]$config.ntfyQuotaEndpoint)) {
            $config.quotaEndpoint = [string]$config.ntfyQuotaEndpoint
        }
        elseif (-not $config.PSObject.Properties['quotaEndpoint'] -or [string]::IsNullOrWhiteSpace([string]$config.quotaEndpoint)) {
            $quotaTopic = 'codex-quota-' + [Guid]::NewGuid().ToString('N')
            $config | Add-Member -NotePropertyName 'quotaEndpoint' -NotePropertyValue ('https://ntfy.sh/' + $quotaTopic) -Force
        }
        if ($config.PSObject.Properties['ntfyConfirmationEndpoint'] -and -not [string]::IsNullOrWhiteSpace([string]$config.ntfyConfirmationEndpoint)) {
            $config.confirmationEndpoint = [string]$config.ntfyConfirmationEndpoint
        }
        elseif (-not $config.PSObject.Properties['confirmationEndpoint'] -or [string]::IsNullOrWhiteSpace([string]$config.confirmationEndpoint)) {
            $confirmationTopic = 'codex-confirm-' + [Guid]::NewGuid().ToString('N')
            $config | Add-Member -NotePropertyName 'confirmationEndpoint' -NotePropertyValue ('https://ntfy.sh/' + $confirmationTopic) -Force
        }
        $config.token = ''
        $subscription = $config.endpoint
    }
    'bark' {
        if ([string]::IsNullOrWhiteSpace($Value)) {
            throw 'Bark 需要设备 Key 或完整推送地址。'
        }
        if ($Value -match '^https?://') {
            $config.endpoint = $Value.TrimEnd('/')
        }
        else {
            $config.endpoint = 'https://api.day.app/' + $Value.Trim('/')
        }
        $config.token = ''
    }
    'pushplus' {
        if ([string]::IsNullOrWhiteSpace($Value)) {
            throw 'PushPlus 需要 Token。'
        }
        $config.endpoint = 'https://www.pushplus.plus/send'
        $config.token = $Value
    }
    'webhook' {
        if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^https?://') {
            throw 'Webhook 需要完整的 HTTP/HTTPS 地址。'
        }
        $config.endpoint = $Value
        $config.token = ''
    }
    'discord' {
        if (-not (Test-IsDiscordWebhook -Uri $Value) -or -not (Test-IsDiscordWebhook -Uri $ConfirmationValue) -or -not (Test-IsDiscordWebhook -Uri $QuotaValue)) {
            throw 'Discord 需要三条完整的官方 Webhook 地址：任务完成、任务待确认、额度变化。'
        }

        if ([string]$config.provider -eq 'ntfy') {
            Set-ConfigValue -Config $config -Name 'ntfyEndpoint' -Value ([string]$config.endpoint)
            Set-ConfigValue -Config $config -Name 'ntfyConfirmationEndpoint' -Value ([string]$config.confirmationEndpoint)
            Set-ConfigValue -Config $config -Name 'ntfyQuotaEndpoint' -Value ([string]$config.quotaEndpoint)
        }

        $config.endpoint = $Value
        $config.confirmationEndpoint = $ConfirmationValue
        $config.quotaEndpoint = $QuotaValue
        $config.token = ''
    }
}

$config.enabled = $true
$config.provider = $Provider
$config.includeAssistantMessage = [bool]$IncludeMessage
if ($config.PSObject.Properties['quotaNotifications']) {
    $config.quotaNotifications = -not [bool]$DisableQuotaNotifications
}
else {
    $config | Add-Member -NotePropertyName 'quotaNotifications' -NotePropertyValue (-not [bool]$DisableQuotaNotifications)
}
$json = $config | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ("已启用 {0} 手机通知。" -f $Provider)
if ($null -ne $subscription) {
    Write-Host ("任务通知主题：{0}" -f $subscription)
    if ($config.PSObject.Properties['confirmationEndpoint'] -and -not [string]::IsNullOrWhiteSpace([string]$config.confirmationEndpoint)) {
        Write-Host ("任务确认主题：{0}" -f $config.confirmationEndpoint)
    }
    if ($config.PSObject.Properties['quotaEndpoint'] -and -not [string]::IsNullOrWhiteSpace([string]$config.quotaEndpoint)) {
        Write-Host ("额度提醒主题：{0}" -f $config.quotaEndpoint)
    }
}
elseif ($Provider -eq 'discord') {
    Write-Host '已配置三条旧式 Discord Webhook（仅发送）：任务完成、任务待确认、额度变化。'
}

if (-not $SkipTest) {
    $testPayload = @{
        type = 'agent-turn-complete'
        'thread-id' = 'mobile-notify-test'
        'turn-id' = 'mobile-notify-test'
        cwd = (Get-Location).Path
        'input-messages' = @('测试手机通知格式')
        'last-assistant-message' = 'Codex 手机通知测试成功。'
    } | ConvertTo-Json -Compress
    & $dispatcherPath -NotificationJson $testPayload -MobileOnly
    & $dispatcherPath -NotificationJson $testPayload -MobileOnly -SkipTaskNotification -SendQuotaStatus
    Write-Host ("已发送测试通知；日志位于 {0}" -f (Join-Path $toolDir 'mobile-notify.log'))
}
