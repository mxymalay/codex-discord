Set-StrictMode -Version Latest

function Invoke-DiscordKeychainCommand {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string[]]$Command)

    # security's interactive mode accepts the command over stdin. In particular,
    # the encryption key never becomes a process argument or a shell command.
    $parts = @($Command | ForEach-Object {
        if ($_ -match '[\r\n\x00]') { throw 'Invalid Keychain command value' }
        '"' + $_.Replace('\', '\\').Replace('"', '\"') + '"'
    })
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new('/usr/bin/security')
    [void]$startInfo.ArgumentList.Add('-i')
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        [void]$process.Start()
        $outputTask = $process.StandardOutput.ReadToEndAsync()
        $errorTask = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.WriteLine(($parts -join ' '))
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(30000)) {
            $process.Kill()
            throw 'Keychain access timed out; unlock the login Keychain and retry'
        }
        # Never expose security's diagnostics: some versions include input.
        [void]$errorTask.GetAwaiter().GetResult()
        return @{ ExitCode = $process.ExitCode; Output = $outputTask.GetAwaiter().GetResult().Trim() }
    }
    finally { $process.Dispose() }
}

function Get-DiscordSecretKey {
    [CmdletBinding()]
    param([switch]$Create)

    if (-not $IsMacOS) {
        throw 'Discord secret storage requires Windows DPAPI or macOS Keychain'
    }
    $identity = @('-a', 'codex-discord', '-s', 'com.openai.codex-discord.encryption.v1')
    $keychain = if ([string]::IsNullOrWhiteSpace($env:CODEX_DISCORD_KEYCHAIN)) { @() } else { @($env:CODEX_DISCORD_KEYCHAIN) }
    $result = Invoke-DiscordKeychainCommand -Command (@('find-generic-password') + $identity + @('-w') + $keychain)
    if ($result.ExitCode -eq 44 -and $Create) {
        $newKey = [byte[]]::new(32)
        $random = [Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $random.GetBytes($newKey)
            # Do not use -U: concurrent initializers must never replace a key
            # that another process has already used to encrypt data.
            $created = Invoke-DiscordKeychainCommand -Command (@('add-generic-password') + $identity + @('-w', [Convert]::ToBase64String($newKey)) + $keychain)
            if ($created.ExitCode -notin @(0, 45)) {
                throw 'Unable to create Discord encryption key in macOS Keychain; unlock the Keychain and retry'
            }
        }
        finally {
            [Array]::Clear($newKey, 0, $newKey.Length)
            $random.Dispose()
        }
        $result = Invoke-DiscordKeychainCommand -Command (@('find-generic-password') + $identity + @('-w') + $keychain)
    }
    if ($result.ExitCode -ne 0) {
        throw 'Unable to read Discord encryption key from macOS Keychain; unlock the original Keychain and retry'
    }
    try { $key = [Convert]::FromBase64String($result.Output) }
    catch { throw 'Discord Keychain encryption key is invalid' }
    if ($key.Length -ne 32) { throw 'Discord Keychain encryption key is invalid' }
    return ,$key
}

function Protect-DiscordSecret {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw '要加密的 Discord 内容不能为空'
    }
    if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
        $secure = ConvertTo-SecureString -String $Value -AsPlainText -Force
        return ConvertFrom-SecureString -SecureString $secure
    }
    $key = Get-DiscordSecretKey -Create
    $plaintext = [Text.Encoding]::UTF8.GetBytes($Value)
    $nonce = [byte[]]::new(12)
    $tag = [byte[]]::new(16)
    $ciphertext = [byte[]]::new($plaintext.Length)
    $prefix = 'codex-discord:aesgcm:v1:'
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    $aes = [Security.Cryptography.AesGcm]::new($key)
    try {
        $random.GetBytes($nonce)
        $aes.Encrypt($nonce, $plaintext, $ciphertext, $tag, [Text.Encoding]::UTF8.GetBytes($prefix))
        return $prefix + [Convert]::ToBase64String([byte[]]($nonce + $tag + $ciphertext))
    }
    finally {
        $aes.Dispose()
        $random.Dispose()
        [Array]::Clear($key, 0, $key.Length)
        [Array]::Clear($plaintext, 0, $plaintext.Length)
    }
}

function Unprotect-DiscordSecret {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Ciphertext)

    try {
        if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
            $secure = ConvertTo-SecureString -String $Ciphertext
            $credential = [System.Management.Automation.PSCredential]::new('discord-secret', $secure)
            return $credential.GetNetworkCredential().Password
        }
        $prefix = 'codex-discord:aesgcm:v1:'
        if (-not $Ciphertext.StartsWith($prefix, [StringComparison]::Ordinal)) {
            throw 'Unsupported Discord secret format'
        }
        $bytes = [Convert]::FromBase64String($Ciphertext.Substring($prefix.Length))
        if ($bytes.Length -le 28) { throw 'Invalid Discord secret ciphertext' }
        $key = Get-DiscordSecretKey
        $plaintext = [byte[]]::new($bytes.Length - 28)
        $aes = [Security.Cryptography.AesGcm]::new($key)
        try {
            $aes.Decrypt([byte[]]$bytes[0..11], [byte[]]$bytes[28..($bytes.Length - 1)], [byte[]]$bytes[12..27], $plaintext, [Text.Encoding]::UTF8.GetBytes($prefix))
            return [Text.Encoding]::UTF8.GetString($plaintext)
        }
        finally {
            $aes.Dispose()
            [Array]::Clear($key, 0, $key.Length)
            [Array]::Clear($plaintext, 0, $plaintext.Length)
        }
    }
    catch {
        throw '无法解密 Discord 内容；请使用原 Windows 账户或解锁原 macOS Keychain，并确认密文未被修改'
    }
}

function Protect-DiscordBotToken {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Token,

        [Parameter(Mandatory)]
        [string]$Path
    )

    if ([string]::IsNullOrWhiteSpace($Token)) {
        throw 'Discord Bot Token 不能为空'
    }
    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw '令牌保存路径不能为空'
    }

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $parent = Split-Path -Parent $fullPath
    if (-not (Test-Path -LiteralPath $parent)) {
        [void](New-Item -ItemType Directory -Path $parent -Force)
        if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { & /bin/chmod 700 $parent; if ($LASTEXITCODE -ne 0) { throw 'Unable to protect Discord secret directory permissions' } }
    }

    $cipher = Protect-DiscordSecret -Value $Token
    $temporaryPath = Join-Path $parent ('.{0}.{1}.tmp' -f ([System.IO.Path]::GetFileName($fullPath)), $PID)

    try {
        [System.IO.File]::WriteAllText($temporaryPath, $cipher, [System.Text.UTF8Encoding]::new($false))
        if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { & /bin/chmod 600 $temporaryPath; if ($LASTEXITCODE -ne 0) { throw 'Unable to protect Discord token file permissions' } }
        Move-Item -LiteralPath $temporaryPath -Destination $fullPath -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
    }
}

function Unprotect-DiscordBotToken {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw 'Discord Bot Token 加密文件不存在'
    }

    try {
        $cipher = [System.IO.File]::ReadAllText([System.IO.Path]::GetFullPath($Path)).Trim()
        if ([string]::IsNullOrWhiteSpace($cipher)) {
            throw 'Discord Bot Token 加密文件为空'
        }
        return Unprotect-DiscordSecret -Ciphertext $cipher
    }
    catch {
        throw '无法解密 Discord Bot Token；请使用原 Windows 账户或解锁原 macOS Keychain'
    }
}
