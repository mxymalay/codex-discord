[CmdletBinding()]
param([string]$StartupScript = '')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$sourceRoot=Split-Path -Parent $PSScriptRoot
if (-not $StartupScript) { $StartupScript=Join-Path $sourceRoot 'start-discord-bridge.ps1' }
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('discord-notification-startup-' + [guid]::NewGuid().ToString('N'))
$pwshPath=(Get-Process -Id $PID).Path
$nodePath=(Get-Command node -CommandType Application -ErrorAction Stop).Source
function Invoke-Fixture([string]$Directory) {
    $start=[Diagnostics.ProcessStartInfo]::new()
    $start.FileName=$pwshPath
    foreach ($argument in @('-NoProfile','-File',(Join-Path $Directory 'start-discord-bridge.ps1'))) { $start.ArgumentList.Add($argument) }
    $start.UseShellExecute=$false
    $start.RedirectStandardOutput=$true
    $start.RedirectStandardError=$true
    $child=[Diagnostics.Process]::new()
    $child.StartInfo=$start
    try {
        [void]$child.Start()
        $stdout=$child.StandardOutput.ReadToEndAsync()
        $stderr=$child.StandardError.ReadToEndAsync()
        if (-not $child.WaitForExit(20000)) { $child.Kill($true); throw 'Isolated startup fixture exceeded its deadline' }
        return [pscustomobject]@{ExitCode=$child.ExitCode;Output=$stdout.GetAwaiter().GetResult();Error=$stderr.GetAwaiter().GetResult()}
    } finally { $child.Dispose() }
}
try {
    [void][IO.Directory]::CreateDirectory($testRoot)
    $mutexName='Local\CodexDiscordBridgeNotificationTest-' + [guid]::NewGuid().ToString('N')
    $startupText=[IO.File]::ReadAllText($StartupScript).Replace('Local\CodexDiscordBridge',$mutexName)
    [IO.File]::WriteAllText((Join-Path $testRoot 'start-discord-bridge.ps1'),$startupText)
    Copy-Item (Join-Path $sourceRoot 'discord-notification-control.ps1') (Join-Path $testRoot 'discord-notification-control.ps1')
    [IO.File]::WriteAllText((Join-Path $testRoot 'config.json'),'{"enabled":false,"keep":"fixture"}')
    [IO.File]::WriteAllText((Join-Path $testRoot 'discord-bridge.mjs'), @'
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const configPath=fileURLToPath(new URL('./config.json',import.meta.url));
const observations=fileURLToPath(new URL('./observations.txt',import.meta.url));
const config=JSON.parse(readFileSync(configPath,'utf8'));
appendFileSync(observations,String(config.enabled)+'\n');
config.enabled=false;
writeFileSync(configPath,JSON.stringify(config));
'@)
    $fakeNative=@'
function New-BridgeSupervisorJob { param($ToolDir,$Process) [IO.File]::WriteAllText((Join-Path $ToolDir 'owned.txt'),'owned'); return [IntPtr]::Zero }
function Write-BridgeRuntimeIdentity { param($Path,$Mode,$ProcessId,$CreationTimeUtc,$ToolDir) }
function Remove-BridgeRuntimeIdentity { param($Path,$ExpectedProcessId) return $true }
function Close-BridgeJob { param($Handle) }
function Format-BridgeGuardLogEntry { param($Category,$ExitCode,$DurationMs) return $Category }
function Get-Command {
    param($Name,$ErrorAction)
    if ($Name -eq 'node') { return [pscustomobject]@{Source='__NODE__'} }
    return $null
}
function Start-Sleep {
    param($Seconds)
    $observations=Join-Path $PSScriptRoot 'observations.txt'
    if ((Test-Path $observations) -and @(Get-Content $observations).Count -ge 2) { throw 'isolated-fixture-complete' }
}
'@.Replace('__NODE__',$nodePath.Replace("'","''"))
    [IO.File]::WriteAllText((Join-Path $testRoot 'discord-bridge-startup.ps1'),$fakeNative)
    $created=$false
    $heldMutex=[Threading.Mutex]::new($true,$mutexName,[ref]$created)
    try {
        if (-not $created) { throw 'Isolated singleton name collided' }
        $rejected=Invoke-Fixture $testRoot
        if ($rejected.ExitCode -ne 0 -or (Test-Path (Join-Path $testRoot 'owned.txt')) -or (Get-Content -Raw (Join-Path $testRoot 'config.json') | ConvertFrom-Json).enabled) { throw 'A rejected singleton changed notification state or acquired native ownership' }
        Write-Output 'PASS: rejected supervisor leaves notification preference unchanged'
    } finally { $heldMutex.ReleaseMutex(); $heldMutex.Dispose() }
    $failingNative=$fakeNative.Replace('function Write-BridgeRuntimeIdentity { param($Path,$Mode,$ProcessId,$CreationTimeUtc,$ToolDir) }', @'
function Write-BridgeRuntimeIdentity {
    param($Path,$Mode,$ProcessId,$CreationTimeUtc,$ToolDir)
    $config=Get-Content -Raw (Join-Path $ToolDir 'config.json') | ConvertFrom-Json
    if (-not $config.enabled) { throw 'Notification preference was not enabled before identity publication' }
    $config.keep='updated-before-failure'
    [IO.File]::WriteAllText((Join-Path $ToolDir 'config.json'),($config | ConvertTo-Json))
    throw 'isolated-identity-publication-failed'
}
'@)
    [IO.File]::WriteAllText((Join-Path $testRoot 'discord-bridge-startup.ps1'),$failingNative)
    $failed=Invoke-Fixture $testRoot
    $afterFailure=Get-Content -Raw (Join-Path $testRoot 'config.json') | ConvertFrom-Json
    if ($failed.ExitCode -eq 0 -or -not $failed.Error.Contains('isolated-identity-publication-failed') -or $afterFailure.enabled -or $afterFailure.keep -cne 'updated-before-failure') { throw 'Failed supervisor initialization did not restore enabled while preserving current unrelated preferences' }
    Write-Output 'PASS: failed supervisor initialization restores the previous notification preference'
    [IO.File]::WriteAllText((Join-Path $testRoot 'discord-bridge-startup.ps1'),$fakeNative)
    $started=Invoke-Fixture $testRoot
    if ($started.ExitCode -eq 0 -or -not $started.Error.Contains('isolated-fixture-complete')) { throw ('Isolated supervisor did not complete both retries: ' + $started.Error) }
    $observed=@(Get-Content (Join-Path $testRoot 'observations.txt'))
    if (($observed -join ',') -cne 'true,false') { throw ('Supervisor must enable once after ownership and retain stop through retries; observed ' + ($observed -join ',')) }
    if ((Get-Content -Raw (Join-Path $testRoot 'config.json') | ConvertFrom-Json).enabled) { throw 'Supervisor child retry re-enabled stopped notifications' }
    Write-Output 'PASS: owner enables notifications once and retries respect a subsequent stop'
} finally { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
