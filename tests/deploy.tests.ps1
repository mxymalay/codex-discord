[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
$deployScript = Join-Path $sourceRoot 'deploy.ps1'
$readmePath = Join-Path $sourceRoot 'README.md'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('codex discord deploy ' + [guid]::NewGuid().ToString('N'))
$testJunctions = [System.Collections.Generic.List[string]]::new()

$sourceFiles = @(
    'activate-discord-bot.ps1',
    'build-control-app.ps1',
    'codex-control-lib.ps1',
    'codex-control.ps1',
    'codex-takeover-lib.mjs',
    'control-app\CodexDiscordControl.cs',
    'assets\codex-discord-control.png',
    'assets\codex-discord-control.ico',
    'discord-bridge-lib.mjs',
    'discord-runtime-lib.mjs',
    'discord-paths-lib.mjs',
    'discord-bridge-startup.ps1',
    'discord-bridge.mjs',
    'discord-commands-lib.mjs',
    'discord-config.ps1',
    'discord-control-client.mjs',
    'discord-gateway-lib.mjs',
    'discord-health-lib.mjs',
    'discord-http.ps1',
    'discord-interactions.mjs',
    'discord-secret.ps1',
    'discord-notification-control.ps1',
    'discord-migration.ps1',
    'export-discord-migration.ps1',
    'import-discord-migration.ps1',
    'discord-state.ps1',
    'discord-task-create-lib.mjs',
    'discord-task-index-lib.mjs',
    'deploy-live-probe.ps1',
    'dispatcher.ps1',
    'get-discord-token.ps1',
    'install-control-app.ps1',
    'install-discord-bridge-task.ps1',
    'protect-discord-pending-reply.ps1',
    'repair-notify.ps1',
    'rollout-completion-watcher-lib.mjs',
    'save-discord-token.ps1',
    'setup.ps1',
    'start-discord-bridge.ps1',
    'task-delivery-state.ps1',
    'unprotect-discord-pending-reply.ps1',
    'watch-notify.ps1'
)
$deployedFiles = @($sourceFiles + 'CodexDiscordControl.exe')
$forbiddenRuntimeNames = @(
    'config.json', 'discord-token.dpapi', 'discord-inbox-state.json',
    'discord-message-map.json', 'discord-task-index.json', 'discord-gateway-state.json',
    'quota-state.json', 'rollout-watcher-state.json', 'task-delivery-state.json',
    'discord-bridge-runtime.json', 'discord-bridge-health.json',
    'discord-bridge.log', 'mobile-notify.log', 'notify-guard.log'
)

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Get-BytesHex {
    param([Parameter(Mandatory)][string]$Path)
    return [Convert]::ToHexString([System.IO.File]::ReadAllBytes($Path))
}

function Write-TestBytes {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][byte[]]$Bytes)
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    [System.IO.File]::WriteAllBytes($Path, $Bytes)
}

function Copy-DeploymentSource {
    param([Parameter(Mandatory)][string]$Destination)
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($relativePath in $sourceFiles) {
        $destinationPath = Join-Path $Destination $relativePath
        $destinationParent = Split-Path -Parent $destinationPath
        if (-not (Test-Path -LiteralPath $destinationParent -PathType Container)) {
            New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
        }
        Copy-Item -LiteralPath (Join-Path $sourceRoot $relativePath) -Destination $destinationPath
    }
    Copy-Item -LiteralPath $readmePath -Destination (Join-Path $Destination 'README.md')
}

function Get-IsolatedControlScript {
    param([Parameter(Mandatory)][ValidateSet('new','old')][string]$Role)
    return @'
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Action)
$role = '__ROLE__'
$state = Get-Content -Raw -LiteralPath $env:CODEX_DEPLOY_TEST_STATE_PATH | ConvertFrom-Json
Add-Content -LiteralPath $env:CODEX_DEPLOY_TEST_ACTION_PATH -Value ("control:${role}:$Action") -Encoding UTF8
if ($Action -eq 'status') {
    [pscustomobject]@{ ok=$true; service=[pscustomobject]@{ running=[bool]$state.running; autoStartEnabled=[bool]$state.autoStartEnabled; mode=[string]$state.mode } } | ConvertTo-Json -Compress
    exit 0
}
if ($env:CODEX_DEPLOY_TEST_FAIL_ACTION -eq $Action -and $role -eq 'new') {
    '{"ok":false,"errorCategory":"synthetic-control-failure"}'
    exit 1
}
switch ($Action) {
    'enable-long-term' { $state.taskInstalled=$true; $state.autoStartEnabled=$true; $state.taskRunning=$true; $state.running=$true; $state.mode='scheduled' }
    'start-temporary' { $state.running=$true; $state.taskRunning=[bool]$state.autoStartEnabled; $state.mode=$(if($state.autoStartEnabled){'scheduled'}else{'temporary'}) }
    'stop-temporary' { $state.running=$false; $state.taskRunning=$false; $state.mode='unknown' }
    default { '{"ok":false,"errorCategory":"unexpected-action"}'; exit 1 }
}
$state | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:CODEX_DEPLOY_TEST_STATE_PATH -Encoding UTF8
if ($env:CODEX_DEPLOY_TEST_FAIL_ACTION_AFTER_MUTATION -eq $Action -and $role -eq 'new') {
    '{"ok":false,"errorCategory":"synthetic-post-mutation-control-failure"}'
    exit 1
}
'{"ok":true}'
exit 0
'@.Replace('__ROLE__', $Role)
}

function Get-IsolatedBridgeScript {
    param([Parameter(Mandatory)][ValidateSet('new','old')][string]$Role)
    return @'
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
appendFileSync(process.env.CODEX_DEPLOY_TEST_ACTION_PATH, 'register:__ROLE__\n', 'utf8');
if (process.env.CODEX_DEPLOY_TEST_REMOTE_PATH) writeFileSync(process.env.CODEX_DEPLOY_TEST_REMOTE_PATH, '__ROLE__', 'utf8');
const mode = process.env.CODEX_DEPLOY_TEST_REGISTRATION_MODE || '';
if ('__ROLE__' === 'new' && mode === 'hang-new') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  if (process.env.CODEX_DEPLOY_TEST_PID_PATH) writeFileSync(process.env.CODEX_DEPLOY_TEST_PID_PATH, `${process.pid}\n${child.pid}\n`, 'utf8');
  setInterval(() => {}, 1000);
}
if ('__ROLE__' === 'new' && mode === 'huge-stdout-new') {
  const sentinel = process.env.CODEX_DEPLOY_TEST_OUTPUT_SENTINEL || 'synthetic-output';
  process.stdout.write(sentinel.repeat(20000));
  setInterval(() => {}, 1000);
}
if ('__ROLE__' === 'new' && mode === 'huge-stderr-new') {
  const sentinel = process.env.CODEX_DEPLOY_TEST_OUTPUT_SENTINEL || 'synthetic-output';
  process.stderr.write(sentinel.repeat(20000));
  setInterval(() => {}, 1000);
}
if ('__ROLE__' === 'new' && mode === 'slow-retry-new') {
  appendFileSync(process.env.CODEX_DEPLOY_TEST_ACTION_PATH, 'register:synthetic-429-long-retry\n', 'utf8');
  setTimeout(() => process.exit(0), 600000);
}
if (process.env.CODEX_DEPLOY_TEST_FAIL_REGISTRATION === '__ROLE__') process.exit(1);
'@.Replace('__ROLE__', $Role)
}

function Assert-BoundedRegistrationProcess {
    param(
        [Parameter(Mandatory)][string]$Mode,
        [Parameter(Mandatory)][string]$BridgePath,
        [Parameter(Mandatory)][string]$ArtifactRoot
    )
    New-Item -ItemType Directory -Path $ArtifactRoot -Force | Out-Null
    $actionPath = Join-Path $ArtifactRoot 'actions.txt'
    $pidPath = Join-Path $ArtifactRoot 'pids.txt'
    $testEnvironment = @{
        CODEX_DEPLOY_TEST_ACTION_PATH = $actionPath
        CODEX_DEPLOY_TEST_REMOTE_PATH = $null
        CODEX_DEPLOY_TEST_PID_PATH = $pidPath
        CODEX_DEPLOY_TEST_REGISTRATION_MODE = $Mode
        CODEX_DEPLOY_TEST_OUTPUT_SENTINEL = 'DO-NOT-LEAK-REGISTRATION-OUTPUT'
    }
    $savedEnvironment = @{}
    foreach ($name in $testEnvironment.Keys) {
        $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    try {
        foreach ($name in $testEnvironment.Keys) {
            [Environment]::SetEnvironmentVariable($name, $testEnvironment[$name], 'Process')
        }
        $nodePath = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        # Time only the production process runner, independently of stage checks
        # and the separate processes needed for deployment and rollback.
        $processClock = [System.Diagnostics.Stopwatch]::StartNew()
        try { $result = [CodexDeployBoundedProcess]::Run($nodePath, $BridgePath, 1400, 4096) }
        finally { $processClock.Stop() }
        Assert-True ($processClock.ElapsedMilliseconds -lt 5000) "bounded $Mode process exceeded its direct deadline tolerance ($($processClock.ElapsedMilliseconds)ms)"
        Assert-True (-not $result.Success) "bounded $Mode process unexpectedly succeeded"
        if ($Mode -in @('huge-stdout-new','huge-stderr-new')) {
            Assert-True $result.OutputLimitExceeded "bounded $Mode process did not enforce its output cap"
        } else {
            Assert-True $result.TimedOut "bounded $Mode process did not enforce its deadline"
        }
        $expectedActions = if ($Mode -eq 'slow-retry-new') {
            'register:new,register:synthetic-429-long-retry'
        } else { 'register:new' }
        Assert-True ((@(Get-Content -LiteralPath $actionPath) -join ',') -eq $expectedActions) "bounded $Mode process did not reach its fault fixture"
        if ($Mode -eq 'hang-new') {
            $processIds = @(Get-Content -LiteralPath $pidPath)
            Assert-True ($processIds.Count -eq 2) 'direct bounded registration did not record its parent and descendant'
            foreach ($pidText in $processIds) {
                $processId = 0
                Assert-True ([int]::TryParse($pidText, [ref]$processId)) 'direct bounded registration recorded an invalid process id'
                Assert-True ($null -eq (Get-Process -Id $processId -ErrorAction SilentlyContinue)) 'direct bounded registration left a process-tree member alive'
            }
        }
        Write-Output "PASS: bounded $Mode process ($($processClock.ElapsedMilliseconds)ms; configured deadline 1400ms)"
    }
    finally {
        foreach ($name in $savedEnvironment.Keys) {
            [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
        }
    }
}

function Install-IsolatedDeploySource {
    param([Parameter(Mandatory)][string]$Destination)
    Copy-DeploymentSource -Destination $Destination
    $fakeLibrary = @'
function Read-IsolatedDeployState { return (Get-Content -Raw -LiteralPath $env:CODEX_DEPLOY_TEST_STATE_PATH | ConvertFrom-Json) }
function Write-IsolatedDeployState { param($State) $State | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:CODEX_DEPLOY_TEST_STATE_PATH -Encoding UTF8 }
function Add-IsolatedDeployAction { param([string]$Value) Add-Content -LiteralPath $env:CODEX_DEPLOY_TEST_ACTION_PATH -Value $Value -Encoding UTF8 }
function Read-IsolatedGuardState {
    if ([string]::IsNullOrWhiteSpace($env:CODEX_DEPLOY_TEST_GUARD_STATE_PATH)) { return [pscustomobject]@{exists=$false;trusted=$true;enabled=$false;running=$false} }
    return (Get-Content -Raw -LiteralPath $env:CODEX_DEPLOY_TEST_GUARD_STATE_PATH | ConvertFrom-Json)
}
function Write-IsolatedGuardState { param($State) $State | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:CODEX_DEPLOY_TEST_GUARD_STATE_PATH -Encoding UTF8 }
function New-CodexControlOperations { return @{} }
function Get-CodexBridgeServiceStatus {
    param([hashtable]$Operations,[string]$ToolDir)
    Add-IsolatedDeployAction 'probe:status'
    $state = Read-IsolatedDeployState
    return [pscustomobject]@{ ok=$true; taskInstalled=[bool]$state.taskInstalled; autoStartEnabled=[bool]$state.autoStartEnabled; taskRunning=[bool]$state.taskRunning; running=[bool]$state.running; runtime=$(if($state.running){[pscustomobject]@{mode=[string]$state.mode}}else{$null}) }
}
function Invoke-CodexBridgeServiceAction {
    param([string]$Action,[string]$ToolDir,[hashtable]$Operations)
    Add-IsolatedDeployAction ("probe:$Action")
    $state = Read-IsolatedDeployState
    if ($Action -eq 'stop-temporary') { $state.running=$false; $state.taskRunning=$false; $state.mode='unknown'; Write-IsolatedDeployState $state }
    if ($env:CODEX_DEPLOY_TEST_PROBE_STOP_FAIL_AFTER -eq '1' -and $Action -eq 'stop-temporary') { return [pscustomobject]@{ok=$false;errorCategory='synthetic-partial-stop'} }
    if ($Action -eq 'enable-long-term') { $state.taskInstalled=$true; $state.autoStartEnabled=$true; $state.taskRunning=$true; $state.running=$true; $state.mode='scheduled'; Write-IsolatedDeployState $state }
    if ($Action -eq 'start-temporary') { $state.running=$true; $state.taskRunning=[bool]$state.autoStartEnabled; $state.mode=$(if($state.autoStartEnabled){'scheduled'}else{'temporary'}); Write-IsolatedDeployState $state }
    return [pscustomobject]@{ok=$true}
}
function Get-CodexNotificationGuardStatus {
    param([hashtable]$Operations,[string]$ToolDir)
    Add-IsolatedDeployAction 'guard:status'
    $state = Read-IsolatedGuardState
    if ($env:CODEX_DEPLOY_TEST_REPLACE_STAGE_ON_FINAL_GUARD -eq '1') {
        $countPath = $env:CODEX_DEPLOY_TEST_GUARD_COUNT_PATH
        $count = if (Test-Path -LiteralPath $countPath -PathType Leaf) { [int](Get-Content -Raw -LiteralPath $countPath) } else { 0 }
        $count++
        [System.IO.File]::WriteAllText($countPath, [string]$count, [System.Text.UTF8Encoding]::new($false))
        if ($count -eq 2) {
            $original = $PSScriptRoot + '.original'
            Move-Item -LiteralPath $PSScriptRoot -Destination $original
            New-Item -ItemType Directory -Path $PSScriptRoot | Out-Null
            [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'replacement-sentinel.txt'), 'replacement-must-survive', [System.Text.UTF8Encoding]::new($false))
        }
    }
    $definitionHash = if ($null -ne $state.PSObject.Properties['definitionHash']) { [string]$state.definitionHash } else { 'isolated-guard-definition-v1' }
    return [pscustomobject]@{ok=$true;exists=[bool]$state.exists;trusted=[bool]$state.trusted;enabled=[bool]$state.enabled;running=[bool]$state.running;definitionHash=$definitionHash}
}
function Invoke-CodexNotificationGuardAction {
    param([string]$Action,[hashtable]$Operations,[string]$ToolDir)
    Add-IsolatedDeployAction ("guard:$Action")
    $state = Read-IsolatedGuardState
    if (-not $state.exists -or -not $state.trusted) { return [pscustomobject]@{ok=$false;errorCategory='guard-unavailable'} }
    switch ($Action) {
        'stop' { $state.running=$(if ($state.enabled -and $null -ne $state.PSObject.Properties['autoRestartWhenEnabled'] -and [bool]$state.autoRestartWhenEnabled){$true}else{$false}) }
        'start' { $state.running=$true }
        'enable' { $state.enabled=$true }
        'disable' {
            $state.enabled=$false
            if ($env:CODEX_DEPLOY_TEST_GUARD_MUTATE_DEFINITION_ON_DISABLE -eq '1') {
                if ($null -eq $state.PSObject.Properties['definitionHash']) { $state | Add-Member -NotePropertyName definitionHash -NotePropertyValue 'isolated-guard-definition-changed' }
                else { $state.definitionHash='isolated-guard-definition-changed' }
            }
        }
    }
    Write-IsolatedGuardState $state
    if ($env:CODEX_DEPLOY_TEST_GUARD_ACTION_FAIL_AFTER -eq $Action) { return [pscustomobject]@{ok=$false;errorCategory='synthetic-guard-post-mutation-failure'} }
    return [pscustomobject]@{ok=$true;guard=$state}
}
'@
    $fakeInstaller = @'
[CmdletBinding()]
param([string]$SourceRoot,[string]$ToolDir,[string]$DesktopPath,[switch]$ShortcutOnly,[Collections.Generic.List[object]]$ShortcutTransactionLog)
if (-not $ShortcutOnly) { throw 'isolated installer requires ShortcutOnly' }
Add-Content -LiteralPath $env:CODEX_DEPLOY_TEST_ACTION_PATH -Value 'install:shortcut' -Encoding UTF8
$newPath=Join-Path $DesktopPath '码驿 · CodexRelay 控制台.lnk'
$hadOriginal=Test-Path -LiteralPath $newPath -PathType Leaf
$originalHash=if($hadOriginal){(Get-FileHash -LiteralPath $newPath -Algorithm SHA256).Hash}else{$null}
[System.IO.File]::WriteAllText($newPath, 'isolated-new-shortcut', [System.Text.UTF8Encoding]::new($false))
$ShortcutTransactionLog.Add([pscustomobject]@{DestinationPath=$newPath;HadOriginal=$hadOriginal;OriginalHash=$originalHash;ExpectedHash=(Get-FileHash -LiteralPath $newPath -Algorithm SHA256).Hash;Removed=$false})
if ($env:CODEX_DEPLOY_TEST_MIGRATE_LEGACY_SHORTCUT -eq '1') {
    $legacyPath=Join-Path $DesktopPath 'Codex Discord 控制台.lnk'
    $legacyHash=(Get-FileHash -LiteralPath $legacyPath -Algorithm SHA256).Hash
    Remove-Item -LiteralPath $legacyPath -Force
    $ShortcutTransactionLog.Add([pscustomobject]@{DestinationPath=$legacyPath;HadOriginal=$true;OriginalHash=$legacyHash;ExpectedHash=$null;Removed=$true})
}
if ($env:CODEX_DEPLOY_TEST_FAIL_SHORTCUT_AFTER_WRITE -eq '1') { throw 'synthetic-shortcut-failure' }
'@
    $fakeBuilder = @'
[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutputDirectory)
[System.IO.File]::WriteAllBytes((Join-Path $OutputDirectory 'CodexDiscordControl.exe'), [byte[]](0x4d,0x5a,1,2,3,4))
if ($env:CODEX_DEPLOY_TEST_REPLACE_STAGE_AFTER_BUILD -eq '1') {
    $original = $OutputDirectory + '.original'
    Move-Item -LiteralPath $OutputDirectory -Destination $original
    Copy-Item -LiteralPath $original -Destination $OutputDirectory -Recurse
}
'@
    [System.IO.File]::WriteAllText((Join-Path $Destination 'codex-control-lib.ps1'), $fakeLibrary, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $Destination 'codex-control.ps1'), (Get-IsolatedControlScript -Role new), [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $Destination 'install-control-app.ps1'), $fakeInstaller, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $Destination 'discord-bridge.mjs'), (Get-IsolatedBridgeScript -Role new), [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $Destination 'build-control-app.ps1'), $fakeBuilder, [System.Text.UTF8Encoding]::new($false))
}

