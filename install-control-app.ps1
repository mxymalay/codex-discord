[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$SourceRoot,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$ToolDir,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$DesktopPath,
    [switch]$ShortcutOnly,
    [ValidateSet('none','after-executable','after-backend','after-library','before-shortcut')]
    [string]$FailureInjectionStep = 'none'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-ControlDirectory {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)
    try { $fullPath = [System.IO.Path]::GetFullPath($Path) }
    catch { throw "$Label is invalid" }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) { throw "$Label is not an existing directory" }
    return (Get-Item -LiteralPath $fullPath -Force).FullName
}

function Invoke-ControlFailureInjection {
    param([Parameter(Mandatory)][string]$Step)
    if ($FailureInjectionStep -ceq $Step) { throw "injected-install-failure:$Step" }
}

function Install-ControlTransactionFile {
    param(
        [Parameter(Mandatory)][string]$StagedPath,
        [Parameter(Mandatory)][string]$DestinationPath,
        [Parameter(Mandatory)][string]$BackupPath
    )
    $hadOriginal = Test-Path -LiteralPath $DestinationPath -PathType Leaf
    if ($hadOriginal) { [System.IO.File]::Replace($StagedPath, $DestinationPath, $BackupPath, $true) }
    else { [System.IO.File]::Move($StagedPath, $DestinationPath) }
    return [pscustomobject]@{
        DestinationPath = $DestinationPath
        BackupPath = $BackupPath
        HadOriginal = $hadOriginal
    }
}

function Restore-ControlTransactionFile {
    param([Parameter(Mandatory)][object]$Record, [Parameter(Mandatory)][string]$TransactionId)
    if ($Record.HadOriginal) {
        if (-not (Test-Path -LiteralPath $Record.BackupPath -PathType Leaf)) { throw 'Control bundle backup is unavailable' }
        if (Test-Path -LiteralPath $Record.DestinationPath -PathType Leaf) {
            $discardPath = Join-Path (Split-Path -Parent $Record.DestinationPath) ('.codex-control-install.' + $TransactionId + '.discard')
            try { [System.IO.File]::Replace($Record.BackupPath, $Record.DestinationPath, $discardPath, $true) }
            finally { if (Test-Path -LiteralPath $discardPath -PathType Leaf) { Remove-Item -LiteralPath $discardPath -Force -ErrorAction SilentlyContinue } }
        }
        else { [System.IO.File]::Move($Record.BackupPath, $Record.DestinationPath) }
    }
    elseif (Test-Path -LiteralPath $Record.DestinationPath -PathType Leaf) {
        Remove-Item -LiteralPath $Record.DestinationPath -Force
    }
}

function Remove-ControlStage {
    param([Parameter(Mandatory)][string]$StageDirectory, [Parameter(Mandatory)][string[]]$KnownPaths)
    foreach ($path in $KnownPaths) {
        if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
    }
    if (Test-Path -LiteralPath $StageDirectory -PathType Container) {
        if (@(Get-ChildItem -LiteralPath $StageDirectory -Force).Count -eq 0) { Remove-Item -LiteralPath $StageDirectory -Force -ErrorAction SilentlyContinue }
    }
}

# Resolve every caller-supplied boundary and every required source before the first write.
$source = Resolve-ControlDirectory -Path $SourceRoot -Label 'SourceRoot'
$tool = Resolve-ControlDirectory -Path $ToolDir -Label 'ToolDir'
$desktop = Resolve-ControlDirectory -Path $DesktopPath -Label 'DesktopPath'
$requiredSources = if ($ShortcutOnly) {
    @((Join-Path $tool 'CodexDiscordControl.exe'))
}
else {
    @(
        (Join-Path $source 'control-app\CodexDiscordControl.cs'),
        (Join-Path $source 'assets\codex-discord-control.ico'),
        (Join-Path $source 'build-control-app.ps1'),
        (Join-Path $source 'codex-control.ps1'),
        (Join-Path $source 'codex-control-lib.ps1')
    )
}
foreach ($required in $requiredSources) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw 'Control app installation is missing a required file' }
}

