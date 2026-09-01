[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$SourceRoot,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$LiveRoot,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$DesktopPath,
    [switch]$SkipLiveActions,
    [ValidateSet('none','after-third-commit','before-live-actions')]
    [string]$FailureInjectionStep = 'none'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# This is the complete source/runtime bundle. Runtime state and secrets are deliberately absent.
$script:DeployFileAllowlist = @(
    'discord-bridge.mjs',
    'discord-bridge-lib.mjs',
    'discord-commands-lib.mjs',
    'discord-interactions.mjs',
    'discord-gateway-lib.mjs',
    'discord-health-lib.mjs',
    'discord-task-create-lib.mjs',
    'discord-task-index-lib.mjs',
    'rollout-completion-watcher-lib.mjs',
    'codex-takeover-lib.mjs',
    'discord-control-client.mjs',
    'dispatcher.ps1',
    'discord-config.ps1',
    'discord-secret.ps1',
    'discord-state.ps1',
    'discord-http.ps1',
    'task-delivery-state.ps1',
    'get-discord-token.ps1',
    'protect-discord-pending-reply.ps1',
    'unprotect-discord-pending-reply.ps1',
    'save-discord-token.ps1',
    'activate-discord-bot.ps1',
    'setup.ps1',
    'repair-notify.ps1',
    'watch-notify.ps1',
    'codex-control-lib.ps1',
    'codex-control.ps1',
    'discord-bridge-startup.ps1',
    'start-discord-bridge.ps1',
    'install-discord-bridge-task.ps1',
    'build-control-app.ps1',
    'install-control-app.ps1',
    'control-app\CodexDiscordControl.cs'
)
$script:GeneratedDeployFiles = @('CodexDiscordControl.exe')
$script:ForbiddenDeployNames = @(
    'config.json', 'discord-token.dpapi', 'discord-inbox-state.json',
    'discord-message-map.json', 'discord-task-index.json', 'discord-gateway-state.json',
    'quota-state.json', 'rollout-watcher-state.json', 'task-delivery-state.json',
    'discord-bridge-runtime.json', 'discord-bridge-health.json',
    'discord-bridge.log', 'mobile-notify.log', 'notify-guard.log'
)

function Resolve-DeployDirectory {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)

    try { $fullPath = [System.IO.Path]::GetFullPath($Path) }
    catch { throw "$Label is invalid" }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) { throw "$Label is not an existing directory" }
    $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label cannot be a reparse point" }
    return $item.FullName.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
}

