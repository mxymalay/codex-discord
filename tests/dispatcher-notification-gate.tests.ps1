[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$sourceRoot=Split-Path -Parent $PSScriptRoot
$fixtureDir=Join-Path ([IO.Path]::GetTempPath()) ('dispatcher-notification-gate-' + [guid]::NewGuid().ToString('N'))
$failures=[Collections.Generic.List[string]]::new()
$requests=[Collections.Generic.List[object]]::new()
$toggleDuringToken=$false
$failOrigin=$false
function Test-Case([string]$Name,[scriptblock]$Body) {
    try { & $Body; Write-Output "PASS: $Name" }
    catch { $failures.Add("${Name}: $($_.Exception.Message)") }
}
function Assert-True([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
function Invoke-RestMethod {
    param($Method,$Uri,$ContentType,$Body,$TimeoutSec,$Headers)
    $requests.Add($Uri)
    if ($failOrigin) {
        [IO.File]::WriteAllText((Join-Path $fixtureDir 'config.json'),'{"enabled":false}')
        throw 'synthetic origin request failed'
    }
    return [pscustomobject]@{id='777777777777777777'}
}
try {
    [void][IO.Directory]::CreateDirectory($fixtureDir)
    foreach ($name in @('dispatcher.ps1','discord-http.ps1')) { Copy-Item (Join-Path $sourceRoot $name) (Join-Path $fixtureDir $name) }
    [IO.File]::WriteAllText((Join-Path $fixtureDir 'config.json'),'{"enabled":true}')
    . (Join-Path $fixtureDir 'dispatcher.ps1') -NotificationJson '{"type":"ignored"}'
    function Unprotect-DiscordBotToken {
        param([string]$Path)
        if ($toggleDuringToken) { [IO.File]::WriteAllText((Join-Path $fixtureDir 'config.json'),'{"enabled":false}') }
        return 'synthetic-in-memory-test-credential'
    }
    foreach ($provider in @('ntfy','bark','pushplus','webhook','discord','discord-bot')) {
        Test-Case "$provider rereads enabled after initial configuration was loaded" {
            $staleConfig=[pscustomobject]@{enabled=$true;provider=$provider;endpoint='https://example.invalid/topic';token='synthetic';discordTaskChannelId='444444444444444444';discordTokenPath='./synthetic.dpapi'}
            $requests.Clear()
            [IO.File]::WriteAllText((Join-Path $fixtureDir 'config.json'),'{"enabled":false}')
            try { Send-MobileMessage -Config $staleConfig -Title test -Body test -EventName user-task-complete -Notification ([pscustomobject]@{'synthetic-test'=$true}) } catch {}
            Assert-True ($requests.Count -eq 0) 'Stopped notifications reached HTTP through stale configuration'
            [IO.File]::WriteAllText((Join-Path $fixtureDir 'config.json'),'{"enabled":true}')
            Send-MobileMessage -Config $staleConfig -Title test -Body test -EventName user-task-complete -Notification ([pscustomobject]@{'synthetic-test'=$true})
            Assert-True ($requests.Count -eq 1) 'Enabled notification never reached the mocked HTTP boundary'
        }
    }
    Test-Case 'bot rechecks enabled after token decryption immediately before HTTP' {
        $requests.Clear()
        $toggleDuringToken=$true
        [IO.File]::WriteAllText((Join-Path $fixtureDir 'config.json'),'{"enabled":true}')
        try { Send-DiscordBotMessage -Config ([pscustomobject]@{discordTokenPath='./synthetic.dpapi'}) -ChannelId '444444444444444444' -Payload @{} -TimeoutSeconds 1 } catch {}
        Assert-True ($requests.Count -eq 0) 'A stop during token decryption did not block HTTP'
        $toggleDuringToken=$false
    }
    Test-Case 'origin fallback cannot send after the primary request observes a stop' {
        $requests.Clear()
        $failOrigin=$true
        function Get-DiscordOriginChannelId { return '555555555555555555' }
        [IO.File]::WriteAllText((Join-Path $fixtureDir 'config.json'),'{"enabled":true}')
        $configForFallback=[pscustomobject]@{enabled=$true;provider='discord-bot';discordTaskChannelId='444444444444444444';discordTokenPath='./synthetic.dpapi'}
        try { Send-MobileMessage -Config $configForFallback -Title test -Body test -EventName user-task-complete -Notification ([pscustomobject]@{'synthetic-test'=$true}) } catch {}
        Assert-True ($requests.Count -eq 1 -and $requests[0] -like '*/555555555555555555/messages') 'Fallback sent after notifications were stopped'
        $failOrigin=$false
    }
    if ($failures.Count) { throw ($failures -join "`n") }
} finally { Remove-Item -LiteralPath $fixtureDir -Recurse -Force -ErrorAction SilentlyContinue }
