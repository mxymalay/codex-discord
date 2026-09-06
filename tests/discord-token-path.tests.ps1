[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-token-path-' + [guid]::NewGuid().ToString('N'))
$toolDirectory = Join-Path $testRoot 'installed scripts'
$projectDirectory = Join-Path $testRoot 'unrelated project'
$originalDirectory = [Environment]::CurrentDirectory
$originalLocation = Get-Location
$requests = [Collections.Generic.List[object]]::new()
$failures = [Collections.Generic.List[string]]::new()
function Test-Case([string]$Name,[scriptblock]$Action) {
    try { & $Action; Write-Output "PASS: $Name" }
    catch { $failures.Add("${Name}: $($_.Exception.Message)") }
}
try {
    [void][IO.Directory]::CreateDirectory($toolDirectory)
    [void][IO.Directory]::CreateDirectory($projectDirectory)
    foreach ($name in @('dispatcher.ps1','get-discord-token.ps1','discord-http.ps1')) { Copy-Item (Join-Path $sourceRoot $name) (Join-Path $toolDirectory $name) }
    # This fixture isolates filesystem resolution from OS encryption and HTTP.
    # The real Keychain/DPAPI behavior has a separate integration suite.
    [IO.File]::WriteAllText((Join-Path $toolDirectory 'discord-secret.ps1'),'function Unprotect-DiscordBotToken([string]$Path) { [IO.File]::ReadAllText([IO.Path]::GetFullPath($Path)) }')
    [IO.File]::WriteAllText((Join-Path $toolDirectory 'discord-token.keychain'),'synthetic-token-in-script-directory')
    [IO.File]::WriteAllText((Join-Path $projectDirectory 'discord-token.keychain'),'wrong-project-directory-token')
    $absoluteToken = Join-Path $testRoot 'external-token.dpapi'
    [IO.File]::WriteAllText($absoluteToken,'synthetic-token-at-absolute-path')
    function Invoke-RestMethod {
        param($Method,$Uri,$Headers,$ContentType,$Body,$TimeoutSec)
        $requests.Add(@{Authorization=$Headers.Authorization;Uri=$Uri})
        return [pscustomobject]@{id='777777777777777777'}
    }
    Set-Location -LiteralPath $projectDirectory
    [Environment]::CurrentDirectory = $projectDirectory
    foreach ($case in @(
        @{Name='relative';Path='./discord-token.keychain';Expected='synthetic-token-in-script-directory'},
        @{Name='absolute';Path=$absoluteToken;Expected='synthetic-token-at-absolute-path'}
    )) {
        $config=@{enabled=$true;provider='discord-bot';discordTaskChannelId='444444444444444444';discordConfirmationChannelId='555555555555555555';discordQuotaChannelId='666666666666666666';discordTokenPath=$case.Path;quotaNotifications=$false;previousNotify=@()}
        [IO.File]::WriteAllText((Join-Path $toolDirectory 'config.json'),($config | ConvertTo-Json))
        Test-Case "$($case.Name) token getter is independent of project cwd" {
            $actual = & (Join-Path $toolDirectory 'get-discord-token.ps1')
            if ($actual -cne $case.Expected) { throw 'Token getter used the wrong token file' }
        }
        Test-Case "$($case.Name) dispatcher token is independent of project cwd" {
            $requests.Clear()
            & (Join-Path $toolDirectory 'dispatcher.ps1') -SystemTestEvent task -MobileOnly | Out-Null
            if ($requests.Count -ne 1) { throw 'Dispatcher did not reach the isolated HTTP boundary' }
            if ($requests[0].Authorization -cne ('Bot ' + $case.Expected)) { throw 'Dispatcher authenticated with the wrong token file' }
            if ($requests[0].Uri -cne 'https://discord.com/api/v10/channels/444444444444444444/messages') { throw 'Token path change affected channel routing' }
        }
    }
    if ($failures.Count -gt 0) { throw ($failures -join "`n") }
}
finally {
    [Environment]::CurrentDirectory = $originalDirectory
    Set-Location -LiteralPath $originalLocation.Path
    Remove-Item Function:Invoke-RestMethod -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
