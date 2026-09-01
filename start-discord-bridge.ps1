[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$toolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgePath = Join-Path $toolDir 'discord-bridge.mjs'
$logPath = Join-Path $toolDir 'discord-bridge-guard.log'
. (Join-Path $toolDir 'discord-bridge-startup.ps1')

function Write-BridgeGuardLog {
    param(
        [Parameter(Mandatory)][string]$Category,
        [Nullable[int]]$ExitCode,
        [Nullable[long]]$DurationMs
    )
    $entry = Format-BridgeGuardLogEntry -Category $Category -ExitCode $ExitCode -DurationMs $DurationMs
    Add-Content -LiteralPath $logPath -Value $entry -Encoding UTF8
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

$runtimePath = Join-Path $toolDir 'discord-bridge-runtime.json'
$jobHandle = [IntPtr]::Zero
try {
    $supervisor = Get-Process -Id $PID -ErrorAction Stop
    $jobHandle = New-BridgeSupervisorJob -ToolDir $toolDir -Process $supervisor
    $mode = if ($env:CODEX_DISCORD_START_MODE -eq 'temporary') { 'temporary' } else { 'scheduled' }
    Write-BridgeRuntimeIdentity -Path $runtimePath -Mode $mode -ProcessId $PID -CreationTimeUtc $supervisor.StartTime.ToUniversalTime() -ToolDir $toolDir | Out-Null
    Write-BridgeGuardLog -Category 'guard-started'
    while ($true) {
        $attempt = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            $nodeCommand = Get-Command node -ErrorAction Stop
            $nodePath = $nodeCommand.Source
            $codexCommand = Get-Command codex -ErrorAction SilentlyContinue
            if ($null -eq $codexCommand) {
                Remove-Item -LiteralPath 'Env:CODEX_DISCORD_CODEX_PATH' -ErrorAction SilentlyContinue
            }
            else {
                $env:CODEX_DISCORD_CODEX_PATH = $codexCommand.Source
            }
            & $nodePath $bridgePath
            $exitCode = $LASTEXITCODE
            $attempt.Stop()
            Write-BridgeGuardLog -Category 'bridge-exited' -ExitCode $exitCode -DurationMs $attempt.ElapsedMilliseconds
        }
        catch {
            $attempt.Stop()
            Write-BridgeGuardLog -Category 'bridge-launch-failed' -DurationMs $attempt.ElapsedMilliseconds
        }
        Start-Sleep -Seconds 5
    }
}
finally {
    [void](Remove-BridgeRuntimeIdentity -Path $runtimePath -ExpectedProcessId $PID)
    Close-BridgeJob -Handle $jobHandle
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
}
