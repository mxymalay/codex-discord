[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
$buildScript = Join-Path $sourceRoot 'build-control-app.ps1'
$installScript = Join-Path $sourceRoot 'install-control-app.ps1'
$controlSource = Join-Path $sourceRoot 'control-app\CodexDiscordControl.cs'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('codex control app ' + [guid]::NewGuid().ToString('N'))

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-FullPathEqual {
    param([string]$Actual, [string]$Expected, [string]$Message)
    $actualFull = [System.IO.Path]::GetFullPath($Actual).TrimEnd('\')
    $expectedFull = [System.IO.Path]::GetFullPath($Expected).TrimEnd('\')
    if (-not $actualFull.Equals($expectedFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw ("{0}: actual={1}; expected={2}" -f $Message, $actualFull, $expectedFull)
    }
}

function Invoke-ChildPowerShell {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& pwsh @Arguments 2>&1)
        $code = $LASTEXITCODE
        return [pscustomobject]@{ ExitCode=$code; Output=$output }
    }
    finally { $ErrorActionPreference = $savedPreference }
}

try {
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    $buildRoot = Join-Path $testRoot 'build output with spaces'
    New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null

    Assert-True (Test-Path -LiteralPath $controlSource -PathType Leaf) 'committed C# source is missing'
    Assert-True (Test-Path -LiteralPath $buildScript -PathType Leaf) 'build script is missing'
    Assert-True (Test-Path -LiteralPath $installScript -PathType Leaf) 'installer is missing'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'CodexDiscordControl.exe'))) 'repository contains a prebuilt control executable'

    & $buildScript -OutputDirectory $buildRoot | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'control app build failed' }
    $exe = Join-Path $buildRoot 'CodexDiscordControl.exe'
    Assert-True (Test-Path -LiteralPath $exe -PathType Leaf) 'control app executable missing'

    $markerPath = Join-Path $testRoot 'fake backend calls.txt'
    $markerLiteral = $markerPath.Replace("'", "''")
    $fakeBackend = @"
