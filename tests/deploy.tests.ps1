[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
$deployScript = Join-Path $sourceRoot 'deploy.ps1'
$readmePath = Join-Path $sourceRoot 'README.md'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('codex discord deploy ' + [guid]::NewGuid().ToString('N'))

$sourceFiles = @(
    'activate-discord-bot.ps1',
    'build-control-app.ps1',
    'codex-control-lib.ps1',
    'codex-control.ps1',
    'codex-takeover-lib.mjs',
    'control-app\CodexDiscordControl.cs',
    'discord-bridge-lib.mjs',
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
    'discord-state.ps1',
    'discord-task-create-lib.mjs',
    'discord-task-index-lib.mjs',
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
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.CODEX_DEPLOY_TEST_ACTION_PATH, 'register:__ROLE__\n', 'utf8');
if (process.env.CODEX_DEPLOY_TEST_FAIL_REGISTRATION === '__ROLE__') process.exit(1);
'@.Replace('__ROLE__', $Role)
}

function Install-IsolatedDeploySource {
    param([Parameter(Mandatory)][string]$Destination)
    Copy-DeploymentSource -Destination $Destination
    $fakeLibrary = @'
function Read-IsolatedDeployState { return (Get-Content -Raw -LiteralPath $env:CODEX_DEPLOY_TEST_STATE_PATH | ConvertFrom-Json) }
function Write-IsolatedDeployState { param($State) $State | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:CODEX_DEPLOY_TEST_STATE_PATH -Encoding UTF8 }
function Add-IsolatedDeployAction { param([string]$Value) Add-Content -LiteralPath $env:CODEX_DEPLOY_TEST_ACTION_PATH -Value $Value -Encoding UTF8 }
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
'@
    $fakeInstaller = @'
[CmdletBinding()]
param([string]$SourceRoot,[string]$ToolDir,[string]$DesktopPath,[switch]$ShortcutOnly)
if (-not $ShortcutOnly) { throw 'isolated installer requires ShortcutOnly' }
Add-Content -LiteralPath $env:CODEX_DEPLOY_TEST_ACTION_PATH -Value 'install:shortcut' -Encoding UTF8
[System.IO.File]::WriteAllText((Join-Path $DesktopPath 'Codex Discord 控制台.lnk'), 'isolated-new-shortcut', [System.Text.UTF8Encoding]::new($false))
if ($env:CODEX_DEPLOY_TEST_FAIL_SHORTCUT_AFTER_WRITE -eq '1') { throw 'synthetic-shortcut-failure' }
'@
    [System.IO.File]::WriteAllText((Join-Path $Destination 'codex-control-lib.ps1'), $fakeLibrary, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $Destination 'codex-control.ps1'), (Get-IsolatedControlScript -Role new), [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $Destination 'install-control-app.ps1'), $fakeInstaller, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $Destination 'discord-bridge.mjs'), (Get-IsolatedBridgeScript -Role new), [System.Text.UTF8Encoding]::new($false))
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

