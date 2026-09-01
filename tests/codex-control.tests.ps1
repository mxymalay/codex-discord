[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $sourceRoot 'codex-control-lib.ps1')

$programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
$trusted = Join-Path $programFiles 'WindowsApps\OpenAI.Codex_1.2.3.0_x64__publisher\app\ChatGPT.exe'
$trustedChild = $trusted

if (-not (Test-CodexDesktopRootPath -Path $trusted)) {
    throw 'trusted Store ChatGPT path was not accepted'
}
$boundStartTime = ConvertTo-ControlCreationTime -Value '20260901120000.000000+480'
if (-not (Test-CodexBoundProcessIdentity -BoundProcess ([pscustomobject]@{ ProcessId=42; StartTimeUtc=$boundStartTime.UtcDateTime }) -ProcessId 42 -CreationDate '20260901120000.000000+480')) {
    throw 'bound process identity did not validate a held process object start time'
}
foreach ($tickRemainder in 1..9) {
    if (-not (Test-CodexBoundProcessIdentity -BoundProcess ([pscustomobject]@{ ProcessId=42; StartTimeUtc=$boundStartTime.UtcDateTime.AddTicks($tickRemainder) }) -ProcessId 42 -CreationDate '20260901120000.000000+480')) {
        throw "bound process identity rejected the same CIM-microsecond process at +$tickRemainder ticks"
    }
}
foreach ($differentMicrosecond in @(10, 11, 19, 20)) {
    if (Test-CodexBoundProcessIdentity -BoundProcess ([pscustomobject]@{ ProcessId=42; StartTimeUtc=$boundStartTime.UtcDateTime.AddTicks($differentMicrosecond) }) -ProcessId 42 -CreationDate '20260901120000.000000+480') {
        throw "bound process identity accepted a process created +$differentMicrosecond ticks later"
    }
}
foreach ($untrustedPath in @(
    'D:\Program Files\WindowsApps\OpenAI.Codex_1.2.3.0_x64__publisher\app\ChatGPT.exe',
    (Join-Path $programFiles 'WindowsApps\OpenAI.Codex_1.2.3.0_x64__publisher\app\ChatGPT.exe\child.exe'),
    (Join-Path $programFiles 'WindowsApps\OpenAI.Other_1.2.3.0_x64__publisher\app\ChatGPT.exe')
)) {
    if (Test-CodexDesktopRootPath -Path $untrustedPath) {
        throw "ambiguous or non-Codex Store path was accepted: $untrustedPath"
    }
}

$processes = @(
    [pscustomobject]@{ ProcessId=100; ParentProcessId=10; Name='ChatGPT.exe'; ExecutablePath=$trusted; CreationDate='20260901120000.000000+480' },
    [pscustomobject]@{ ProcessId=101; ParentProcessId=100; Name='codex.exe'; ExecutablePath='C:\Users\test\AppData\Local\OpenAI\Codex\bin\v\codex.exe'; CreationDate='20260901120001.000000+480' },
    [pscustomobject]@{ ProcessId=102; ParentProcessId=100; Name='ChatGPT.exe'; ExecutablePath=$trustedChild; CreationDate='20260901120002.000000+480' },
    [pscustomobject]@{ ProcessId=103; ParentProcessId=102; Name='utility.exe'; ExecutablePath=$trustedChild; CreationDate='20260901120003.000000+480' },
    [pscustomobject]@{ ProcessId=200; ParentProcessId=10; Name='codex.exe'; ExecutablePath='C:\tools\codex.exe'; CreationDate='20260901120004.000000+480' }
)
$plan = Get-CodexDesktopProcessPlan -Processes $processes
if ((@($plan.Roots).ProcessId -join ',') -ne '100') { throw 'trusted root selection included a Store helper or missed root' }
if ((@($plan.ProcessIds) -join ',') -ne '100,101,102,103') { throw 'tree boundary is wrong' }
if ($plan.CreationTimes[100] -ne '20260901120000.000000+480') { throw 'root creation time was not captured for revalidation' }

$invalidPackageParent = @(
    [pscustomobject]@{ ProcessId=200; ParentProcessId=10; Name='ChatGPT.exe'; ExecutablePath=$trusted; CreationDate=$null },
    [pscustomobject]@{ ProcessId=201; ParentProcessId=200; Name='ChatGPT.exe'; ExecutablePath=$trusted; CreationDate='20260901130001.000000+480' }
)
$invalidPackageParentPlan = Get-CodexDesktopProcessPlan -Processes $invalidPackageParent
if (@($invalidPackageParentPlan.Roots).Count -ne 0) {
    throw 'canonical renderer was promoted to a root when its same-package parent was unverifiable'
}

