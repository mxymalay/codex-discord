[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$repairScript = Join-Path $PSScriptRoot 'repair-notify.ps1'
$logPath = Join-Path $PSScriptRoot 'notify-guard.log'
$bridgeTaskName = 'Codex Discord Bridge'
$bridgeInstallScript = Join-Path $PSScriptRoot 'install-discord-bridge-task.ps1'

Add-Content -LiteralPath $logPath -Value ('{0} Notification guard started.' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding UTF8

while ($true) {
    try {
        & $repairScript -Quiet
        $bridgeTask = Get-ScheduledTask -TaskName $bridgeTaskName -ErrorAction SilentlyContinue
        if ($null -eq $bridgeTask -and (Test-Path -LiteralPath $bridgeInstallScript)) {
            & $bridgeInstallScript | Out-Null
            Add-Content -LiteralPath $logPath -Value ('{0} Reinstalled missing Discord bridge task.' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding UTF8
        }
        elseif ($null -ne $bridgeTask -and $bridgeTask.State -ne 'Running') {
            Start-ScheduledTask -TaskName $bridgeTaskName
            Add-Content -LiteralPath $logPath -Value ('{0} Restarted Discord bridge task.' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding UTF8
        }
    }
    catch {
        Add-Content -LiteralPath $logPath -Value ('{0} Guard check failed: {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $_.Exception.Message) -Encoding UTF8
    }
    Start-Sleep -Seconds 2
}
