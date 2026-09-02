[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourcePath = Join-Path $scriptRoot 'control-app\CodexDiscordControl.cs'
$iconPath = Join-Path $scriptRoot 'assets\codex-discord-control.ico'
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw 'Control app source is unavailable'
}
if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
    throw 'Control app icon is unavailable'
}

try { $outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory) }
catch { throw 'Output directory is invalid' }

if (Test-Path -LiteralPath $outputRoot) {
    if (-not (Test-Path -LiteralPath $outputRoot -PathType Container)) { throw 'Output directory is not a directory' }
}
else {
    New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
}

$compilerCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $compiler) { throw '.NET Framework C# compiler is unavailable' }

$outputPath = Join-Path $outputRoot 'CodexDiscordControl.exe'
$temporaryPath = Join-Path $outputRoot ('.CodexDiscordControl.' + [guid]::NewGuid().ToString('N') + '.tmp.exe')
$backupPath = Join-Path $outputRoot ('.CodexDiscordControl.' + [guid]::NewGuid().ToString('N') + '.bak.exe')
$replacementComplete = $false

try {
    $compilerArguments = @(
        '/nologo',
        '/target:winexe',
        '/optimize+',
        '/platform:anycpu',
        '/warnaserror+',
        '/reference:System.dll',
        '/reference:System.Core.dll',
        '/reference:System.Drawing.dll',
        '/reference:System.Web.Extensions.dll',
        '/reference:System.Windows.Forms.dll',
        ('/win32icon:' + $iconPath),
        ('/out:' + $temporaryPath),
        $sourcePath
    )
    & $compiler @compilerArguments
    $compilerExitCode = $LASTEXITCODE
    if ($compilerExitCode -ne 0 -or -not (Test-Path -LiteralPath $temporaryPath -PathType Leaf)) {
        throw 'Control app compilation failed'
    }

    if (Test-Path -LiteralPath $outputPath -PathType Leaf) {
        [System.IO.File]::Replace($temporaryPath, $outputPath, $backupPath, $true)
    }
    else {
        [System.IO.File]::Move($temporaryPath, $outputPath)
    }
    $replacementComplete = $true
}
catch {
    if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf) -and (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
        [System.IO.File]::Move($backupPath, $outputPath)
    }
    throw
}
finally {
    if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) { Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue }
    if ($replacementComplete -and (Test-Path -LiteralPath $backupPath -PathType Leaf)) { Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue }
}

Write-Output $outputPath
