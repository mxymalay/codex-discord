[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
$repairScript = Join-Path $sourceRoot 'repair-notify.ps1'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('codex-repair-notify-' + [guid]::NewGuid().ToString('N'))
$toolDir = Join-Path $testRoot 'mobile-notify'
$configPath = Join-Path $testRoot 'config.toml'
$dispatcherPath = Join-Path $toolDir 'dispatcher.ps1'
$pwshPath = 'C:\Program Files\PowerShell\7\pwsh.exe'

try {
    New-Item -ItemType Directory -Path $toolDir -Force | Out-Null
    [System.IO.File]::WriteAllText($dispatcherPath, "param()`n", [System.Text.UTF8Encoding]::new($false))
    $legacy = 'notify = [ "C:\\Tools\\codex-computer-use.exe", "turn-ended", "--previous-notify", "[\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\",\"-NoProfile\",\"-File\",\"C:\\\\Old\\\\dispatcher.ps1\"]" ]'
    [System.IO.File]::WriteAllText($configPath, $legacy + "`nmodel = `"gpt-5`"`n", [System.Text.UTF8Encoding]::new($false))

    & $repairScript -Quiet -CodexRoot $testRoot -PowerShellPath $pwshPath
    if ($LASTEXITCODE -ne 0) {
        throw "repair-notify.ps1 exited with code $LASTEXITCODE"
    }

    $updated = [System.IO.File]::ReadAllText($configPath)
    if ($updated -notmatch 'codex-computer-use\.exe' -or $updated -notmatch '"turn-ended"' -or $updated -notmatch '"--previous-notify"') {
        throw 'repair-notify.ps1 did not preserve the existing Codex turn-ended wrapper'
    }
    if ($updated -notmatch 'Program Files.*PowerShell.*7.*pwsh\.exe') {
        throw "repair-notify.ps1 did not place PowerShell 7 in the nested previous-notify command. Updated config: $updated"
    }
    if ($updated -match 'WindowsPowerShell') {
        throw 'repair-notify.ps1 left the legacy Windows PowerShell runtime in config.toml'
    }
    if ($updated -notmatch 'mobile-notify.*dispatcher\.ps1') {
        throw 'repair-notify.ps1 did not restore the current dispatcher path'
    }

    Write-Output 'PASS: repair-notify preserves wrappers and enforces PowerShell 7'
}
finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