function Test-DeployPathIsRoot {
    param([Parameter(Mandatory)][string]$Path)
    $root = [System.IO.Path]::GetPathRoot($Path)
    return $Path.TrimEnd('\','/').Equals($root.TrimEnd('\','/'), [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-DeployPathContains {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Candidate)
    $normalizedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\','/')
    $normalizedCandidate = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\','/')
    if ($normalizedCandidate.Equals($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $normalizedCandidate.StartsWith($normalizedRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-DeployDirectoriesSeparate {
    param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Live, [Parameter(Mandatory)][string]$Desktop)

    foreach ($entry in @(
        [pscustomobject]@{ Label='SourceRoot'; Path=$Source },
        [pscustomobject]@{ Label='LiveRoot'; Path=$Live },
        [pscustomobject]@{ Label='DesktopPath'; Path=$Desktop }
    )) {
        if (Test-DeployPathIsRoot -Path $entry.Path) { throw "$($entry.Label) cannot be a filesystem root" }
    }
    foreach ($pair in @(
        @('SourceRoot',$Source,'LiveRoot',$Live),
        @('SourceRoot',$Source,'DesktopPath',$Desktop),
        @('LiveRoot',$Live,'DesktopPath',$Desktop)
    )) {
        if ((Test-DeployPathContains -Root $pair[1] -Candidate $pair[3]) -or (Test-DeployPathContains -Root $pair[3] -Candidate $pair[1])) {
            throw "$($pair[0]) and $($pair[2]) cannot overlap"
        }
    }
}

function Assert-DeployPathBoundary {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-DeployPathContains -Root $Root -Candidate $fullPath) -or $fullPath.Equals($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label escapes its trusted root"
    }
    $relative = [System.IO.Path]::GetRelativePath($Root, $fullPath)
    $cursor = $Root
    foreach ($segment in ($relative -split '[\\/]')) {
        if ([string]::IsNullOrWhiteSpace($segment)) { continue }
        $cursor = Join-Path $cursor $segment
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label traverses a reparse point" }
        }
    }
    return $fullPath
}

function Get-DeployHash {
    param([Parameter(Mandatory)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}

function New-DeployParentDirectories {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[string]]$CreatedDirectories
    )

    $parent = Split-Path -Parent $Path
    if (Test-Path -LiteralPath $parent -PathType Container) {
        if ([System.IO.Path]::GetFullPath($parent).TrimEnd('\','/').Equals([System.IO.Path]::GetFullPath($Root).TrimEnd('\','/'), [System.StringComparison]::OrdinalIgnoreCase)) { return }
        [void](Assert-DeployPathBoundary -Root $Root -Path $parent -Label 'destination parent')
        return
    }
    $relative = [System.IO.Path]::GetRelativePath($Root, $parent)
    $cursor = $Root
    foreach ($segment in ($relative -split '[\\/]')) {
        if ([string]::IsNullOrWhiteSpace($segment)) { continue }
        $cursor = Join-Path $cursor $segment
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'destination parent is unsafe'
            }
        }
        else {
            New-Item -ItemType Directory -Path $cursor | Out-Null
            $CreatedDirectories.Add($cursor)
        }
    }
}

function Copy-DeployFileVerified {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)][string]$ExpectedHash
    )
    [System.IO.File]::Copy($Source, $Destination, $false)
    if ((Get-DeployHash -Path $Destination) -cne $ExpectedHash) { throw 'staged file hash mismatch' }
}

function Restore-DeployRecord {
    param([Parameter(Mandatory)][object]$Record, [Parameter(Mandatory)][string]$TransactionId)

    if (-not $Record.Committed) { return }
    if ($Record.HadOriginal) {
        if (-not (Test-Path -LiteralPath $Record.BackupPath -PathType Leaf)) { throw 'deployment backup is unavailable' }
        $restorePath = Join-Path (Split-Path -Parent $Record.DestinationPath) ('.codex-discord-deploy.' + $TransactionId + '.rollback')
        [System.IO.File]::Copy($Record.BackupPath, $restorePath, $false)
        try {
            if (Test-Path -LiteralPath $Record.DestinationPath -PathType Leaf) {
                $discardPath = $restorePath + '.discard'
                [System.IO.File]::Replace($restorePath, $Record.DestinationPath, $discardPath, $true)
                if (Test-Path -LiteralPath $discardPath -PathType Leaf) { Remove-Item -LiteralPath $discardPath -Force }
            }
            else { [System.IO.File]::Move($restorePath, $Record.DestinationPath) }
        }
        finally {
            if (Test-Path -LiteralPath $restorePath -PathType Leaf) { Remove-Item -LiteralPath $restorePath -Force -ErrorAction SilentlyContinue }
        }
        if ((Get-DeployHash -Path $Record.DestinationPath) -cne $Record.OriginalHash) { throw 'deployment rollback hash mismatch' }
    }
    elseif (Test-Path -LiteralPath $Record.DestinationPath -PathType Leaf) {
        Remove-Item -LiteralPath $Record.DestinationPath -Force
    }
}