function Assert-DirectoryUnchanged {
    param([Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][hashtable]$Expected)
    $actual = @{}
    Get-ChildItem -LiteralPath $Directory -Recurse -File | ForEach-Object {
        $relative = [System.IO.Path]::GetRelativePath($Directory, $_.FullName)
        $actual[$relative] = Get-BytesHex -Path $_.FullName
    }
    Assert-True ($actual.Count -eq $Expected.Count) 'directory file count changed before a rejected deployment'
    foreach ($name in $Expected.Keys) {
        Assert-True ($actual.ContainsKey($name) -and $actual[$name] -ceq $Expected[$name]) "rejected deployment changed $name"
    }
}

function Test-StoppedDeployNotificationRestoration {
    # Exercise the actual restoration and notification-control functions while replacing only
    # Windows process/task boundaries. This also runs independently on macOS during review.
    $parseTokens = $null; $parseErrors = $null
    $deployAst = [Management.Automation.Language.Parser]::ParseFile($deployScript, [ref]$parseTokens, [ref]$parseErrors)
    Assert-True ($parseErrors.Count -eq 0) 'Deployment script could not be parsed for restoration regression'
    foreach ($name in @('Test-DeployBridgeStateEqual', 'Restore-DeployBridgeState')) {
        $definition = $deployAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
        Assert-True ($null -ne $definition) "Missing deployment function: $name"
        . ([scriptblock]::Create($definition.Extent.Text))
    }
    . (Join-Path $sourceRoot 'codex-control-lib.ps1')
    function Invoke-DeployControl {
        param($PowerShellPath, $ControlPath, $Action)
        $result = Invoke-CodexBridgeServiceAction -Action $Action -ToolDir $fixtureDirectory -Operations $fixtureOperations -PollAttempts 1 -PollMilliseconds 0
        if (-not $result.ok) { throw "control action failed: $Action" }
        return $result
    }
    function Invoke-DeployServiceProbe {
        param($PowerShellPath, $ProbePath, $Action, $ToolDir)
        Assert-True ($Action -eq 'status') 'Restoration unexpectedly used the staged action fallback'
        $status = Get-CodexBridgeServiceStatus -Operations $fixtureOperations -ToolDir $ToolDir
        return [pscustomobject]@{ok=$status.ok;service=[pscustomobject]@{
            taskInstalled=$status.taskInstalled; autoStartEnabled=$status.autoStartEnabled
            taskRunning=$status.taskRunning; running=$status.running; mode='unknown'
        }}
    }
    foreach ($installed in @($true, $false)) {
        $fixtureDirectory = Join-Path $testRoot "stopped notification regression $installed"
        [void][IO.Directory]::CreateDirectory($fixtureDirectory)
        $fixtureControl = Join-Path $fixtureDirectory 'codex-control.ps1'
        [IO.File]::WriteAllText($fixtureControl, '# All task boundaries are injected by this test.')
        $fixtureConfig = Join-Path $fixtureDirectory 'config.json'
        $beforeJson = '{"enabled":true,"previousNotify":["synthetic-previous-notifier","--keep"],"nested":{"value":[1,"two",true]},"huge":9007199254740993,"exponent":1e400,"negativeZero":-0}'
        [IO.File]::WriteAllText($fixtureConfig, $beforeJson)
        $fixtureToken = Join-Path $fixtureDirectory 'discord-token.dpapi'
        [IO.File]::WriteAllBytes($fixtureToken, [byte[]](0,255,1,22))
        $fixtureOperations = @{
            GetTask = { [pscustomobject]@{installed=$installed; enabled=$false; running=$false; definitionCurrent=$true} }.GetNewClosure()
            GetRuntime = { $null }
            StopTask = { throw 'Already stopped task should not be stopped again' }
            InstallTask = { throw 'Stopped deployment must never create a task' }
            EnableTask = { throw 'Stopped deployment must preserve disabled startup' }
            StartTask = { throw 'Stopped deployment must not start a task' }
            StartDetached = { throw 'Stopped deployment must not start a bridge' }
        }
        $expected = [pscustomobject]@{taskInstalled=$installed;autoStartEnabled=$false;taskRunning=$false;running=$false;mode='unknown'}
        $restored = Restore-DeployBridgeState -PowerShellPath 'unused' -ProbePath 'unused' -ToolDir $fixtureDirectory -Expected $expected -ControlPath $fixtureControl
        $before = [Text.Json.JsonDocument]::Parse($beforeJson)
        $after = [Text.Json.JsonDocument]::Parse([IO.File]::ReadAllText($fixtureConfig))
        try {
            Assert-True ($after.RootElement.GetProperty('enabled').ValueKind -eq [Text.Json.JsonValueKind]::False) "Stopped deployment left legacy hook notifications enabled (taskInstalled=$installed)"
            foreach ($property in $before.RootElement.EnumerateObject()) {
                if ($property.Name -ceq 'enabled') { continue }
                Assert-True ($after.RootElement.GetProperty($property.Name).GetRawText() -ceq $property.Value.GetRawText()) "Stopped deployment changed unrelated configuration: $($property.Name)"
            }
        } finally { $before.Dispose(); $after.Dispose() }
        Assert-True ((Get-BytesHex $fixtureToken) -ceq '00FF0116') 'Stopped deployment changed the encrypted token'
        Assert-True (Test-DeployBridgeStateEqual -Actual $restored.service -Expected $expected) 'Stopped deployment changed task existence or startup preference'
        # A malformed config must produce a failed update, never claim that notifications stopped.
        [IO.File]::WriteAllText($fixtureConfig, '{broken')
        $failed = $false
        try { [void](Restore-DeployBridgeState -PowerShellPath 'unused' -ProbePath 'unused' -ToolDir $fixtureDirectory -Expected $expected -ControlPath $fixtureControl) }
        catch { $failed = $true }
        Assert-True $failed 'Stopped deployment ignored a notification configuration failure'
    }
    Write-Output 'PASS: stopped deployment mutes legacy hooks while preserving configuration, token and task preferences'
}

