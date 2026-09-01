[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $sourceRoot 'discord-bridge-startup.ps1')

$definition = Get-DiscordBridgeTaskDefinition `
    -ToolDir 'G:\tools\mobile-notify' `
    -PowerShellPath 'C:\Program Files\PowerShell\7\pwsh.exe'

if ([string]$definition.TaskName -ne 'Codex Discord Bridge') {
    throw 'Discord bridge scheduled task name is incorrect'
}
if ([string]$definition.Execute -ne 'C:\Program Files\PowerShell\7\pwsh.exe') {
    throw 'Discord bridge scheduled task executable is incorrect'
}
if ([string]$definition.Arguments -notmatch '(?i)-NoProfile\s+-File\s+"G:\\tools\\mobile-notify\\start-discord-bridge\.ps1"') {
    throw 'Discord bridge scheduled task does not launch only the dynamic startup guard'
}
if ([string]$definition.Arguments -match 'discord-bridge\.mjs|node\.exe|codex\.exe') {
    throw 'Discord bridge scheduled task pins a runtime executable or bypasses the startup guard'
}
if ([string]$definition.Arguments -match '(?i)discord-token|\bBot\s+[A-Za-z0-9_.-]+|webhooks/') {
    throw 'Discord bridge scheduled task arguments contain a secret'
}
if ([string]$definition.WorkingDirectory -ne 'G:\tools\mobile-notify') {
    throw 'Discord bridge scheduled task working directory is incorrect'
}

$quoted = ConvertTo-ScheduledTaskArgument -Value 'G:\Path With Spaces\start-discord-bridge.ps1'
if ($quoted -ne '"G:\Path With Spaces\start-discord-bridge.ps1"') {
    throw 'Scheduled task argument quoting is incorrect'
}

$startupSource = Get-Content -Raw -LiteralPath (Join-Path $sourceRoot 'start-discord-bridge.ps1')
if ($startupSource -notmatch 'Get-Command\s+node' -or $startupSource -notmatch 'Get-Command\s+codex') {
    throw 'Startup guard does not dynamically locate Node and Codex after CC Switch changes'
}
if ($startupSource -notmatch '(?s)while\s*\(\$true\).*Get-Command\s+node.*Get-Command\s+codex.*&\s*\$nodePath\s+\$bridgePath') {
    throw 'Startup guard does not resolve Node and Codex again before each bridge child process'
}
if ($startupSource -notmatch 'Get-Command\s+codex\s+-ErrorAction\s+SilentlyContinue') {
    throw 'Startup guard prevents a configured Codex path when codex is absent from PATH'
}
if ($startupSource -match '(?i)discord-token|\bBot\s+[A-Za-z0-9_.-]+|webhooks/') {
    throw 'Startup guard contains a Discord secret'
}

$watchSource = Get-Content -Raw -LiteralPath (Join-Path $sourceRoot 'watch-notify.ps1')
if ($watchSource -notmatch 'install-discord-bridge-task\.ps1' -or $watchSource -notmatch '\$null -eq \$bridgeTask') {
    throw 'Notification guard does not reinstall a missing Discord bridge task'
}

Write-Output 'PASS: Discord bridge startup task definition'
