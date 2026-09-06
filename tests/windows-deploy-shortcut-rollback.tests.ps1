#requires -Version 7.0
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$deploy=Join-Path (Split-Path -Parent $PSScriptRoot) 'deploy.ps1'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($deploy,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'deployment source did not parse'}
$rollback=$ast.Find({param($node)
    ($node -is [Management.Automation.Language.IfStatementAst] -or $node -is [Management.Automation.Language.ForEachStatementAst] -or $node -is [Management.Automation.Language.ForStatementAst]) -and
    $node.Extent.Text.Contains("throw 'Desktop shortcut rollback refused concurrent bytes'")
},$true)
if($null -eq $rollback){throw 'shortcut rollback block is missing'}
$runRollback=[scriptblock]::Create($rollback.Extent.Text)
# Only Windows directory-handle checks are unavailable on other hosts. Execute
# the exact production rollback block against isolated real files on every OS.
function Assert-DeployDirectoryIdentity {param($Expected)}
function Assert-DeployDirectChildIdentity {param($ParentIdentity,$ChildIdentity,$Label)}
function Get-DeployHash {param($Path) (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash}
function Invoke-DeployTestHook {param($Name,$Context)
    if($raceLegacy -and $Context.DestinationPath -eq $legacyPath){[IO.File]::WriteAllText($legacyPath,'concurrent user bytes')}
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('codex-deploy-shortcuts-'+[guid]::NewGuid().ToString('N'))
$failures=[Collections.Generic.List[string]]::new()
try {
    foreach($raceLegacy in @($false,$true)){
        $desktop=Join-Path $root ([string]$raceLegacy);New-Item -ItemType Directory -Path $desktop -Force | Out-Null
        $legacyPath=Join-Path $desktop 'Codex Discord 控制台.lnk';$newPath=Join-Path $desktop '码驿 · CodexRelay 控制台.lnk'
        $legacyBackup=Join-Path $desktop 'old.backup';$newBackup=Join-Path $desktop 'new.backup'
        [IO.File]::WriteAllText($legacyBackup,'original legacy bytes');[IO.File]::WriteAllText($newBackup,'original branded bytes');[IO.File]::WriteAllText($newPath,'installed branded bytes')
        $shortcutRecords=@(
            [pscustomobject]@{HadOriginal=$true;BackupPath=$newBackup;OriginalHash=(Get-DeployHash $newBackup);DestinationPath=$newPath;MutationAttempted=$true;ChangedByTransaction=$true;ExpectedHash=(Get-DeployHash $newPath)},
            [pscustomobject]@{HadOriginal=$true;BackupPath=$legacyBackup;OriginalHash=(Get-DeployHash $legacyBackup);DestinationPath=$legacyPath;MutationAttempted=$true;ChangedByTransaction=$true;ExpectedHash=$null}
        )
        $shortcutRecord=$shortcutRecords[0];$transactionId=[guid]::NewGuid().ToString('N');$desktopIdentity=@{};$backupParentIdentity=@{};$backupRootIdentity=@{};$rollbackFailed=$false
        . $runRollback
        try {
            if([IO.File]::ReadAllText($newPath) -cne 'original branded bytes'){throw 'branded shortcut was not restored'}
            if($raceLegacy){
                if(-not $rollbackFailed){throw 'concurrent legacy recreation did not report incomplete rollback'}
                if([IO.File]::ReadAllText($legacyPath) -cne 'concurrent user bytes'){throw 'rollback replaced concurrent legacy bytes'}
            }else{
                if($rollbackFailed){throw 'ordinary shortcut rollback failed'}
                if(-not(Test-Path -LiteralPath $legacyPath) -or [IO.File]::ReadAllText($legacyPath) -cne 'original legacy bytes'){throw 'deployment rollback did not restore the migrated legacy shortcut'}
            }
            Write-Output "PASS: deployment restores both shortcut names; concurrent legacy recreation=$raceLegacy"
        }catch{$failures.Add($_.Exception.Message);Write-Output "FAIL: $($_.Exception.Message)"}
    }
    # Read the actual caller's finally block, with a proven installer mutation log
    # and bytes changed independently before the caller observes the result.
    $installerTry=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.TryStatementAst] -and $node.Body.Extent.Text.Contains("& (Join-Path `$live 'install-control-app.ps1')")},$true) | Sort-Object { $_.Extent.Text.Length }) | Select-Object -First 1
    if($null -eq $installerTry){throw 'installer transaction observation block is missing'}
    $observe=[scriptblock]::Create(($installerTry.Finally.Statements | ForEach-Object {$_.Extent.Text}) -join "`n")
    foreach($variant in @('foreign-after-write','foreign-without-write','already-restored')){
        try {
            $desktop=Join-Path $root $variant;New-Item -ItemType Directory -Path $desktop | Out-Null
            $newPath=Join-Path $desktop '码驿 · CodexRelay 控制台.lnk';$backup=Join-Path $desktop 'original.backup';$staged=Join-Path $desktop 'installed.stage'
            [IO.File]::WriteAllText($backup,'original bytes');[IO.File]::WriteAllText($staged,'installer bytes')
            [IO.File]::WriteAllText($newPath,$(if($variant -eq 'already-restored'){'original bytes'}else{'concurrent user bytes'}))
            $originalHash=Get-DeployHash $backup;$installedHash=Get-DeployHash $staged
            $shortcutRecords=@([pscustomobject]@{HadOriginal=$true;BackupPath=$backup;OriginalHash=$originalHash;DestinationPath=$newPath;IsLegacy=$false;MutationAttempted=$true;ChangedByTransaction=$false;ExpectedHash=$null})
            $shortcutTransactionLog=[Collections.Generic.List[object]]::new()
            if($variant -ne 'foreign-without-write'){$shortcutTransactionLog.Add([pscustomobject]@{DestinationPath=$newPath;HadOriginal=$true;OriginalHash=$originalHash;ExpectedHash=$installedHash;Removed=$false})}
            . $observe
            if($variant -eq 'foreign-after-write') {
                if($shortcutRecords[0].ExpectedHash -cne $installedHash){throw 'deployment adopted external bytes as its installed shortcut'}
                $rollbackFailed=$false;. $runRollback
                if(-not $rollbackFailed -or [IO.File]::ReadAllText($newPath) -cne 'concurrent user bytes'){throw 'deployment rollback modified an externally replaced shortcut'}
            }elseif($shortcutRecords[0].ChangedByTransaction){throw 'deployment claimed shortcut bytes not left by its installer'}
            Write-Output "PASS: deployment installer ownership evidence; $variant"
        }catch{$failures.Add($_.Exception.Message);Write-Output "FAIL: $($_.Exception.Message)"}
    }
    if($failures.Count){throw ($failures -join "`n")}
}finally{if(Test-Path -LiteralPath $root){Remove-Item -LiteralPath $root -Recurse -Force}}