function Get-TestShortPath {
    param([Parameter(Mandatory)][string]$Path)

    if ($null -eq ('CodexDeployTestPathNative' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CodexDeployTestPathNative {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern uint GetShortPathName(string longPath, StringBuilder shortPath, uint bufferLength);
}
'@
    }
    $buffer = [System.Text.StringBuilder]::new(32768)
    $length = [CodexDeployTestPathNative]::GetShortPathName([System.IO.Path]::GetFullPath($Path), $buffer, [uint32]$buffer.Capacity)
    if ($length -eq 0 -or $length -ge $buffer.Capacity) { return $null }
    return $buffer.ToString()
}

try {
    Assert-True (Test-Path -LiteralPath $deployScript -PathType Leaf) 'deploy.ps1 is missing'
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    Test-StoppedDeployNotificationRestoration

    foreach ($relativePath in $sourceFiles) {
        Assert-True (Test-Path -LiteralPath (Join-Path $sourceRoot $relativePath) -PathType Leaf) "deployment source is missing: $relativePath"
    }

    $liveRoot = Join-Path $testRoot 'live root with spaces'
    $desktopRoot = Join-Path $testRoot 'temporary Desktop with spaces'
    New-Item -ItemType Directory -Path $liveRoot,$desktopRoot -Force | Out-Null

    $preserved = @{
        'config.json' = [byte[]](0,255,1,2,3)
        'discord-token.dpapi' = [byte[]](10,20,30,40,0,200)
        'discord-inbox-state.json' = [byte[]](91,49,44,50,93)
        'discord-message-map.json' = [byte[]](123,125)
        'discord-task-index.json' = [byte[]](21,22,23)
        'discord-gateway-state.json' = [byte[]](31,32,33)
        'quota-state.json' = [byte[]](7,8,9)
        'rollout-watcher-state.json' = [byte[]](41,42,43)
        'task-delivery-state.json' = [byte[]](51,52,53)
        'discord-bridge-runtime.json' = [byte[]](4,5,6)
        'discord-bridge-health.json' = [byte[]](11,12,13)
        'discord-inbox-state.corrupt-sample.json' = [byte[]](61,62,63)
        'discord-task-index.corrupt-sample.json' = [byte[]](71,72,73)
        '.rollout-notification-sample.json' = [byte[]](81,82,83)
        'discord-bridge.log' = [byte[]](91,92,93)
        'discord-bridge-guard.log' = [byte[]](101,102,103)
        'mobile-notify.log' = [byte[]](111,112,113)
        'notify-guard.log' = [byte[]](121,122,123)
        '.private-stage.tmp' = [byte[]](131,132,133)
        'custom-secret.dat' = [byte[]](141,142,143)
        'unrelated.bin' = [byte[]](99,0,88,77)
    }
    foreach ($entry in $preserved.GetEnumerator()) {
        Write-TestBytes -Path (Join-Path $liveRoot $entry.Key) -Bytes $entry.Value
    }
    Write-TestBytes -Path (Join-Path $liveRoot 'discord-bridge.mjs') -Bytes ([byte[]](111,108,100,45,98,114,105,100,103,101))
    Write-TestBytes -Path (Join-Path $liveRoot 'CodexDiscordControl.exe') -Bytes ([byte[]](111,108,100,45,101,120,101))
    $oldBridgeHash = Get-BytesHex -Path (Join-Path $liveRoot 'discord-bridge.mjs')
    $oldExecutableHash = Get-BytesHex -Path (Join-Path $liveRoot 'CodexDiscordControl.exe')

    $deployOutput = @(& $deployScript -SourceRoot $sourceRoot -LiveRoot $liveRoot -DesktopPath $desktopRoot -SkipLiveActions)
    if ($LASTEXITCODE -ne 0) { throw "isolated deployment failed with exit code $LASTEXITCODE" }

    foreach ($entry in $preserved.GetEnumerator()) {
        Assert-True ((Get-BytesHex -Path (Join-Path $liveRoot $entry.Key)) -ceq [Convert]::ToHexString($entry.Value)) "deployment changed preserved bytes: $($entry.Key)"
    }
    foreach ($relativePath in $sourceFiles) {
        $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $sourceRoot $relativePath)).Hash
        $liveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $liveRoot $relativePath)).Hash
        Assert-True ($liveHash -ceq $sourceHash) "deployment did not copy allowlisted file exactly: $relativePath"
    }
    $deployedExe = Join-Path $liveRoot 'CodexDiscordControl.exe'
    Assert-True (Test-Path -LiteralPath $deployedExe -PathType Leaf) 'SkipLiveActions did not build and deploy the control executable'
    $exeBytes = [System.IO.File]::ReadAllBytes($deployedExe)
    Assert-True ($exeBytes.Length -gt 2 -and $exeBytes[0] -eq 0x4d -and $exeBytes[1] -eq 0x5a) 'deployed control executable is not a built PE file'
    Assert-True (@(Get-ChildItem -LiteralPath $desktopRoot -Force).Count -eq 0) 'SkipLiveActions changed the Desktop directory'

    $backupParent = Join-Path $liveRoot '.codex-discord-backups'
    $firstBackups = @(Get-ChildItem -LiteralPath $backupParent -Directory)
    Assert-True ($firstBackups.Count -eq 1) 'deployment did not retain exactly one timestamped backup'
    Assert-True (Test-Path -LiteralPath (Join-Path $firstBackups[0].FullName 'discord-bridge.mjs') -PathType Leaf) 'backup omitted an overwritten allowlisted file'
    Assert-True ((Get-BytesHex -Path (Join-Path $firstBackups[0].FullName 'discord-bridge.mjs')) -ceq $oldBridgeHash) 'backup changed old bridge bytes'
    Assert-True ((Get-BytesHex -Path (Join-Path $firstBackups[0].FullName 'CodexDiscordControl.exe')) -ceq $oldExecutableHash) 'backup omitted or changed the old executable'
    foreach ($name in $preserved.Keys) {
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $firstBackups[0].FullName $name))) "backup copied forbidden or unrelated state: $name"
    }
    Assert-True (($deployOutput -join "`n") -match [regex]::Escape($firstBackups[0].FullName)) 'deployment output did not report the recoverable backup path'

    & $deployScript -SourceRoot $sourceRoot -LiveRoot $liveRoot -DesktopPath $desktopRoot -SkipLiveActions | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'repeat isolated deployment failed' }
    Assert-True (@(Get-ChildItem -LiteralPath $backupParent -Directory).Count -eq 2) 'repeat deployment did not retain a new backup'
    foreach ($entry in $preserved.GetEnumerator()) {
        Assert-True ((Get-BytesHex -Path (Join-Path $liveRoot $entry.Key)) -ceq [Convert]::ToHexString($entry.Value)) "repeat deployment changed preserved bytes: $($entry.Key)"
    }

    $incompleteSource = Join-Path $testRoot 'incomplete source with spaces'
    Copy-DeploymentSource -Destination $incompleteSource
    Remove-Item -LiteralPath (Join-Path $incompleteSource 'discord-gateway-lib.mjs') -Force
    $untouchedLive = Join-Path $testRoot 'missing source destination'
    $untouchedDesktop = Join-Path $testRoot 'missing source Desktop'
    New-Item -ItemType Directory -Path $untouchedLive,$untouchedDesktop -Force | Out-Null
    Write-TestBytes -Path (Join-Path $untouchedLive 'sentinel.bin') -Bytes ([byte[]](1,3,3,7))
    $beforeMissing = @{ 'sentinel.bin' = Get-BytesHex -Path (Join-Path $untouchedLive 'sentinel.bin') }
    $missingError = $null
    try { & $deployScript -SourceRoot $incompleteSource -LiveRoot $untouchedLive -DesktopPath $untouchedDesktop -SkipLiveActions | Out-Null }
    catch { $missingError = $_.Exception.Message }
    Assert-True (-not [string]::IsNullOrWhiteSpace($missingError)) 'deployment accepted a source missing an allowlisted dependency'
    Assert-DirectoryUnchanged -Directory $untouchedLive -Expected $beforeMissing
    Assert-True (@(Get-ChildItem -LiteralPath $untouchedLive -Force).Count -eq 1) 'missing-source rejection left a directory or transaction artifact'
    Assert-True (@(Get-ChildItem -LiteralPath $untouchedDesktop -Force).Count -eq 0) 'missing-source rejection changed DesktopPath'

    $overlapLive = Join-Path $testRoot 'overlap live'
    New-Item -ItemType Directory -Path $overlapLive -Force | Out-Null
    Write-TestBytes -Path (Join-Path $overlapLive 'sentinel.bin') -Bytes ([byte[]](2,4,6,8))
    $beforeOverlap = @{ 'sentinel.bin' = Get-BytesHex -Path (Join-Path $overlapLive 'sentinel.bin') }
    $overlapError = $null
    try { & $deployScript -SourceRoot $sourceRoot -LiveRoot $overlapLive -DesktopPath $overlapLive -SkipLiveActions | Out-Null }
    catch { $overlapError = $_.Exception.Message }
    Assert-True (-not [string]::IsNullOrWhiteSpace($overlapError)) 'deployment accepted overlapping LiveRoot and DesktopPath'
    Assert-DirectoryUnchanged -Directory $overlapLive -Expected $beforeOverlap

    $nestedLive = Join-Path $testRoot 'nested overlap live'
    $nestedDesktop = Join-Path $nestedLive 'Desktop child'
    New-Item -ItemType Directory -Path $nestedDesktop -Force | Out-Null
    Write-TestBytes -Path (Join-Path $nestedLive 'sentinel.bin') -Bytes ([byte[]](9,9,9))
    $nestedError = $null
    try { & $deployScript -SourceRoot $sourceRoot -LiveRoot $nestedLive -DesktopPath $nestedDesktop -SkipLiveActions | Out-Null }
    catch { $nestedError = $_.Exception.Message }
    Assert-True (-not [string]::IsNullOrWhiteSpace($nestedError)) 'deployment accepted a DesktopPath nested inside LiveRoot'
    Assert-True (@(Get-ChildItem -LiteralPath $nestedLive -Force).Count -eq 2) 'nested overlap rejection wrote into LiveRoot'

    $rootSourceError = $null
    try { & $deployScript -SourceRoot ([System.IO.Path]::GetPathRoot($testRoot)) -LiveRoot $overlapLive -DesktopPath $desktopRoot -SkipLiveActions | Out-Null }
    catch { $rootSourceError = $_.Exception.Message }
    Assert-True ($rootSourceError -match 'filesystem root') 'deployment accepted a filesystem root as a trusted directory'

    $junctionPhysical = Join-Path $testRoot 'physical ancestor targets'
    $junctionAlias = Join-Path $testRoot 'ancestor junction alias'
    $junctionAvailable = $true
    New-Item -ItemType Directory -Path $junctionPhysical -Force | Out-Null
    try {
        New-Item -ItemType Junction -Path $junctionAlias -Target $junctionPhysical -ErrorAction Stop | Out-Null
        $testJunctions.Add($junctionAlias)
    }
    catch {
        $junctionAvailable = $false
        Write-Output 'SKIP: junction unavailable for ancestor-root safety cases'
    }
    if ($junctionAvailable) {
        $junctionSourcePhysical = Join-Path $junctionPhysical 'source child'
        $junctionLivePhysical = Join-Path $junctionPhysical 'live child'
        $junctionDesktopPhysical = Join-Path $junctionPhysical 'Desktop child'
        Copy-DeploymentSource -Destination $junctionSourcePhysical
        New-Item -ItemType Directory -Path $junctionLivePhysical,$junctionDesktopPhysical -Force | Out-Null

        $ancestorCases = @(
            [pscustomobject]@{Name='SourceRoot'; Source=(Join-Path $junctionAlias 'source child'); Live=(Join-Path $testRoot 'ancestor source live'); Desktop=(Join-Path $testRoot 'ancestor source Desktop')},
            [pscustomobject]@{Name='LiveRoot'; Source=$sourceRoot; Live=(Join-Path $junctionAlias 'live child'); Desktop=(Join-Path $testRoot 'ancestor live Desktop')},
            [pscustomobject]@{Name='DesktopPath'; Source=$sourceRoot; Live=(Join-Path $testRoot 'ancestor Desktop live'); Desktop=(Join-Path $junctionAlias 'Desktop child')}
        )
        foreach ($case in $ancestorCases) {
            New-Item -ItemType Directory -Path $case.Live,$case.Desktop -Force | Out-Null
            Write-TestBytes -Path (Join-Path $case.Live 'sentinel.bin') -Bytes ([byte[]](8,6,7,5,3,0,9))
            $ancestorBefore = @{ 'sentinel.bin' = Get-BytesHex -Path (Join-Path $case.Live 'sentinel.bin') }
            $ancestorError = $null
            try { & $deployScript -SourceRoot $case.Source -LiveRoot $case.Live -DesktopPath $case.Desktop -SkipLiveActions | Out-Null }
            catch { $ancestorError = $_.Exception.Message }
            Assert-True ($ancestorError -match 'reparse') "deployment accepted $($case.Name) beneath an ancestor junction"
            Assert-DirectoryUnchanged -Directory $case.Live -Expected $ancestorBefore
        }
    }

    $shortAliasDirectory = Join-Path $testRoot 'physical alias directory with long name'
    New-Item -ItemType Directory -Path $shortAliasDirectory -Force | Out-Null
    Write-TestBytes -Path (Join-Path $shortAliasDirectory 'sentinel.bin') -Bytes ([byte[]](1,6,1,8))
    $shortAlias = Get-TestShortPath -Path $shortAliasDirectory
    if ([string]::IsNullOrWhiteSpace($shortAlias) -or $shortAlias.Equals($shortAliasDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-Output 'SKIP: distinct 8.3 alias unavailable'
    }
    else {
        $aliasError = $null
        try { & $deployScript -SourceRoot $sourceRoot -LiveRoot $shortAliasDirectory -DesktopPath $shortAlias -SkipLiveActions | Out-Null }
        catch { $aliasError = $_.Exception.Message }
        Assert-True (-not [string]::IsNullOrWhiteSpace($aliasError)) 'deployment accepted two aliases for the same physical directory'
        Assert-True ((@(Get-ChildItem -LiteralPath $shortAliasDirectory -Force).Name -join ',') -eq 'sentinel.bin') 'same-physical alias rejection wrote into LiveRoot'

        $shortNestedChild = Join-Path $shortAliasDirectory 'nested child with long name'
        New-Item -ItemType Directory -Path $shortNestedChild -Force | Out-Null
        $shortNestedAlias = Get-TestShortPath -Path $shortNestedChild
        if ([string]::IsNullOrWhiteSpace($shortNestedAlias) -or $shortNestedAlias.Equals($shortNestedChild, [System.StringComparison]::OrdinalIgnoreCase)) {
            Write-Output 'SKIP: distinct nested 8.3 alias unavailable'
        }
        else {
            $nestedAliasError = $null
            try { & $deployScript -SourceRoot $sourceRoot -LiveRoot $shortAliasDirectory -DesktopPath $shortNestedAlias -SkipLiveActions | Out-Null }
            catch { $nestedAliasError = $_.Exception.Message }
            Assert-True (-not [string]::IsNullOrWhiteSpace($nestedAliasError)) 'deployment accepted a physical child represented through an 8.3 alias'
            Assert-True (-not (Test-Path -LiteralPath (Join-Path $shortAliasDirectory '.codex-discord-backups'))) 'nested physical alias rejection wrote a backup directory'
        }
    }

    $rollbackLive = Join-Path $testRoot 'rollback live'
    $rollbackDesktop = Join-Path $testRoot 'rollback Desktop'
    New-Item -ItemType Directory -Path $rollbackLive,$rollbackDesktop -Force | Out-Null
    Write-TestBytes -Path (Join-Path $rollbackLive 'discord-bridge.mjs') -Bytes ([byte[]](9,8,7,6))
    Write-TestBytes -Path (Join-Path $rollbackLive 'discord-bridge-lib.mjs') -Bytes ([byte[]](5,4,3,2))
    Write-TestBytes -Path (Join-Path $rollbackLive 'config.json') -Bytes ([byte[]](42,0,42))
    $rollbackBefore = @{
        'discord-bridge.mjs' = Get-BytesHex -Path (Join-Path $rollbackLive 'discord-bridge.mjs')
        'discord-bridge-lib.mjs' = Get-BytesHex -Path (Join-Path $rollbackLive 'discord-bridge-lib.mjs')
        'config.json' = Get-BytesHex -Path (Join-Path $rollbackLive 'config.json')
    }
    $rollbackError = $null
    $rollbackOutput = [System.Collections.Generic.List[string]]::new()
    try { & $deployScript -SourceRoot $sourceRoot -LiveRoot $rollbackLive -DesktopPath $rollbackDesktop -SkipLiveActions -FailureInjectionStep 'after-third-commit' | ForEach-Object { $rollbackOutput.Add([string]$_) } }
    catch { $rollbackError = $_.Exception.Message }
    Assert-True ($rollbackError -eq 'injected-deploy-failure:after-third-commit') 'deployment did not reach deterministic transactional failure injection'
    foreach ($name in $rollbackBefore.Keys) {
        Assert-True ((Get-BytesHex -Path (Join-Path $rollbackLive $name)) -ceq $rollbackBefore[$name]) "rollback did not restore exact bytes: $name"
    }
    foreach ($relativePath in $deployedFiles) {
        if (-not $rollbackBefore.ContainsKey($relativePath)) {
            Assert-True (-not (Test-Path -LiteralPath (Join-Path $rollbackLive $relativePath) -PathType Leaf)) "rollback left a newly deployed file: $relativePath"
        }
    }
    $rollbackBackups = @(Get-ChildItem -LiteralPath (Join-Path $rollbackLive '.codex-discord-backups') -Directory)
    Assert-True ($rollbackBackups.Count -eq 1) 'failed deployment did not retain its recovery backup'
    Assert-True (Test-Path -LiteralPath (Join-Path $rollbackBackups[0].FullName 'discord-bridge.mjs') -PathType Leaf) 'failed deployment backup cannot restore the old bridge'
    Assert-True (($rollbackOutput -join "`n") -match [regex]::Escape($rollbackBackups[0].FullName)) 'failed deployment did not report its recoverable backup before commit'
    Assert-True (@(Get-ChildItem -LiteralPath $rollbackLive -Recurse -Force | Where-Object { $_.Name -match '(?i)\.stage$|\.commit$|\.discard$|\.rollback$' }).Count -eq 0) 'failed deployment left transaction artifacts'

    $casSource = Join-Path $testRoot 'identity and CAS source'
    Install-IsolatedDeploySource -Destination $casSource

    $backupSwapLive = Join-Path $testRoot 'backup identity live'
    $backupSwapDesktop = Join-Path $testRoot 'backup identity Desktop'
    $backupSwapOutside = Join-Path $testRoot 'backup identity outside'
    New-Item -ItemType Directory -Path $backupSwapLive,$backupSwapDesktop,$backupSwapOutside -Force | Out-Null
    Write-TestBytes -Path (Join-Path $backupSwapLive 'discord-bridge.mjs') -Bytes ([byte[]](7,7,1,1))
    Write-TestBytes -Path (Join-Path $backupSwapOutside 'outside-sentinel.bin') -Bytes ([byte[]](9,9,8,8))
    $backupSwapOldHash = Get-BytesHex -Path (Join-Path $backupSwapLive 'discord-bridge.mjs')
    $backupSwapOutsideHash = Get-BytesHex -Path (Join-Path $backupSwapOutside 'outside-sentinel.bin')
    $backupRootSwapHook = {
        param($context)
        Move-Item -LiteralPath $context.Path -Destination ($context.Path + '.original')
        New-Item -ItemType Junction -Path $context.Path -Target $backupSwapOutside | Out-Null
        $testJunctions.Add($context.Path)
    }.GetNewClosure()
    $backupSwapError = $null
    try { & $deployScript -SourceRoot $casSource -LiveRoot $backupSwapLive -DesktopPath $backupSwapDesktop -SkipLiveActions -TestHooks @{AfterBackupRootCreated=$backupRootSwapHook} 3>&1 | Out-Null }
    catch { $backupSwapError = $_.Exception.Message }
    Assert-True (-not [string]::IsNullOrWhiteSpace($backupSwapError)) 'deployment accepted a replaced backup root identity'
    Assert-True ((Get-BytesHex -Path (Join-Path $backupSwapLive 'discord-bridge.mjs')) -ceq $backupSwapOldHash) 'backup root replacement reached a live file commit'
    Assert-True ((Get-BytesHex -Path (Join-Path $backupSwapOutside 'outside-sentinel.bin')) -ceq $backupSwapOutsideHash) 'backup root replacement wrote outside LiveRoot'

    foreach ($casWindow in @('before-commit','between-precheck','absent-race')) {
        $casLive = Join-Path $testRoot ("CAS $casWindow live")
        $casDesktop = Join-Path $testRoot ("CAS $casWindow Desktop")
        New-Item -ItemType Directory -Path $casLive,$casDesktop -Force | Out-Null
        $casDestination = Join-Path $casLive 'discord-bridge.mjs'
        if ($casWindow -ne 'absent-race') { Write-TestBytes -Path $casDestination -Bytes ([byte[]](1,2,1,2)) }
        $thirdPartyBytes = [byte[]](203,17,203,17)
        $hookName = if ($casWindow -eq 'before-commit') { 'BeforeCommit' } else { 'BetweenPrecheckAndReplace' }
        $casChanged = $false
        $casHook = {
            param($record)
            if (-not $casChanged -and $record.RelativePath -eq 'discord-bridge.mjs') {
                $casChanged = $true
                Write-TestBytes -Path $record.DestinationPath -Bytes $thirdPartyBytes
            }
        }.GetNewClosure()
        $casError = $null
        try { & $deployScript -SourceRoot $casSource -LiveRoot $casLive -DesktopPath $casDesktop -SkipLiveActions -TestHooks @{$hookName=$casHook} 3>&1 | Out-Null }
        catch { $casError = $_.Exception.Message }
        Assert-True (-not [string]::IsNullOrWhiteSpace($casError)) "deployment ignored concurrent destination bytes at $casWindow"
        $casActualHex = Get-BytesHex -Path $casDestination
        $casExpectedHex = [Convert]::ToHexString($thirdPartyBytes)
        Assert-True ($casActualHex -ceq $casExpectedHex) "deployment overwrote concurrent destination bytes at $casWindow (expected=$casExpectedHex actual=$casActualHex error=$casError)"
    }

    $rollbackCasLive = Join-Path $testRoot 'rollback destination CAS live'
    $rollbackCasDesktop = Join-Path $testRoot 'rollback destination CAS Desktop'
    New-Item -ItemType Directory -Path $rollbackCasLive,$rollbackCasDesktop -Force | Out-Null
    Write-TestBytes -Path (Join-Path $rollbackCasLive 'discord-bridge.mjs') -Bytes ([byte[]](8,1,8,1))
    $rollbackThirdParty = [byte[]](222,173,190,239)
    $rollbackCasHook = {
        param($context)
        $bridgeRecord = @($context.Records | Where-Object { $_.RelativePath -eq 'discord-bridge.mjs' }) | Select-Object -First 1
        Write-TestBytes -Path $bridgeRecord.DestinationPath -Bytes $rollbackThirdParty
    }.GetNewClosure()
    $rollbackCasError = $null
    try { & $deployScript -SourceRoot $casSource -LiveRoot $rollbackCasLive -DesktopPath $rollbackCasDesktop -SkipLiveActions -FailureInjectionStep 'after-third-commit' -TestHooks @{BeforeRollback=$rollbackCasHook} 3>&1 | Out-Null }
    catch { $rollbackCasError = $_.Exception.Message }
    Assert-True ($rollbackCasError -match 'rollback is incomplete') 'concurrent rollback bytes did not produce a safe incomplete-rollback result'
    Assert-True ((Get-BytesHex -Path (Join-Path $rollbackCasLive 'discord-bridge.mjs')) -ceq [Convert]::ToHexString($rollbackThirdParty)) 'rollback overwrote concurrent destination bytes'

    $rollbackAtomicLive = Join-Path $testRoot 'rollback atomic CAS live'
    $rollbackAtomicDesktop = Join-Path $testRoot 'rollback atomic CAS Desktop'
    New-Item -ItemType Directory -Path $rollbackAtomicLive,$rollbackAtomicDesktop -Force | Out-Null
    Write-TestBytes -Path (Join-Path $rollbackAtomicLive 'discord-bridge.mjs') -Bytes ([byte[]](8,2,8,2))
    $rollbackAtomicThirdParty = [byte[]](186,173,240,13)
    $rollbackAtomicChanged = $false
    $rollbackAtomicHook = {
        param($record)
        if (-not $rollbackAtomicChanged -and $record.RelativePath -eq 'discord-bridge.mjs') {
            $rollbackAtomicChanged = $true
            Write-TestBytes -Path $record.DestinationPath -Bytes $rollbackAtomicThirdParty
        }
    }.GetNewClosure()
    $rollbackAtomicError = $null
    try { & $deployScript -SourceRoot $casSource -LiveRoot $rollbackAtomicLive -DesktopPath $rollbackAtomicDesktop -SkipLiveActions -FailureInjectionStep 'after-third-commit' -TestHooks @{BetweenRollbackPrecheckAndReplace=$rollbackAtomicHook} 3>&1 | Out-Null }
    catch { $rollbackAtomicError = $_.Exception.Message }
    Assert-True ($rollbackAtomicError -match 'rollback is incomplete') 'atomic rollback race did not produce a safe incomplete-rollback result'
    Assert-True ((Get-BytesHex -Path (Join-Path $rollbackAtomicLive 'discord-bridge.mjs')) -ceq [Convert]::ToHexString($rollbackAtomicThirdParty)) 'atomic rollback race overwrote concurrent destination bytes'

    foreach ($rootSwapWindow in @('commit','rollback')) {
        $rootSwapLive = Join-Path $testRoot ("root swap $rootSwapWindow live")
        $rootSwapDesktop = Join-Path $testRoot ("root swap $rootSwapWindow Desktop")
        New-Item -ItemType Directory -Path $rootSwapLive,$rootSwapDesktop -Force | Out-Null
        Write-TestBytes -Path (Join-Path $rootSwapLive 'discord-bridge.mjs') -Bytes ([byte[]](6,2,6,2))
        $replacementSentinel = [byte[]](5,5,5,5)
        $rootSwapped = $false
        $rootSwapHook = {
            param($context)
            if ($rootSwapped) { return }
            $rootSwapped = $true
            Move-Item -LiteralPath $rootSwapLive -Destination ($rootSwapLive + '.original')
            New-Item -ItemType Directory -Path $rootSwapLive | Out-Null
            Write-TestBytes -Path (Join-Path $rootSwapLive 'replacement-sentinel.bin') -Bytes $replacementSentinel
        }.GetNewClosure()
        $rootHooks = if ($rootSwapWindow -eq 'commit') { @{BeforeCommit=$rootSwapHook} } else { @{BeforeRollback=$rootSwapHook} }
        $rootSwapError = $null
        try { & $deployScript -SourceRoot $casSource -LiveRoot $rootSwapLive -DesktopPath $rootSwapDesktop -SkipLiveActions -FailureInjectionStep $(if($rootSwapWindow -eq 'rollback'){'after-third-commit'}else{'none'}) -TestHooks $rootHooks 3>&1 | Out-Null }
        catch { $rootSwapError = $_.Exception.Message }
        Assert-True (-not [string]::IsNullOrWhiteSpace($rootSwapError)) "deployment ignored a LiveRoot replacement before $rootSwapWindow"
        Assert-True ((Get-BytesHex -Path (Join-Path $rootSwapLive 'replacement-sentinel.bin')) -ceq [Convert]::ToHexString($replacementSentinel)) "deployment changed replacement LiveRoot bytes before $rootSwapWindow"
    }

    $cleanupSource = Join-Path $testRoot 'cleanup injection source'
    Install-IsolatedDeploySource -Destination $cleanupSource
    $cleanupSuccessLive = Join-Path $testRoot 'cleanup success live'
    $cleanupSuccessDesktop = Join-Path $testRoot 'cleanup success Desktop'
    New-Item -ItemType Directory -Path $cleanupSuccessLive,$cleanupSuccessDesktop -Force | Out-Null
    $cleanupSuccessError = $null
    $cleanupSuccessOutput = [System.Collections.Generic.List[string]]::new()
    try {
        & $deployScript -SourceRoot $cleanupSource -LiveRoot $cleanupSuccessLive -DesktopPath $cleanupSuccessDesktop -SkipLiveActions -InjectCleanupFailure 3>&1 |
            ForEach-Object { $cleanupSuccessOutput.Add([string]$_) }
    }
    catch { $cleanupSuccessError = $_.Exception.Message }
    Assert-True ([string]::IsNullOrWhiteSpace($cleanupSuccessError)) 'stage cleanup failure falsely reported a committed deployment as failed'
    Assert-True (($cleanupSuccessOutput -join "`n") -match 'deployment-stage-cleanup-failed') 'successful deployment cleanup failure omitted its fixed warning category'
    Assert-True (Test-Path -LiteralPath (Join-Path $cleanupSuccessLive 'discord-bridge.mjs') -PathType Leaf) 'cleanup failure undid a committed deployment'
    Assert-True (@(Get-ChildItem -LiteralPath $cleanupSuccessLive -Directory -Force | Where-Object { $_.Name -like '.codex-discord-deploy.*.stage' }).Count -eq 1) 'cleanup failure did not safely retain its stage'

    $cleanupFailureLive = Join-Path $testRoot 'cleanup primary failure live'
    $cleanupFailureDesktop = Join-Path $testRoot 'cleanup primary failure Desktop'
    New-Item -ItemType Directory -Path $cleanupFailureLive,$cleanupFailureDesktop -Force | Out-Null
    Write-TestBytes -Path (Join-Path $cleanupFailureLive 'discord-bridge.mjs') -Bytes ([byte[]](44,55,66))
    $cleanupOldHash = Get-BytesHex -Path (Join-Path $cleanupFailureLive 'discord-bridge.mjs')
    $cleanupPrimaryError = $null
    $cleanupFailureOutput = [System.Collections.Generic.List[string]]::new()
    try {
        & $deployScript -SourceRoot $cleanupSource -LiveRoot $cleanupFailureLive -DesktopPath $cleanupFailureDesktop -SkipLiveActions -FailureInjectionStep 'after-third-commit' -InjectCleanupFailure 3>&1 |
            ForEach-Object { $cleanupFailureOutput.Add([string]$_) }
    }
    catch { $cleanupPrimaryError = $_.Exception.Message }
    Assert-True ($cleanupPrimaryError -eq 'injected-deploy-failure:after-third-commit') 'stage cleanup failure replaced the primary deployment error'
    Assert-True (($cleanupFailureOutput -join "`n") -match 'deployment-stage-cleanup-failed') 'failed deployment cleanup failure omitted its fixed warning category'
    Assert-True ((Get-BytesHex -Path (Join-Path $cleanupFailureLive 'discord-bridge.mjs')) -ceq $cleanupOldHash) 'cleanup failure prevented the primary transaction rollback'
    Assert-True (@(Get-ChildItem -LiteralPath $cleanupFailureLive -Directory -Force | Where-Object { $_.Name -like '.codex-discord-deploy.*.stage' }).Count -eq 1) 'primary failure cleanup did not retain its stage for safe retry'

    $stageSwapSource = Join-Path $testRoot 'stage identity source'
    Install-IsolatedDeploySource -Destination $stageSwapSource
    $stageSwapLive = Join-Path $testRoot 'stage identity live'
    $stageSwapDesktop = Join-Path $testRoot 'stage identity Desktop'
    New-Item -ItemType Directory -Path $stageSwapLive,$stageSwapDesktop -Force | Out-Null
    Write-TestBytes -Path (Join-Path $stageSwapLive 'sentinel.bin') -Bytes ([byte[]](17,18,19))
    $stageSwapSentinelHash = Get-BytesHex -Path (Join-Path $stageSwapLive 'sentinel.bin')
    $env:CODEX_DEPLOY_TEST_REPLACE_STAGE_AFTER_BUILD = '1'
    $stageSwapError = $null
    try { & $deployScript -SourceRoot $stageSwapSource -LiveRoot $stageSwapLive -DesktopPath $stageSwapDesktop -SkipLiveActions 3>&1 | Out-Null }
    catch { $stageSwapError = $_.Exception.Message }
    finally { Remove-Item Env:CODEX_DEPLOY_TEST_REPLACE_STAGE_AFTER_BUILD -ErrorAction SilentlyContinue }
    Assert-True ($stageSwapError -match 'stage physical identity changed') 'deployment did not reject a stage replaced before backup and commit'
    Assert-True ((Get-BytesHex -Path (Join-Path $stageSwapLive 'sentinel.bin')) -ceq $stageSwapSentinelHash) 'stage replacement rejection changed preexisting live bytes'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $stageSwapLive 'discord-bridge.mjs') -PathType Leaf)) 'stage replacement reached the file commit window'
    Assert-True (@(Get-ChildItem -LiteralPath $stageSwapLive -Directory -Force | Where-Object { $_.Name -like '.codex-discord-deploy.*.stage' }).Count -eq 1) 'replacement stage was recursively deleted instead of retained'

    $cleanupSwapSource = Join-Path $testRoot 'cleanup identity source'
    Install-IsolatedDeploySource -Destination $cleanupSwapSource
    $cleanupSwapLive = Join-Path $testRoot 'cleanup identity live'
    $cleanupSwapDesktop = Join-Path $testRoot 'cleanup identity Desktop'
    New-Item -ItemType Directory -Path $cleanupSwapLive,$cleanupSwapDesktop -Force | Out-Null
    $cleanupSwapState = Join-Path $testRoot 'cleanup identity state.json'
    $cleanupSwapActions = Join-Path $testRoot 'cleanup identity actions.txt'
    $cleanupSwapGuardCount = Join-Path $testRoot 'cleanup identity guard count.txt'
    [System.IO.File]::WriteAllText($cleanupSwapState, '{"taskInstalled":false,"taskRunning":false,"running":false,"autoStartEnabled":false,"mode":"unknown"}', [System.Text.UTF8Encoding]::new($false))
    $env:CODEX_DEPLOY_TEST_STATE_PATH = $cleanupSwapState
    $env:CODEX_DEPLOY_TEST_ACTION_PATH = $cleanupSwapActions
    $env:CODEX_DEPLOY_TEST_REPLACE_STAGE_ON_FINAL_GUARD = '1'
    $env:CODEX_DEPLOY_TEST_GUARD_COUNT_PATH = $cleanupSwapGuardCount
    $cleanupSwapError = $null
    $cleanupSwapOutput = [System.Collections.Generic.List[string]]::new()
    try {
        & $deployScript -SourceRoot $cleanupSwapSource -LiveRoot $cleanupSwapLive -DesktopPath $cleanupSwapDesktop 3>&1 |
            ForEach-Object { $cleanupSwapOutput.Add([string]$_) }
    }
    catch { $cleanupSwapError = $_.Exception.Message }
    finally {
        Remove-Item Env:CODEX_DEPLOY_TEST_STATE_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_ACTION_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_REPLACE_STAGE_ON_FINAL_GUARD -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_GUARD_COUNT_PATH -ErrorAction SilentlyContinue
    }
    Assert-True ([string]::IsNullOrWhiteSpace($cleanupSwapError)) "replacement-stage cleanup falsely failed a committed deployment: $cleanupSwapError"
    Assert-True (($cleanupSwapOutput -join "`n") -match 'deployment-stage-cleanup-failed') 'replacement-stage cleanup omitted its fixed warning'
    $retainedReplacementStages = @(Get-ChildItem -LiteralPath $cleanupSwapLive -Directory -Force | Where-Object { $_.Name -like '.codex-discord-deploy.*.stage' })
    Assert-True ($retainedReplacementStages.Count -eq 1) 'replacement stage was not retained for safe manual review'
    Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $retainedReplacementStages[0].FullName 'replacement-sentinel.txt')) -eq 'replacement-must-survive') 'cleanup recursively deleted or changed an untrusted replacement stage'

    $skipSource = Join-Path $testRoot 'instrumented source'
    Copy-DeploymentSource -Destination $skipSource
    $liveActionMarker = Join-Path $testRoot 'live actions must not run.txt'
    $escapedMarker = $liveActionMarker.Replace("'", "''")
    foreach ($scriptName in @(
        'codex-control.ps1','install-control-app.ps1','install-discord-bridge-task.ps1','start-discord-bridge.ps1',
        'activate-discord-bot.ps1','save-discord-token.ps1','setup.ps1','repair-notify.ps1','watch-notify.ps1'
    )) {
        [System.IO.File]::WriteAllText((Join-Path $skipSource $scriptName), "Add-Content -LiteralPath '$escapedMarker' -Value '$scriptName'`n", [System.Text.UTF8Encoding]::new($false))
    }
    foreach ($secretName in @('config.json','discord-token.dpapi','arbitrary-private-key.bin','discord-inbox-state.corrupt-sample.json','private.log')) {
        Write-TestBytes -Path (Join-Path $skipSource $secretName) -Bytes ([byte[]](201,202,203))
    }
    [System.IO.File]::WriteAllText((Join-Path $skipSource 'discord-bridge.mjs'), "await import('node:fs').then(({appendFileSync}) => appendFileSync(String.raw``$liveActionMarker``, 'discord'))`n", [System.Text.UTF8Encoding]::new($false))
    $skipLive = Join-Path $testRoot 'skip live actions destination'
    $skipDesktop = Join-Path $testRoot 'skip Desktop'
    New-Item -ItemType Directory -Path $skipLive,$skipDesktop -Force | Out-Null
    & $deployScript -SourceRoot $skipSource -LiveRoot $skipLive -DesktopPath $skipDesktop -SkipLiveActions | Out-Null
    Assert-True (-not (Test-Path -LiteralPath $liveActionMarker)) 'SkipLiveActions invoked a service, installer, registration, or bridge process'
    Assert-True (Test-Path -LiteralPath (Join-Path $skipLive 'CodexDiscordControl.exe') -PathType Leaf) 'SkipLiveActions skipped the required EXE build'
    foreach ($secretName in @('config.json','discord-token.dpapi','arbitrary-private-key.bin','discord-inbox-state.corrupt-sample.json','private.log')) {
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $skipLive $secretName))) "deployment copied a non-allowlisted source file: $secretName"
    }

    $reparseSource = Join-Path $testRoot 'reparse source'
    Copy-DeploymentSource -Destination $reparseSource
    $outsideControl = Join-Path $testRoot 'outside control source'
    New-Item -ItemType Directory -Path $outsideControl -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'control-app\CodexDiscordControl.cs') -Destination (Join-Path $outsideControl 'CodexDiscordControl.cs')
    Remove-Item -LiteralPath (Join-Path $reparseSource 'control-app') -Recurse -Force
    $sourceChildJunction = Join-Path $reparseSource 'control-app'
    New-Item -ItemType Junction -Path $sourceChildJunction -Target $outsideControl | Out-Null
    $testJunctions.Add($sourceChildJunction)
    $reparseLive = Join-Path $testRoot 'reparse live'
    $reparseDesktop = Join-Path $testRoot 'reparse Desktop'
    New-Item -ItemType Directory -Path $reparseLive,$reparseDesktop -Force | Out-Null
    Write-TestBytes -Path (Join-Path $reparseLive 'sentinel.bin') -Bytes ([byte[]](6,6,6))
    $beforeReparse = @{ 'sentinel.bin' = Get-BytesHex -Path (Join-Path $reparseLive 'sentinel.bin') }
    $reparseError = $null
    try { & $deployScript -SourceRoot $reparseSource -LiveRoot $reparseLive -DesktopPath $reparseDesktop -SkipLiveActions | Out-Null }
    catch { $reparseError = $_.Exception.Message }
    Assert-True (-not [string]::IsNullOrWhiteSpace($reparseError)) 'deployment followed a reparse point outside SourceRoot'
    Assert-DirectoryUnchanged -Directory $reparseLive -Expected $beforeReparse

    $destinationJunctionLive = Join-Path $testRoot 'destination junction live'
    $destinationJunctionDesktop = Join-Path $testRoot 'destination junction Desktop'
    $outsideDestination = Join-Path $testRoot 'outside destination'
    New-Item -ItemType Directory -Path $destinationJunctionLive,$destinationJunctionDesktop,$outsideDestination -Force | Out-Null
    $destinationChildJunction = Join-Path $destinationJunctionLive 'control-app'
    New-Item -ItemType Junction -Path $destinationChildJunction -Target $outsideDestination | Out-Null
    $testJunctions.Add($destinationChildJunction)
    $destinationJunctionError = $null
    try { & $deployScript -SourceRoot $sourceRoot -LiveRoot $destinationJunctionLive -DesktopPath $destinationJunctionDesktop -SkipLiveActions | Out-Null }
    catch { $destinationJunctionError = $_.Exception.Message }
    Assert-True (-not [string]::IsNullOrWhiteSpace($destinationJunctionError)) 'deployment followed a destination reparse point outside LiveRoot'
    Assert-True (@(Get-ChildItem -LiteralPath $outsideDestination -Force).Count -eq 0) 'destination reparse rejection wrote outside LiveRoot'

    # Non-Skip deployment probes through the staged fixed control library even when the old live
    # bundle has no control entrypoint. All actions below are isolated fakes in temporary paths.
    $nonSkipSource = Join-Path $testRoot 'non skip isolated source'
    Install-IsolatedDeploySource -Destination $nonSkipSource

    $guardCases = @(
        [pscustomobject]@{Name='absent'; Initial=@{exists=$false;trusted=$true;enabled=$false;running=$false}; Expected=@('guard:status','probe:status','install:shortcut','register:new','control:new:stop-temporary','probe:status','guard:status')},
        [pscustomobject]@{Name='enabled running auto restart'; Initial=@{exists=$true;trusted=$true;enabled=$true;running=$true;autoRestartWhenEnabled=$true}; Expected=@('guard:status','guard:disable','guard:stop','guard:status','probe:status','install:shortcut','register:new','control:new:stop-temporary','probe:status','guard:status','guard:enable','guard:start','guard:status')},
        [pscustomobject]@{Name='enabled stopped'; Initial=@{exists=$true;trusted=$true;enabled=$true;running=$false}; Expected=@('guard:status','guard:disable','guard:stop','guard:status','probe:status','install:shortcut','register:new','control:new:stop-temporary','probe:status','guard:status','guard:status','guard:enable','guard:status')},
        [pscustomobject]@{Name='disabled running'; Initial=@{exists=$true;trusted=$true;enabled=$false;running=$true}; Expected=@('guard:status','guard:disable','guard:stop','guard:status','probe:status','install:shortcut','register:new','control:new:stop-temporary','probe:status','guard:status','guard:enable','guard:start','guard:disable','guard:status')},
        [pscustomobject]@{Name='disabled stopped'; Initial=@{exists=$true;trusted=$true;enabled=$false;running=$false}; Expected=@('guard:status','guard:disable','guard:stop','guard:status','probe:status','install:shortcut','register:new','control:new:stop-temporary','probe:status','guard:status','guard:status')}
    )
    foreach ($case in $guardCases) {
        $caseLive = Join-Path $testRoot ("guard $($case.Name) live")
        $caseDesktop = Join-Path $testRoot ("guard $($case.Name) Desktop")
        $caseState = Join-Path $testRoot ("guard $($case.Name) bridge.json")
        $caseGuard = Join-Path $testRoot ("guard $($case.Name) state.json")
        $caseActions = Join-Path $testRoot ("guard $($case.Name) actions.txt")
        New-Item -ItemType Directory -Path $caseLive,$caseDesktop -Force | Out-Null
        [System.IO.File]::WriteAllText($caseState, '{"taskInstalled":true,"taskRunning":false,"running":false,"autoStartEnabled":false,"mode":"unknown"}', [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText($caseGuard, ($case.Initial | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
        $env:CODEX_DEPLOY_TEST_STATE_PATH = $caseState
        $env:CODEX_DEPLOY_TEST_GUARD_STATE_PATH = $caseGuard
        $env:CODEX_DEPLOY_TEST_ACTION_PATH = $caseActions
        try { & $deployScript -SourceRoot $nonSkipSource -LiveRoot $caseLive -DesktopPath $caseDesktop | Out-Null }
        finally {
            Remove-Item Env:CODEX_DEPLOY_TEST_STATE_PATH -ErrorAction SilentlyContinue
            Remove-Item Env:CODEX_DEPLOY_TEST_GUARD_STATE_PATH -ErrorAction SilentlyContinue
            Remove-Item Env:CODEX_DEPLOY_TEST_ACTION_PATH -ErrorAction SilentlyContinue
        }
        $caseFinal = Get-Content -Raw -LiteralPath $caseGuard | ConvertFrom-Json
        Assert-True (
            $caseFinal.exists -eq $case.Initial.exists -and $caseFinal.trusted -eq $case.Initial.trusted -and
            $caseFinal.enabled -eq $case.Initial.enabled -and $caseFinal.running -eq $case.Initial.running
        ) "guard $($case.Name) did not preserve exact existence/enabled/running state"
        Assert-True ((@(Get-Content -LiteralPath $caseActions) -join ',') -eq ($case.Expected -join ',')) "guard $($case.Name) was not stopped first and restored last"
    }

    $untrustedGuardLive = Join-Path $testRoot 'untrusted guard live'
    $untrustedGuardDesktop = Join-Path $testRoot 'untrusted guard Desktop'
    $untrustedGuardState = Join-Path $testRoot 'untrusted guard bridge.json'
    $untrustedGuardTask = Join-Path $testRoot 'untrusted guard state.json'
    $untrustedGuardActions = Join-Path $testRoot 'untrusted guard actions.txt'
    New-Item -ItemType Directory -Path $untrustedGuardLive,$untrustedGuardDesktop -Force | Out-Null
    Write-TestBytes -Path (Join-Path $untrustedGuardLive 'sentinel.bin') -Bytes ([byte[]](2,7,1,8))
    [System.IO.File]::WriteAllText($untrustedGuardState, '{"taskInstalled":true,"taskRunning":false,"running":false,"autoStartEnabled":false,"mode":"unknown"}', [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($untrustedGuardTask, '{"exists":true,"trusted":false,"enabled":true,"running":true}', [System.Text.UTF8Encoding]::new($false))
    $env:CODEX_DEPLOY_TEST_STATE_PATH = $untrustedGuardState
    $env:CODEX_DEPLOY_TEST_GUARD_STATE_PATH = $untrustedGuardTask
    $env:CODEX_DEPLOY_TEST_ACTION_PATH = $untrustedGuardActions
    $untrustedGuardError = $null
    try { & $deployScript -SourceRoot $nonSkipSource -LiveRoot $untrustedGuardLive -DesktopPath $untrustedGuardDesktop | Out-Null }
    catch { $untrustedGuardError = $_.Exception.Message }
    finally {
        Remove-Item Env:CODEX_DEPLOY_TEST_STATE_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_GUARD_STATE_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_ACTION_PATH -ErrorAction SilentlyContinue
    }
    Assert-True ($untrustedGuardError -eq 'notification guard identity is untrusted') 'deployment accepted or leaked details for an untrusted notification guard task'
    Assert-True ((@(Get-ChildItem -LiteralPath $untrustedGuardLive -Force).Name -join ',') -eq 'sentinel.bin') 'untrusted guard rejection wrote into LiveRoot before failing'
    Assert-True (@(Get-ChildItem -LiteralPath $untrustedGuardDesktop -Force).Count -eq 0) 'untrusted guard rejection changed DesktopPath'

    $mutatedGuardLive = Join-Path $testRoot 'mutated guard definition live'
    $mutatedGuardDesktop = Join-Path $testRoot 'mutated guard definition Desktop'
    $mutatedGuardBridge = Join-Path $testRoot 'mutated guard definition bridge.json'
    $mutatedGuardTask = Join-Path $testRoot 'mutated guard definition task.json'
    $mutatedGuardActions = Join-Path $testRoot 'mutated guard definition actions.txt'
    New-Item -ItemType Directory -Path $mutatedGuardLive,$mutatedGuardDesktop -Force | Out-Null
    Write-TestBytes -Path (Join-Path $mutatedGuardLive 'sentinel.bin') -Bytes ([byte[]](4,2,4,2))
    [System.IO.File]::WriteAllText($mutatedGuardBridge, '{"taskInstalled":true,"taskRunning":false,"running":false,"autoStartEnabled":false,"mode":"unknown"}', [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($mutatedGuardTask, '{"exists":true,"trusted":true,"enabled":true,"running":true,"definitionHash":"isolated-guard-definition-v1"}', [System.Text.UTF8Encoding]::new($false))
    $env:CODEX_DEPLOY_TEST_STATE_PATH = $mutatedGuardBridge
    $env:CODEX_DEPLOY_TEST_GUARD_STATE_PATH = $mutatedGuardTask
    $env:CODEX_DEPLOY_TEST_ACTION_PATH = $mutatedGuardActions
    $env:CODEX_DEPLOY_TEST_GUARD_MUTATE_DEFINITION_ON_DISABLE = '1'
    $mutatedGuardError = $null
    try { & $deployScript -SourceRoot $nonSkipSource -LiveRoot $mutatedGuardLive -DesktopPath $mutatedGuardDesktop | Out-Null }
    catch { $mutatedGuardError = $_.Exception.Message }
    finally {
        Remove-Item Env:CODEX_DEPLOY_TEST_STATE_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_GUARD_STATE_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_ACTION_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_GUARD_MUTATE_DEFINITION_ON_DISABLE -ErrorAction SilentlyContinue
    }
    Assert-True (-not [string]::IsNullOrWhiteSpace($mutatedGuardError)) 'deployment ignored a Guard definition change during freeze'
    Assert-True ((@(Get-ChildItem -LiteralPath $mutatedGuardLive -Force).Name -join ',') -eq 'sentinel.bin') 'Guard definition change reached a LiveRoot write'

    $partialGuardLive = Join-Path $testRoot 'partial guard stop live'
    $partialGuardDesktop = Join-Path $testRoot 'partial guard stop Desktop'
    $partialGuardState = Join-Path $testRoot 'partial guard bridge.json'
    $partialGuardTask = Join-Path $testRoot 'partial guard state.json'
    $partialGuardActions = Join-Path $testRoot 'partial guard actions.txt'
    New-Item -ItemType Directory -Path $partialGuardLive,$partialGuardDesktop -Force | Out-Null
    Write-TestBytes -Path (Join-Path $partialGuardLive 'sentinel.bin') -Bytes ([byte[]](3,1,4,1,5))
    [System.IO.File]::WriteAllText($partialGuardState, '{"taskInstalled":true,"taskRunning":false,"running":false,"autoStartEnabled":false,"mode":"unknown"}', [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($partialGuardTask, '{"exists":true,"trusted":true,"enabled":true,"running":true}', [System.Text.UTF8Encoding]::new($false))
    $env:CODEX_DEPLOY_TEST_STATE_PATH = $partialGuardState
    $env:CODEX_DEPLOY_TEST_GUARD_STATE_PATH = $partialGuardTask
    $env:CODEX_DEPLOY_TEST_ACTION_PATH = $partialGuardActions
    $env:CODEX_DEPLOY_TEST_GUARD_ACTION_FAIL_AFTER = 'stop'
    $partialGuardError = $null
    try { & $deployScript -SourceRoot $nonSkipSource -LiveRoot $partialGuardLive -DesktopPath $partialGuardDesktop | Out-Null }
    catch { $partialGuardError = $_.Exception.Message }
    finally {
        Remove-Item Env:CODEX_DEPLOY_TEST_STATE_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_GUARD_STATE_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_ACTION_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_GUARD_ACTION_FAIL_AFTER -ErrorAction SilentlyContinue
    }
    $partialGuardFinal = Get-Content -Raw -LiteralPath $partialGuardTask | ConvertFrom-Json
    Assert-True ($partialGuardError -eq 'service probe failed: guard-stop') 'partial guard stop replaced or hid its primary failure'
    Assert-True ($partialGuardFinal.exists -and $partialGuardFinal.enabled -and $partialGuardFinal.running) 'partial guard stop failure did not restore the exact prior guard state'
    Assert-True ((@(Get-ChildItem -LiteralPath $partialGuardLive -Force).Name -join ',') -eq 'sentinel.bin') 'partial guard stop wrote LiveRoot before confirmed guard suspension'
    Assert-True ((@(Get-Content -LiteralPath $partialGuardActions) -join ',') -eq 'guard:status,guard:disable,guard:stop,guard:status,guard:enable,guard:start,guard:status') 'partial guard stop recovery did not restore the guard last'

    $serviceCases = @(
        [pscustomobject]@{ Name='scheduled'; Initial=@{taskInstalled=$true;autoStartEnabled=$true;taskRunning=$true;running=$true;mode='scheduled'}; Expected=@('probe:status','probe:stop-temporary','install:shortcut','register:new','control:new:enable-long-term','probe:status'); Installed=$true; TaskRunning=$true; Running=$true; AutoStart=$true; Mode='scheduled' },
        [pscustomobject]@{ Name='enabled stopped'; Initial=@{taskInstalled=$true;autoStartEnabled=$true;taskRunning=$false;running=$false;mode='unknown'}; Expected=@('probe:status','install:shortcut','register:new','control:new:enable-long-term','control:new:stop-temporary','probe:status'); Installed=$true; TaskRunning=$false; Running=$false; AutoStart=$true; Mode='unknown' },
        [pscustomobject]@{ Name='disabled'; Initial=@{taskInstalled=$true;autoStartEnabled=$false;taskRunning=$false;running=$false;mode='unknown'}; Expected=@('probe:status','install:shortcut','register:new','control:new:stop-temporary','probe:status'); Installed=$true; TaskRunning=$false; Running=$false; AutoStart=$false; Mode='unknown' },
        [pscustomobject]@{ Name='temporary'; Initial=@{taskInstalled=$true;autoStartEnabled=$false;taskRunning=$false;running=$true;mode='temporary'}; Expected=@('probe:status','probe:stop-temporary','install:shortcut','register:new','control:new:start-temporary','probe:status'); Installed=$true; TaskRunning=$false; Running=$true; AutoStart=$false; Mode='temporary' },
        [pscustomobject]@{ Name='no task'; Initial=@{taskInstalled=$false;autoStartEnabled=$false;taskRunning=$false;running=$false;mode='unknown'}; Expected=@('probe:status','install:shortcut','register:new','control:new:stop-temporary','probe:status'); Installed=$false; TaskRunning=$false; Running=$false; AutoStart=$false; Mode='unknown' }
    )
    foreach ($case in $serviceCases) {
        $caseLive = Join-Path $testRoot ("non skip $($case.Name) live")
        $caseDesktop = Join-Path $testRoot ("non skip $($case.Name) Desktop")
        $caseState = Join-Path $testRoot ("non skip $($case.Name) state.json")
        $caseActions = Join-Path $testRoot ("non skip $($case.Name) actions.txt")
        New-Item -ItemType Directory -Path $caseLive,$caseDesktop -Force | Out-Null
        [System.IO.File]::WriteAllText($caseState, ($case.Initial | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
        $env:CODEX_DEPLOY_TEST_STATE_PATH = $caseState
        $env:CODEX_DEPLOY_TEST_ACTION_PATH = $caseActions
        try { & $deployScript -SourceRoot $nonSkipSource -LiveRoot $caseLive -DesktopPath $caseDesktop | Out-Null }
        finally {
            Remove-Item Env:CODEX_DEPLOY_TEST_STATE_PATH -ErrorAction SilentlyContinue
            Remove-Item Env:CODEX_DEPLOY_TEST_ACTION_PATH -ErrorAction SilentlyContinue
        }
        $expectedServiceActions = @('guard:status') + @($case.Expected) + @('guard:status')
        Assert-True ((@(Get-Content -LiteralPath $caseActions) -join ',') -eq ($expectedServiceActions -join ',')) "non-Skip $($case.Name) did not preserve the exact service action sequence"
        $caseFinal = Get-Content -Raw -LiteralPath $caseState | ConvertFrom-Json
        Assert-True (
            $caseFinal.taskInstalled -eq $case.Installed -and
            $caseFinal.taskRunning -eq $case.TaskRunning -and
            $caseFinal.running -eq $case.Running -and
            $caseFinal.autoStartEnabled -eq $case.AutoStart -and
            $caseFinal.mode -eq $case.Mode
        ) "non-Skip $($case.Name) changed the exact installed/enabled/running/owner state"
        Assert-True (Test-Path -LiteralPath (Join-Path $caseDesktop '码驿 · CodexRelay 控制台.lnk') -PathType Leaf) "non-Skip $($case.Name) did not install the isolated shortcut"
    }

    # Shortcut creation is an external live mutation too. If the trusted installer writes the
    # link and then fails, the transaction must restore its exact previous bytes.
    $shortcutFailureLive = Join-Path $testRoot 'shortcut partial failure live'
    $shortcutFailureDesktop = Join-Path $testRoot 'shortcut partial failure Desktop'
    $shortcutFailureState = Join-Path $testRoot 'shortcut partial failure state.json'
    $shortcutFailureActions = Join-Path $testRoot 'shortcut partial failure actions.txt'
    New-Item -ItemType Directory -Path $shortcutFailureLive,$shortcutFailureDesktop -Force | Out-Null
    [System.IO.File]::WriteAllText($shortcutFailureState, '{"taskInstalled":true,"taskRunning":false,"running":false,"autoStartEnabled":false,"mode":"unknown"}', [System.Text.UTF8Encoding]::new($false))
    Write-TestBytes -Path (Join-Path $shortcutFailureDesktop '码驿 · CodexRelay 控制台.lnk') -Bytes ([byte[]](41,0,42,255))
    $shortcutFailureBefore = Get-BytesHex -Path (Join-Path $shortcutFailureDesktop '码驿 · CodexRelay 控制台.lnk')
    $env:CODEX_DEPLOY_TEST_STATE_PATH = $shortcutFailureState
    $env:CODEX_DEPLOY_TEST_ACTION_PATH = $shortcutFailureActions
    $env:CODEX_DEPLOY_TEST_FAIL_SHORTCUT_AFTER_WRITE = '1'
    $shortcutFailureError = $null
    try { & $deployScript -SourceRoot $nonSkipSource -LiveRoot $shortcutFailureLive -DesktopPath $shortcutFailureDesktop | Out-Null }
    catch { $shortcutFailureError = $_.Exception.Message }
    finally {
        Remove-Item Env:CODEX_DEPLOY_TEST_STATE_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_ACTION_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_FAIL_SHORTCUT_AFTER_WRITE -ErrorAction SilentlyContinue
    }
    Assert-True ($shortcutFailureError -match 'synthetic-shortcut-failure') "deployment hid the trusted shortcut partial-write failure: $shortcutFailureError"
    Assert-True ((Get-BytesHex -Path (Join-Path $shortcutFailureDesktop '码驿 · CodexRelay 控制台.lnk')) -ceq $shortcutFailureBefore) 'shortcut partial-write failure did not restore the exact previous bytes'

    # Discord bulk registration can reach the Guild before the local process reports failure.
    # Any attempted update must therefore compensate with the restored bridge definitions.
    $registrationFailureLive = Join-Path $testRoot 'registration ambiguous live'
    $registrationFailureDesktop = Join-Path $testRoot 'registration ambiguous Desktop'
    $registrationFailureState = Join-Path $testRoot 'registration ambiguous state.json'
    $registrationFailureActions = Join-Path $testRoot 'registration ambiguous actions.txt'
    New-Item -ItemType Directory -Path $registrationFailureLive,$registrationFailureDesktop -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $registrationFailureLive 'codex-control.ps1'), (Get-IsolatedControlScript -Role old), [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $registrationFailureLive 'discord-bridge.mjs'), (Get-IsolatedBridgeScript -Role old), [System.Text.UTF8Encoding]::new($false))
    $registrationOldBridge = Get-BytesHex -Path (Join-Path $registrationFailureLive 'discord-bridge.mjs')
    [System.IO.File]::WriteAllText($registrationFailureState, '{"taskInstalled":true,"taskRunning":false,"running":false,"autoStartEnabled":false,"mode":"unknown"}', [System.Text.UTF8Encoding]::new($false))
    $env:CODEX_DEPLOY_TEST_STATE_PATH = $registrationFailureState
    $env:CODEX_DEPLOY_TEST_ACTION_PATH = $registrationFailureActions
    $env:CODEX_DEPLOY_TEST_FAIL_REGISTRATION = 'new'
    $registrationFailureError = $null
    try { & $deployScript -SourceRoot $nonSkipSource -LiveRoot $registrationFailureLive -DesktopPath $registrationFailureDesktop | Out-Null }
    catch { $registrationFailureError = $_.Exception.Message }
    finally {
        Remove-Item Env:CODEX_DEPLOY_TEST_STATE_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_ACTION_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_FAIL_REGISTRATION -ErrorAction SilentlyContinue
    }
    Assert-True ($registrationFailureError -eq 'Discord command registration failed') 'deployment hid an ambiguous Discord registration failure'
    Assert-True ((Get-BytesHex -Path (Join-Path $registrationFailureLive 'discord-bridge.mjs')) -ceq $registrationOldBridge) 'ambiguous registration failure did not restore the old bridge file'
    Assert-True ((@(Get-Content -LiteralPath $registrationFailureActions | Where-Object { $_ -like 'register:*' }) -join ',') -eq 'register:new,register:old') 'ambiguous registration failure did not compensate with the restored Guild commands'

    $shortcutCasLive = Join-Path $testRoot 'shortcut rollback CAS live'
    $shortcutCasDesktop = Join-Path $testRoot 'shortcut rollback CAS Desktop'
    $shortcutCasState = Join-Path $testRoot 'shortcut rollback CAS state.json'
    $shortcutCasActions = Join-Path $testRoot 'shortcut rollback CAS actions.txt'
    New-Item -ItemType Directory -Path $shortcutCasLive,$shortcutCasDesktop -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $shortcutCasLive 'codex-control.ps1'), (Get-IsolatedControlScript -Role old), [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $shortcutCasLive 'discord-bridge.mjs'), (Get-IsolatedBridgeScript -Role old), [System.Text.UTF8Encoding]::new($false))
    Write-TestBytes -Path (Join-Path $shortcutCasDesktop '码驿 · CodexRelay 控制台.lnk') -Bytes ([byte[]](71,72,73,74))
    [System.IO.File]::WriteAllText($shortcutCasState, '{"taskInstalled":true,"taskRunning":false,"running":false,"autoStartEnabled":false,"mode":"unknown"}', [System.Text.UTF8Encoding]::new($false))
    $shortcutCasThirdParty = [byte[]](240,13,202,254)
    $shortcutCasChanged = $false
    $shortcutCasHook = {
        param($record)
        if (-not $shortcutCasChanged) {
            $shortcutCasChanged = $true
            Write-TestBytes -Path $record.DestinationPath -Bytes $shortcutCasThirdParty
        }
    }.GetNewClosure()
    $env:CODEX_DEPLOY_TEST_STATE_PATH = $shortcutCasState
    $env:CODEX_DEPLOY_TEST_ACTION_PATH = $shortcutCasActions
    $env:CODEX_DEPLOY_TEST_FAIL_REGISTRATION = 'new'
    $shortcutCasError = $null
    try { & $deployScript -SourceRoot $nonSkipSource -LiveRoot $shortcutCasLive -DesktopPath $shortcutCasDesktop -TestHooks @{BetweenShortcutRollbackPrecheckAndReplace=$shortcutCasHook} 3>&1 | Out-Null }
    catch { $shortcutCasError = $_.Exception.Message }
    finally {
        Remove-Item Env:CODEX_DEPLOY_TEST_STATE_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_ACTION_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_FAIL_REGISTRATION -ErrorAction SilentlyContinue
    }
    Assert-True ($shortcutCasError -match 'rollback is incomplete') 'shortcut rollback CAS race did not report incomplete rollback'
    Assert-True ((Get-BytesHex -Path (Join-Path $shortcutCasDesktop '码驿 · CodexRelay 控制台.lnk')) -ceq [Convert]::ToHexString($shortcutCasThirdParty)) 'shortcut rollback CAS race overwrote concurrent bytes'

    # A service action can start the new bridge and then report failure. The new runtime must be
    # stopped while the new files still exist, before local files and the old service are restored.
    $serviceMutationLive = Join-Path $testRoot 'service post mutation live'
    $serviceMutationDesktop = Join-Path $testRoot 'service post mutation Desktop'
    $serviceMutationState = Join-Path $testRoot 'service post mutation state.json'
    $serviceMutationActions = Join-Path $testRoot 'service post mutation actions.txt'
    New-Item -ItemType Directory -Path $serviceMutationLive,$serviceMutationDesktop -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $serviceMutationLive 'codex-control.ps1'), (Get-IsolatedControlScript -Role old), [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $serviceMutationLive 'discord-bridge.mjs'), (Get-IsolatedBridgeScript -Role old), [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($serviceMutationState, '{"taskInstalled":true,"taskRunning":true,"running":true,"autoStartEnabled":true,"mode":"scheduled"}', [System.Text.UTF8Encoding]::new($false))
    $env:CODEX_DEPLOY_TEST_STATE_PATH = $serviceMutationState
    $env:CODEX_DEPLOY_TEST_ACTION_PATH = $serviceMutationActions
    $env:CODEX_DEPLOY_TEST_FAIL_ACTION_AFTER_MUTATION = 'enable-long-term'
    $serviceMutationError = $null
    try { & $deployScript -SourceRoot $nonSkipSource -LiveRoot $serviceMutationLive -DesktopPath $serviceMutationDesktop | Out-Null }
    catch { $serviceMutationError = $_.Exception.Message }
    finally {
        Remove-Item Env:CODEX_DEPLOY_TEST_STATE_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_ACTION_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_FAIL_ACTION_AFTER_MUTATION -ErrorAction SilentlyContinue
    }
    Assert-True ($serviceMutationError -eq 'control action failed: enable-long-term') 'deployment hid the post-mutation service failure'
    Assert-True ((@(Get-Content -LiteralPath $serviceMutationActions) -join ',') -eq 'guard:status,probe:status,probe:stop-temporary,install:shortcut,register:new,control:new:enable-long-term,probe:stop-temporary,register:old,control:old:enable-long-term,probe:status,guard:status') 'post-mutation service rollback replaced files before stopping the new runtime'
    $serviceMutationFinal = Get-Content -Raw -LiteralPath $serviceMutationState | ConvertFrom-Json
    Assert-True ($serviceMutationFinal.running -eq $true -and $serviceMutationFinal.autoStartEnabled -eq $true -and $serviceMutationFinal.mode -eq 'scheduled') 'post-mutation service rollback did not restore the prior state'

    # A trusted stop action can fail after it has already stopped the bridge. Deployment must still
    # restore the previously enabled/running state, using only an isolated fake backend.
    $partialStopSource = Join-Path $testRoot 'partial stop source'
    Install-IsolatedDeploySource -Destination $partialStopSource
    $partialStopLive = Join-Path $testRoot 'partial stop live'
    $partialStopDesktop = Join-Path $testRoot 'partial stop Desktop'
    New-Item -ItemType Directory -Path $partialStopLive,$partialStopDesktop -Force | Out-Null
    $partialStopState = Join-Path $testRoot 'partial stop state.json'
    $partialStopActions = Join-Path $testRoot 'partial stop actions.txt'
    [System.IO.File]::WriteAllText($partialStopState, '{"taskInstalled":true,"taskRunning":true,"running":true,"autoStartEnabled":true,"mode":"scheduled"}', [System.Text.UTF8Encoding]::new($false))
    $env:CODEX_DEPLOY_TEST_STATE_PATH = $partialStopState
    $env:CODEX_DEPLOY_TEST_ACTION_PATH = $partialStopActions
    $env:CODEX_DEPLOY_TEST_PROBE_STOP_FAIL_AFTER = '1'
    $partialStopError = $null
    try { & $deployScript -SourceRoot $partialStopSource -LiveRoot $partialStopLive -DesktopPath $partialStopDesktop | Out-Null }
    catch { $partialStopError = $_.Exception.Message }
    finally {
        Remove-Item Env:CODEX_DEPLOY_TEST_STATE_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_ACTION_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_PROBE_STOP_FAIL_AFTER -ErrorAction SilentlyContinue
    }
    Assert-True ($partialStopError -eq 'service probe failed: stop-temporary') 'deployment hid or replaced the trusted partial-stop failure'
    $restoredPartialStopState = Get-Content -Raw -LiteralPath $partialStopState | ConvertFrom-Json
    Assert-True ($restoredPartialStopState.running -eq $true -and $restoredPartialStopState.autoStartEnabled -eq $true) 'failed partial stop did not restore the prior running/long-term state'
    Assert-True ((@(Get-Content -LiteralPath $partialStopActions) -join ',') -eq 'guard:status,probe:status,probe:stop-temporary,probe:status,probe:enable-long-term,probe:status,guard:status') 'first-upgrade partial-stop recovery did not use the staged trusted probe'

    # If a later service restore fails after new Guild commands were registered, both the local
    # bundle and the remote command set must return to their old versions.
    $externalRollbackSource = Join-Path $testRoot 'external rollback source'
    Install-IsolatedDeploySource -Destination $externalRollbackSource
    $externalRollbackLive = Join-Path $testRoot 'external rollback live'
    $externalRollbackDesktop = Join-Path $testRoot 'external rollback Desktop'
    New-Item -ItemType Directory -Path $externalRollbackLive,$externalRollbackDesktop -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $externalRollbackLive 'codex-control.ps1'), (Get-IsolatedControlScript -Role old), [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $externalRollbackLive 'discord-bridge.mjs'), (Get-IsolatedBridgeScript -Role old), [System.Text.UTF8Encoding]::new($false))
    Write-TestBytes -Path (Join-Path $externalRollbackLive 'CodexDiscordControl.exe') -Bytes ([byte[]](1,2,3,4))
    Write-TestBytes -Path (Join-Path $externalRollbackDesktop '码驿 · CodexRelay 控制台.lnk') -Bytes ([byte[]](5,6,7,8))
    $oldRollbackControlHash = Get-BytesHex -Path (Join-Path $externalRollbackLive 'codex-control.ps1')
    $oldRollbackBridgeHash = Get-BytesHex -Path (Join-Path $externalRollbackLive 'discord-bridge.mjs')
    $oldRollbackExeHash = Get-BytesHex -Path (Join-Path $externalRollbackLive 'CodexDiscordControl.exe')
    $oldRollbackShortcutHash = Get-BytesHex -Path (Join-Path $externalRollbackDesktop '码驿 · CodexRelay 控制台.lnk')
    Write-TestBytes -Path (Join-Path $externalRollbackDesktop 'Codex Discord 控制台.lnk') -Bytes ([byte[]](9,10,11,12))
    $oldRollbackLegacyHash = Get-BytesHex -Path (Join-Path $externalRollbackDesktop 'Codex Discord 控制台.lnk')
    $externalRollbackState = Join-Path $testRoot 'external rollback state.json'
    $externalRollbackActions = Join-Path $testRoot 'external rollback actions.txt'
    [System.IO.File]::WriteAllText($externalRollbackState, '{"taskInstalled":true,"taskRunning":true,"running":true,"autoStartEnabled":true,"mode":"scheduled"}', [System.Text.UTF8Encoding]::new($false))
    $env:CODEX_DEPLOY_TEST_STATE_PATH = $externalRollbackState
    $env:CODEX_DEPLOY_TEST_ACTION_PATH = $externalRollbackActions
    $env:CODEX_DEPLOY_TEST_FAIL_ACTION = 'enable-long-term'
    $env:CODEX_DEPLOY_TEST_MIGRATE_LEGACY_SHORTCUT = '1'
    $externalRollbackError = $null
    try { & $deployScript -SourceRoot $externalRollbackSource -LiveRoot $externalRollbackLive -DesktopPath $externalRollbackDesktop | Out-Null }
    catch { $externalRollbackError = $_.Exception.Message }
    finally {
        Remove-Item Env:CODEX_DEPLOY_TEST_STATE_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_ACTION_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_FAIL_ACTION -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_MIGRATE_LEGACY_SHORTCUT -ErrorAction SilentlyContinue
    }
    Assert-True ($externalRollbackError -eq 'control action failed: enable-long-term') 'external rollback replaced the primary service-restore failure'
    Assert-True ((Get-BytesHex -Path (Join-Path $externalRollbackLive 'codex-control.ps1')) -ceq $oldRollbackControlHash) 'external rollback did not restore the old control entrypoint'
    Assert-True ((Get-BytesHex -Path (Join-Path $externalRollbackLive 'discord-bridge.mjs')) -ceq $oldRollbackBridgeHash) 'external rollback did not restore the old bridge command definitions'
    Assert-True ((Get-BytesHex -Path (Join-Path $externalRollbackLive 'CodexDiscordControl.exe')) -ceq $oldRollbackExeHash) 'external rollback did not restore the old executable'
    Assert-True ((Get-BytesHex -Path (Join-Path $externalRollbackDesktop '码驿 · CodexRelay 控制台.lnk')) -ceq $oldRollbackShortcutHash) 'external rollback did not restore the old shortcut'
    Assert-True ((Get-BytesHex -Path (Join-Path $externalRollbackDesktop 'Codex Discord 控制台.lnk')) -ceq $oldRollbackLegacyHash) 'external rollback did not restore the migrated legacy shortcut'
    $externalRollbackFinal = Get-Content -Raw -LiteralPath $externalRollbackState | ConvertFrom-Json
    Assert-True ($externalRollbackFinal.running -eq $true -and $externalRollbackFinal.autoStartEnabled -eq $true) 'external rollback did not restore the prior bridge service state'
    $externalActions = @(Get-Content -LiteralPath $externalRollbackActions)
    Assert-True ((@($externalActions | Where-Object { $_ -like 'register:*' }) -join ',') -eq 'register:new,register:old') 'external rollback did not restore the old Discord Guild commands'

    foreach ($registrationMode in @('hang-new','huge-stdout-new','huge-stderr-new','slow-retry-new')) {
        $boundedSource = Join-Path $testRoot ("bounded $registrationMode source")
        Install-IsolatedDeploySource -Destination $boundedSource
        Assert-BoundedRegistrationProcess -Mode $registrationMode -BridgePath (Join-Path $boundedSource 'discord-bridge.mjs') -ArtifactRoot (Join-Path $testRoot "bounded $registrationMode process")
        $boundedLive = Join-Path $testRoot ("bounded $registrationMode live")
        $boundedDesktop = Join-Path $testRoot ("bounded $registrationMode Desktop")
        New-Item -ItemType Directory -Path $boundedLive,$boundedDesktop -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $boundedLive 'codex-control.ps1'), (Get-IsolatedControlScript -Role old), [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText((Join-Path $boundedLive 'discord-bridge.mjs'), (Get-IsolatedBridgeScript -Role old), [System.Text.UTF8Encoding]::new($false))
        Write-TestBytes -Path (Join-Path $boundedLive 'CodexDiscordControl.exe') -Bytes ([byte[]](31,41,59,26))
        Write-TestBytes -Path (Join-Path $boundedDesktop '码驿 · CodexRelay 控制台.lnk') -Bytes ([byte[]](53,58,97,93))
        $boundedOldControl = Get-BytesHex -Path (Join-Path $boundedLive 'codex-control.ps1')
        $boundedOldBridge = Get-BytesHex -Path (Join-Path $boundedLive 'discord-bridge.mjs')
        $boundedOldExe = Get-BytesHex -Path (Join-Path $boundedLive 'CodexDiscordControl.exe')
        $boundedOldShortcut = Get-BytesHex -Path (Join-Path $boundedDesktop '码驿 · CodexRelay 控制台.lnk')
        $boundedState = Join-Path $testRoot ("bounded $registrationMode state.json")
        $boundedActions = Join-Path $testRoot ("bounded $registrationMode actions.txt")
        $boundedRemote = Join-Path $testRoot ("bounded $registrationMode remote.txt")
        $boundedPids = Join-Path $testRoot ("bounded $registrationMode pids.txt")
        [System.IO.File]::WriteAllText($boundedState, '{"taskInstalled":true,"taskRunning":true,"running":true,"autoStartEnabled":true,"mode":"scheduled"}', [System.Text.UTF8Encoding]::new($false))
        $secretSentinel = 'DO-NOT-LEAK-REGISTRATION-OUTPUT'
        $env:CODEX_DEPLOY_TEST_STATE_PATH = $boundedState
        $env:CODEX_DEPLOY_TEST_ACTION_PATH = $boundedActions
        $env:CODEX_DEPLOY_TEST_REMOTE_PATH = $boundedRemote
        $env:CODEX_DEPLOY_TEST_PID_PATH = $boundedPids
        $env:CODEX_DEPLOY_TEST_REGISTRATION_MODE = $registrationMode
        $env:CODEX_DEPLOY_TEST_OUTPUT_SENTINEL = $secretSentinel
        $boundedError = $null
        $boundedText = [System.Collections.Generic.List[string]]::new()
        $clock = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            & $deployScript -SourceRoot $boundedSource -LiveRoot $boundedLive -DesktopPath $boundedDesktop -RegistrationDeadlineMilliseconds 1400 -RegistrationOutputLimitBytes 4096 2>&1 |
                ForEach-Object { $boundedText.Add([string]$_) }
        }
        catch {
            $boundedError = $_.Exception.Message
            $boundedText.Add($boundedError)
        }
        finally {
            $clock.Stop()
            Remove-Item Env:CODEX_DEPLOY_TEST_STATE_PATH -ErrorAction SilentlyContinue
            Remove-Item Env:CODEX_DEPLOY_TEST_ACTION_PATH -ErrorAction SilentlyContinue
            Remove-Item Env:CODEX_DEPLOY_TEST_REMOTE_PATH -ErrorAction SilentlyContinue
            Remove-Item Env:CODEX_DEPLOY_TEST_PID_PATH -ErrorAction SilentlyContinue
            Remove-Item Env:CODEX_DEPLOY_TEST_REGISTRATION_MODE -ErrorAction SilentlyContinue
            Remove-Item Env:CODEX_DEPLOY_TEST_OUTPUT_SENTINEL -ErrorAction SilentlyContinue
        }
        Assert-True ($boundedError -eq 'Discord command registration failed') "bounded $registrationMode registration did not preserve the fixed primary error"
        # The direct test above checks the 1.4s registration budget within a 5s tolerance.
        # This whole transaction also copies and verifies the stage and backups, and
        # launches separate old-command, bridge, shortcut, file, and Guard compensations.
        # Those operations exceeded 30s on the Windows CI runner even with bounded registration.
        Assert-True ($clock.ElapsedMilliseconds -lt 120000) "bounded $registrationMode deployment plus full recovery exceeded its transaction bound ($($clock.ElapsedMilliseconds)ms)"
        Assert-True (-not (($boundedText -join "`n").Contains($secretSentinel))) "bounded $registrationMode registration leaked child output"
        Assert-True ((Get-Content -Raw -LiteralPath $boundedRemote) -eq 'old') "bounded $registrationMode rollback did not restore remote Guild commands"
        $boundedRegistrationActions = @(Get-Content -LiteralPath $boundedActions | Where-Object { $_ -like 'register:*' })
        $expectedRegistrationActions = if ($registrationMode -eq 'slow-retry-new') {
            'register:new,register:synthetic-429-long-retry,register:old'
        } else { 'register:new,register:old' }
        Assert-True (($boundedRegistrationActions -join ',') -eq $expectedRegistrationActions) "bounded $registrationMode rollback did not compensate a possibly-effective registration"
        Assert-True ((Get-BytesHex -Path (Join-Path $boundedLive 'codex-control.ps1')) -ceq $boundedOldControl) "bounded $registrationMode rollback changed the old control"
        Assert-True ((Get-BytesHex -Path (Join-Path $boundedLive 'discord-bridge.mjs')) -ceq $boundedOldBridge) "bounded $registrationMode rollback changed the old bridge"
        Assert-True ((Get-BytesHex -Path (Join-Path $boundedLive 'CodexDiscordControl.exe')) -ceq $boundedOldExe) "bounded $registrationMode rollback changed the old executable"
        Assert-True ((Get-BytesHex -Path (Join-Path $boundedDesktop '码驿 · CodexRelay 控制台.lnk')) -ceq $boundedOldShortcut) "bounded $registrationMode rollback changed the old shortcut"
        $boundedFinalState = Get-Content -Raw -LiteralPath $boundedState | ConvertFrom-Json
        Assert-True ($boundedFinalState.running -eq $true -and $boundedFinalState.autoStartEnabled -eq $true -and $boundedFinalState.mode -eq 'scheduled') "bounded $registrationMode rollback changed bridge ownership"
        Assert-True (@(Get-ChildItem -LiteralPath $boundedLive -Directory -Force | Where-Object { $_.Name -like '.codex-discord-deploy.*.stage' }).Count -eq 0) "bounded $registrationMode rollback left a deployment stage"
        if ($registrationMode -eq 'hang-new') {
            Assert-True (Test-Path -LiteralPath $boundedPids -PathType Leaf) 'bounded registration did not prove its process tree was created'
            $boundedProcessIds = @(Get-Content -LiteralPath $boundedPids)
            Assert-True ($boundedProcessIds.Count -eq 2) 'bounded registration did not record exactly one parent and one descendant'
            foreach ($pidText in $boundedProcessIds) {
                $processId = 0
                Assert-True ([int]::TryParse($pidText, [ref]$processId)) 'bounded registration recorded an invalid process id'
                Assert-True ($null -eq (Get-Process -Id $processId -ErrorAction SilentlyContinue)) 'bounded registration left a process-tree member alive'
            }
        }
    }

    $deployText = Get-Content -Raw -LiteralPath $deployScript
    $probeText = Get-Content -Raw -LiteralPath (Join-Path $sourceRoot 'deploy-live-probe.ps1')
    Assert-True ($deployText -notmatch '(?i)Invoke-Expression|cmd(?:\.exe)?\s+/c|powershell(?:\.exe)?\s+-Command') 'deployment constructs or invokes shell text'
    Assert-True ($deployText -match 'ProcessStartInfo' -and $deployText -match 'ArgumentList\.Add') 'Discord registration is not launched with bounded exact argv process control'
    Assert-True ($deployText -match 'RegistrationDeadlineMilliseconds' -and $deployText -match 'RegistrationOutputLimitBytes') 'Discord registration has no explicit deadline or output cap'
    Assert-True ($deployText -match 'TerminateJobObject|Kill\(\$true\)') 'Discord registration cannot terminate a hung process tree'
    Assert-True ($deployText -notmatch '(?m)^\s*&\s+\$NodePath\s+\$BridgePath') 'Discord registration still invokes an unbounded synchronous child process'
    Assert-True ($deployText -notmatch '(?m)^\s*&\s*\(Join-Path\s+\$live\s+''install-discord-bridge-task\.ps1''\)') 'deployment unconditionally installs and enables a missing scheduled task'
    Assert-True ($deployText -notmatch '-Action\s+\S*stop-codex') 'deployment can terminate Codex desktop instead of only the bridge'
    Assert-True ($deployText -match 'GetFileHash|Get-FileHash') 'deployment does not hash-verify its complete stage'
    Assert-True ($deployText -match '\$stageIdentity\s*=\s*Resolve-DeployDirectory' -and $deployText -match 'Assert-DeployStageIdentity') 'deployment does not pin and revalidate the physical stage identity'
    Assert-True ($probeText -match '\$operations\[[''"]InstallTask[''"]\]\s*=\s*\{\s*throw') 'staged recovery probe can install a scheduled task that points into its temporary stage'
    Assert-True ($deployText -match 'ForbiddenDeployNames\s+-contains\s+\[System\.IO\.Path\]::GetFileName') 'forbidden allowlist check is not Windows case-insensitive by leaf name'
    $allowlistMatch = [regex]::Match($deployText, '(?s)\$script:DeployFileAllowlist\s*=\s*@\((.*?)\)')
    Assert-True $allowlistMatch.Success 'deployment does not expose one fixed internal file allowlist'
    foreach ($forbidden in $forbiddenRuntimeNames) {
        Assert-True (-not $allowlistMatch.Groups[1].Value.Contains("'$forbidden'")) "deployment allowlist includes forbidden runtime state: $forbidden"
    }

    $readme = Get-Content -Raw -LiteralPath $readmePath
    Assert-True ($readme -match '11\s*个.*Slash Commands|11\s*条.*命令') 'README does not document all eleven commands'
    Assert-True ($readme -match '/退出codex[\s\S]{0,500}(?:风险|中断)[\s\S]{0,500}(?:二次|确认)') 'README does not explain the exit risk preview and confirmation'
    Assert-True ($readme -match 'active-writer|写入者占用') 'README does not explain active-writer takeover'
    Assert-True ($readme -match '临时开启[\s\S]{0,1000}临时停止[\s\S]{0,1000}长期开启[\s\S]{0,1000}长期停用') 'README does not explain the four control modes'
    Assert-True ($readme -match '原频道[\s\S]{0,500}(?:待确认|最终结果)[\s\S]{0,500}不(?:会|再)转发[\s\S]{0,100}(?:commentary|工具调用|过程)') 'README does not document final-only Discord-origin routing'
    Assert-True ($readme -match '登录[\s\S]{0,300}(?:唤醒|休眠)[\s\S]{0,300}(?:联网|网络)') 'README does not document the logged-in, awake, networked PC boundary'
    Assert-True ($readme -match 'git clone --branch main https://github\.com/mxymalay/CodexRelay\.git') 'README does not obtain the current main repository'
    Assert-True ($readme -match '安全部署、更新与恢复[\s\S]{0,1000}update-windows\.cmd' -and $readme -match 'deploy-macos\.mjs') 'README does not provide current Windows and macOS recovery entrypoints'
    Assert-True ($readme -match 'Token|secret|私密[\s\S]{0,300}(?:不进入 Git|不提交)') 'README does not state the source/runtime secret boundary'

    Write-Output 'PASS: safe allowlisted deployment, rollback, and recovery documentation'
}
finally {
    for ($junctionIndex = $testJunctions.Count - 1; $junctionIndex -ge 0; $junctionIndex--) {
        $junction = $testJunctions[$junctionIndex]
        if (-not (Test-Path -LiteralPath $junction)) { continue }
        $junctionPath = [System.IO.Path]::GetFullPath($junction)
        $validatedTestRoot = [System.IO.Path]::GetFullPath($testRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
        if (-not $junctionPath.StartsWith($validatedTestRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'refusing unsafe junction cleanup' }
        $junctionItem = Get-Item -LiteralPath $junction -Force
        if (($junctionItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) { throw 'refusing to delete a non-junction as a junction' }
        Remove-Item -LiteralPath $junction -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $testRoot) {
        $resolved = [System.IO.Path]::GetFullPath($testRoot)
        $temp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
        if (-not $resolved.StartsWith($temp, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'refusing unsafe test cleanup' }
        Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
    }
}
