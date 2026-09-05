[CmdletBinding()]
param([string]$StartupScript = '')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$sourceRoot=Split-Path -Parent $PSScriptRoot
if (-not $StartupScript) { $StartupScript=Join-Path $sourceRoot 'start-discord-bridge.ps1' }
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('discord-notification-startup-' + [guid]::NewGuid().ToString('N'))
$pwshPath=(Get-Process -Id $PID).Path
$originalPath=$env:PATH
$firstNodePath=(Get-Command node -ErrorAction Stop).Source
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
        if (-not $child.WaitForExit(20000)) {
            try { $child.Kill($true) } catch {}
            [void]$child.WaitForExit(2000)
            $diagnostics=[Collections.Generic.List[string]]::new()
            foreach ($capture in @(@{Name='stdout';Task=$stdout},@{Name='stderr';Task=$stderr})) {
                if ($capture.Task.Wait(2000)) {
                    $content=$capture.Task.GetAwaiter().GetResult()
                    if ($content.Length -gt 4000) { $content=$content.Substring($content.Length - 4000) }
                    $diagnostics.Add($capture.Name + ': ' + $content)
                } else { $diagnostics.Add($capture.Name + ': capture did not finish after termination') }
            }
            foreach ($name in @('discord-bridge-guard.log','observations.txt','attempts.txt')) {
                $path=Join-Path $Directory $name
                if (Test-Path -LiteralPath $path) { $diagnostics.Add($name + ': ' + ((Get-Content -LiteralPath $path -Tail 8) -join ' | ')) }
            }
            throw ('Isolated startup fixture exceeded its deadline; ' + ($diagnostics -join "`n"))
        }
        return [pscustomobject]@{ExitCode=$child.ExitCode;Output=$stdout.GetAwaiter().GetResult();Error=$stderr.GetAwaiter().GetResult()}
    } finally { $child.Dispose() }
}
try {
    [void][IO.Directory]::CreateDirectory($testRoot)
    # Hosted runners can have setup-node and a preinstalled Node on PATH.
    # Exercise actual command discovery with multiple application matches.
    $additionalNodeDirectory=Join-Path $testRoot 'additional Node installation'
    [void][IO.Directory]::CreateDirectory($additionalNodeDirectory)
    $nodeName=if ($IsWindows) { 'node.exe' } else { 'node' }
    [void][IO.File]::CreateSymbolicLink((Join-Path $additionalNodeDirectory $nodeName),$firstNodePath)
    $env:PATH=$additionalNodeDirectory + [IO.Path]::PathSeparator + $originalPath
    $nodeCandidates=@(Get-Command node -CommandType Application -ErrorAction Stop)
    if ($nodeCandidates.Count -lt 2) { throw 'Fixture did not create multiple Node application matches' }
    $nodePath=$nodeCandidates[0].Source
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
function Format-BridgeGuardLogEntry {
    param($Category,$ExitCode,$DurationMs)
    if ($Category -eq 'bridge-launch-failed') { return ($Category + ': ' + [string]$Error[0]) }
    return ($Category + ': exit=' + $ExitCode)
}
function Get-Command {
    param($Name,$ErrorAction)
    if ($Name -eq 'node') { return [pscustomobject]@{Source='__NODE__'} }
    return $null
}
function Start-Sleep {
    param($Seconds)
    $observations=Join-Path $PSScriptRoot 'observations.txt'
    if ((Test-Path $observations) -and @(Get-Content $observations).Count -ge 2) { throw 'isolated-fixture-complete' }
    $attemptPath=Join-Path $PSScriptRoot 'attempts.txt'
    Add-Content -LiteralPath $attemptPath -Value 'attempt'
    if (@(Get-Content -LiteralPath $attemptPath).Count -ge 4) {
        $guardPath=Join-Path $PSScriptRoot 'discord-bridge-guard.log'
        throw ('isolated-fixture-observations-missing; ' + ((Get-Content -LiteralPath $guardPath -Tail 8) -join ' | '))
    }
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
} finally {
    $env:PATH=$originalPath
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
