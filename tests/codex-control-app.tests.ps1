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

function Assert-TestProcessExited {
    param([Parameter(Mandatory)][int]$ProcessId, [string]$Message)
    $deadline = [datetime]::UtcNow.AddSeconds(3)
    do {
        if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 50
    } while ([datetime]::UtcNow -lt $deadline)
    throw $Message
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
if (-not [string]::IsNullOrWhiteSpace(`$env:CODEX_CONTROL_APP_TEST_PID_PATH)) {
    Set-Content -LiteralPath `$env:CODEX_CONTROL_APP_TEST_PID_PATH -Value `$PID -Encoding ASCII
}
switch (`$env:CODEX_CONTROL_APP_TEST_MODE) {
    'oversized-stdout' {
        [Console]::Out.Write(('x' * 70000))
        [Console]::Out.Flush()
        Start-Sleep -Seconds 30
        exit 1
    }
    'oversized-stderr' {
        [Console]::Error.Write(('y' * 70000))
        [Console]::Error.Flush()
        Start-Sleep -Seconds 30
        exit 1
    }
    'hang' {
        while (`$true) { Start-Sleep -Seconds 1 }
    }
}
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

    foreach ($oversizedMode in @('oversized-stdout','oversized-stderr')) {
        $pidPath = Join-Path $testRoot ($oversizedMode + '.pid')
        $env:CODEX_CONTROL_APP_TEST_MODE = $oversizedMode
        $env:CODEX_CONTROL_APP_TEST_PID_PATH = $pidPath
        $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            $oversizedLines = @(& $exe --status-json | ForEach-Object { $_ })
            $oversizedExit = $LASTEXITCODE
        }
        finally {
            $stopwatch.Stop()
            Remove-Item Env:CODEX_CONTROL_APP_TEST_MODE -ErrorAction SilentlyContinue
            Remove-Item Env:CODEX_CONTROL_APP_TEST_PID_PATH -ErrorAction SilentlyContinue
        }
        Assert-True ($stopwatch.Elapsed.TotalSeconds -lt 5) "$oversizedMode was not terminated promptly"
        Assert-True ($oversizedExit -ne 0 -and $oversizedLines.Count -eq 1) "$oversizedMode did not return one bounded failure"
        $oversizedResult = $oversizedLines[0] | ConvertFrom-Json
        Assert-True ($oversizedResult.ok -eq $false -and $oversizedResult.errorCategory -eq 'backend-output-too-large') "$oversizedMode did not return the fixed output-limit category"
        Assert-True (-not (($oversizedLines -join '').Contains('xxxx') -or ($oversizedLines -join '').Contains('yyyy'))) "$oversizedMode leaked subprocess output"
        Assert-True (Test-Path -LiteralPath $pidPath -PathType Leaf) "$oversizedMode fake backend did not start"
        Assert-TestProcessExited -ProcessId ([int](Get-Content -LiteralPath $pidPath -Raw)) -Message "$oversizedMode left its fake backend process running"
    }

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
    foreach ($row in @('桥接服务','开机自启','Codex 桌面端','Discord','最近活动','继续队列')) {
        Assert-True ($sourceText.Contains($row)) "GUI status row is missing: $row"
    }
    Assert-True ($sourceText -match 'MessageBox\.Show[\s\S]{0,1000}DisableLongTerm|DisableLongTerm[\s\S]{0,1000}MessageBox\.Show') 'long-term disable lacks a local confirmation'
    Assert-True ($sourceText -match 'SetActionButtonsEnabled|actionButtons') 'action buttons are not managed as one disabled set while work runs'

    $harnessSource = Join-Path $testRoot 'CodexControlHarness.cs'
    $harnessExe = Join-Path $buildRoot 'CodexControlHarness.exe'
    $harnessText = @'
using System;
using System.Collections.Generic;
using System.Web.Script.Serialization;

namespace CodexDiscordControl
{
    internal static class TestHarness
    {
        private static Dictionary<string, object> Parse(string json)
        {
            return new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
        }

        private static void PrintRows(StatusRows rows, string message)
        {
            Console.WriteLine(new JavaScriptSerializer().Serialize(new Dictionary<string, object> {
                { "bridge", rows.BridgeService }, { "autoStart", rows.AutoStart },
                { "desktop", rows.Desktop }, { "discord", rows.Discord },
                { "activity", rows.Activity }, { "queue", rows.Queue }, { "message", message }
            }));
        }

        internal static int Main(string[] args)
        {
            if (args.Length != 1) { return 2; }
            if (args[0] == "known") {
                PrintRows(StatusRenderer.Render(Parse("{\"service\":{\"mode\":\"temporary\",\"running\":true,\"autoStartEnabled\":false},\"desktop\":{\"running\":true},\"discord\":{\"state\":\"ready\",\"restState\":\"failed\",\"lastActivityAt\":\"2026-09-01T12:34:56.000Z\"},\"queueCount\":12}")), null);
                return 0;
            }
            if (args[0] == "wrong-types") {
                PrintRows(StatusRenderer.Render(Parse("{\"service\":{\"mode\":2,\"running\":\"yes\",\"autoStartEnabled\":1},\"desktop\":{\"running\":\"no\"},\"discord\":{\"state\":3,\"restState\":false,\"lastActivityAt\":1},\"queueCount\":\"12\"}")), null);
                return 0;
            }
            if (args[0] == "post-action-status-failed") {
                BackendResult failedStatus = new BackendResult { Ok=false, ExitCode=1, ErrorCategory="synthetic" };
                ActionPresentation view = StatusRenderer.AfterSuccessfulAction(ControlAction.StartTemporary, failedStatus);
                PrintRows(view.Rows, view.Message);
                return 0;
            }
            if (args[0] == "short-timeout") {
                BackendResult result = Program.InvokeBackendForTest(ControlAction.Status, 2000, 600);
                Console.WriteLine(new JavaScriptSerializer().Serialize(new Dictionary<string, object> {
                    { "ok", result.Ok }, { "errorCategory", Program.FixedErrorCategory(result) }, { "exitCode", result.ExitCode }
                }));
                return 0;
            }
            return 2;
        }
    }
}
'@
    Set-Content -LiteralPath $harnessSource -Value $harnessText -Encoding UTF8
    $compiler = @(
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $compiler /nologo /target:exe /optimize+ /warnaserror+ /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.Windows.Forms.dll "/main:CodexDiscordControl.TestHarness" "/out:$harnessExe" $controlSource $harnessSource
        $harnessCompileExit = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedPreference }
    Assert-True ($harnessCompileExit -eq 0 -and (Test-Path -LiteralPath $harnessExe -PathType Leaf)) 'testable status renderer/backend seam did not compile'

    $knownRows = (& $harnessExe known | ConvertFrom-Json)
    Assert-True ($knownRows.bridge -eq '模式：临时运行 · 状态：运行中') 'bridge row did not combine known mode and running state'
    Assert-True ($knownRows.autoStart -eq '已停用') 'auto-start row did not render its known boolean'
    Assert-True ($knownRows.desktop -eq '运行中') 'desktop row did not render desktop.running'
    Assert-True ($knownRows.discord -eq 'Gateway：已连接 · REST：故障') 'Discord row did not keep Gateway and REST separately visible'
    Assert-True ($knownRows.activity -match '^2026-09-01 ') 'activity row did not render the known timestamp'
    Assert-True ($knownRows.queue -eq '12 条') 'queue row did not render queueCount'

    $wrongRows = (& $harnessExe wrong-types | ConvertFrom-Json)
    Assert-True ($wrongRows.bridge -eq '模式：未知 · 状态：未知') 'wrong bridge field types did not fail closed'
    Assert-True ($wrongRows.autoStart -eq '未知' -and $wrongRows.desktop -eq '未知') 'wrong boolean field types did not fail closed'
    Assert-True ($wrongRows.discord -eq 'Gateway：未知 · REST：未知') 'wrong Discord field types did not fail closed'
    Assert-True ($wrongRows.activity -eq '未知' -and $wrongRows.queue -eq '未知') 'wrong activity/queue field types did not fail closed'

    $postAction = (& $harnessExe post-action-status-failed | ConvertFrom-Json)
    Assert-True ($postAction.message -eq '操作已完成，但状态刷新失败。') 'successful action followed by failed status did not explain the uncertainty'
    $stalePostActionRows = @(@($postAction.bridge,$postAction.autoStart,$postAction.desktop,$postAction.discord,$postAction.activity,$postAction.queue) | Where-Object { $_ -ne '未知' })
    Assert-True ($stalePostActionRows.Count -eq 0) 'failed post-action refresh retained stale status values'

    $timeoutPidPath = Join-Path $testRoot 'timeout.pid'
    $env:CODEX_CONTROL_APP_TEST_MODE = 'hang'
    $env:CODEX_CONTROL_APP_TEST_PID_PATH = $timeoutPidPath
    $timeoutWatch = [System.Diagnostics.Stopwatch]::StartNew()
    try { $timeoutResult = (& $harnessExe short-timeout | ConvertFrom-Json) }
    finally {
        $timeoutWatch.Stop()
        Remove-Item Env:CODEX_CONTROL_APP_TEST_MODE -ErrorAction SilentlyContinue
        Remove-Item Env:CODEX_CONTROL_APP_TEST_PID_PATH -ErrorAction SilentlyContinue
    }
    Assert-True ($timeoutWatch.Elapsed.TotalSeconds -lt 6) 'never-ending backend was not bounded by the injected internal deadline'
    Assert-True ($timeoutResult.ok -eq $false -and $timeoutResult.errorCategory -eq 'backend-timeout') 'never-ending backend did not return the fixed timeout category'
    Assert-True (Test-Path -LiteralPath $timeoutPidPath -PathType Leaf) 'timeout fake backend did not start'
    Assert-TestProcessExited -ProcessId ([int](Get-Content -LiteralPath $timeoutPidPath -Raw)) -Message 'timeout left its fake backend process running'

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

    $installedExe = Join-Path $installRoot 'CodexDiscordControl.exe'
    $installedBackend = Join-Path $installRoot 'codex-control.ps1'
    $installedLibrary = Join-Path $installRoot 'codex-control-lib.ps1'
    $shortcutPath = Join-Path $desktopRoot 'Codex Discord 控制台.lnk'
    $shell = New-Object -ComObject WScript.Shell

    Set-Content -LiteralPath $installedExe -Value 'old-executable' -Encoding ASCII
    Set-Content -LiteralPath $installedBackend -Value 'old-backend' -Encoding ASCII
    Set-Content -LiteralPath $installedLibrary -Value 'old-library' -Encoding ASCII
    $oldShortcutTarget = Join-Path $env:WINDIR 'System32\notepad.exe'
    $oldShortcut = $shell.CreateShortcut($shortcutPath)
    $oldShortcut.TargetPath = $oldShortcutTarget
    $oldShortcut.WorkingDirectory = $desktopRoot
    $oldShortcut.Save()
    $oldBundleHashes = @{
        exe = (Get-FileHash -LiteralPath $installedExe).Hash
        backend = (Get-FileHash -LiteralPath $installedBackend).Hash
        library = (Get-FileHash -LiteralPath $installedLibrary).Hash
        shortcut = (Get-FileHash -LiteralPath $shortcutPath).Hash
    }

    foreach ($failureStep in @('after-executable','after-backend','after-library','before-shortcut')) {
        $injectedFailure = $null
        try { & $installScript -ToolDir $installRoot -DesktopPath $desktopRoot -SourceRoot $stagedSource -FailureInjectionStep $failureStep | Out-Null }
        catch { $injectedFailure = $_.Exception.Message }
        Assert-True ($injectedFailure -eq "injected-install-failure:$failureStep") "installer did not reach the deterministic $failureStep failure injection"
        Assert-True ((Get-FileHash -LiteralPath $installedExe).Hash -eq $oldBundleHashes.exe) "$failureStep did not restore the old executable"
        Assert-True ((Get-FileHash -LiteralPath $installedBackend).Hash -eq $oldBundleHashes.backend) "$failureStep did not restore the old backend"
        Assert-True ((Get-FileHash -LiteralPath $installedLibrary).Hash -eq $oldBundleHashes.library) "$failureStep did not restore the old library"
        Assert-True ((Get-FileHash -LiteralPath $shortcutPath).Hash -eq $oldBundleHashes.shortcut) "$failureStep changed the old shortcut"
        $rolledBackShortcut = $shell.CreateShortcut($shortcutPath)
        Assert-FullPathEqual $rolledBackShortcut.TargetPath $oldShortcutTarget "$failureStep did not restore the shortcut target"
        Assert-FullPathEqual $rolledBackShortcut.WorkingDirectory $desktopRoot "$failureStep did not restore the shortcut working directory"
        Assert-True (@(Get-ChildItem -LiteralPath $installRoot,$desktopRoot -Force | Where-Object { $_.Name -match '(?i)codex-control-install|\.stage|\.backup|\.bak|\.tmp' }).Count -eq 0) "$failureStep rollback left transaction artifacts"
    }

    $emptyInstallRoot = Join-Path $testRoot 'empty install rollback'
    $emptyDesktopRoot = Join-Path $testRoot 'empty desktop rollback'
    New-Item -ItemType Directory -Path $emptyInstallRoot,$emptyDesktopRoot -Force | Out-Null
    $emptyFailure = $null
    try { & $installScript -ToolDir $emptyInstallRoot -DesktopPath $emptyDesktopRoot -SourceRoot $stagedSource -FailureInjectionStep 'after-executable' | Out-Null }
    catch { $emptyFailure = $_.Exception.Message }
    Assert-True ($emptyFailure -eq 'injected-install-failure:after-executable') 'installer did not reach the no-old-bundle failure injection'
    foreach ($unexpected in @(
        (Join-Path $emptyInstallRoot 'CodexDiscordControl.exe'),
        (Join-Path $emptyInstallRoot 'codex-control.ps1'),
        (Join-Path $emptyInstallRoot 'codex-control-lib.ps1'),
        (Join-Path $emptyDesktopRoot 'Codex Discord 控制台.lnk')
    )) { Assert-True (-not (Test-Path -LiteralPath $unexpected)) 'failed first install left a partial bundle' }
    Assert-True (@(Get-ChildItem -LiteralPath $emptyInstallRoot,$emptyDesktopRoot -Force).Count -eq 0) 'failed first install left staging or backup artifacts'

    & $installScript -ToolDir $installRoot -DesktopPath $desktopRoot -SourceRoot $stagedSource | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'control app installer failed' }

    foreach ($path in @($installedExe,$installedBackend,$installedLibrary,$shortcutPath)) {
        Assert-True (Test-Path -LiteralPath $path -PathType Leaf) "installer output is missing: $([System.IO.Path]::GetFileName($path))"
    }
    Assert-True ((Get-FileHash -LiteralPath $installedBackend).Hash -eq (Get-FileHash -LiteralPath (Join-Path $stagedSource 'codex-control.ps1')).Hash) 'installer did not copy the fixed backend exactly'
    Assert-True ((Get-FileHash -LiteralPath $installedLibrary).Hash -eq (Get-FileHash -LiteralPath (Join-Path $stagedSource 'codex-control-lib.ps1')).Hash) 'installer did not copy the backend library exactly'

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
