[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-token-entrypoints-' + [guid]::NewGuid().ToString('N'))
$toolDirectory = Join-Path $testRoot 'installed scripts'
$projectDirectory = Join-Path $testRoot 'unrelated project'
$originalDirectory = [Environment]::CurrentDirectory
$originalLocation = Get-Location
$requests = [Collections.Generic.List[object]]::new()
$tokenWrites = [Collections.Generic.List[object]]::new()
$failures = [Collections.Generic.List[string]]::new()
function Test-Case([string]$Name,[scriptblock]$Action) {
    try { & $Action; Write-Output "PASS: $Name" }
    catch { $failures.Add("${Name}: $($_.Exception.Message)") }
}
try {
    [void][IO.Directory]::CreateDirectory($toolDirectory)
    [void][IO.Directory]::CreateDirectory($projectDirectory)
    foreach ($name in @('activate-discord-bot.ps1','save-discord-token.ps1','send-discord-bot-live-tests.ps1','discord-http.ps1','discord-config.ps1')) { Copy-Item (Join-Path $sourceRoot $name) (Join-Path $toolDirectory $name) }
    # Keep OS encryption, network, and outgoing notifications outside this path
    # regression. Every script still runs its real control flow.
    [IO.File]::WriteAllText((Join-Path $toolDirectory 'discord-secret.ps1'), @'
function Unprotect-DiscordBotToken([string]$Path) { [IO.File]::ReadAllText([IO.Path]::GetFullPath($Path)) }
function Protect-DiscordBotToken([string]$Token,[string]$Path) { $tokenWrites.Add(@{Path=$Path;Token=$Token}) }
'@)
    [IO.File]::WriteAllText((Join-Path $toolDirectory 'dispatcher.ps1'), @'
param([string]$NotificationJson,[switch]$MobileOnly,[switch]$SkipTaskNotification,[switch]$SendQuotaStatus)
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'discord-message-map.json'),' {"messages":{"777777777777777777":{},"888888888888888888":{}}}')
'@)
    $installedToken = ('A' * 24) + '.' + ('B' * 6) + '.' + ('C' * 27)
    $externalToken = ('D' * 24) + '.' + ('E' * 6) + '.' + ('F' * 27)
    $installedTokenPath = Join-Path $toolDirectory 'discord-token.keychain'
    [IO.File]::WriteAllText($installedTokenPath,$installedToken)
    [IO.File]::WriteAllText((Join-Path $projectDirectory 'discord-token.keychain'),'invalid-decoy-project-token')
    $absoluteTokenPath = Join-Path $testRoot 'external-token.dpapi'
    [IO.File]::WriteAllText($absoluteTokenPath,$externalToken)
    function Invoke-RestMethod {
        param($Method,$Uri,$Headers,$ContentType,$Body,$TimeoutSec)
        if ($Headers.Authorization -cne ('Bot ' + $case.ExpectedToken)) { throw 'The script selected the unrelated project token' }
        $requests.Add($Uri)
        if ($Uri.EndsWith('/users/@me')) { return [pscustomobject]@{id='111111111111111111';bot=$true} }
        if ($Uri.Contains('/444444444444444444/')) { $id='777777777777777777';$color=3066993 }
        elseif ($Uri.Contains('/555555555555555555/')) { $id='888888888888888888';$color=15965202 }
        elseif ($Uri.Contains('/666666666666666666/')) { $id='999999999999999999';$color=3447003 }
        else { throw 'Unexpected isolated Discord request' }
        return [pscustomobject]@{id=$id;author=[pscustomobject]@{id='111111111111111111'};embeds=@([pscustomobject]@{color=$color})}
    }
    Set-Location -LiteralPath $projectDirectory
    [Environment]::CurrentDirectory = $projectDirectory
    foreach ($case in @(
        @{Name='relative';Path='./discord-token.keychain';ExpectedPath=$installedTokenPath;ExpectedToken=$installedToken},
        @{Name='absolute';Path=$absoluteTokenPath;ExpectedPath=$absoluteTokenPath;ExpectedToken=$externalToken}
    )) {
        foreach ($entrypoint in @('activate','save-existing','live-validation')) {
            $config=@{enabled=$true;provider='discord-bot';discordApplicationId='111111111111111111';discordGuildId='222222222222222222';discordAllowedUserId='333333333333333333';discordTaskChannelId='444444444444444444';discordConfirmationChannelId='555555555555555555';discordQuotaChannelId='666666666666666666';discordTokenPath=$case.Path;quotaNotifications=$true;previousNotify=@()}
            $configPath=Join-Path $toolDirectory 'config.json'
            [IO.File]::WriteAllText($configPath,($config | ConvertTo-Json))
            $requests.Clear();$tokenWrites.Clear()
            Test-Case "$($case.Name) $entrypoint token is independent of project cwd" {
                switch ($entrypoint) {
                    'activate' {
                        & (Join-Path $toolDirectory 'activate-discord-bot.ps1') | Out-Null
                        if ((Get-Content -Raw $configPath | ConvertFrom-Json).provider -cne 'discord-bot') { throw 'Activation did not finish' }
                    }
                    'save-existing' {
                        & (Join-Path $toolDirectory 'save-discord-token.ps1') -UseEncryptedToken -AllowedUserId '333333333333333333' | Out-Null
                        if ($requests.Count -ne 1 -or $tokenWrites.Count -ne 1) { throw 'Existing-token save did not reach its validation and encryption boundaries' }
                        if ($tokenWrites[0].Path -cne $case.ExpectedPath -or $tokenWrites[0].Token -cne $case.ExpectedToken) { throw 'Existing-token save selected the wrong destination file or token' }
                    }
                    'live-validation' {
                        & (Join-Path $toolDirectory 'send-discord-bot-live-tests.ps1') -ThreadId 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' -Cwd $projectDirectory | Out-Null
                        if ($requests.Count -ne 3) { throw 'Validation did not verify all three fake channels using both token reads' }
                    }
                }
            }
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
