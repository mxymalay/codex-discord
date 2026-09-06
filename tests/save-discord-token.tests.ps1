[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-save-token-' + [guid]::NewGuid().ToString('N'))
$originalInput = [Console]::In
try {
    [void][IO.Directory]::CreateDirectory($testRoot)
    foreach ($name in @('save-discord-token.ps1','discord-config.ps1','discord-http.ps1')) { Copy-Item (Join-Path $sourceRoot $name) (Join-Path $testRoot $name) }
    # Network and OS secret-store effects are covered by separate integration tests.
    [IO.File]::WriteAllText((Join-Path $testRoot 'discord-secret.ps1'), @'
function Protect-DiscordBotToken([string]$Token,[string]$Path) { [IO.File]::WriteAllText($Path,'encrypted-test-sentinel') }
function Unprotect-DiscordBotToken([string]$Path) { if (-not (Test-Path $Path)) { throw 'Configured token path was not used' }; 'AAAAAAAAAAAAAAAAAAAAAAAA.BBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCCC' }
'@)
    function Invoke-RestMethod { param($Method,$Uri,$Headers,$TimeoutSec); [pscustomobject]@{id='100000000000000001';bot=$true} }
    $config = @{enabled=$false;provider='discord-bot';discordApplicationId='100000000000000001';discordGuildId='100000000000000002';discordTaskChannelId='100000000000000004';discordConfirmationChannelId='100000000000000005';discordQuotaChannelId='100000000000000006'}
    $configPath = Join-Path $testRoot 'config.json'
    [IO.File]::WriteAllText($configPath,($config | ConvertTo-Json))
    [Console]::SetIn([IO.StringReader]::new('AAAAAAAAAAAAAAAAAAAAAAAA.BBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCCC'))
    $output = @(& (Join-Path $testRoot 'save-discord-token.ps1') -FromStdin -AllowedUserId '100000000000000003') -join "`n"
    $saved = Get-Content -Raw $configPath | ConvertFrom-Json
    $extension = if ($IsWindows) { '.dpapi' } else { '.keychain' }
    if (-not $saved.discordTokenPath.EndsWith($extension)) { throw 'Token filename does not describe platform secret storage' }
    if (-not $IsWindows -and ($output.Contains('Windows DPAPI') -or -not $output.Contains('Keychain'))) { throw 'Token save result misidentifies macOS encryption' }
    $movedPath = Join-Path $testRoot ('custom-token' + $extension)
    Move-Item -LiteralPath $saved.discordTokenPath -Destination $movedPath
    $saved.discordTokenPath = $movedPath
    [IO.File]::WriteAllText($configPath,($saved | ConvertTo-Json))
    & (Join-Path $testRoot 'save-discord-token.ps1') -UseEncryptedToken -AllowedUserId '100000000000000003' | Out-Null
    Write-Output 'PASS: token setup accepts private stdin, uses platform filename, and respects the configured existing token path'
}
finally {
    [Console]::SetIn($originalInput)
    Remove-Item Function:Invoke-RestMethod -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