# WScript.Shell.Save uses the Windows ANSI codepage for shortcut paths. Use
# IShellLinkW and IPersistFile so Chinese names and user directories round-trip
# on an English Windows installation as well.
if (-not ('CodexControlShortcut' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
internal class CodexControlShellLink { }

[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface ICodexControlShellLinkW
{
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int size, IntPtr findData, uint flags);
    void GetIDList(out IntPtr itemIdList);
    void SetIDList(IntPtr itemIdList);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder description, int size);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string description);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int size);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int size);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
    void GetHotkey(out short hotkey);
    void SetHotkey(short hotkey);
    void GetShowCmd(out int showCommand);
    void SetShowCmd(int showCommand);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder iconPath, int size, out int iconIndex);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int iconIndex);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
    void Resolve(IntPtr window, uint flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
}

public sealed class CodexControlShortcutInfo
{
    public string TargetPath { get; set; }
    public string WorkingDirectory { get; set; }
    public string Arguments { get; set; }
    public string Description { get; set; }
    public string IconLocation { get; set; }
}

public static class CodexControlShortcut
{
    public static void Save(string shortcutPath, string targetPath, string workingDirectory,
        string arguments, string description, string iconPath, int iconIndex)
    {
        object instance = new CodexControlShellLink();
        try {
            ICodexControlShellLinkW link = (ICodexControlShellLinkW)instance;
            link.SetPath(targetPath);
            link.SetWorkingDirectory(workingDirectory);
            link.SetArguments(arguments);
            link.SetDescription(description);
            link.SetIconLocation(iconPath, iconIndex);
            ((IPersistFile)instance).Save(shortcutPath, true);
        }
        finally { Marshal.FinalReleaseComObject(instance); }
    }

    public static CodexControlShortcutInfo Read(string shortcutPath)
    {
        object instance = new CodexControlShellLink();
        try {
            ((IPersistFile)instance).Load(shortcutPath, 0);
            ICodexControlShellLinkW link = (ICodexControlShellLinkW)instance;
            StringBuilder target = new StringBuilder(32768);
            StringBuilder directory = new StringBuilder(32768);
            StringBuilder arguments = new StringBuilder(32768);
            StringBuilder description = new StringBuilder(32768);
            StringBuilder icon = new StringBuilder(32768);
            int iconIndex;
            link.GetPath(target, target.Capacity, IntPtr.Zero, 4); // SLGP_RAWPATH: do not resolve or search for another target.
            link.GetWorkingDirectory(directory, directory.Capacity);
            link.GetArguments(arguments, arguments.Capacity);
            link.GetDescription(description, description.Capacity);
            link.GetIconLocation(icon, icon.Capacity, out iconIndex);
            return new CodexControlShortcutInfo {
                TargetPath = target.ToString(), WorkingDirectory = directory.ToString(),
                Arguments = arguments.ToString(), Description = description.ToString(),
                IconLocation = icon.ToString() + "," + iconIndex
            };
        }
        finally { Marshal.FinalReleaseComObject(instance); }
    }
}
'@
}

$transactionId = [guid]::NewGuid().ToString('N')
$stageDirectory = Join-Path $tool ('.codex-control-install.' + $transactionId + '.stage')
$stagedExecutable = Join-Path $stageDirectory 'CodexDiscordControl.exe'
$stagedBackend = Join-Path $stageDirectory 'codex-control.ps1'
$stagedLibrary = Join-Path $stageDirectory 'codex-control-lib.ps1'
$stagedShortcut = Join-Path $desktop ('.Codex Discord 控制台.' + $transactionId + '.stage.lnk')

$executablePath = Join-Path $tool 'CodexDiscordControl.exe'
$backendPath = Join-Path $tool 'codex-control.ps1'
$libraryPath = Join-Path $tool 'codex-control-lib.ps1'
$shortcutPath = Join-Path $desktop 'Codex Discord 控制台.lnk'
$records = [System.Collections.Generic.List[object]]::new()
$succeeded = $false

