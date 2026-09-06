[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$toolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $toolDir 'config.json'
. (Join-Path $toolDir 'discord-config.ps1')
. (Join-Path $toolDir 'discord-secret.ps1')

$config = Get-Content -Raw -LiteralPath $configPath -Encoding UTF8 | ConvertFrom-Json
$tokenPath = [string]$config.discordTokenPath
if (-not [System.IO.Path]::IsPathRooted($tokenPath)) {
    $tokenPath = [System.IO.Path]::GetFullPath((Join-Path $toolDir $tokenPath))
}
$token = Unprotect-DiscordBotToken -Path $tokenPath
if (-not (Test-DiscordBotTokenShape -Token $token)) {
    throw 'Discord Bot Token 无法通过本地验证'
}
$token = $null

$updated = Enable-DiscordBotConfiguration -Config $config
$temporaryPath = Join-Path $toolDir ('.config.json.activate-discord-bot-{0}.tmp' -f $PID)
try {
    [System.IO.File]::WriteAllText($temporaryPath, ($updated | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $configPath -Force
}
finally {
    if (Test-Path -LiteralPath $temporaryPath) {
        Remove-Item -LiteralPath $temporaryPath -Force
    }
}

Write-Output 'Discord Bot 已设为唯一活动通知通道；旧 Webhook 仅保留为本地回退信息。'
