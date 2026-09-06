#requires -Version 7.0
Set-StrictMode -Version Latest

function Get-DiscordPortableConfiguration {
    param([Parameter(Mandatory)][object]$Config)
    $copy = [ordered]@{}
    # Runtime commands, paths, message mappings, and pending queues belong to
    # the original machine. Only supported preferences and account IDs travel.
    foreach ($name in @('enabled','provider','endpoint','confirmationEndpoint','quotaEndpoint','ntfyEndpoint','ntfyConfirmationEndpoint','ntfyQuotaEndpoint','token','includeAssistantMessage','quotaNotifications','timeoutSeconds','discordApplicationId','discordGuildId','discordAllowedUserId','discordTaskChannelId','discordConfirmationChannelId','discordQuotaChannelId')) {
        $property = $Config.PSObject.Properties[$name]
        if ($null -ne $property) {
            if ($null -ne $property.Value -and $property.Value -isnot [string] -and $property.Value -isnot [bool] -and $property.Value -isnot [ValueType]) { throw 'Migration configuration has an invalid preference value' }
            $copy[$name] = $property.Value
        }
    }
    return [pscustomobject]$copy
}

function Get-DiscordMigrationKey {
    param([Parameter(Mandatory)][securestring]$Password,[Parameter(Mandatory)][byte[]]$Salt)
    $plainPassword = [PSCredential]::new('migration',$Password).GetNetworkCredential().Password
    if ($plainPassword.Trim().Length -lt 12) { throw 'Use a migration passphrase with at least 12 non-padding characters' }
    $passwordBytes = [Text.Encoding]::UTF8.GetBytes($plainPassword)
    $plainPassword = $null
    $derive = [Security.Cryptography.Rfc2898DeriveBytes]::new($passwordBytes,$Salt,600000,[Security.Cryptography.HashAlgorithmName]::SHA256)
    try { return ,$derive.GetBytes(32) }
    finally { $derive.Dispose(); [Array]::Clear($passwordBytes,0,$passwordBytes.Length) }
}

function Protect-DiscordMigration {
    param([Parameter(Mandatory)][string]$Payload,[Parameter(Mandatory)][securestring]$Password)
    $salt = [byte[]]::new(16); $nonce = [byte[]]::new(12); $tag = [byte[]]::new(16)
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($salt); $random.GetBytes($nonce) } finally { $random.Dispose() }
    $key = Get-DiscordMigrationKey -Password $Password -Salt $salt
    $plain = [Text.Encoding]::UTF8.GetBytes($Payload)
    $cipher = [byte[]]::new($plain.Length)
    $aes = [Security.Cryptography.AesGcm]::new($key)
    try {
        $header = [Text.Encoding]::UTF8.GetBytes('codex-discord-migration:v1:PBKDF2-SHA256:600000:AES-256-GCM')
        $aes.Encrypt($nonce,$plain,$cipher,$tag,$header)
        return ([ordered]@{format='codex-discord-migration';version=1;kdf='PBKDF2-SHA256';iterations=600000;cipher='AES-256-GCM';salt=[Convert]::ToBase64String($salt);nonce=[Convert]::ToBase64String($nonce);tag=[Convert]::ToBase64String($tag);ciphertext=[Convert]::ToBase64String($cipher)} | ConvertTo-Json -Compress)
    }
    finally { $aes.Dispose(); [Array]::Clear($key,0,$key.Length); [Array]::Clear($plain,0,$plain.Length) }
}

function Unprotect-DiscordMigration {
    param([Parameter(Mandatory)][string]$Package,[Parameter(Mandatory)][securestring]$Password)
    try {
        if ($Package.Length -gt 1MB) { throw 'Oversized package' }
        $envelope = $Package | ConvertFrom-Json
        if ($envelope.format -cne 'codex-discord-migration' -or $envelope.version -ne 1 -or $envelope.kdf -cne 'PBKDF2-SHA256' -or $envelope.iterations -ne 600000 -or $envelope.cipher -cne 'AES-256-GCM') { throw 'Unsupported package' }
        $salt = [Convert]::FromBase64String($envelope.salt)
        $nonce = [Convert]::FromBase64String($envelope.nonce)
        $tag = [Convert]::FromBase64String($envelope.tag)
        $cipher = [Convert]::FromBase64String($envelope.ciphertext)
        if ($salt.Length -ne 16 -or $nonce.Length -ne 12 -or $tag.Length -ne 16 -or $cipher.Length -eq 0) { throw 'Invalid package' }
        $key = Get-DiscordMigrationKey -Password $Password -Salt $salt
        $plain = [byte[]]::new($cipher.Length)
        $aes = [Security.Cryptography.AesGcm]::new($key)
        try {
            $header = [Text.Encoding]::UTF8.GetBytes('codex-discord-migration:v1:PBKDF2-SHA256:600000:AES-256-GCM')
            $aes.Decrypt($nonce,$cipher,$tag,$plain,$header)
            return [Text.Encoding]::UTF8.GetString($plain)
        }
        finally { $aes.Dispose(); [Array]::Clear($key,0,$key.Length); [Array]::Clear($plain,0,$plain.Length) }
    }
    catch { throw 'Migration package cannot be decrypted: the passphrase is incorrect or the package is damaged or unsupported' }
}

function Set-DiscordMigrationPrivateMode {
    param([Parameter(Mandatory)][string]$Path,[switch]$Directory)
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        & /bin/chmod $(if ($Directory) { '700' } else { '600' }) $Path
        if ($LASTEXITCODE -ne 0) { throw 'Unable to restrict migration file permissions' }
    }
}
