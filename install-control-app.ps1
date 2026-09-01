[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$SourceRoot,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$ToolDir,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$DesktopPath
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

function Replace-ControlFile {
    param([Parameter(Mandatory)][string]$TemporaryPath, [Parameter(Mandatory)][string]$DestinationPath)
    $destinationDirectory = Split-Path -Parent $DestinationPath
    $backupPath = Join-Path $destinationDirectory ('.' + [System.IO.Path]::GetFileName($DestinationPath) + '.' + [guid]::NewGuid().ToString('N') + '.bak')
    $replacementComplete = $false
    try {
        if (Test-Path -LiteralPath $DestinationPath -PathType Leaf) {
            [System.IO.File]::Replace($TemporaryPath, $DestinationPath, $backupPath, $true)
        }
        else {
            [System.IO.File]::Move($TemporaryPath, $DestinationPath)
        }
        $replacementComplete = $true
    }
    catch {
        if (-not (Test-Path -LiteralPath $DestinationPath -PathType Leaf) -and (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
            [System.IO.File]::Move($backupPath, $DestinationPath)
        }
        throw
    }
    finally {
        if (Test-Path -LiteralPath $TemporaryPath -PathType Leaf) { Remove-Item -LiteralPath $TemporaryPath -Force -ErrorAction SilentlyContinue }
        if ($replacementComplete -and (Test-Path -LiteralPath $backupPath -PathType Leaf)) { Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue }
    }
}

function Copy-ControlFileAtomic {
    param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination)
    $sourceFull = [System.IO.Path]::GetFullPath($Source)
    $destinationFull = [System.IO.Path]::GetFullPath($Destination)
    if ($sourceFull.Equals($destinationFull, [System.StringComparison]::OrdinalIgnoreCase)) { return }
    $temporaryPath = Join-Path (Split-Path -Parent $destinationFull) ('.' + [System.IO.Path]::GetFileName($destinationFull) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [System.IO.File]::Copy($sourceFull, $temporaryPath, $true)
        Replace-ControlFile -TemporaryPath $temporaryPath -DestinationPath $destinationFull
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) { Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue }
    }
}

# Resolve and validate every caller-supplied boundary before the first write.
$source = Resolve-ControlDirectory -Path $SourceRoot -Label 'SourceRoot'
$tool = Resolve-ControlDirectory -Path $ToolDir -Label 'ToolDir'
$desktop = Resolve-ControlDirectory -Path $DesktopPath -Label 'DesktopPath'
$requiredSources = @(
    (Join-Path $source 'control-app\CodexDiscordControl.cs'),
    (Join-Path $source 'build-control-app.ps1'),
    (Join-Path $source 'codex-control.ps1'),
    (Join-Path $source 'codex-control-lib.ps1')
)
foreach ($required in $requiredSources) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw 'SourceRoot is missing a required control file' }
}

$buildScript = Join-Path $source 'build-control-app.ps1'
& $buildScript -OutputDirectory $tool
if ($LASTEXITCODE -ne 0) { throw 'Control app build failed' }

Copy-ControlFileAtomic -Source (Join-Path $source 'codex-control.ps1') -Destination (Join-Path $tool 'codex-control.ps1')
Copy-ControlFileAtomic -Source (Join-Path $source 'codex-control-lib.ps1') -Destination (Join-Path $tool 'codex-control-lib.ps1')

$executablePath = Join-Path $tool 'CodexDiscordControl.exe'
if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) { throw 'Built control executable is unavailable' }

$shortcutPath = Join-Path $desktop 'Codex Discord 控制台.lnk'
$temporaryShortcut = Join-Path $desktop ('.Codex Discord 控制台.' + [guid]::NewGuid().ToString('N') + '.tmp.lnk')
try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($temporaryShortcut)
    $shortcut.TargetPath = $executablePath
    $shortcut.WorkingDirectory = $tool
    $shortcut.Arguments = ''
    $shortcut.Description = '控制 Discord 桥接服务的运行和开机自启状态'
    $shortcut.IconLocation = $executablePath + ',0'
    $shortcut.Save()
    if (-not (Test-Path -LiteralPath $temporaryShortcut -PathType Leaf)) { throw 'Shortcut creation failed' }
    Replace-ControlFile -TemporaryPath $temporaryShortcut -DestinationPath $shortcutPath
}
finally {
    if (Test-Path -LiteralPath $temporaryShortcut -PathType Leaf) { Remove-Item -LiteralPath $temporaryShortcut -Force -ErrorAction SilentlyContinue }
}

Write-Output $executablePath
Write-Output $shortcutPath
