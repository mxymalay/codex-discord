[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$toolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $toolDir 'discord-bridge-startup.ps1')

$powerShellPath = (Get-Command pwsh -ErrorAction Stop).Source
$definition = Get-DiscordBridgeTaskDefinition -ToolDir $toolDir -PowerShellPath $powerShellPath
$action = New-ScheduledTaskAction `
    -Execute $definition.Execute `
    -Argument $definition.Arguments `
    -WorkingDirectory $definition.WorkingDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -Hidden `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

[void](Register-ScheduledTask `
    -TaskName $definition.TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Runs the private Discord command console, notification reply bridge, and completion fallback.' `
    -Force)

Start-ScheduledTask -TaskName $definition.TaskName
Start-Sleep -Milliseconds 500
$task = Get-ScheduledTask -TaskName $definition.TaskName
Write-Output ("Discord 桥接计划任务已安装：{0}（{1}）" -f $task.TaskName, $task.State)
