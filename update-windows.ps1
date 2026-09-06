#requires -Version 7.0
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This updater is for Windows; use install-macos.mjs on macOS.' }
$codexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
if (-not [IO.Path]::IsPathFullyQualified($codexRoot)) { throw 'CODEX_HOME must be an absolute path.' }
$live = Join-Path $codexRoot 'mobile-notify'
if (-not (Test-Path -LiteralPath (Join-Path $live 'config.json') -PathType Leaf)) {
    throw 'No existing configuration was found. Follow docs/GETTING-STARTED.md for a new installation.'
}
$desktop = [Environment]::GetFolderPath('Desktop')
& (Join-Path $PSScriptRoot 'deploy.ps1') -SourceRoot $PSScriptRoot -LiveRoot $live -DesktopPath $desktop
Write-Output 'Update complete. Configuration, token and service startup choice were preserved.'
Write-Output 'Stopping the updated console also pauses this tool''s notifications on this computer.'