$reusedDesktopParent = @(
    [pscustomobject]@{ ProcessId=100; ParentProcessId=10; Name='ChatGPT.exe'; ExecutablePath=$trusted; CreationDate='20260901130000.000000+480' },
    [pscustomobject]@{ ProcessId=500; ParentProcessId=10; Name='node.exe'; ExecutablePath='C:\Program Files\nodejs\node.exe'; CreationDate='20260901110000.000000+480' },
    [pscustomobject]@{ ProcessId=101; ParentProcessId=100; Name='codex.exe'; ExecutablePath='C:\Users\test\AppData\Local\OpenAI\Codex\bin\v\codex.exe'; CreationDate='20260901120000.000000+480' }
)
$reusedDesktopParentPlan = Get-CodexDesktopProcessPlan -Processes $reusedDesktopParent
if (-not $reusedDesktopParentPlan.PSObject.Properties['IsValid'] -or $reusedDesktopParentPlan.IsValid) {
    throw 'bridge app-server with an old reused parent PID did not invalidate the desktop tree'
}

function Assert-UnverifiableCodexTreeFailsBeforeOperations {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][object[]]$Processes
    )

    $invalidPlan = Get-CodexDesktopProcessPlan -Processes $Processes
    if (-not $invalidPlan.PSObject.Properties['IsValid'] -or $invalidPlan.IsValid) {
        throw "$Name did not invalidate the Codex process plan"
    }
    $callState = [pscustomobject]@{ open=0; close=0; stop=0 }
    $invalidResult = Stop-CodexDesktop -Operations @{
        GetProcesses = { $Processes }
        OpenProcess = { param($processId) $callState.open++; throw 'invalid tree must not open a process' }
        RequestClose = { param($bound) $callState.close++ }
        StopProcess = { param($bound) $callState.stop++ }
        Sleep = { param($milliseconds) }
    } -GraceMilliseconds 0
    if ($invalidResult.ok -or $callState.open -ne 0 -or $callState.close -ne 0 -or $callState.stop -ne 0) {
        throw "$Name performed a process operation after tree verification failed"
    }
}

Assert-UnverifiableCodexTreeFailsBeforeOperations -Name 'same-package parent with invalid ParentProcessId' -Processes @(
    [pscustomobject]@{ ProcessId=210; ParentProcessId='invalid'; Name='ChatGPT.exe'; ExecutablePath=$trusted; CreationDate='20260901130000.000000+480' },
    [pscustomobject]@{ ProcessId=211; ParentProcessId=210; Name='ChatGPT.exe'; ExecutablePath=$trusted; CreationDate='20260901130001.000000+480' }
)
Assert-UnverifiableCodexTreeFailsBeforeOperations -Name 'trusted root with missing ParentProcessId' -Processes @(
    [pscustomobject]@{ ProcessId=215; ParentProcessId=$null; Name='ChatGPT.exe'; ExecutablePath=$trusted; CreationDate='20260901130000.000000+480' }
)
Assert-UnverifiableCodexTreeFailsBeforeOperations -Name 'direct descendant with invalid CreationDate' -Processes @(
    [pscustomobject]@{ ProcessId=220; ParentProcessId=10; Name='ChatGPT.exe'; ExecutablePath=$trusted; CreationDate='20260901130000.000000+480' },
    [pscustomobject]@{ ProcessId=221; ParentProcessId=220; Name='codex.exe'; ExecutablePath='C:\Users\test\AppData\Local\OpenAI\Codex\bin\v\codex.exe'; CreationDate='invalid' }
)
Assert-UnverifiableCodexTreeFailsBeforeOperations -Name 'deep descendant with invalid CreationDate' -Processes @(
    [pscustomobject]@{ ProcessId=230; ParentProcessId=10; Name='ChatGPT.exe'; ExecutablePath=$trusted; CreationDate='20260901130000.000000+480' },
    [pscustomobject]@{ ProcessId=231; ParentProcessId=230; Name='renderer.exe'; ExecutablePath=$trusted; CreationDate='20260901130001.000000+480' },
    [pscustomobject]@{ ProcessId=232; ParentProcessId=231; Name='utility.exe'; ExecutablePath=$trusted; CreationDate='invalid' }
)
$invalidExecutablePath = 'C:\invalid' + [char]0
Assert-UnverifiableCodexTreeFailsBeforeOperations -Name 'direct descendant with missing ExecutablePath' -Processes @(
    [pscustomobject]@{ ProcessId=240; ParentProcessId=10; Name='ChatGPT.exe'; ExecutablePath=$trusted; CreationDate='20260901130000.000000+480' },
    [pscustomobject]@{ ProcessId=241; ParentProcessId=240; Name='codex.exe'; ExecutablePath=$null; CreationDate='20260901130001.000000+480' }
)
Assert-UnverifiableCodexTreeFailsBeforeOperations -Name 'deep descendant with an unnormalizable ExecutablePath' -Processes @(
    [pscustomobject]@{ ProcessId=250; ParentProcessId=10; Name='ChatGPT.exe'; ExecutablePath=$trusted; CreationDate='20260901130000.000000+480' },
    [pscustomobject]@{ ProcessId=251; ParentProcessId=250; Name='renderer.exe'; ExecutablePath=$trusted; CreationDate='20260901130001.000000+480' },
    [pscustomobject]@{ ProcessId=252; ParentProcessId=251; Name='utility.exe'; ExecutablePath=$invalidExecutablePath; CreationDate='20260901130002.000000+480' }
)

