[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$windowsOnly = @('codex-control.tests.ps1', 'codex-control-app.tests.ps1', 'deploy.tests.ps1', 'discord-bridge-startup.tests.ps1')
$failed = @()
Push-Location $repo
try {
    $node = (Get-Command node -ErrorAction Stop).Source
    $pwsh = (Get-Process -Id $PID).Path
    $javascriptTests = @(Get-ChildItem ./tests/*.test.mjs | Sort-Object Name | ForEach-Object FullName)
    & $node --test @javascriptTests
    if ($LASTEXITCODE -ne 0) { $failed += 'Node tests' }
    foreach ($test in Get-ChildItem ./tests/*.tests.ps1 | Sort-Object Name) {
        if (-not $IsWindows -and $test.Name -in $windowsOnly) {
            Write-Output "SKIP Windows API suite on this OS: $($test.Name)"
            continue
        }
        Write-Output "RUN $($test.Name)"
        & $pwsh -NoProfile -File $test.FullName
        if ($LASTEXITCODE -ne 0) { $failed += $test.Name }
    }
    foreach ($source in Get-ChildItem ./*.mjs) {
        & $node --check $source.FullName
        if ($LASTEXITCODE -ne 0) { $failed += $source.Name }
    }
    foreach ($source in Get-ChildItem ./*.ps1) {
        $parseTokens = $null
        $parseErrors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($source.FullName, [ref]$parseTokens, [ref]$parseErrors)
        if ($parseErrors.Count) { $failed += ($source.Name + ' syntax'); $parseErrors | Write-Output }
    }
    & git diff --check
    if ($LASTEXITCODE -ne 0) { $failed += 'git diff --check' }
    if ($failed.Count) { throw ('Failed: ' + ($failed -join ', ')) }
    Write-Output 'PASS: all suites applicable to this operating system'
} finally { Pop-Location }