function Remove-DeployStage {
    param([Parameter(Mandatory)][string]$Live, [Parameter(Mandatory)][string]$Stage)

    if (-not (Test-Path -LiteralPath $Stage)) { return }
    $fullStage = [System.IO.Path]::GetFullPath($Stage)
    if (-not (Test-DeployPathContains -Root $Live -Candidate $fullStage) -or $fullStage.Equals($Live, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'refusing unsafe deployment stage cleanup'
    }
    $item = Get-Item -LiteralPath $fullStage -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'refusing reparse-point deployment stage cleanup' }
    Remove-Item -LiteralPath $fullStage -Recurse -Force
}

function Invoke-DeployControl {
    param([Parameter(Mandatory)][string]$PowerShellPath, [Parameter(Mandatory)][string]$ControlPath, [Parameter(Mandatory)][string]$Action)

    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $lines = @(& $PowerShellPath -NoProfile -File $ControlPath -Action $Action 2>&1 | ForEach-Object { [string]$_ })
        $exitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedPreference }
    if ($lines.Count -ne 1) { throw 'control action returned an invalid response' }
    try { $response = $lines[0] | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'control action returned invalid JSON' }
    if ($exitCode -ne 0 -or $response.ok -ne $true) { throw "control action failed: $Action" }
    return $response
}

function New-DeployServiceProbe {
    param([Parameter(Mandatory)][string]$StageRoot)

    $probePath = Join-Path $StageRoot '.codex-discord-service-probe.ps1'
    $probeSource = @'
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('status','stop-temporary','start-temporary','enable-long-term')][string]$Action,
    [Parameter(Mandatory)][string]$ToolDir
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'codex-control-lib.ps1')
try {
    $operations = New-CodexControlOperations
    # The probe lives in a disposable stage. It may inspect and control an existing task, but it
    # must never create one whose action would reference this temporary directory.
    $operations['InstallTask'] = { throw 'staged-task-install-disabled' }
    if ($Action -eq 'status') {
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
    else {
        if ($Action -eq 'enable-long-term') {
            # Never let the staged control library install a task whose script path would point
            # into the soon-to-be-removed stage. Recovery may only re-enable an existing task.
            $beforeEnable = Get-CodexBridgeServiceStatus -Operations $operations -ToolDir $ToolDir
            if ($beforeEnable.ok -ne $true -or $beforeEnable.taskInstalled -ne $true) { throw 'staged-task-recovery-unavailable' }
        }
        $result = Invoke-CodexBridgeServiceAction -Action $Action -ToolDir $ToolDir -Operations $operations
    }
    $result | ConvertTo-Json -Depth 8 -Compress
    exit $(if ($result.ok -eq $true) { 0 } else { 1 })
}
catch {
    [pscustomobject]@{ok=$false;errorCategory='deploy-service-probe-failed'} | ConvertTo-Json -Compress
    exit 1
}
'@
    [System.IO.File]::WriteAllText($probePath, $probeSource, [System.Text.UTF8Encoding]::new($false))
    return $probePath
}

function Invoke-DeployServiceProbe {
    param(
        [Parameter(Mandatory)][string]$PowerShellPath,
        [Parameter(Mandatory)][string]$ProbePath,
        [Parameter(Mandatory)][ValidateSet('status','stop-temporary','start-temporary','enable-long-term')][string]$Action,
        [Parameter(Mandatory)][string]$ToolDir
    )

    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $lines = @(& $PowerShellPath -NoProfile -File $ProbePath -Action $Action -ToolDir $ToolDir 2>&1 | ForEach-Object { [string]$_ })
        $exitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedPreference }
    if ($lines.Count -ne 1) { throw 'service probe returned an invalid response' }
    try { $response = $lines[0] | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'service probe returned invalid JSON' }
    if ($exitCode -ne 0 -or $response.ok -ne $true) { throw "service probe failed: $Action" }
    return $response
}

function Invoke-DeployCommandRegistration {
    param([Parameter(Mandatory)][string]$NodePath, [Parameter(Mandatory)][string]$BridgePath)

    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $NodePath $BridgePath '--register-commands' '--once'
        $exitCode = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedPreference }
    if ($exitCode -ne 0) { throw 'Discord command registration failed' }
}