$events = [System.Collections.Generic.List[string]]::new()
$boundProcesses = @{}
$boundProcessState = [pscustomobject]@{ nextId = 0 }
$ops = @{
    GetProcesses = { $processes }
    OpenProcess = {
        param($processId)
        $boundProcessState.nextId++
        $process = @($processes | Where-Object { $_.ProcessId -eq $processId })[0]
        $bound = [pscustomobject]@{ ProcessId=$processId; CreationDate=$process.CreationDate; bindingId=$boundProcessState.nextId }
        $boundProcesses[$bound.bindingId] = $bound
        return $bound
    }
    RequestClose = { param($bound) if (-not [object]::ReferenceEquals($boundProcesses[$bound.bindingId], $bound)) { throw 'close did not receive the bound process object' }; $events.Add("close:$($bound.bindingId)"); $false }
    StopProcess = { param($bound) if (-not [object]::ReferenceEquals($boundProcesses[$bound.bindingId], $bound)) { throw 'stop did not receive the bound process object' }; $events.Add("stop:$($bound.ProcessId):$($bound.CreationDate):$($bound.bindingId)") }
    Sleep = { param($milliseconds) $events.Add("sleep:${milliseconds}") }
}
$result = Stop-CodexDesktop -Operations $ops -GraceMilliseconds 10
if (-not $result.ok -or $result.stoppedProcessCount -ne 4) { throw 'verified tree was not stopped' }
$rootStop = @($events | ForEach-Object { if ($_ -like 'stop:100:20260901120000.000000+480:*') { $_ } })[0]
foreach ($childStop in @(
    'stop:101:20260901120001.000000+480:*',
    'stop:102:20260901120002.000000+480:*',
    'stop:103:20260901120003.000000+480:*'
)) {
    $matchedChildStop = @($events | ForEach-Object { if ($_ -like $childStop) { $_ } })[0]
    if ($null -eq $matchedChildStop -or $events.IndexOf($matchedChildStop) -gt $events.IndexOf($rootStop)) {
        throw 'verified descendants did not stop before the root'
    }
}
if (@($events | Where-Object { $_ -like 'stop:200:*' }).Count -ne 0) { throw 'untrusted codex process was stopped' }

$reusedEvents = [System.Collections.Generic.List[string]]::new()
$reusedResult = Stop-CodexDesktop -Operations @{
    GetProcesses = { $reusedDesktopParent }
    OpenProcess = { param($processId) $process = @($reusedDesktopParent | Where-Object { $_.ProcessId -eq $processId })[0]; [pscustomobject]@{ ProcessId=$processId; CreationDate=$process.CreationDate } }
    RequestClose = { param($bound) $reusedEvents.Add("close:$($bound.ProcessId)") }
    StopProcess = { param($bound) $reusedEvents.Add("stop:$($bound.ProcessId)") }
    Sleep = { param($milliseconds) }
} -GraceMilliseconds 0
if ($reusedResult.ok -or $reusedEvents.Count -ne 0) {
    throw 'bridge app-server tree did not fail closed after its old desktop parent PID was reused'
}

