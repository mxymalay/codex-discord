#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PackagePath,
    [string]$ToolDir = $PSScriptRoot,
    [securestring]$Password,
    [switch]$ReplaceExisting
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'discord-secret.ps1')
. (Join-Path $PSScriptRoot 'discord-config.ps1')
. (Join-Path $PSScriptRoot 'discord-migration.ps1')
$targetDir = [IO.Path]::GetFullPath($ToolDir)
$configPath = Join-Path $targetDir 'config.json'
$tokenName = if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { 'discord-token.dpapi' } else { 'discord-token.keychain' }
$tokenPath = Join-Path $targetDir $tokenName
foreach ($path in @($configPath,$tokenPath)) {
    if (Test-Path -LiteralPath $path) {
        if (-not $ReplaceExisting) { throw 'Target configuration or token already exists; use -ReplaceExisting only after stopping the bridge and reviewing the destination' }
        $item = Get-Item -LiteralPath $path -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Migration target must be an ordinary file' }
    }
}
if ((Get-Item -LiteralPath $PackagePath).Length -gt 1MB) { throw 'Migration package is too large' }
if ($null -eq $Password) { $Password = Read-Host 'Migration passphrase from the original PC' -AsSecureString }
$payload = Unprotect-DiscordMigration -Package ([IO.File]::ReadAllText([IO.Path]::GetFullPath($PackagePath))) -Password $Password
try { $data = $payload | ConvertFrom-Json }
catch { throw 'Decrypted migration payload is invalid' }
$payload=$null
if ($data.version -ne 1 -or -not (Test-DiscordBotTokenShape -Token ([string]$data.token))) { throw 'Migration payload has no valid Discord Bot token' }
$config = Get-DiscordPortableConfiguration -Config $data.config
foreach ($field in @('discordApplicationId','discordGuildId','discordAllowedUserId','discordTaskChannelId','discordConfirmationChannelId','discordQuotaChannelId')) {
    if (-not (Test-DiscordSnowflake -Value (Get-DiscordConfigProperty -Config $config -Name $field))) { throw "Migration configuration is missing a valid $field" }
}
$codexRoot = if (-not [string]::IsNullOrWhiteSpace($env:CODEX_HOME) -and [IO.Path]::IsPathRooted($env:CODEX_HOME)) { [IO.Path]::GetFullPath($env:CODEX_HOME) } elseif ((Split-Path -Leaf $targetDir) -eq 'mobile-notify') { Split-Path -Parent $targetDir } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' }
$previousNotify = @()
if (Test-Path -LiteralPath $configPath) {
    try {
        $existingConfig = Get-Content -Raw -LiteralPath $configPath -Encoding UTF8 | ConvertFrom-Json
        if ($existingConfig.PSObject.Properties['previousNotify']) { $previousNotify = @($existingConfig.previousNotify) }
    } catch { throw 'Existing target configuration is invalid; preserve a backup and repair it before importing' }
}
Set-DiscordConfigProperty -Config $config -Name 'previousNotify' -Value $previousNotify
Set-DiscordConfigProperty -Config $config -Name 'discordTokenPath' -Value $tokenPath
Set-DiscordConfigProperty -Config $config -Name 'discordCodexPath' -Value 'codex'
Set-DiscordConfigProperty -Config $config -Name 'discordProjectlessRoot' -Value (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Documents/Codex/Discord Tasks')
Set-DiscordConfigProperty -Config $config -Name 'discordWorktreeRoot' -Value (Join-Path $codexRoot 'worktrees/discord')
if (-not (Test-Path -LiteralPath $targetDir)) { [void][IO.Directory]::CreateDirectory($targetDir); Set-DiscordMigrationPrivateMode -Path $targetDir -Directory }
$lockPath = Join-Path $targetDir '.discord-migration.lock'
$lock = [IO.File]::Open($lockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
$stage = Join-Path $targetDir ('.discord-migration-' + [guid]::NewGuid().ToString('N'))
$movedOriginals = [Collections.Generic.List[string]]::new()
$installed = [Collections.Generic.List[string]]::new()
$keepStage = $false
try {
    [void][IO.Directory]::CreateDirectory($stage)
    Set-DiscordMigrationPrivateMode -Path $stage -Directory
    $stageToken = Join-Path $stage $tokenName
    $stageConfig = Join-Path $stage 'config.json'
    Protect-DiscordBotToken -Token ([string]$data.token) -Path $stageToken
    [IO.File]::WriteAllText($stageConfig,($config | ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
    Set-DiscordMigrationPrivateMode -Path $stageConfig
    foreach ($path in @($tokenPath,$configPath)) {
        if (Test-Path -LiteralPath $path) {
            if (-not $ReplaceExisting) { throw 'A target file appeared while importing; migration stopped without overwriting it' }
            Move-Item -LiteralPath $path -Destination (Join-Path $stage ((Split-Path -Leaf $path) + '.backup'))
            $movedOriginals.Add($path)
        }
    }
    Move-Item -LiteralPath $stageToken -Destination $tokenPath
    $installed.Add($tokenPath)
    Move-Item -LiteralPath $stageConfig -Destination $configPath
    $installed.Add($configPath)
}
catch {
    $failure = $_
    try {
        foreach ($path in $installed) { Remove-Item -LiteralPath $path -Force }
        foreach ($path in $movedOriginals) { Move-Item -LiteralPath (Join-Path $stage ((Split-Path -Leaf $path) + '.backup')) -Destination $path }
    }
    catch { $keepStage=$true; throw "Migration rollback needs attention; original encrypted files are preserved in $stage" }
    throw $failure
}
finally {
    $data=$null; $config=$null
    $lock.Dispose()
    Remove-Item -LiteralPath $lockPath -Force
    if (-not $keepStage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
Write-Output "Imported configuration and encrypted token into: $targetDir"
Write-Output 'Stop the original bridge before starting this bridge. Task history, message mappings, and pending replies were not imported.'
