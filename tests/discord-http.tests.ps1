[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $sourceRoot 'discord-http.ps1')

$headers = New-DiscordBotHeaders -Token 'test-token'
if ([string]$headers.Authorization -ne 'Bot test-token') {
    throw 'Discord Bot Authorization header is invalid'
}
if ([string]$headers.'User-Agent' -notmatch '\ADiscordBot \(.+, \d+\.\d+\.\d+\)\z') {
    throw 'Discord Bot User-Agent does not follow Discord API requirements'
}

Write-Output 'PASS: Discord Bot HTTP headers'
