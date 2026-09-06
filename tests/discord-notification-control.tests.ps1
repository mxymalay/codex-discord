[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $sourceRoot 'codex-control-lib.ps1')
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('discord-notification-control-' + [guid]::NewGuid().ToString('N'))
$failures = [Collections.Generic.List[string]]::new()
function Test-Case([string]$Name, [scriptblock]$Body) {
    try { & $Body; Write-Output "PASS: $Name" }
    catch { $failures.Add("${Name}: $($_.Exception.Message)") }
}
function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function New-Fixture([string]$Name, [string]$Json) {
    $directory = Join-Path $testRoot $Name
    [void][IO.Directory]::CreateDirectory($directory)
    if ($Json) { [IO.File]::WriteAllText((Join-Path $directory 'config.json'), $Json) }
    return $directory
}
function New-Operations([hashtable]$State) {
    $operations = @{
        GetTask = { [pscustomobject]@{ installed=$State.installed; enabled=$State.autoStart; running=($State.running -and $State.mode -eq 'scheduled'); definitionCurrent=$true } }
        GetRuntime = { if ($State.running) { [pscustomobject]@{ processId=501; mode=$State.mode } } }
        InstallTask = { $State.installed=$true }
        EnableTask = { $State.autoStart=$true }
        DisableTask = { $State.autoStart=$false }
        StartTask = { $State.observedEnabled=(Get-Content -Raw (Join-Path $State.directory 'config.json') | ConvertFrom-Json).enabled; $State.running=$true; $State.mode='scheduled' }
        StartDetached = { param($path,$mode) $State.observedEnabled=(Get-Content -Raw (Join-Path $State.directory 'config.json') | ConvertFrom-Json).enabled; $State.running=$true; $State.mode=$mode }
        StopTask = { $State.observedEnabled=(Get-Content -Raw (Join-Path $State.directory 'config.json') | ConvertFrom-Json).enabled; $State.running=$false }
        StopRuntime = { param($runtime) $State.observedEnabled=(Get-Content -Raw (Join-Path $State.directory 'config.json') | ConvertFrom-Json).enabled; $State.running=$false }
        Sleep = {}
    }
    foreach ($name in @($operations.Keys)) { $operations[$name]=$operations[$name].GetNewClosure() }
    return $operations
}
try {
    [void][IO.Directory]::CreateDirectory($testRoot)
    foreach ($action in @('stop-temporary','disable-long-term','start-temporary','enable-long-term')) {
        Test-Case "$action controls project notifications without losing preferences" {
            $starts = $action -in @('start-temporary','enable-long-term')
            $initialJson = '{"enabled":false,"provider":"discord-bot","nested":{"keep":[1,"two",true]},"id":"123456789012345678","date":"2026-09-01T12:00:00Z"}'
            if (-not $starts) { $initialJson=$initialJson.Replace('"enabled":false','"enabled":true') }
            $directory = New-Fixture $action $initialJson
            $state = @{directory=$directory;installed=$true;autoStart=(-not $starts);running=(-not $starts);mode='scheduled';observedEnabled=$null}
            $result = Invoke-CodexBridgeServiceAction -Action $action -ToolDir $directory -Operations (New-Operations $state) -PollAttempts 1 -PollMilliseconds 0
            Assert-True $result.ok 'Control operation failed'
            $config = Get-Content -Raw (Join-Path $directory 'config.json') | ConvertFrom-Json
            Assert-True ($config.enabled -eq $starts -and $state.observedEnabled -eq $starts) 'Notification preference was not written before the bridge action'
            Assert-True ($config.nested.keep.Count -eq 3 -and $config.id -ceq '123456789012345678' -and [IO.File]::ReadAllText((Join-Path $directory 'config.json')).Contains('2026-09-01T12:00:00Z')) 'Unrelated preferences changed'
            if ($action -eq 'stop-temporary') { Assert-True $state.autoStart 'Temporary stop disabled next-login startup' }
            if ($action -eq 'disable-long-term') { Assert-True (-not $state.autoStart) 'Long-term disable retained auto-start' }
        }
    }
    Test-Case 'verified stop reasserts disabled after a racing startup' {
        $directory = New-Fixture 'racing stop' '{"enabled":true,"keep":42}'
        $state = @{directory=$directory;installed=$true;autoStart=$true;running=$true;mode='scheduled';observedEnabled=$null}
        $operations = New-Operations $state
        $operations.StopTask = {
            Assert-True (-not (Get-Content -Raw (Join-Path $directory 'config.json') | ConvertFrom-Json).enabled) 'Stop was entered while notifications remained enabled'
            [IO.File]::WriteAllText((Join-Path $directory 'config.json'), '{"enabled":true,"keep":43}')
            $state.running=$false
        }
        $result=Invoke-CodexBridgeServiceAction -Action stop-temporary -ToolDir $directory -Operations $operations -PollAttempts 1 -PollMilliseconds 0
        $config=Get-Content -Raw (Join-Path $directory 'config.json') | ConvertFrom-Json
        Assert-True ($result.ok -and -not $config.enabled -and $config.keep -eq 43) 'Stop did not close the startup race while preserving the latest config'
    }
    foreach ($initial in @('{"enabled":false,"keep":1}','{"keep":1}')) {
        foreach ($failure in @('throw','unpublished')) {
            Test-Case "failed $failure start restores the prior enabled preference: $initial" {
                $directory=New-Fixture ([guid]::NewGuid().ToString('N')) $initial
                $state=@{directory=$directory;installed=$false;autoStart=$false;running=$false;mode='temporary';observedEnabled=$null}
                $operations=New-Operations $state
                $operations.StartDetached={
                    $latest=Get-Content -Raw (Join-Path $directory 'config.json') | ConvertFrom-Json
                    Assert-True $latest.enabled 'Start did not enable notifications first'
                    $latest.keep=2
                    [IO.File]::WriteAllText((Join-Path $directory 'config.json'), ($latest | ConvertTo-Json))
                    if ($failure -eq 'throw') { throw 'synthetic start failure' }
                }
                $result=Invoke-CodexBridgeServiceAction -Action start-temporary -ToolDir $directory -Operations $operations -PollAttempts 1 -PollMilliseconds 0
                $config=Get-Content -Raw (Join-Path $directory 'config.json') | ConvertFrom-Json
                Assert-True (-not $result.ok -and $config.keep -eq 2) 'Failed start lost its failure or an unrelated concurrent config edit'
                if ($initial.Contains('enabled')) { Assert-True ($config.enabled -eq $false) 'Failed start did not restore false' }
                else { Assert-True ($null -eq $config.PSObject.Properties['enabled']) 'Failed start introduced a previously absent enabled key' }
            }
        }
    }
    foreach ($json in @('[]','null','true','"text"','{"broken":')) {
        Test-Case "invalid configuration fails before service start: $json" {
            $directory=New-Fixture ([guid]::NewGuid().ToString('N')) $json
            $state=@{directory=$directory;installed=$true;autoStart=$false;running=$false;mode='temporary';observedEnabled=$null;launches=0}
            $operations=New-Operations $state
            $operations.StartDetached={ $state.launches++; $state.running=$true }
            $result=Invoke-CodexBridgeServiceAction -Action start-temporary -ToolDir $directory -Operations $operations -PollAttempts 1 -PollMilliseconds 0
            Assert-True (-not $result.ok -and -not $state.running -and $state.launches -eq 0) 'Invalid config did not block service start'
            Assert-True ([IO.File]::ReadAllText((Join-Path $directory 'config.json')) -ceq $json) 'Invalid config was overwritten'
        }
    }
    Test-Case 'missing configuration remains harmless and absent' {
        $directory=New-Fixture 'unconfigured' ''
        $state=@{directory=$directory;installed=$false;autoStart=$false;running=$false;mode='temporary';observedEnabled=$null}
        $operations=New-Operations $state
        $result=Invoke-CodexBridgeServiceAction -Action stop-temporary -ToolDir $directory -Operations $operations -PollAttempts 1 -PollMilliseconds 0
        Assert-True ($result.ok -and -not (Test-Path (Join-Path $directory 'config.json'))) 'Unconfigured stop created config or failed'
    }
    Test-Case 'symlink configuration is rejected without modifying its target' {
        $directory=New-Fixture 'symlink' ''
        $target=Join-Path $testRoot 'symlink target.json'
        [IO.File]::WriteAllText($target,'{"enabled":true}')
        [void][IO.File]::CreateSymbolicLink((Join-Path $directory 'config.json'),$target)
        $state=@{directory=$directory;installed=$true;autoStart=$false;running=$false;mode='temporary';observedEnabled=$null;launches=0}
        $operations=New-Operations $state
        $operations.StartDetached={ $state.launches++; $state.running=$true }
        $result=Invoke-CodexBridgeServiceAction -Action start-temporary -ToolDir $directory -Operations $operations -PollAttempts 1 -PollMilliseconds 0
        Assert-True (-not $result.ok -and -not $state.running -and $state.launches -eq 0) 'Symlink did not block service start'
        Assert-True ([IO.File]::ReadAllText($target) -ceq '{"enabled":true}') 'Symlink target was modified'
    }
    Test-Case 'notification edits preserve exact JSON numbers and restore null' {
        $directory=New-Fixture 'precise values' '{"enabled":null,"huge":123456789012345678901234567890,"decimal":-0.00E+20,"nested":{"Enabled":"keep"}}'
        $snapshot=Set-DiscordNotificationsEnabled -ToolDir $directory -Enabled $true
        Restore-DiscordNotificationsEnabled -ToolDir $directory -Snapshot $snapshot
        $document=[Text.Json.JsonDocument]::Parse([IO.File]::ReadAllText((Join-Path $directory 'config.json')))
        try {
            Assert-True ($document.RootElement.GetProperty('huge').GetRawText() -ceq '123456789012345678901234567890') 'Large JSON number lost precision'
            Assert-True ($document.RootElement.GetProperty('decimal').GetRawText() -ceq '-0.00E+20') 'JSON number representation changed'
            Assert-True ($document.RootElement.GetProperty('enabled').ValueKind -eq [Text.Json.JsonValueKind]::Null) 'Null enabled preference was not restored'
            Assert-True ($document.RootElement.GetProperty('nested').GetProperty('Enabled').GetString() -ceq 'keep') 'Nested similarly named key changed'
        } finally { $document.Dispose() }
    }
    Test-Case 'concurrent configuration update is retained and temporary files are removed' {
        $directory=New-Fixture 'concurrent edit' '{"enabled":true,"keep":1}'
        $path=Join-Path $directory 'config.json'
        $snapshot=Read-DiscordNotificationControlConfig -Path $path
        try {
            [IO.File]::WriteAllText($path,'{"enabled":true,"keep":2}')
            $rejected=$false
            try { Write-DiscordNotificationControlConfig -Path $path -Original $snapshot -EnabledJson 'false' }
            catch { $rejected=$true }
            Assert-True ($rejected -and [IO.File]::ReadAllText($path) -ceq '{"enabled":true,"keep":2}') 'A concurrent config edit was lost'
            Assert-True (@(Get-ChildItem -LiteralPath $directory -Force).Count -eq 1) 'An update left a temporary config file'
        } finally { $snapshot.Document.Dispose() }
    }
    Test-Case 'failed stop remutes a racing startup and reports bridge failure' {
        $directory=New-Fixture 'failed stop' '{"enabled":true}'
        $state=@{directory=$directory;installed=$true;autoStart=$true;running=$true;mode='scheduled';observedEnabled=$null}
        $operations=New-Operations $state
        $operations.StopTask={ [IO.File]::WriteAllText((Join-Path $directory 'config.json'),'{"enabled":true}'); throw 'synthetic stop failure' }
        $result=Invoke-CodexBridgeServiceAction -Action stop-temporary -ToolDir $directory -Operations $operations -PollAttempts 1 -PollMilliseconds 0
        Assert-True (-not $result.ok -and $result.errorCategory -ceq 'service-action-failed' -and $state.running -and -not (Get-Content -Raw (Join-Path $directory 'config.json') | ConvertFrom-Json).enabled) 'Failed stop lost its bridge failure or re-enabled notifications'
    }
    Test-Case 'failed preference restoration is reported' {
        $directory=New-Fixture 'failed restore' '{"enabled":false}'
        $state=@{directory=$directory;installed=$false;autoStart=$false;running=$false;mode='temporary';observedEnabled=$null}
        $operations=New-Operations $state
        $operations.StartDetached={ [IO.File]::WriteAllText((Join-Path $directory 'config.json'),'[]'); throw 'synthetic failure after invalid config edit' }
        $result=Invoke-CodexBridgeServiceAction -Action start-temporary -ToolDir $directory -Operations $operations -PollAttempts 1 -PollMilliseconds 0
        Assert-True (-not $result.ok -and $result.errorCategory -ceq 'notification-preference-restore-failed') 'Failed notification preference restoration was hidden'
    }
    foreach ($action in @('stop-temporary','disable-long-term')) {
        Test-Case "$action still stops the bridge when initial notification mute fails" {
            $directory=New-Fixture ([guid]::NewGuid().ToString('N')) '[]'
            $state=@{directory=$directory;installed=$true;autoStart=$true;running=$true;mode='scheduled';observedEnabled=$null}
            $operations=New-Operations $state
            $operations.StopTask={ $state.running=$false }
            $result=Invoke-CodexBridgeServiceAction -Action $action -ToolDir $directory -Operations $operations -PollAttempts 1 -PollMilliseconds 0
            Assert-True (-not $result.ok -and $result.errorCategory -ceq 'notification-disable-failed' -and -not $state.running) 'Notification mute failure prevented bridge stop or was hidden'
            if ($action -eq 'disable-long-term') { Assert-True (-not $state.autoStart) 'Notification mute failure prevented auto-start disable' }
            Assert-True ([IO.File]::ReadAllText((Join-Path $directory 'config.json')) -ceq '[]') 'Invalid config was overwritten during stop'
        }
    }
    Test-Case 'stop mutes notifications even when initial bridge status is unavailable' {
        $directory=New-Fixture 'status failure' '{"enabled":true}'
        $state=@{directory=$directory;installed=$true;autoStart=$true;running=$true;mode='scheduled';observedEnabled=$null}
        $operations=New-Operations $state
        $operations.GetTask={ throw 'synthetic status unavailable' }
        $result=Invoke-CodexBridgeServiceAction -Action stop-temporary -ToolDir $directory -Operations $operations -PollAttempts 1 -PollMilliseconds 0
        Assert-True (-not $result.ok -and $result.errorCategory -ceq 'service-status-failed' -and -not (Get-Content -Raw (Join-Path $directory 'config.json') | ConvertFrom-Json).enabled) 'An unreadable bridge status bypassed notification stop'
    }
    if ($failures.Count) { throw ($failures -join "`n") }
} finally { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
