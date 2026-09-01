[CmdletBinding()]
param(
    [switch]$Once,
    [hashtable]$Operations
)

$ErrorActionPreference = 'Continue'
$repairScript = Join-Path $PSScriptRoot 'repair-notify.ps1'
$logPath = Join-Path $PSScriptRoot 'notify-guard.log'

if ($null -eq $Operations) {
    $Operations = @{
        Repair = { & $repairScript -Quiet }
        Log = { param($message) Add-Content -LiteralPath $logPath -Value $message -Encoding UTF8 }
        Sleep = { param($seconds) Start-Sleep -Seconds $seconds }
    }
}
foreach ($operationName in @('Repair', 'Log', 'Sleep')) {
    if (-not $Operations.ContainsKey($operationName) -or $Operations[$operationName] -isnot [scriptblock]) {
        throw "Notification guard operation is missing: $operationName"
    }
}

& $Operations.Log ('{0} Notification guard started.' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
while ($true) {
    try {
        & $Operations.Repair
    }
    catch {
        & $Operations.Log ('{0} Guard check failed: {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $_.Exception.Message)
    }
    if ($Once) { break }
    & $Operations.Sleep 2
}
