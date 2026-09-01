[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $sourceRoot 'codex-control-lib.ps1')

$programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
$trusted = Join-Path $programFiles 'WindowsApps\OpenAI.Codex_1.2.3.0_x64__publisher\app\ChatGPT.exe'
$trustedChild = Join-Path $programFiles 'WindowsApps\OpenAI.Codex_1.2.3.0_x64__publisher\app\renderer\ChatGPT.exe'

if (-not (Test-CodexDesktopRootPath -Path $trusted)) {
    throw 'trusted Store ChatGPT path was not accepted'
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

$events = [System.Collections.Generic.List[string]]::new()
$ops = @{
    GetProcesses = { $processes }
    RequestClose = { param($processId) $events.Add("close:${processId}"); $false }
    StopProcess = { param($processId, $creationDate) $events.Add("stop:${processId}:${creationDate}") }
    Sleep = { param($milliseconds) $events.Add("sleep:${milliseconds}") }
}
$result = Stop-CodexDesktop -Operations $ops -GraceMilliseconds 10
if (-not $result.ok -or $result.stoppedProcessCount -ne 4) { throw 'verified tree was not stopped' }
$rootStop = $events.IndexOf('stop:100:20260901120000.000000+480')
foreach ($childStop in @(
    'stop:101:20260901120001.000000+480',
    'stop:102:20260901120002.000000+480',
    'stop:103:20260901120003.000000+480'
)) {
    if ($events.IndexOf($childStop) -lt 0 -or $events.IndexOf($childStop) -gt $rootStop) {
        throw 'verified descendants did not stop before the root'
    }
}
if ($events -contains 'stop:200:20260901120004.000000+480') { throw 'untrusted codex process was stopped' }

$changedRoot = @(
    [pscustomobject]@{ ProcessId=100; ParentProcessId=10; Name='ChatGPT.exe'; ExecutablePath=$trusted; CreationDate='20260901130000.000000+480' }
)
$revalidationState = [pscustomobject]@{ callCount = 0 }
$revalidationEvents = [System.Collections.Generic.List[string]]::new()
$revalidationOps = @{
    GetProcesses = { $revalidationState.callCount++; if ($revalidationState.callCount -eq 1) { $processes } else { $changedRoot } }
    RequestClose = { param($processId) $revalidationEvents.Add("close:${processId}"); $true }
    StopProcess = { param($processId, $creationDate) $revalidationEvents.Add("stop:${processId}:${creationDate}") }
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
    RequestClose = { param($processId) $untrustedEvents.Add("close:${processId}") }
    StopProcess = { param($processId, $creationDate) $untrustedEvents.Add("stop:${processId}") }
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
$invalidJson = & pwsh -NoProfile -File $entrypoint -Action 'arbitrary-action' 2>$null
if ($LASTEXITCODE -eq 0) { throw 'entrypoint accepted an arbitrary action' }
$invalidResult = $invalidJson | ConvertFrom-Json
if ($invalidResult.ok -or $invalidResult.errorCategory -ne 'invalid-action') { throw 'entrypoint did not emit a fixed-action JSON error' }

Write-Output 'PASS: Codex desktop control boundaries'