$changedRoot = @(
    [pscustomobject]@{ ProcessId=100; ParentProcessId=10; Name='ChatGPT.exe'; ExecutablePath=$trusted; CreationDate='20260901130000.000000+480' }
)
$revalidationState = [pscustomobject]@{ callCount = 0 }
$revalidationEvents = [System.Collections.Generic.List[string]]::new()
$revalidationOps = @{
    GetProcesses = { $revalidationState.callCount++; if ($revalidationState.callCount -eq 1) { $processes } else { $changedRoot } }
    OpenProcess = { param($processId) $process = @($processes | Where-Object { $_.ProcessId -eq $processId })[0]; [pscustomobject]@{ ProcessId=$processId; CreationDate=$process.CreationDate } }
    RequestClose = { param($bound) $revalidationEvents.Add("close:$($bound.ProcessId)"); $true }
    StopProcess = { param($bound) $revalidationEvents.Add("stop:$($bound.ProcessId):$($bound.CreationDate)") }
    Sleep = { param($milliseconds) $revalidationEvents.Add("sleep:${milliseconds}") }
}
$revalidationResult = Stop-CodexDesktop -Operations $revalidationOps -GraceMilliseconds 0
if ($revalidationResult.ok -or @($revalidationEvents | Where-Object { $_ -like 'stop:*' }).Count -ne 0) {
    throw 'PID reuse with a changed creation time did not fail closed'
}

$untrustedOnly = @([pscustomobject]@{ ProcessId=300; ParentProcessId=1; Name='ChatGPT.exe'; ExecutablePath='D:\WindowsApps\OpenAI.Codex_x\app\ChatGPT.exe'; CreationDate='20260901140000.000000+480' })
$untrustedEvents = [System.Collections.Generic.List[string]]::new()
$untrustedResult = Stop-CodexDesktop -Operations @{
    GetProcesses = { $untrustedOnly }
    OpenProcess = { param($processId) throw 'untrusted process must not be opened' }
    RequestClose = { param($bound) $untrustedEvents.Add("close:$($bound.ProcessId)") }
    StopProcess = { param($bound) $untrustedEvents.Add("stop:$($bound.ProcessId)") }
    Sleep = { param($milliseconds) $untrustedEvents.Add("sleep:${milliseconds}") }
} -GraceMilliseconds 0
if (-not $untrustedResult.ok -or -not $untrustedResult.alreadyStopped -or $untrustedEvents.Count -ne 0) {
    throw 'ambiguous path did not fail closed without a stop operation'
}

$status = Get-CodexControlStatus -Operations @{ GetProcesses = { $processes } } -ToolDir $sourceRoot
if (-not $status.ok -or -not $status.codexDesktop.running -or $status.codexDesktop.processCount -ne 4) {
    throw 'control status did not report the trusted process plan'
}

function New-FakeBridgeOperations {
    param([Parameter(Mandatory)][hashtable]$State)

    $operations = @{
        GetTask = { [pscustomobject]@{ installed=$State.installed; enabled=$State.enabled; running=($State.running -and $State.mode -eq 'scheduled') } }
        GetProcesses = {
            if (-not $State.running) { return @() }
            return @([pscustomobject]@{ ProcessId=501; CreationTimeUtc='2026-09-01T12:00:00.0000000Z' })
        }
        GetRuntime = {
            if (-not $State.running) { return $null }
            return [pscustomobject]@{ processId=501; creationTimeUtc='2026-09-01T12:00:00.0000000Z'; mode=$State.mode }
        }
        InstallTask = { $State.installed=$true }
        EnableTask = { $State.enabled=$true }
        DisableTask = { $State.enabled=$false }
        StartTask = { $State.running=$true; $State.mode='scheduled' }
        StopTask = { $State.running=$false; $State.mode=$null }
        StartDetached = { param($startupPath,$mode) $State.running=$true; $State.mode=$mode }
        StopRuntime = { param($runtime) if ($runtime.processId -ne 501) { throw 'wrong runtime stopped' }; $State.running=$false; $State.mode=$null }
    }
    foreach ($name in @($operations.Keys)) { $operations[$name] = $operations[$name].GetNewClosure() }
    return $operations
}

$bridgeRuntimeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('codex-bridge-runtime-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $bridgeRuntimeRoot -Force | Out-Null
    $runtimePath = Join-Path $bridgeRuntimeRoot 'discord-bridge-runtime.json'
    [void](Write-BridgeRuntimeIdentity -Path $runtimePath -Mode temporary -ProcessId 501 -CreationTimeUtc '2026-09-01T12:00:00.0000000Z' -ToolDir $bridgeRuntimeRoot)
    $runtime = Read-ValidatedBridgeRuntimeIdentity -Path $runtimePath -Processes @([pscustomobject]@{ ProcessId=501; CreationTimeUtc='2026-09-01T12:00:00.0000000Z' }) -ToolDir $bridgeRuntimeRoot
    if ($null -eq $runtime -or $runtime.mode -ne 'temporary' -or $runtime.processId -ne 501) {
        throw 'runtime identity did not validate its matching synthetic supervisor'
    }
    if ($null -ne (Read-ValidatedBridgeRuntimeIdentity -Path $runtimePath -Processes @([pscustomobject]@{ ProcessId=501; CreationTimeUtc='2026-09-01T12:00:01.0000000Z' }) -ToolDir $bridgeRuntimeRoot)) {
        throw 'runtime identity accepted a reused PID with a different creation time'
    }
    if ($null -ne (Read-ValidatedBridgeRuntimeIdentity -Path $runtimePath -Processes @([pscustomobject]@{ ProcessId=501; CreationTimeUtc='2026-09-01T12:00:00.0000000Z' }) -ToolDir (Join-Path $bridgeRuntimeRoot 'other-tool-dir'))) {
        throw 'runtime identity accepted a different tool directory'
    }
    [void](Remove-BridgeRuntimeIdentity -Path $runtimePath -ExpectedProcessId 502)
    if (-not (Test-Path -LiteralPath $runtimePath)) { throw 'runtime cleanup removed a different supervisor identity' }
    [void](Remove-BridgeRuntimeIdentity -Path $runtimePath -ExpectedProcessId 501)
    if (Test-Path -LiteralPath $runtimePath) { throw 'runtime cleanup did not remove its matching supervisor identity' }
}
finally {
    Remove-Item -LiteralPath $bridgeRuntimeRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$bridgeState = @{ installed=$false; enabled=$false; running=$false; mode=$null }
$bridgeOps = New-FakeBridgeOperations -State $bridgeState
$startTemporary = Invoke-CodexBridgeServiceAction -Action 'start-temporary' -ToolDir $sourceRoot -Operations $bridgeOps
if (-not $startTemporary.ok) { throw "temporary start failed: $($startTemporary.errorCategory)" }
if (-not $bridgeState.running -or $bridgeState.enabled -or $bridgeState.mode -ne 'temporary') { throw 'temporary start changed long-term setting or did not use detached ownership' }
$enableLongTerm = Invoke-CodexBridgeServiceAction -Action 'enable-long-term' -ToolDir $sourceRoot -Operations $bridgeOps
if (-not $enableLongTerm.ok) { throw "long-term enable failed: $($enableLongTerm.errorCategory)" }
if (-not $bridgeState.running -or -not $bridgeState.enabled -or $bridgeState.mode -ne 'scheduled') { throw 'long-term enable did not adopt scheduled ownership' }
$stopTemporary = Invoke-CodexBridgeServiceAction -Action 'stop-temporary' -ToolDir $sourceRoot -Operations $bridgeOps
if (-not $stopTemporary.ok) { throw "temporary stop failed: $($stopTemporary.errorCategory)" }
if ($bridgeState.running -or -not $bridgeState.enabled) { throw 'temporary stop changed long-term setting' }
$disableLongTerm = Invoke-CodexBridgeServiceAction -Action 'disable-long-term' -ToolDir $sourceRoot -Operations $bridgeOps
if (-not $disableLongTerm.ok) { throw "long-term disable failed: $($disableLongTerm.errorCategory)" }
if ($bridgeState.running -or $bridgeState.enabled) { throw 'long-term disable did not persist' }

$entrypoint = Join-Path $sourceRoot 'codex-control.ps1'
$invalidJson = @(& pwsh -NoProfile -File $entrypoint -Action 'arbitrary-action' 2>$null)
if ($LASTEXITCODE -eq 0) { throw 'entrypoint accepted an arbitrary action' }
if ($invalidJson.Count -ne 1) { throw 'entrypoint did not emit exactly one stdout JSON object' }
if ($invalidJson[0].TrimStart().StartsWith('[')) { throw 'entrypoint emitted a JSON array instead of one top-level object' }
$invalidResult = $invalidJson[0] | ConvertFrom-Json
if ($invalidResult.ok -or $invalidResult.errorCategory -ne 'invalid-action') { throw 'entrypoint did not emit a fixed-action JSON error' }

Write-Output 'PASS: Codex desktop control boundaries'