[CmdletBinding()]
param([string]`$Action)
Add-Content -LiteralPath '$markerLiteral' -Value `$Action -Encoding UTF8
if (`$env:CODEX_CONTROL_APP_TEST_FAILURE -eq '1') {
    '{"ok":false,"errorCategory":"synthetic-status-failed"}'
    exit 1
}
'{"ok":true,"service":{"running":true,"autoStartEnabled":false,"mode":"temporary"},"discord":{"state":"ready","restState":"ok","lastActivityAt":"2026-09-01T12:34:56.000Z","healthState":"ready","queueState":"ready"},"desktop":{"running":false,"processCount":0},"queueCount":2}'
exit 0
"@
    Set-Content -LiteralPath (Join-Path $buildRoot 'codex-control.ps1') -Value $fakeBackend -Encoding UTF8

    $statusLines = @(& $exe --status-json | ForEach-Object { $_ })
    $statusExit = $LASTEXITCODE
    Assert-True ($statusExit -eq 0) 'headless status did not preserve a successful backend exit code'
    Assert-True ($statusLines.Count -eq 1) ("headless status did not emit exactly one JSON object (count={0}, exit={1}, backendCalled={2})" -f $statusLines.Count,$statusExit,(Test-Path -LiteralPath $markerPath))
    $status = $statusLines[0] | ConvertFrom-Json
    Assert-True ($status.ok -eq $true -and $status.service.mode -eq 'temporary' -and $status.discord.restState -eq 'ok') 'headless status did not pass through the backend status schema'
    Assert-True ((@(Get-Content -LiteralPath $markerPath) -join ',') -eq 'status') 'headless status invoked an action other than the fixed status action'

    $env:CODEX_CONTROL_APP_TEST_FAILURE = '1'
    try {
        $failureLines = @(& $exe --status-json | ForEach-Object { $_ })
        $failureExit = $LASTEXITCODE
    }
    finally { Remove-Item Env:CODEX_CONTROL_APP_TEST_FAILURE -ErrorAction SilentlyContinue }
    Assert-True ($failureExit -ne 0) 'headless status hid a backend failure exit code'
    Assert-True ($failureLines.Count -eq 1) 'failed headless status did not emit one structured JSON object'
    $failure = $failureLines[0] | ConvertFrom-Json
    Assert-True ($failure.ok -eq $false -and $failure.errorCategory -eq 'synthetic-status-failed') 'headless status replaced the structured backend failure'

    $sourceText = Get-Content -Raw -LiteralPath $controlSource
    foreach ($action in @('status','start-temporary','stop-temporary','enable-long-term','disable-long-term')) {
        Assert-True ($sourceText.Contains('"' + $action + '"')) "C# allowlist is missing $action"
    }
    Assert-True (-not $sourceText.Contains('--tool-dir')) 'control app accepts a tool-directory override'
    Assert-True ($sourceText -match 'UseShellExecute\s*=\s*false' -and $sourceText -match 'CreateNoWindow\s*=\s*true') 'backend process is not hidden and shell-free'
    Assert-True ($sourceText -notmatch 'FileName\s*=\s*"pwsh\.exe"' -and $sourceText -match 'ProgramFiles[\s\S]{0,500}PowerShell[\s\S]{0,500}["'']7["'']') 'control app does not pin the installed Program Files PowerShell 7 executable'
    Assert-True ($sourceText -match 'Task\.Run|async\s+void|async\s+Task') 'GUI backend work is not asynchronous'
    Assert-True ($sourceText -match 'Interval\s*=\s*2000') 'automatic status refresh is not two seconds'
    foreach ($button in @('临时开启','临时停止','长期启用（开机自启）','长期停用')) {
        Assert-True ($sourceText.Contains($button)) "GUI button is missing: $button"
    }
    foreach ($row in @('服务模式','服务运行','开机自启','Discord Gateway','Discord REST','最近活动')) {
        Assert-True ($sourceText.Contains($row)) "GUI status row is missing: $row"
    }
    Assert-True ($sourceText -match 'MessageBox\.Show[\s\S]{0,1000}DisableLongTerm|DisableLongTerm[\s\S]{0,1000}MessageBox\.Show') 'long-term disable lacks a local confirmation'
    Assert-True ($sourceText -match 'SetActionButtonsEnabled|actionButtons') 'action buttons are not managed as one disabled set while work runs'

    $badSourceRoot = Join-Path $testRoot 'bad compiler source'
    $badBuildRoot = Join-Path $testRoot 'bad compiler output'
    New-Item -ItemType Directory -Path (Join-Path $badSourceRoot 'control-app') -Force | Out-Null
    Copy-Item -LiteralPath $buildScript -Destination (Join-Path $badSourceRoot 'build-control-app.ps1')
    Set-Content -LiteralPath (Join-Path $badSourceRoot 'control-app\CodexDiscordControl.cs') -Value 'this is not C sharp' -Encoding UTF8
    $badBuild = Invoke-ChildPowerShell -Arguments @('-NoProfile','-File',(Join-Path $badSourceRoot 'build-control-app.ps1'),'-OutputDirectory',$badBuildRoot)
    Assert-True ($badBuild.ExitCode -ne 0) 'compiler failure returned a successful exit code'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $badBuildRoot 'CodexDiscordControl.exe'))) 'compiler failure left a usable-looking executable'

    $stagedSource = Join-Path $testRoot 'recovery source with spaces'
    $stagedControl = Join-Path $stagedSource 'control-app'
    New-Item -ItemType Directory -Path $stagedControl -Force | Out-Null
    Copy-Item -LiteralPath $controlSource -Destination (Join-Path $stagedControl 'CodexDiscordControl.cs')
    Copy-Item -LiteralPath $buildScript -Destination (Join-Path $stagedSource 'build-control-app.ps1')
    Copy-Item -LiteralPath $installScript -Destination (Join-Path $stagedSource 'install-control-app.ps1')
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'codex-control.ps1') -Destination (Join-Path $stagedSource 'codex-control.ps1')
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'codex-control-lib.ps1') -Destination (Join-Path $stagedSource 'codex-control-lib.ps1')

    $installRoot = Join-Path $testRoot 'installed tool with spaces'
    $desktopRoot = Join-Path $testRoot 'temporary Desktop with spaces'
    New-Item -ItemType Directory -Path $installRoot,$desktopRoot -Force | Out-Null
    & $installScript -ToolDir $installRoot -DesktopPath $desktopRoot -SourceRoot $stagedSource | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'control app installer failed' }

    $installedExe = Join-Path $installRoot 'CodexDiscordControl.exe'
    $installedBackend = Join-Path $installRoot 'codex-control.ps1'
    $installedLibrary = Join-Path $installRoot 'codex-control-lib.ps1'
    $shortcutPath = Join-Path $desktopRoot 'Codex Discord 控制台.lnk'
    foreach ($path in @($installedExe,$installedBackend,$installedLibrary,$shortcutPath)) {
        Assert-True (Test-Path -LiteralPath $path -PathType Leaf) "installer output is missing: $([System.IO.Path]::GetFileName($path))"
    }
    Assert-True ((Get-FileHash -LiteralPath $installedBackend).Hash -eq (Get-FileHash -LiteralPath (Join-Path $stagedSource 'codex-control.ps1')).Hash) 'installer did not copy the fixed backend exactly'
    Assert-True ((Get-FileHash -LiteralPath $installedLibrary).Hash -eq (Get-FileHash -LiteralPath (Join-Path $stagedSource 'codex-control-lib.ps1')).Hash) 'installer did not copy the backend library exactly'

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    Assert-FullPathEqual $shortcut.TargetPath $installedExe 'shortcut target is stale'
    Assert-FullPathEqual $shortcut.WorkingDirectory $installRoot 'shortcut working directory is stale'
    Assert-True ([string]::IsNullOrWhiteSpace($shortcut.Arguments)) 'shortcut injects unexpected arguments'

    Remove-Item -LiteralPath $installedExe -Force
    Remove-Item -LiteralPath $shortcutPath -Force
    & $installScript -ToolDir $installRoot -DesktopPath $desktopRoot -SourceRoot $stagedSource | Out-Null
    Assert-True (Test-Path -LiteralPath $installedExe -PathType Leaf) 'second install did not rebuild a deleted executable'
    Assert-True (Test-Path -LiteralPath $shortcutPath -PathType Leaf) 'second install did not restore a deleted shortcut'
    $restoredShortcut = $shell.CreateShortcut($shortcutPath)
    Assert-FullPathEqual $restoredShortcut.TargetPath $installedExe 'restored shortcut target is stale'
    Assert-FullPathEqual $restoredShortcut.WorkingDirectory $installRoot 'restored shortcut working directory is stale'

    $staleShortcut = $shell.CreateShortcut($shortcutPath)
    $staleShortcut.TargetPath = Join-Path $env:WINDIR 'System32\cmd.exe'
    $staleShortcut.WorkingDirectory = $env:WINDIR
    $staleShortcut.Save()
    & $installScript -ToolDir $installRoot -DesktopPath $desktopRoot -SourceRoot $stagedSource | Out-Null
    $updatedShortcut = $shell.CreateShortcut($shortcutPath)
    Assert-FullPathEqual $updatedShortcut.TargetPath $installedExe 'installer did not atomically update a stale shortcut'
    Assert-FullPathEqual $updatedShortcut.WorkingDirectory $installRoot 'installer did not update stale shortcut working directory'
    Assert-True (@(Get-ChildItem -LiteralPath $desktopRoot -File | Where-Object { $_.Name -match '\.(tmp|bak)$' }).Count -eq 0) 'successful shortcut update left temporary recovery files'

    $invalidDesktop = Join-Path $testRoot 'desktop is a file'
    $unwrittenTool = Join-Path $testRoot 'must stay empty'
    New-Item -ItemType Directory -Path $unwrittenTool -Force | Out-Null
    Set-Content -LiteralPath $invalidDesktop -Value 'not a directory'
    $invalidFailed = $false
    try { & $installScript -ToolDir $unwrittenTool -DesktopPath $invalidDesktop -SourceRoot $stagedSource }
    catch { $invalidFailed = $true }
    Assert-True $invalidFailed 'installer accepted a non-directory DesktopPath'
    Assert-True (@(Get-ChildItem -LiteralPath $unwrittenTool -Force).Count -eq 0) 'installer wrote files before validating every destination'

    $installText = Get-Content -Raw -LiteralPath $installScript
    Assert-True ($installText -notmatch 'Remove-Item[^\r\n]*-Recurse') 'installer contains recursive deletion'
    Assert-True ($installText -match 'GetFullPath|Resolve-Path') 'installer does not resolve and validate explicit paths'
    Assert-True ($installText -match '\.tmp|temporary|Guid') 'shortcut update does not use a recoverable temporary file'

    Write-Output 'PASS: Codex Discord control app build, status, and recovery install'
}
finally {
    Remove-Item Env:CODEX_CONTROL_APP_TEST_FAILURE -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $testRoot) {
        $resolved = [System.IO.Path]::GetFullPath($testRoot)
        $temp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
        if (-not $resolved.StartsWith($temp, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'refusing unsafe test cleanup' }
        Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
    }
}
