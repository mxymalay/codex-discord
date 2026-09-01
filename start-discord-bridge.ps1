[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$toolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgePath = Join-Path $toolDir 'discord-bridge.mjs'
$logPath = Join-Path $toolDir 'discord-bridge-guard.log'
$nodeCommand = Get-Command node -ErrorAction Stop
$nodePath = $nodeCommand.Source

function Write-BridgeGuardLog {
    param([string]$Message)
    Add-Content -LiteralPath $logPath -Value ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message) -Encoding UTF8
}

if (-not (Test-Path -LiteralPath $bridgePath)) {
    throw 'Discord bridge entry point is missing'
}

$createdNew = $false
$mutex = [System.Threading.Mutex]::new($true, 'Local\CodexDiscordBridge', [ref]$createdNew)
if (-not $createdNew) {
    $mutex.Dispose()
    exit 0
}

try {
    Write-BridgeGuardLog 'Discord bridge guard started.'
    while ($true) {
        try {
            & $nodePath $bridgePath
            $exitCode = $LASTEXITCODE
            Write-BridgeGuardLog ("Discord bridge exited with code $exitCode; restarting.")
        }
        catch {
            Write-BridgeGuardLog ("Discord bridge failed: {0}" -f $_.Exception.Message)
        }
        Start-Sleep -Seconds 5
    }
}
finally {
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
}
