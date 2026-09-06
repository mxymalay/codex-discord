#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Destination,
    [string]$ToolDir = $PSScriptRoot,
    [securestring]$Password
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'discord-secret.ps1')
. (Join-Path $PSScriptRoot 'discord-config.ps1')
. (Join-Path $PSScriptRoot 'discord-migration.ps1')
$destinationPath = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $destinationPath) { throw 'Migration destination already exists; choose a new filename' }
try { $config = Get-Content -Raw -LiteralPath (Join-Path $ToolDir 'config.json') -Encoding UTF8 | ConvertFrom-Json }
catch { throw 'Unable to read the original machine notification configuration' }
$tokenPath = Get-DiscordConfigProperty -Config $config -Name 'discordTokenPath'
if ([string]::IsNullOrWhiteSpace($tokenPath)) { throw 'The source configuration has no encrypted Discord token path' }
if (-not [IO.Path]::IsPathRooted($tokenPath)) { $tokenPath = Join-Path $ToolDir $tokenPath }
if ($null -eq $Password) {
    $Password = Read-Host 'Choose a new migration passphrase (at least 12 characters)' -AsSecureString
    $confirmation = Read-Host 'Repeat the migration passphrase' -AsSecureString
    $first = [PSCredential]::new('migration',$Password).GetNetworkCredential().Password
    $second = [PSCredential]::new('migration',$confirmation).GetNetworkCredential().Password
    try { if ($first -cne $second) { throw 'Migration passphrases do not match' } }
    finally { $first=$null; $second=$null; $confirmation.Dispose() }
}
$token = Unprotect-DiscordBotToken -Path $tokenPath
$temporaryPath = $null
try {
    if (-not (Test-DiscordBotTokenShape -Token $token)) { throw 'The original account could not recover a valid Discord Bot token' }
    $payload = [ordered]@{version=1;exportedAt=[DateTime]::UtcNow.ToString('o');config=(Get-DiscordPortableConfiguration -Config $config);token=$token} | ConvertTo-Json -Depth 10 -Compress
    $package = Protect-DiscordMigration -Payload $payload -Password $Password
    $parent = Split-Path -Parent $destinationPath
    if (-not (Test-Path -LiteralPath $parent)) { [void][IO.Directory]::CreateDirectory($parent); Set-DiscordMigrationPrivateMode -Path $parent -Directory }
    $temporaryPath = Join-Path $parent ('.discord-export-' + [guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($temporaryPath,$package,[Text.UTF8Encoding]::new($false))
    Set-DiscordMigrationPrivateMode -Path $temporaryPath
    [IO.File]::Move($temporaryPath,$destinationPath)
}
finally {
    $token=$null; $payload=$null; $config=$null
    if ($null -ne $temporaryPath -and (Test-Path -LiteralPath $temporaryPath)) { Remove-Item -LiteralPath $temporaryPath -Force }
}
Write-Output "Encrypted migration package saved: $destinationPath"
Write-Output 'Pending replies, task mappings, and original machine paths were excluded. Drain pending replies and stop the old bridge before starting the new bridge.'
