[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-migration-test-' + [guid]::NewGuid().ToString('N'))
$oldKeychain = $env:CODEX_DISCORD_KEYCHAIN
$keychainPath = Join-Path $testRoot 'test.keychain-db'
$exporter = Join-Path $sourceRoot 'export-discord-migration.ps1'
$importer = Join-Path $sourceRoot 'import-discord-migration.ps1'
$password = ConvertTo-SecureString 'synthetic migration test passphrase' -AsPlainText -Force
$wrongPassword = ConvertTo-SecureString 'synthetic WRONG migration passphrase' -AsPlainText -Force
function Assert-Rejected([scriptblock]$Action,[string]$Reason) {
    $accepted = $false
    try { & $Action | Out-Null; $accepted = $true } catch { $script:rejectionMessage = $_.Exception.Message }
    if ($accepted) { throw $Reason }
}
try {
    if (-not (Test-Path $exporter) -or -not (Test-Path $importer)) { throw 'Encrypted export/import tooling is missing' }
    [void][IO.Directory]::CreateDirectory($testRoot)
    . (Join-Path $sourceRoot 'discord-secret.ps1')
    if ($IsMacOS) {
        $env:CODEX_DISCORD_KEYCHAIN = $keychainPath
        $created = Invoke-DiscordKeychainCommand -Command @('create-keychain','-p',[guid]::NewGuid().ToString('N'),$keychainPath)
        if ($created.ExitCode -ne 0) { throw 'Unable to create disposable migration test Keychain' }
    }
    $sourceDir = Join-Path $testRoot 'old machine'
    $targetDir = Join-Path $testRoot 'new machine'
    [void][IO.Directory]::CreateDirectory($sourceDir)
    $token = ('A' * 24) + '.' + ('B' * 6) + '.' + ('C' * 27)
    $sourceToken = Join-Path $sourceDir 'discord-token.dpapi'
    Protect-DiscordBotToken -Token $token -Path $sourceToken
    $sourceConfig = @{enabled=$true;provider='discord-bot';quotaNotifications=$true;includeAssistantMessage=$true;discordApplicationId='111111111111111111';discordGuildId='222222222222222222';discordAllowedUserId='333333333333333333';discordTaskChannelId='444444444444444444';discordConfirmationChannelId='555555555555555555';discordQuotaChannelId='666666666666666666';discordTokenPath=$sourceToken;discordCodexPath='C:\old\codex.exe';discordProjectlessRoot='C:\old\tasks';discordWorktreeRoot='C:\old\worktrees';previousNotify=@('C:\old\notifier.exe');unexpectedLocalPath='C:\old\private'}
    $sourceConfig.ntfyConfirmationEndpoint='https://ntfy.invalid/confirm-example'
    $sourceConfig.ntfyQuotaEndpoint='https://ntfy.invalid/quota-example'
    [IO.File]::WriteAllText((Join-Path $sourceDir 'config.json'),($sourceConfig | ConvertTo-Json))
    [IO.File]::WriteAllText((Join-Path $sourceDir 'discord-inbox-state.json'),'old-machine-queue-must-not-migrate')
    $packagePath = Join-Path $testRoot 'settings.codex-discord-migration'
    & $exporter -ToolDir $sourceDir -Destination $packagePath -Password $password | Out-Null
    $packageText = [IO.File]::ReadAllText($packagePath)
    foreach ($secret in @($token,'222222222222222222','C:\old','old-machine-queue-must-not-migrate')) {
        if ($packageText.Contains($secret)) { throw 'Export leaked unencrypted source data' }
    }
    Assert-Rejected { & $exporter -ToolDir $sourceDir -Destination $packagePath -Password $password } 'Export clobbered an existing package'
    Assert-Rejected { & $importer -PackagePath $packagePath -ToolDir $targetDir -Password $wrongPassword } 'Wrong migration passphrase was accepted'
    if (Test-Path (Join-Path $targetDir 'config.json')) { throw 'Wrong password changed target configuration' }
    $tampered = $packageText | ConvertFrom-Json
    $tag = [Convert]::FromBase64String($tampered.tag); $tag[0] = $tag[0] -bxor 1
    $tampered.tag = [Convert]::ToBase64String($tag)
    $tamperedPath = Join-Path $testRoot 'tampered.package'
    [IO.File]::WriteAllText($tamperedPath,($tampered | ConvertTo-Json))
    Assert-Rejected { & $importer -PackagePath $tamperedPath -ToolDir $targetDir -Password $password } 'Tampered package was accepted'
    & $importer -PackagePath $packagePath -ToolDir $targetDir -Password $password | Out-Null
    $targetConfigPath = Join-Path $targetDir 'config.json'
    $targetConfig = Get-Content -Raw $targetConfigPath | ConvertFrom-Json
    if ($targetConfig.discordGuildId -cne '222222222222222222' -or -not $targetConfig.quotaNotifications -or -not $targetConfig.includeAssistantMessage) { throw 'Imported IDs or preferences were lost' }
    foreach ($name in @('ntfyConfirmationEndpoint','ntfyQuotaEndpoint')) { if (-not $targetConfig.PSObject.Properties[$name] -or $targetConfig.$name -cne $sourceConfig[$name]) { throw "Migration lost saved provider preference $name" } }
    if ((Unprotect-DiscordBotToken -Path $targetConfig.discordTokenPath) -cne $token) { throw 'Imported token cannot be decrypted using the destination account' }
    if ([IO.File]::ReadAllText($targetConfigPath).Contains('C:\\old') -or $targetConfig.PSObject.Properties['unexpectedLocalPath']) { throw 'Source machine paths crossed into target configuration' }
    if ($targetConfig.previousNotify.Count -ne 0) { throw 'Old machine notifier command was imported' }
    if (Test-Path (Join-Path $targetDir 'discord-inbox-state.json')) { throw 'Old machine pending state was imported' }
    Assert-Rejected { & $importer -PackagePath $packagePath -ToolDir $targetDir -Password $password } 'Import clobbered existing target without explicit replacement'
    $beforeConfig = [IO.File]::ReadAllText($targetConfigPath)
    $beforeToken = [IO.File]::ReadAllText($targetConfig.discordTokenPath)
    $commitFailureState = @{Reached=$false}
    function Move-Item {
        [CmdletBinding()]
        param([string]$LiteralPath,[string]$Destination,[switch]$Force)
        if (-not $commitFailureState.Reached -and $Destination -ceq $targetConfigPath -and (Split-Path -Leaf $LiteralPath) -eq 'config.json') {
            $commitFailureState.Reached = $true
            throw 'Injected second-file commit failure'
        }
        Microsoft.PowerShell.Management\Move-Item @PSBoundParameters
    }
    Assert-Rejected { & $importer -PackagePath $packagePath -ToolDir $targetDir -Password $password -ReplaceExisting } 'Commit failure was ignored'
    Remove-Item Function:Move-Item
    if (-not $commitFailureState.Reached) { throw "Rollback test did not reach the commit boundary: $script:rejectionMessage" }
    if ([IO.File]::ReadAllText($targetConfigPath) -cne $beforeConfig -or [IO.File]::ReadAllText($targetConfig.discordTokenPath) -cne $beforeToken) { throw 'Failed migration did not restore original target files' }
    Write-Output 'PASS: encrypted migration, authentication, target-native secrets, no clobber, sanitization, and rollback'
}
finally {
    Remove-Item Function:Move-Item -ErrorAction SilentlyContinue
    if ($IsMacOS -and (Test-Path $keychainPath)) { [void](Invoke-DiscordKeychainCommand -Command @('delete-keychain',$keychainPath)) }
    $env:CODEX_DISCORD_KEYCHAIN = $oldKeychain
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