if (@($script:DeployFileAllowlist | Where-Object { $script:ForbiddenDeployNames -contains [System.IO.Path]::GetFileName($_) }).Count -gt 0) {
    throw 'Deployment allowlist contains runtime state'
}
if ($script:DeployFileAllowlist.Count -ne @($script:DeployFileAllowlist | Sort-Object -Unique).Count) {
    throw 'Deployment allowlist contains duplicate paths'
}

# Resolve every caller-controlled boundary and every required source before the first write.
$source = Resolve-DeployDirectory -Path $SourceRoot -Label 'SourceRoot'
$live = Resolve-DeployDirectory -Path $LiveRoot -Label 'LiveRoot'
$desktop = Resolve-DeployDirectory -Path $DesktopPath -Label 'DesktopPath'
Assert-DeployDirectoriesSeparate -Source $source -Live $live -Desktop $desktop

$readmeMarker = Join-Path $source 'README.md'
if (-not (Test-Path -LiteralPath $readmeMarker -PathType Leaf)) { throw 'SourceRoot is missing the repository marker' }
[void](Assert-DeployPathBoundary -Root $source -Path $readmeMarker -Label 'repository marker')
$markerText = [System.IO.File]::ReadAllText($readmeMarker, [System.Text.Encoding]::UTF8)
if (-not $markerText.StartsWith('# Codex Discord 私有命令控制台', [System.StringComparison]::Ordinal)) {
    throw 'SourceRoot repository marker is invalid'
}

$sourceManifest = [System.Collections.Generic.List[object]]::new()
foreach ($relativePath in $script:DeployFileAllowlist) {
    if ([System.IO.Path]::IsPathRooted($relativePath) -or $relativePath -match '(^|[\\/])\.\.([\\/]|$)') { throw 'Deployment allowlist path is unsafe' }
    $sourcePath = Assert-DeployPathBoundary -Root $source -Path (Join-Path $source $relativePath) -Label "source file $relativePath"
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw "SourceRoot is missing a required deployment file: $relativePath" }
    $destinationPath = Assert-DeployPathBoundary -Root $live -Path (Join-Path $live $relativePath) -Label "destination file $relativePath"
    if (Test-Path -LiteralPath $destinationPath) {
        if (-not (Test-Path -LiteralPath $destinationPath -PathType Leaf)) { throw "Live destination is not a file: $relativePath" }
    }
    $sourceManifest.Add([pscustomobject][ordered]@{
        RelativePath = $relativePath
        SourcePath = $sourcePath
        DestinationPath = $destinationPath
        Hash = Get-DeployHash -Path $sourcePath
    })
}
foreach ($relativePath in $script:GeneratedDeployFiles) {
    [void](Assert-DeployPathBoundary -Root $live -Path (Join-Path $live $relativePath) -Label "generated destination $relativePath")
}
$shortcutPath = Join-Path $desktop 'Codex Discord 控制台.lnk'
[void](Assert-DeployPathBoundary -Root $desktop -Path $shortcutPath -Label 'Desktop shortcut')

$transactionId = [guid]::NewGuid().ToString('N')
$timestamp = [DateTimeOffset]::Now.ToString('yyyyMMdd-HHmmss-fffffff')
$stageRoot = Join-Path $live ('.codex-discord-deploy.' + $transactionId + '.stage')
$backupParent = Join-Path $live '.codex-discord-backups'
$backupRoot = Join-Path $backupParent ($timestamp + '-' + $transactionId.Substring(0,8))
[void](Assert-DeployPathBoundary -Root $live -Path $stageRoot -Label 'deployment stage')
[void](Assert-DeployPathBoundary -Root $live -Path $backupParent -Label 'deployment backup parent')
[void](Assert-DeployPathBoundary -Root $live -Path $backupRoot -Label 'deployment backup')
if (Test-Path -LiteralPath $stageRoot) { throw 'Deployment stage already exists' }
if (Test-Path -LiteralPath $backupRoot) { throw 'Deployment backup already exists' }

