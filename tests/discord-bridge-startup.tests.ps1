[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $sourceRoot 'discord-bridge-startup.ps1')

$definition = Get-DiscordBridgeTaskDefinition `
    -ToolDir 'G:\tools\mobile-notify' `
    -NodePath 'C:\nvm4w\nodejs\node.exe'

if ([string]$definition.TaskName -ne 'Codex Discord Bridge') {
    throw 'Discord bridge scheduled task name is incorrect'
}
if ([string]$definition.Execute -ne 'C:\nvm4w\nodejs\node.exe') {
    throw 'Discord bridge scheduled task executable is incorrect'
}
if ([string]$definition.Arguments -notmatch 'discord-bridge\.mjs') {
    throw 'Discord bridge scheduled task does not launch the bridge entry point directly'
}
if ([string]$definition.Arguments -match '(?i)discord-token|\bBot\s+[A-Za-z0-9_.-]+|webhooks/') {
    throw 'Discord bridge scheduled task arguments contain a secret'
}
if ([string]$definition.WorkingDirectory -ne 'G:\tools\mobile-notify') {
    throw 'Discord bridge scheduled task working directory is incorrect'
}

$quoted = ConvertTo-ScheduledTaskArgument -Value 'G:\Path With Spaces\discord-bridge.mjs'
if ($quoted -ne '"G:\Path With Spaces\discord-bridge.mjs"') {
    throw 'Scheduled task argument quoting is incorrect'
}

$watchSource = Get-Content -Raw -LiteralPath (Join-Path $sourceRoot 'watch-notify.ps1')
if ($watchSource -notmatch 'install-discord-bridge-task\.ps1' -or $watchSource -notmatch '\$null -eq \$bridgeTask') {
    throw 'Notification guard does not reinstall a missing Discord bridge task'
}

Write-Output 'PASS: Discord bridge startup task definition'
