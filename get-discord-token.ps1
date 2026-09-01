[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$toolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $toolDir 'config.json'
. (Join-Path $toolDir 'discord-secret.ps1')

if (-not (Test-Path -LiteralPath $configPath)) {
    throw 'Discord 配置不存在'
}
$config = Get-Content -Raw -LiteralPath $configPath -Encoding UTF8 | ConvertFrom-Json
$tokenPath = [string]$config.discordTokenPath
if ([string]::IsNullOrWhiteSpace($tokenPath)) {
    throw 'Discord Bot Token 路径未配置'
}

Write-Output (Unprotect-DiscordBotToken -Path $tokenPath)