$records = [System.Collections.Generic.List[object]]::new()
$createdDirectories = [System.Collections.Generic.List[string]]::new()
$priorStatus = $null
$serviceStopped = $false
$shortcutRecord = $null
$deploymentCommitted = $false
$primaryError = $null
$serviceProbePath = $null
$serviceWasActive = $false
$serviceMutationAttempted = $false
$commandRegistrationAttempted = $false
$nodePath = $null

try {
    # Complete staging and hash verification happen before backup or destination mutation.
    New-Item -ItemType Directory -Path $stageRoot | Out-Null
    foreach ($entry in $sourceManifest) {
        $stagedPath = Join-Path $stageRoot $entry.RelativePath
        $stagedParent = Split-Path -Parent $stagedPath
        if (-not (Test-Path -LiteralPath $stagedParent -PathType Container)) { New-Item -ItemType Directory -Path $stagedParent -Force | Out-Null }
        Copy-DeployFileVerified -Source $entry.SourcePath -Destination $stagedPath -ExpectedHash $entry.Hash
    }
    & (Join-Path $stageRoot 'build-control-app.ps1') -OutputDirectory $stageRoot | Out-Null
    $stagedExecutable = Join-Path $stageRoot 'CodexDiscordControl.exe'
    if (-not (Test-Path -LiteralPath $stagedExecutable -PathType Leaf)) { throw 'Control app build did not produce an executable' }

    $stageManifest = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $sourceManifest) {
        $stagedPath = Assert-DeployPathBoundary -Root $stageRoot -Path (Join-Path $stageRoot $entry.RelativePath) -Label "staged file $($entry.RelativePath)"
        if (-not (Test-Path -LiteralPath $stagedPath -PathType Leaf) -or (Get-DeployHash -Path $stagedPath) -cne $entry.Hash) {
            throw "Staged deployment verification failed: $($entry.RelativePath)"
        }
        $stageManifest.Add([pscustomobject][ordered]@{
            RelativePath = $entry.RelativePath
            StagedPath = $stagedPath
            DestinationPath = $entry.DestinationPath
            Hash = $entry.Hash
        })
    }
    $executableHash = Get-DeployHash -Path $stagedExecutable
    if ([string]::IsNullOrWhiteSpace($executableHash)) { throw 'Control app hash is unavailable' }
    $stageManifest.Add([pscustomobject][ordered]@{
        RelativePath = 'CodexDiscordControl.exe'
        StagedPath = $stagedExecutable
        DestinationPath = Join-Path $live 'CodexDiscordControl.exe'
        Hash = $executableHash
    })
    foreach ($entry in $stageManifest) {
        if (-not (Test-Path -LiteralPath $entry.StagedPath -PathType Leaf) -or (Get-DeployHash -Path $entry.StagedPath) -cne $entry.Hash) {
            throw "Complete stage verification failed: $($entry.RelativePath)"
        }
    }

    if (-not $SkipLiveActions) {
        $powerShellPath = (Get-Command pwsh -ErrorAction Stop).Source
        $serviceProbePath = New-DeployServiceProbe -StageRoot $stageRoot
        $priorStatus = Invoke-DeployServiceProbe -PowerShellPath $powerShellPath -ProbePath $serviceProbePath -Action 'status' -ToolDir $live
        $serviceWasActive = ($priorStatus.service.running -eq $true -or $priorStatus.service.taskRunning -eq $true)
    }

    New-Item -ItemType Directory -Path $backupParent -Force | Out-Null
    $backupParentItem = Get-Item -LiteralPath $backupParent -Force
    if (($backupParentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Deployment backup parent is a reparse point' }
    New-Item -ItemType Directory -Path $backupRoot | Out-Null

    # Back up every old allowlisted destination before the first file commit.
    foreach ($entry in $stageManifest) {
        $destinationPath = Assert-DeployPathBoundary -Root $live -Path $entry.DestinationPath -Label "commit destination $($entry.RelativePath)"
        $hadOriginal = Test-Path -LiteralPath $destinationPath -PathType Leaf
        $backupPath = Join-Path $backupRoot $entry.RelativePath
        $originalHash = $null
        if ($hadOriginal) {
            $originalHash = Get-DeployHash -Path $destinationPath
            $backupDirectory = Split-Path -Parent $backupPath
            if (-not (Test-Path -LiteralPath $backupDirectory -PathType Container)) { New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null }
            [System.IO.File]::Copy($destinationPath, $backupPath, $false)
            if ((Get-DeployHash -Path $backupPath) -cne $originalHash) { throw 'Deployment backup hash mismatch' }
        }
        $records.Add([pscustomobject][ordered]@{
            RelativePath = $entry.RelativePath
            StagedPath = $entry.StagedPath
            DestinationPath = $destinationPath
            BackupPath = $backupPath
            ExpectedHash = $entry.Hash
            OriginalHash = $originalHash
            HadOriginal = $hadOriginal
            Committed = $false
        })
    }
    Write-Output ("部署备份：{0}" -f $backupRoot)

    if (-not $SkipLiveActions) {
        if ($serviceWasActive) {
            # Treat the state as needing restoration before invoking stop: a trusted control
            # action may report failure after it has already stopped the runtime.
            $serviceStopped = $true
            [void](Invoke-DeployServiceProbe -PowerShellPath $powerShellPath -ProbePath $serviceProbePath -Action 'stop-temporary' -ToolDir $live)
        }
        $shortcutHadOriginal = Test-Path -LiteralPath $shortcutPath -PathType Leaf
        $shortcutBackupPath = Join-Path $backupRoot 'desktop-shortcut\Codex Discord 控制台.lnk'
        if ($shortcutHadOriginal) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $shortcutBackupPath) -Force | Out-Null
            $shortcutOriginalHash = Get-DeployHash -Path $shortcutPath
            [System.IO.File]::Copy($shortcutPath, $shortcutBackupPath, $false)
            if ((Get-DeployHash -Path $shortcutBackupPath) -cne $shortcutOriginalHash) { throw 'Desktop shortcut backup hash mismatch' }
        }
        else { $shortcutOriginalHash = $null }
        $shortcutRecord = [pscustomobject]@{ HadOriginal=$shortcutHadOriginal; BackupPath=$shortcutBackupPath; OriginalHash=$shortcutOriginalHash; DestinationPath=$shortcutPath; MutationAttempted=$false }
    }

    $commitCount = 0
    foreach ($record in $records) {
        New-DeployParentDirectories -Root $live -Path $record.DestinationPath -CreatedDirectories $createdDirectories
        [void](Assert-DeployPathBoundary -Root $live -Path $record.DestinationPath -Label "commit destination $($record.RelativePath)")
        $commitTemporary = Join-Path (Split-Path -Parent $record.DestinationPath) ('.codex-discord-deploy.' + $transactionId + '.commit')
        [System.IO.File]::Copy($record.StagedPath, $commitTemporary, $false)
        try {
            if ((Get-DeployHash -Path $commitTemporary) -cne $record.ExpectedHash) { throw 'Deployment commit temporary hash mismatch' }
            if (Test-Path -LiteralPath $record.DestinationPath -PathType Leaf) {
                $discardPath = $commitTemporary + '.discard'
                [System.IO.File]::Replace($commitTemporary, $record.DestinationPath, $discardPath, $true)
                $record.Committed = $true
                if (Test-Path -LiteralPath $discardPath -PathType Leaf) { Remove-Item -LiteralPath $discardPath -Force -ErrorAction SilentlyContinue }
            }
            else {
                [System.IO.File]::Move($commitTemporary, $record.DestinationPath)
                $record.Committed = $true
            }
        }
        finally {
            if (Test-Path -LiteralPath $commitTemporary -PathType Leaf) { Remove-Item -LiteralPath $commitTemporary -Force -ErrorAction SilentlyContinue }
        }
        if ((Get-DeployHash -Path $record.DestinationPath) -cne $record.ExpectedHash) { throw 'Deployment destination hash mismatch' }
        $commitCount++
        if ($FailureInjectionStep -ceq 'after-third-commit' -and $commitCount -eq 3) { throw 'injected-deploy-failure:after-third-commit' }
    }
    $deploymentCommitted = $true

    if (-not $SkipLiveActions) {
        if ($FailureInjectionStep -ceq 'before-live-actions') { throw 'injected-deploy-failure:before-live-actions' }
        # The installer may write the shortcut and then fail, so recovery ownership begins
        # before the external action rather than after its successful return.
        $shortcutRecord.MutationAttempted = $true
        & (Join-Path $live 'install-control-app.ps1') -SourceRoot $live -ToolDir $live -DesktopPath $desktop -ShortcutOnly | Out-Null
        if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { throw 'Control app shortcut installation failed' }
        foreach ($record in $records) {
            if (-not (Test-Path -LiteralPath $record.DestinationPath -PathType Leaf) -or (Get-DeployHash -Path $record.DestinationPath) -cne $record.ExpectedHash) {
                throw "Post-install deployment hash mismatch: $($record.RelativePath)"
            }
        }

        $nodePath = (Get-Command node -ErrorAction Stop).Source
        # Guild PUT can take effect before its local caller reports success, so any attempt owns
        # compensating registration with the restored bridge during rollback.
        $commandRegistrationAttempted = $true
        Invoke-DeployCommandRegistration -NodePath $nodePath -BridgePath (Join-Path $live 'discord-bridge.mjs')

        $powerShellPath = (Get-Command pwsh -ErrorAction Stop).Source
        $newControl = Join-Path $live 'codex-control.ps1'
        if ($priorStatus.service.autoStartEnabled -eq $true) {
            $serviceMutationAttempted = $true
            [void](Invoke-DeployControl -PowerShellPath $powerShellPath -ControlPath $newControl -Action 'enable-long-term')
        }
        elseif ($serviceWasActive) {
            $serviceMutationAttempted = $true
            [void](Invoke-DeployControl -PowerShellPath $powerShellPath -ControlPath $newControl -Action 'start-temporary')
        }
        foreach ($record in $records) {
            if (-not (Test-Path -LiteralPath $record.DestinationPath -PathType Leaf) -or (Get-DeployHash -Path $record.DestinationPath) -cne $record.ExpectedHash) {
                throw "Final deployment hash mismatch: $($record.RelativePath)"
            }
        }
    }
}
catch {
    $primaryError = $_
    $rollbackFailed = $false
    if ($serviceMutationAttempted -and $null -ne $serviceProbePath) {
        try {
            # A fixed service action can start the new runtime and still report failure. Stop it
            # through the intact staged control library before replacing its on-disk code.
            [void](Invoke-DeployServiceProbe -PowerShellPath $powerShellPath -ProbePath $serviceProbePath -Action 'stop-temporary' -ToolDir $live)
        }
        catch { $rollbackFailed = $true }
    }
    for ($index = $records.Count - 1; $index -ge 0; $index--) {
        try { Restore-DeployRecord -Record $records[$index] -TransactionId $transactionId }
        catch { $rollbackFailed = $true }
    }
    for ($index = $createdDirectories.Count - 1; $index -ge 0; $index--) {
        $directory = $createdDirectories[$index]
        if (Test-Path -LiteralPath $directory -PathType Container) {
            try {
                if (@(Get-ChildItem -LiteralPath $directory -Force).Count -eq 0) { Remove-Item -LiteralPath $directory -Force }
            }
            catch { $rollbackFailed = $true }
        }
    }
    if ($null -ne $shortcutRecord -and $shortcutRecord.MutationAttempted) {
        try {
            if ($shortcutRecord.HadOriginal) {
                $shortcutRestore = Join-Path $desktop ('.codex-discord-deploy.' + $transactionId + '.shortcut-rollback')
                [System.IO.File]::Copy($shortcutRecord.BackupPath, $shortcutRestore, $false)
                if (Test-Path -LiteralPath $shortcutRecord.DestinationPath -PathType Leaf) {
                    $shortcutDiscard = $shortcutRestore + '.discard'
                    [System.IO.File]::Replace($shortcutRestore, $shortcutRecord.DestinationPath, $shortcutDiscard, $true)
                    if (Test-Path -LiteralPath $shortcutDiscard -PathType Leaf) { Remove-Item -LiteralPath $shortcutDiscard -Force -ErrorAction SilentlyContinue }
                }
                else { [System.IO.File]::Move($shortcutRestore, $shortcutRecord.DestinationPath) }
                if ((Get-DeployHash -Path $shortcutRecord.DestinationPath) -cne $shortcutRecord.OriginalHash) { throw 'Desktop shortcut rollback hash mismatch' }
            }
            elseif (Test-Path -LiteralPath $shortcutRecord.DestinationPath -PathType Leaf) { Remove-Item -LiteralPath $shortcutRecord.DestinationPath -Force }
        }
        catch { $rollbackFailed = $true }
    }
    if ($commandRegistrationAttempted) {
        try {
            if ($null -eq $nodePath) { $nodePath = (Get-Command node -ErrorAction Stop).Source }
            $restoredBridge = Join-Path $live 'discord-bridge.mjs'
            if (-not (Test-Path -LiteralPath $restoredBridge -PathType Leaf)) { throw 'Restored bridge is unavailable for command rollback' }
            Invoke-DeployCommandRegistration -NodePath $nodePath -BridgePath $restoredBridge
        }
        catch { $rollbackFailed = $true }
    }
    if (($serviceStopped -or $serviceMutationAttempted) -and $null -ne $priorStatus) {
        try {
            $powerShellPath = (Get-Command pwsh -ErrorAction Stop).Source
            $restoredControl = Join-Path $live 'codex-control.ps1'
            if ($serviceWasActive -and $priorStatus.service.autoStartEnabled -eq $true) {
                $restoreAction = 'enable-long-term'
            }
            elseif ($serviceWasActive) {
                $restoreAction = 'start-temporary'
            }
            else {
                $restoreAction = 'stop-temporary'
            }
            if (Test-Path -LiteralPath $restoredControl -PathType Leaf) {
                [void](Invoke-DeployControl -PowerShellPath $powerShellPath -ControlPath $restoredControl -Action $restoreAction)
            }
            else {
                # A first upgrade may legitimately have no old control entrypoint. The fully
                # hash-verified staged library remains available until finally, so it is the
                # trusted recovery path for the pre-deployment service state.
                [void](Invoke-DeployServiceProbe -PowerShellPath $powerShellPath -ProbePath $serviceProbePath -Action $restoreAction -ToolDir $live)
            }
        }
        catch { $rollbackFailed = $true }
    }
    if ($rollbackFailed) { throw "Deployment failed and automatic rollback is incomplete; use backup: $backupRoot" }
    throw $primaryError
}
finally {
    if (Test-Path -LiteralPath $stageRoot) { Remove-DeployStage -Live $live -Stage $stageRoot }
}

Write-Output ("已部署 {0} 个受控文件；私密配置和运行状态保持不变。" -f $records.Count)
if ($SkipLiveActions) { Write-Output '已跳过服务、Discord 命令注册和桌面快捷方式操作。' }
elseif ($deploymentCommitted) { Write-Output 'Discord 桥接部署、控制程序和启动状态已更新。' }
