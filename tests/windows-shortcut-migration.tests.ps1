#requires -Version 7.0
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$installer = Join-Path (Split-Path -Parent $PSScriptRoot) 'install-control-app.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-shortcut-migration-' + [guid]::NewGuid().ToString('N'))

# Windows exercises IShellLinkW. Other hosts replace only that unavailable COM
# boundary; the actual installer and all file/rollback operations still run.
if (-not $IsWindows) {
    Add-Type @'
using System;
using System.IO;
using System.Text;
public sealed class CodexControlShortcutInfo {
    public string TargetPath {get;set;} public string WorkingDirectory {get;set;}
    public string Arguments {get;set;} public string Description {get;set;} public string IconLocation {get;set;}
}
public static class CodexControlShortcut {
    public static void Save(string file,string target,string directory,string arguments,string description,string icon,int index) {
        var values=new[]{target,directory,arguments,description,icon+","+index};
        File.WriteAllLines(file,Array.ConvertAll(values,x=>Convert.ToBase64String(Encoding.UTF8.GetBytes(x))));
    }
    public static CodexControlShortcutInfo Read(string file) {
        var v=Array.ConvertAll(File.ReadAllLines(file),x=>Encoding.UTF8.GetString(Convert.FromBase64String(x)));
        if(v.Length!=5)throw new InvalidDataException();
        return new CodexControlShortcutInfo{TargetPath=v[0],WorkingDirectory=v[1],Arguments=v[2],Description=v[3],IconLocation=v[4]};
    }
}
'@
}
function Assert-True([bool]$Condition,[string]$Message) { if(-not $Condition){throw $Message} }
function New-Fixture([string]$Name) {
    $root=Join-Path $testRoot $Name;$tool=Join-Path $root 'tool';$desktop=Join-Path $root 'Desktop 中文'
    New-Item -ItemType Directory -Path $tool,$desktop -Force | Out-Null
    $exe=Join-Path $tool 'CodexDiscordControl.exe';[IO.File]::WriteAllText($exe,'unchanged executable')
    [pscustomobject]@{Tool=$tool;Desktop=$desktop;Exe=$exe;Old=(Join-Path $desktop 'Codex Discord 控制台.lnk');New=(Join-Path $desktop '码驿 · CodexRelay 控制台.lnk')}
}
function Save-Link($Fixture,[string]$Path,[string]$Target='',[string]$Arguments='') {
    if(-not $Target){$Target=$Fixture.Exe}
    [CodexControlShortcut]::Save($Path,$Target,$Fixture.Tool,$Arguments,'prior shortcut',$Target,0)
}
function Install-Fixture($Fixture,[string]$Failure='none') {
    & $installer -SourceRoot $Fixture.Tool -ToolDir $Fixture.Tool -DesktopPath $Fixture.Desktop -ShortcutOnly -FailureInjectionStep $Failure | Out-Null
}
$failures=[Collections.Generic.List[string]]::new()
function Case([string]$Name,[scriptblock]$Body) {
    try { & $Body; Write-Output "PASS: $Name" } catch { $failures.Add($Name+': '+$_.Exception.Message); Write-Output "FAIL: $Name : $($_.Exception.Message)" }
}
try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    Case 'deployment accepts the Chinese brand and prior repository titles but rejects lookalikes' {
        $deployPath=Join-Path (Split-Path -Parent $PSScriptRoot) 'deploy.ps1'
        $tokens=$null;$parseErrors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($deployPath,[ref]$tokens,[ref]$parseErrors)
        $guard=$ast.Find({param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text -match "throw 'SourceRoot repository marker is invalid'"},$true)
        Assert-True ($null -ne $guard) 'repository marker guard is missing'
        $check=[scriptblock]::Create($guard.Extent.Text)
        foreach($title in @('# 码驿 · CodexRelay','# CodexRelay','# Codex Discord 私有命令控制台')) {
            $markerText=$title+"`nexample repository";& $check
        }
        foreach($title in @('# CodexRelayOther','# unrelated','# 码驿 · CodexRelayX')) {
            $markerText=$title+"`n";$rejected=$false;try{& $check}catch{$rejected=$true}
            Assert-True $rejected 'a lookalike repository marker was accepted'
        }
    }
    if($IsWindows){$bootstrap=New-Fixture 'bootstrap';Install-Fixture $bootstrap}
    Case 'fresh install creates the branded Unicode link without renaming the executable' {
        $f=New-Fixture 'fresh';Install-Fixture $f
        Assert-True (Test-Path -LiteralPath $f.New -PathType Leaf) 'branded shortcut is missing'
        Assert-True (-not(Test-Path -LiteralPath $f.Old)) 'fresh install created the legacy name'
        Assert-True (([CodexControlShortcut]::Read($f.New)).TargetPath -eq $f.Exe) 'shortcut changed the stable executable target'
        Assert-True ([IO.File]::ReadAllText($f.Exe) -ceq 'unchanged executable') 'shortcut-only install modified the executable'
    }
    Case 'fresh installer proof preserves null original hash for the deployment caller' {
        $f=New-Fixture 'fresh transaction proof';$proof=[Collections.Generic.List[object]]::new()
        & $installer -SourceRoot $f.Tool -ToolDir $f.Tool -DesktopPath $f.Desktop -ShortcutOnly -ShortcutTransactionLog $proof | Out-Null
        Assert-True ($proof.Count -eq 1) 'installer did not publish exactly one shortcut mutation'
        Assert-True (-not $proof[0].HadOriginal -and $null -eq $proof[0].OriginalHash) 'fresh installer proof changed null original hash to an empty string'
        Assert-True ($proof[0].ExpectedHash -ceq (Get-FileHash -LiteralPath $f.New).Hash) 'installer proof does not identify its committed bytes'
    }
    Case 'owned legacy shortcut migrates after the new shortcut is verified' {
        $f=New-Fixture 'owned legacy';Save-Link $f $f.Old;Install-Fixture $f
        Assert-True (Test-Path -LiteralPath $f.New -PathType Leaf) 'migration did not create the new link'
        Assert-True (-not(Test-Path -LiteralPath $f.Old)) 'owned legacy link was not migrated'
        Assert-True (([CodexControlShortcut]::Read($f.New)).TargetPath -eq $f.Exe) 'migrated link points elsewhere'
    }
    Case 'foreign legacy targets and argument-bearing links are preserved exactly' {
        foreach($variant in @('foreign','arguments')){
            $f=New-Fixture $variant
            if($variant -eq 'foreign'){Save-Link $f $f.Old (Join-Path $testRoot 'other.exe')}else{Save-Link $f $f.Old '' '--unrelated'}
            $before=(Get-FileHash -LiteralPath $f.Old).Hash;Install-Fixture $f
            Assert-True ((Get-FileHash -LiteralPath $f.Old).Hash -ceq $before) 'an unrelated legacy link changed'
            Assert-True (Test-Path -LiteralPath $f.New -PathType Leaf) 'foreign legacy link prevented a separate branded install'
        }
    }
    Case 'an unrelated branded shortcut blocks installation without deleting the owned legacy link' {
        $f=New-Fixture 'occupied new';Save-Link $f $f.Old;Save-Link $f $f.New (Join-Path $testRoot 'other.exe')
        $old=(Get-FileHash -LiteralPath $f.Old).Hash;$new=(Get-FileHash -LiteralPath $f.New).Hash;$errorText=''
        try{Install-Fixture $f}catch{$errorText=$_.Exception.Message}
        Assert-True ($errorText -match 'not owned|unowned|belongs to another') 'an unrelated branded link was accepted'
        Assert-True ((Get-FileHash -LiteralPath $f.Old).Hash -ceq $old) 'refusal modified the legacy link'
        Assert-True ((Get-FileHash -LiteralPath $f.New).Hash -ceq $new) 'refusal modified the occupied branded link'
    }
    foreach($step in @('after-shortcut','after-legacy-shortcut')){
        Case "migration rollback restores both shortcut names after $step" {
            $f=New-Fixture $step;Save-Link $f $f.Old;Save-Link $f $f.New
            $old=(Get-FileHash -LiteralPath $f.Old).Hash;$new=(Get-FileHash -LiteralPath $f.New).Hash;$errorText=''
            try{Install-Fixture $f $step}catch{$errorText=$_.Exception.Message}
            Assert-True ($errorText -ceq "injected-install-failure:$step") 'failure injection was not reached'
            Assert-True ((Get-FileHash -LiteralPath $f.Old).Hash -ceq $old) 'rollback did not restore legacy bytes'
            Assert-True ((Get-FileHash -LiteralPath $f.New).Hash -ceq $new) 'rollback did not restore branded bytes'
            Assert-True (@(Get-ChildItem -LiteralPath $f.Desktop -Force).Count -eq 2) 'rollback left shortcut transaction artifacts'
        }
    }
    Case 'rollback after migration removes a newly created branded link and restores the legacy link' {
        $f=New-Fixture 'rollback without branded original';Save-Link $f $f.Old
        $old=(Get-FileHash -LiteralPath $f.Old).Hash;$errorText=''
        try{Install-Fixture $f 'after-legacy-shortcut'}catch{$errorText=$_.Exception.Message}
        Assert-True ($errorText -ceq 'injected-install-failure:after-legacy-shortcut') 'migration failure injection was not reached'
        Assert-True ((Get-FileHash -LiteralPath $f.Old).Hash -ceq $old) 'rollback lost original legacy link'
        Assert-True (-not(Test-Path -LiteralPath $f.New)) 'rollback retained newly created branded link'
    }
    foreach($kind in @('replace','delete','removed')) {
        Case "installer rollback preserves a concurrent shortcut during $kind" {
            $tokens=$null;$parseErrors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($installer,[ref]$tokens,[ref]$parseErrors)
            $function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Restore-ControlTransactionFile'},$true)
            . ([scriptblock]::Create($function.Extent.Text))
            $f=New-Fixture "concurrent $kind";$backup=Join-Path $f.Desktop 'original.backup'
            [IO.File]::WriteAllText($backup,'original bytes')
            $original=(Get-FileHash -LiteralPath $backup).Hash
            if($kind -ne 'removed'){[IO.File]::WriteAllText($f.New,'installed bytes');$expected=(Get-FileHash -LiteralPath $f.New).Hash}else{$expected=$null}
            $record=[pscustomobject]@{DestinationPath=$f.New;BackupPath=$backup;HadOriginal=($kind -ne 'delete');GuardShortcut=$true;ExpectedHash=$expected;OriginalHash=$original;Removed=($kind -eq 'removed')}
            $script:raceShortcut=$f.New;$script:raceFired=$false
            # Mutate immediately after the actual precheck returns its snapshot.
            function Get-FileHash {
                param([string]$LiteralPath,[string]$Algorithm='SHA256')
                $value=Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $LiteralPath -Algorithm $Algorithm
                if($kind -ne 'removed' -and $LiteralPath -ceq $script:raceShortcut -and -not $script:raceFired){$script:raceFired=$true;[IO.File]::WriteAllText($LiteralPath,'concurrent user bytes')}
                return $value
            }
            function Test-Path {
                param([string]$LiteralPath,[string]$PathType)
                $value=if($PathType){Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath -PathType $PathType}else{Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath}
                if($kind -eq 'removed' -and $LiteralPath -ceq $script:raceShortcut -and -not $script:raceFired){$script:raceFired=$true;[IO.File]::WriteAllText($LiteralPath,'concurrent user bytes')}
                return $value
            }
            $failed=$false;try{Restore-ControlTransactionFile -Record $record -TransactionId ([guid]::NewGuid().ToString('N'))}catch{$failed=$true}
            Assert-True $script:raceFired 'concurrent mutation hook was not reached'
            Assert-True ([IO.File]::Exists($f.New) -and [IO.File]::ReadAllText($f.New) -ceq 'concurrent user bytes') 'rollback deleted or overwrote a concurrent shortcut'
            Assert-True $failed 'rollback falsely succeeded despite a concurrent shortcut'
        }
    }
    Case 'shortcut commit preserves the second concurrent replacement while retaining displaced first-writer bytes' {
        $tokens=$null;$parseErrors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($installer,[ref]$tokens,[ref]$parseErrors)
        $function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Install-ControlTransactionFile'},$true)
        . ([scriptblock]::Create($function.Extent.Text))
        $f=New-Fixture 'concurrent commit';$backup=Join-Path $f.Desktop 'original.backup';$staged=Join-Path $f.Desktop 'staged.link'
        [IO.File]::WriteAllText($f.New,'original bytes');[IO.File]::WriteAllText($staged,'installed bytes')
        $original=(Get-FileHash -LiteralPath $f.New).Hash;$script:raceShortcut=$f.New;$script:raceReads=0
        function Get-FileHash {
            param([string]$LiteralPath,[string]$Algorithm='SHA256')
            $value=Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $LiteralPath -Algorithm $Algorithm
            if($LiteralPath -ceq $script:raceShortcut){$script:raceReads++;if($script:raceReads -le 2){[IO.File]::WriteAllText($LiteralPath,"concurrent writer $script:raceReads")}}
            return $value
        }
        $failed=$false;try{Install-ControlTransactionFile -StagedPath $staged -DestinationPath $f.New -BackupPath $backup -GuardShortcut -ExpectedOriginalHash $original | Out-Null}catch{$failed=$true}
        Assert-True ($script:raceReads -ge 2) 'second concurrent mutation was not reached'
        Assert-True $failed 'concurrent shortcut commit incorrectly succeeded'
        Assert-True ([IO.File]::ReadAllText($f.New) -ceq 'concurrent writer 2') 'commit recovery overwrote the second concurrent shortcut'
        Assert-True ([IO.File]::ReadAllText($backup) -ceq 'concurrent writer 1') 'commit recovery lost first-writer bytes'
    }
    Case 'shortcut commit restores bytes displaced by a concurrent writer' {
        $tokens=$null;$parseErrors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($installer,[ref]$tokens,[ref]$parseErrors)
        $function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Install-ControlTransactionFile'},$true)
        . ([scriptblock]::Create($function.Extent.Text))
        $f=New-Fixture 'single concurrent commit';$backup=Join-Path $f.Desktop 'original.backup';$staged=Join-Path $f.Desktop 'staged.link'
        [IO.File]::WriteAllText($f.New,'original bytes');[IO.File]::WriteAllText($staged,'installed bytes')
        $original=(Get-FileHash -LiteralPath $f.New).Hash;$script:raceShortcut=$f.New;$script:raceFired=$false
        function Get-FileHash {
            param([string]$LiteralPath,[string]$Algorithm='SHA256')
            $value=Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $LiteralPath -Algorithm $Algorithm
            if($LiteralPath -ceq $script:raceShortcut -and -not $script:raceFired){$script:raceFired=$true;[IO.File]::WriteAllText($LiteralPath,'concurrent user bytes')}
            return $value
        }
        $failed=$false;try{Install-ControlTransactionFile -StagedPath $staged -DestinationPath $f.New -BackupPath $backup -GuardShortcut -ExpectedOriginalHash $original | Out-Null}catch{$failed=$true}
        Assert-True $failed 'concurrent shortcut commit incorrectly succeeded'
        Assert-True ([IO.File]::ReadAllText($f.New) -ceq 'concurrent user bytes') 'commit recovery did not restore the displaced user shortcut'
    }
    if($failures.Count){throw ($failures -join "`n")}
    Write-Output 'PASS: Windows shortcut branding, ownership, migration and rollback'
} finally {if(Test-Path -LiteralPath $testRoot){Remove-Item -LiteralPath $testRoot -Recurse -Force}}
