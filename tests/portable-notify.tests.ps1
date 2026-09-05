[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-portable-notify-' + [guid]::NewGuid().ToString('N'))
$originalCodexHome = $env:CODEX_HOME
$originalUserProfile = $env:USERPROFILE
$originalPath = $env:PATH
$failures = [Collections.Generic.List[string]]::new()
function Test-Case([string]$Name, [scriptblock]$Action) {
    try { & $Action; Write-Output "PASS: $Name" }
    catch { $failures.Add("${Name}: $($_.Exception.Message)") }
}
function Write-Text([string]$Path, [string]$Text) {
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path))
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}
try {
    $env:CODEX_HOME = Join-Path $testRoot 'custom codex home'
    $env:USERPROFILE = $null
    $env:PATH = $PSHOME + [IO.Path]::PathSeparator + $originalPath
    $packageDir = Join-Path $testRoot 'package directory'
    [void][IO.Directory]::CreateDirectory($packageDir)
    Copy-Item (Join-Path $sourceRoot 'dispatcher.ps1') (Join-Path $packageDir 'dispatcher.ps1')
    Write-Text (Join-Path $packageDir 'config.json') '{"enabled":false,"quotaNotifications":false,"previousNotify":[]}'
    Write-Text (Join-Path $env:CODEX_HOME 'mobile-notify/dispatcher.ps1') 'param()'
    $tomlPath = Join-Path $env:CODEX_HOME 'config.toml'
    $wrapperName = if ($IsWindows) { 'codex-computer-use.exe' } else { 'codex-computer-use' }
    $legacy = 'notify = ["/Applications/Previous/' + $wrapperName + '", "turn-ended", "--previous-notify", "[\"old-runtime\"]"]'
    Write-Text $tomlPath ($legacy + "`nmodel = `"example`"`n")
    Test-Case 'repair resolves CODEX_HOME and current PowerShell without USERPROFILE' {
        $runtime = Join-Path $PSHOME $(if ($IsWindows) { 'pwsh.exe' } else { 'pwsh' })
        $start = [Diagnostics.ProcessStartInfo]::new($runtime)
        foreach ($arg in @('-NoProfile', '-File', (Join-Path $sourceRoot 'repair-notify.ps1'), '-Quiet')) { [void]$start.ArgumentList.Add($arg) }
        $start.UseShellExecute = $false
        $start.RedirectStandardError = $true
        $child = [Diagnostics.Process]::Start($start)
        try {
            $errorText = $child.StandardError.ReadToEnd()
            $child.WaitForExit()
            if ($child.ExitCode -ne 0) { throw "Repair failed: $errorText" }
        } finally { $child.Dispose() }
        $updated = [IO.File]::ReadAllText($tomlPath)
        if (-not $updated.Contains($wrapperName) -or -not $updated.Contains('--previous-notify')) { throw 'Existing Codex wrapper was lost' }
        if (-not $updated.Contains('mobile-notify') -or $updated.Contains('old-runtime')) { throw 'Nested notifier was not repaired' }
        if (-not $updated.Contains('model = "example"')) { throw 'Unrelated TOML setting was changed' }
    }
    Test-Case 'dispatcher uses explicit CODEX_HOME outside installed mobile-notify' {
        & {
            . (Join-Path $packageDir 'dispatcher.ps1') -NotificationJson '{"type":"ignored"}'
            if ($codexRoot -cne $env:CODEX_HOME) { throw 'Dispatcher resolved session data from the package parent instead of CODEX_HOME' }
        }
    }
    Test-Case 'previous notifier resolves executable from PATH and preserves JSON arguments' {
        $capture = Join-Path $testRoot 'captured.json'
        $captureScript = Join-Path $packageDir 'capture arguments.ps1'
        Write-Text $captureScript 'param([string]$Destination,[string]$Notification) [IO.File]::WriteAllText($Destination,$Notification)'
        $config = @{enabled=$false; quotaNotifications=$false; previousNotify=@('pwsh','-NoProfile','-File',$captureScript,$capture)}
        Write-Text (Join-Path $packageDir 'config.json') ($config | ConvertTo-Json -Depth 4)
        $raw = @{type='agent-turn-complete'; value='引号 "literal" and backslash \ end'} | ConvertTo-Json -Compress
        & (Join-Path $packageDir 'dispatcher.ps1') -NotificationJson $raw -SkipTaskNotification
        if (-not (Test-Path $capture)) { throw 'PATH-based notifier was never invoked' }
        if ([IO.File]::ReadAllText($capture) -cne $raw) { throw 'Previous notifier received changed JSON' }
    }
    if ($failures.Count -gt 0) { throw ($failures -join "`n") }
}
finally {
    $env:CODEX_HOME = $originalCodexHome
    $env:USERPROFILE = $originalUserProfile
    $env:PATH = $originalPath
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