try {
    Assert-True (Test-Path -LiteralPath $deployScript -PathType Leaf) 'deploy.ps1 is missing'
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null

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
    New-Item -ItemType Junction -Path (Join-Path $reparseSource 'control-app') -Target $outsideControl | Out-Null
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
    New-Item -ItemType Junction -Path (Join-Path $destinationJunctionLive 'control-app') -Target $outsideDestination | Out-Null
    $destinationJunctionError = $null
    try { & $deployScript -SourceRoot $sourceRoot -LiveRoot $destinationJunctionLive -DesktopPath $destinationJunctionDesktop -SkipLiveActions | Out-Null }
    catch { $destinationJunctionError = $_.Exception.Message }
    Assert-True (-not [string]::IsNullOrWhiteSpace($destinationJunctionError)) 'deployment followed a destination reparse point outside LiveRoot'
    Assert-True (@(Get-ChildItem -LiteralPath $outsideDestination -Force).Count -eq 0) 'destination reparse rejection wrote outside LiveRoot'

    # Non-Skip deployment probes through the staged fixed control library even when the old live
    # bundle has no control entrypoint. All actions below are isolated fakes in temporary paths.
    $nonSkipSource = Join-Path $testRoot 'non skip isolated source'
    Install-IsolatedDeploySource -Destination $nonSkipSource
    $serviceCases = @(
        [pscustomobject]@{ Name='scheduled'; Initial=@{taskInstalled=$true;autoStartEnabled=$true;taskRunning=$true;running=$true;mode='scheduled'}; Expected=@('probe:status','probe:stop-temporary','install:shortcut','register:new','control:new:enable-long-term'); Running=$true; AutoStart=$true; Mode='scheduled' },
        [pscustomobject]@{ Name='disabled'; Initial=@{taskInstalled=$true;autoStartEnabled=$false;taskRunning=$false;running=$false;mode='unknown'}; Expected=@('probe:status','install:shortcut','register:new'); Running=$false; AutoStart=$false; Mode='unknown' },
        [pscustomobject]@{ Name='temporary'; Initial=@{taskInstalled=$true;autoStartEnabled=$false;taskRunning=$false;running=$true;mode='temporary'}; Expected=@('probe:status','probe:stop-temporary','install:shortcut','register:new','control:new:start-temporary'); Running=$true; AutoStart=$false; Mode='temporary' }
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
        Assert-True ((@(Get-Content -LiteralPath $caseActions) -join ',') -eq ($case.Expected -join ',')) "non-Skip $($case.Name) did not preserve the exact service action sequence"
        $caseFinal = Get-Content -Raw -LiteralPath $caseState | ConvertFrom-Json
        Assert-True ($caseFinal.running -eq $case.Running -and $caseFinal.autoStartEnabled -eq $case.AutoStart -and $caseFinal.mode -eq $case.Mode) "non-Skip $($case.Name) changed the requested long-term/runtime state"
        Assert-True (Test-Path -LiteralPath (Join-Path $caseDesktop 'Codex Discord 控制台.lnk') -PathType Leaf) "non-Skip $($case.Name) did not install the isolated shortcut"
    }

    # Shortcut creation is an external live mutation too. If the trusted installer writes the
    # link and then fails, the transaction must restore its exact previous bytes.
    $shortcutFailureLive = Join-Path $testRoot 'shortcut partial failure live'
    $shortcutFailureDesktop = Join-Path $testRoot 'shortcut partial failure Desktop'
    $shortcutFailureState = Join-Path $testRoot 'shortcut partial failure state.json'
    $shortcutFailureActions = Join-Path $testRoot 'shortcut partial failure actions.txt'
    New-Item -ItemType Directory -Path $shortcutFailureLive,$shortcutFailureDesktop -Force | Out-Null
    [System.IO.File]::WriteAllText($shortcutFailureState, '{"taskInstalled":true,"taskRunning":false,"running":false,"autoStartEnabled":false,"mode":"unknown"}', [System.Text.UTF8Encoding]::new($false))
    Write-TestBytes -Path (Join-Path $shortcutFailureDesktop 'Codex Discord 控制台.lnk') -Bytes ([byte[]](41,0,42,255))
    $shortcutFailureBefore = Get-BytesHex -Path (Join-Path $shortcutFailureDesktop 'Codex Discord 控制台.lnk')
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
    Assert-True ($shortcutFailureError -match 'synthetic-shortcut-failure') 'deployment hid the trusted shortcut partial-write failure'
    Assert-True ((Get-BytesHex -Path (Join-Path $shortcutFailureDesktop 'Codex Discord 控制台.lnk')) -ceq $shortcutFailureBefore) 'shortcut partial-write failure did not restore the exact previous bytes'

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
    Assert-True ((@(Get-Content -LiteralPath $serviceMutationActions) -join ',') -eq 'probe:status,probe:stop-temporary,install:shortcut,register:new,control:new:enable-long-term,probe:stop-temporary,register:old,control:old:enable-long-term') 'post-mutation service rollback replaced files before stopping the new runtime'
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
    Assert-True ((@(Get-Content -LiteralPath $partialStopActions) -join ',') -eq 'probe:status,probe:stop-temporary,probe:status,probe:enable-long-term') 'first-upgrade partial-stop recovery did not use the staged trusted probe'

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
    Write-TestBytes -Path (Join-Path $externalRollbackDesktop 'Codex Discord 控制台.lnk') -Bytes ([byte[]](5,6,7,8))
    $oldRollbackControlHash = Get-BytesHex -Path (Join-Path $externalRollbackLive 'codex-control.ps1')
    $oldRollbackBridgeHash = Get-BytesHex -Path (Join-Path $externalRollbackLive 'discord-bridge.mjs')
    $oldRollbackExeHash = Get-BytesHex -Path (Join-Path $externalRollbackLive 'CodexDiscordControl.exe')
    $oldRollbackShortcutHash = Get-BytesHex -Path (Join-Path $externalRollbackDesktop 'Codex Discord 控制台.lnk')
    $externalRollbackState = Join-Path $testRoot 'external rollback state.json'
    $externalRollbackActions = Join-Path $testRoot 'external rollback actions.txt'
    [System.IO.File]::WriteAllText($externalRollbackState, '{"taskInstalled":true,"taskRunning":true,"running":true,"autoStartEnabled":true,"mode":"scheduled"}', [System.Text.UTF8Encoding]::new($false))
    $env:CODEX_DEPLOY_TEST_STATE_PATH = $externalRollbackState
    $env:CODEX_DEPLOY_TEST_ACTION_PATH = $externalRollbackActions
    $env:CODEX_DEPLOY_TEST_FAIL_ACTION = 'enable-long-term'
    $externalRollbackError = $null
    try { & $deployScript -SourceRoot $externalRollbackSource -LiveRoot $externalRollbackLive -DesktopPath $externalRollbackDesktop | Out-Null }
    catch { $externalRollbackError = $_.Exception.Message }
    finally {
        Remove-Item Env:CODEX_DEPLOY_TEST_STATE_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_ACTION_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_DEPLOY_TEST_FAIL_ACTION -ErrorAction SilentlyContinue
    }
    Assert-True ($externalRollbackError -eq 'control action failed: enable-long-term') 'external rollback replaced the primary service-restore failure'
    Assert-True ((Get-BytesHex -Path (Join-Path $externalRollbackLive 'codex-control.ps1')) -ceq $oldRollbackControlHash) 'external rollback did not restore the old control entrypoint'
    Assert-True ((Get-BytesHex -Path (Join-Path $externalRollbackLive 'discord-bridge.mjs')) -ceq $oldRollbackBridgeHash) 'external rollback did not restore the old bridge command definitions'
    Assert-True ((Get-BytesHex -Path (Join-Path $externalRollbackLive 'CodexDiscordControl.exe')) -ceq $oldRollbackExeHash) 'external rollback did not restore the old executable'
    Assert-True ((Get-BytesHex -Path (Join-Path $externalRollbackDesktop 'Codex Discord 控制台.lnk')) -ceq $oldRollbackShortcutHash) 'external rollback did not restore the old shortcut'
    $externalRollbackFinal = Get-Content -Raw -LiteralPath $externalRollbackState | ConvertFrom-Json
    Assert-True ($externalRollbackFinal.running -eq $true -and $externalRollbackFinal.autoStartEnabled -eq $true) 'external rollback did not restore the prior bridge service state'
    $externalActions = @(Get-Content -LiteralPath $externalRollbackActions)
    Assert-True ((@($externalActions | Where-Object { $_ -like 'register:*' }) -join ',') -eq 'register:new,register:old') 'external rollback did not restore the old Discord Guild commands'

    $deployText = Get-Content -Raw -LiteralPath $deployScript
    Assert-True ($deployText -notmatch '(?i)Invoke-Expression|cmd(?:\.exe)?\s+/c|powershell(?:\.exe)?\s+-Command') 'deployment constructs or invokes shell text'
    Assert-True ($deployText -notmatch '(?m)^\s*&\s*\(Join-Path\s+\$live\s+''install-discord-bridge-task\.ps1''\)') 'deployment unconditionally installs and enables a missing scheduled task'
    Assert-True ($deployText -notmatch '-Action\s+\S*stop-codex') 'deployment can terminate Codex desktop instead of only the bridge'
    Assert-True ($deployText -match 'GetFileHash|Get-FileHash') 'deployment does not hash-verify its complete stage'
    Assert-True ($deployText -match '\$operations\[[''"]InstallTask[''"]\]\s*=\s*\{\s*throw') 'staged recovery probe can install a scheduled task that points into its temporary stage'
    Assert-True ($deployText -match 'ForbiddenDeployNames\s+-contains\s+\[System\.IO\.Path\]::GetFileName') 'forbidden allowlist check is not Windows case-insensitive by leaf name'
    $allowlistMatch = [regex]::Match($deployText, '(?s)\$script:DeployFileAllowlist\s*=\s*@\((.*?)\)')
    Assert-True $allowlistMatch.Success 'deployment does not expose one fixed internal file allowlist'
    foreach ($forbidden in $forbiddenRuntimeNames) {
        Assert-True (-not $allowlistMatch.Groups[1].Value.Contains("'$forbidden'")) "deployment allowlist includes forbidden runtime state: $forbidden"
    }

    $readme = Get-Content -Raw -LiteralPath $readmePath
    Assert-True ($readme -match '11\s*个.*Slash Commands|11\s*条.*命令') 'README does not document all eleven commands'
    Assert-True ($readme -match '/退出Codex[\s\S]{0,500}(?:风险|中断)[\s\S]{0,500}(?:二次|确认)') 'README does not explain the exit risk preview and confirmation'
    Assert-True ($readme -match 'active-writer|写入者占用') 'README does not explain active-writer takeover'
    Assert-True ($readme -match '临时开启[\s\S]{0,1000}临时停止[\s\S]{0,1000}长期开启[\s\S]{0,1000}长期停用') 'README does not explain the four control modes'
    Assert-True ($readme -match '原频道[\s\S]{0,500}(?:commentary|工具进度|进度)') 'README does not document Discord-origin progress routing'
    Assert-True ($readme -match '登录[\s\S]{0,300}(?:唤醒|休眠)[\s\S]{0,300}(?:联网|网络)') 'README does not document the logged-in, awake, networked PC boundary'
    Assert-True ($readme -match 'deploy\.ps1[\s\S]{0,500}(?:恢复|重建|重新部署)') 'README does not provide one-command repository recovery'
    Assert-True ($readme -match 'Token|secret|私密[\s\S]{0,300}(?:不进入 Git|不提交)') 'README does not state the source/runtime secret boundary'

    Write-Output 'PASS: safe allowlisted deployment, rollback, and recovery documentation'
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        $resolved = [System.IO.Path]::GetFullPath($testRoot)
        $temp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
        if (-not $resolved.StartsWith($temp, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'refusing unsafe test cleanup' }
        Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
    }
}