try {
    if (-not $ShortcutOnly) {
        New-Item -ItemType Directory -Path $stageDirectory | Out-Null
        & (Join-Path $source 'build-control-app.ps1') -OutputDirectory $stageDirectory | Out-Null
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $stagedExecutable -PathType Leaf)) { throw 'Control app build failed' }
        [System.IO.File]::Copy((Join-Path $source 'codex-control.ps1'), $stagedBackend, $false)
        [System.IO.File]::Copy((Join-Path $source 'codex-control-lib.ps1'), $stagedLibrary, $false)
    }

    $description = '控制 Discord 桥接服务的运行和开机自启状态'
    [CodexControlShortcut]::Save($stagedShortcut, $executablePath, $tool, '', $description, $executablePath, 0)
    if (-not (Test-Path -LiteralPath $stagedShortcut -PathType Leaf)) { throw 'Shortcut staging failed' }
    $shortcut = [CodexControlShortcut]::Read($stagedShortcut)
    if (-not $shortcut.TargetPath.Equals($executablePath, [StringComparison]::OrdinalIgnoreCase) -or
        -not $shortcut.WorkingDirectory.Equals($tool, [StringComparison]::OrdinalIgnoreCase) -or
        -not $shortcut.IconLocation.Equals(($executablePath + ',0'), [StringComparison]::OrdinalIgnoreCase) -or
        $shortcut.Arguments -cne '' -or $shortcut.Description -cne $description) {
        throw 'Shortcut staging verification failed'
    }

    if (-not $ShortcutOnly) {
        $records.Add((Install-ControlTransactionFile -StagedPath $stagedExecutable -DestinationPath $executablePath -BackupPath (Join-Path $tool ('.CodexDiscordControl.' + $transactionId + '.backup.exe'))))
        Invoke-ControlFailureInjection -Step 'after-executable'
        $records.Add((Install-ControlTransactionFile -StagedPath $stagedBackend -DestinationPath $backendPath -BackupPath (Join-Path $tool ('.codex-control.' + $transactionId + '.backup.ps1'))))
        Invoke-ControlFailureInjection -Step 'after-backend'
        $records.Add((Install-ControlTransactionFile -StagedPath $stagedLibrary -DestinationPath $libraryPath -BackupPath (Join-Path $tool ('.codex-control-lib.' + $transactionId + '.backup.ps1'))))
        Invoke-ControlFailureInjection -Step 'after-library'
    }
    Invoke-ControlFailureInjection -Step 'before-shortcut'
    $records.Add((Install-ControlTransactionFile -StagedPath $stagedShortcut -DestinationPath $shortcutPath -BackupPath (Join-Path $desktop ('.Codex Discord 控制台.' + $transactionId + '.backup.lnk'))))
    $succeeded = $true
}
catch {
    $primaryError = $_
    $rollbackErrors = [System.Collections.Generic.List[string]]::new()
    for ($index = $records.Count - 1; $index -ge 0; $index--) {
        try { Restore-ControlTransactionFile -Record $records[$index] -TransactionId $transactionId }
        catch { $rollbackErrors.Add('rollback-failed') }
    }
    if ($rollbackErrors.Count -gt 0) { throw 'Control app installation failed and rollback is incomplete' }
    throw $primaryError
}
finally {
    if ($succeeded) {
        foreach ($record in $records) {
            if ($record.HadOriginal -and (Test-Path -LiteralPath $record.BackupPath -PathType Leaf)) { Remove-Item -LiteralPath $record.BackupPath -Force -ErrorAction SilentlyContinue }
        }
    }
    Remove-ControlStage -StageDirectory $stageDirectory -KnownPaths @($stagedExecutable,$stagedBackend,$stagedLibrary,$stagedShortcut)
}

Write-Output $executablePath
Write-Output $shortcutPath
