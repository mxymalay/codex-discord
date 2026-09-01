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
if ((@($reusedDesktopParentPlan.ProcessIds) -join ',') -ne '100') {
    throw 'bridge app-server with an old reused parent PID was included in the desktop tree'
}

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
if (-not $reusedResult.ok -or $reusedEvents -contains 'stop:101') {
    throw 'bridge app-server was stopped after its old desktop parent PID was reused'
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

$entrypoint = Join-Path $sourceRoot 'codex-control.ps1'
$invalidJson = @(& pwsh -NoProfile -File $entrypoint -Action 'arbitrary-action' 2>$null)
if ($LASTEXITCODE -eq 0) { throw 'entrypoint accepted an arbitrary action' }
if ($invalidJson.Count -ne 1) { throw 'entrypoint did not emit exactly one stdout JSON object' }
if ($invalidJson[0].TrimStart().StartsWith('[')) { throw 'entrypoint emitted a JSON array instead of one top-level object' }
$invalidResult = $invalidJson[0] | ConvertFrom-Json
if ($invalidResult.ok -or $invalidResult.errorCategory -ne 'invalid-action') { throw 'entrypoint did not emit a fixed-action JSON error' }

Write-Output 'PASS: Codex desktop control boundaries'
