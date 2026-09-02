[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $sourceRoot 'discord-bridge-startup.ps1')

Initialize-BridgeJobNative
if ([IntPtr]::Size -eq 8 -and (([Runtime.InteropServices.Marshal]::SizeOf([type]'CodexBridgeJobNative+Basic') -ne 64) -or ([Runtime.InteropServices.Marshal]::SizeOf([type]'CodexBridgeJobNative+Io') -ne 48) -or ([Runtime.InteropServices.Marshal]::SizeOf([type]'CodexBridgeJobNative+Extended') -ne 144) -or ([Runtime.InteropServices.Marshal]::SizeOf([type]'CodexBridgeJobNative+Accounting') -ne 48))) { throw 'Job Object ABI layout is invalid on x64' }
$emptyJob = [CodexBridgeJobNative]::CreateJobObject([IntPtr]::Zero, ('Local\CodexBridgeAbiTest-' + [guid]::NewGuid().ToString('N')))
try {
    if ($emptyJob -eq [IntPtr]::Zero) { throw 'could not create safe empty Job Object' }
    $extended = New-BridgeExtendedLimitInformation
    if ($extended.basic.LimitFlags -ne 0x2000) { throw 'production bridge Job helper did not set kill-on-close' }
    if (-not [CodexBridgeJobNative]::SetInformationJobObject($emptyJob, 9, [ref]$extended, [Runtime.InteropServices.Marshal]::SizeOf($extended))) { throw 'empty Job Object rejected extended limit ABI' }
    $accounting = New-Object CodexBridgeJobNative+Accounting
    if (-not [CodexBridgeJobNative]::QueryInformationJobObject($emptyJob, 1, [ref]$accounting, [Runtime.InteropServices.Marshal]::SizeOf($accounting), [IntPtr]::Zero) -or $accounting.ActiveProcesses -ne 0) { throw 'empty Job Object accounting ABI is invalid' }
}
finally { if ($emptyJob -ne [IntPtr]::Zero) { [CodexBridgeJobNative]::CloseHandle($emptyJob) | Out-Null } }

$definition = Get-DiscordBridgeTaskDefinition `
    -ToolDir 'G:\tools\mobile-notify'

if ([string]$definition.TaskName -ne 'Codex Discord Bridge') {
    throw 'Discord bridge scheduled task name is incorrect'
}
if ([string]$definition.Execute -ne 'G:\tools\mobile-notify\CodexDiscordControl.exe') {
    throw 'Discord bridge scheduled task does not use the windowless controller supervisor'
}
if ([string]$definition.Arguments -cne '--bridge-supervisor scheduled') {
    throw 'Discord bridge scheduled task does not launch the scheduled windowless supervisor'
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

$watchScript = Join-Path $sourceRoot 'watch-notify.ps1'
$guardState = [ordered]@{ repairs=0; installs=0; enables=0; disables=0; starts=0; stops=0; sleeps=0 }
$guardOperations = @{
    Repair = { $guardState.repairs++ }
    InstallTask = { $guardState.installs++ }
    EnableTask = { $guardState.enables++ }
    DisableTask = { $guardState.disables++ }
    StartTask = { $guardState.starts++ }
    StopTask = { $guardState.stops++ }
    Sleep = { param($seconds) $guardState.sleeps++ }
    Log = { param($message) }
}
& $watchScript -Once -Operations $guardOperations
if ($guardState.repairs -ne 1 -or $guardState.sleeps -ne 0) {
    throw 'notification guard did not perform exactly one injected repair iteration'
}
if (($guardState.installs + $guardState.enables + $guardState.disables + $guardState.starts + $guardState.stops) -ne 0) {
    throw 'notification guard changed Discord bridge service state'
}

Write-Output 'PASS: Discord bridge startup task definition'
