[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet(
        'bridge-status','bridge-stop','bridge-start','bridge-enable',
        'guard-status','guard-stop','guard-start','guard-enable','guard-disable'
    )]
    [string]$Action,

    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$ToolDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'codex-control-lib.ps1')

try {
    $operations = New-CodexControlOperations
    # This probe can run from a disposable deployment stage. It may control an existing bridge
    # task, but must never create one whose action points into that stage.
    $operations['InstallTask'] = { throw 'staged-task-install-disabled' }
    switch ($Action) {
        'bridge-status' {
            $service = Get-CodexBridgeServiceStatus -Operations $operations -ToolDir $ToolDir
            if ($service.ok -ne $true) { throw 'service-status-failed' }
            $mode = if ($null -ne $service.runtime -and $null -ne $service.runtime.mode) { [string]$service.runtime.mode } else { 'unknown' }
            $result = [pscustomobject][ordered]@{
                ok = $true
                service = [pscustomobject][ordered]@{
                    taskInstalled = [bool]$service.taskInstalled
                    autoStartEnabled = [bool]$service.autoStartEnabled
                    taskRunning = [bool]$service.taskRunning
                    running = [bool]$service.running
                    mode = $mode
                }
            }
        }
        'bridge-stop' { $result = Invoke-CodexBridgeServiceAction -Action 'stop-temporary' -ToolDir $ToolDir -Operations $operations }
        'bridge-start' { $result = Invoke-CodexBridgeServiceAction -Action 'start-temporary' -ToolDir $ToolDir -Operations $operations }
        'bridge-enable' {
            $beforeEnable = Get-CodexBridgeServiceStatus -Operations $operations -ToolDir $ToolDir
            if ($beforeEnable.ok -ne $true -or $beforeEnable.taskInstalled -ne $true) { throw 'staged-task-recovery-unavailable' }
            $result = Invoke-CodexBridgeServiceAction -Action 'enable-long-term' -ToolDir $ToolDir -Operations $operations
        }
        'guard-status' {
            $guard = Get-CodexNotificationGuardStatus -Operations $operations -ToolDir $ToolDir
            if ($guard.ok -ne $true) { throw 'guard-status-failed' }
            $result = [pscustomobject][ordered]@{ ok=$true; guard=$guard }
        }
        'guard-stop' { $result = Invoke-CodexNotificationGuardAction -Action stop -ToolDir $ToolDir -Operations $operations }
        'guard-start' { $result = Invoke-CodexNotificationGuardAction -Action start -ToolDir $ToolDir -Operations $operations }
        'guard-enable' { $result = Invoke-CodexNotificationGuardAction -Action enable -ToolDir $ToolDir -Operations $operations }
        'guard-disable' { $result = Invoke-CodexNotificationGuardAction -Action disable -ToolDir $ToolDir -Operations $operations }
    }
    $result | ConvertTo-Json -Depth 8 -Compress
    exit $(if ($result.ok -eq $true) { 0 } else { 1 })
}
catch {
    [pscustomobject]@{ ok=$false; errorCategory='deploy-live-probe-failed' } | ConvertTo-Json -Compress
    exit 1
}
