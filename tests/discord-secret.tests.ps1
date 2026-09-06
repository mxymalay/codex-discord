[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
$secretModule = Join-Path $sourceRoot 'discord-secret.ps1'
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = [System.IO.Path]::GetFullPath((Join-Path $tempBase ('codex-discord-secret-tests-{0}' -f [guid]::NewGuid().ToString('N'))))
$originalKeychain = $env:CODEX_DISCORD_KEYCHAIN
$testKeychain = Join-Path $tempRoot 'test secrets.keychain-db'

if (-not $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe temporary test path: $tempRoot"
}

try {
    [void](New-Item -ItemType Directory -Path $tempRoot -Force)
    . $secretModule
    if ($IsMacOS) {
        # A separate disposable Keychain prevents tests from changing real keys.
        $env:CODEX_DISCORD_KEYCHAIN = $testKeychain
        $created = Invoke-DiscordKeychainCommand -Command @('create-keychain', '-p', [guid]::NewGuid().ToString('N'), $testKeychain)
        if ($created.ExitCode -ne 0) { throw 'Unable to create isolated test Keychain' }
    }

    $secretPath = Join-Path $tempRoot 'discord-token.dpapi'
    $testToken = 'test.token.value-with_more-characters'
    Protect-DiscordBotToken -Token $testToken -Path $secretPath

    if (-not (Test-Path -LiteralPath $secretPath)) {
        throw 'Encrypted token file was not created'
    }

    $stored = [System.IO.File]::ReadAllText($secretPath)
    if ([string]::IsNullOrWhiteSpace($stored)) {
        throw 'Encrypted token file is empty'
    }
    if ($stored.Contains($testToken, [System.StringComparison]::Ordinal)) {
        throw 'Plaintext token leaked into encrypted file'
    }
    if (-not $IsWindows) {
        $plaintextHex = [Convert]::ToHexString([Text.Encoding]::Unicode.GetBytes($testToken))
        if ($stored.Equals($plaintextHex, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Unix SecureString serialization stored the token as reversible plaintext hex'
        }
    }

    $plain = Unprotect-DiscordBotToken -Path $secretPath
    if ($plain -cne $testToken) {
        throw 'Encrypted token round trip failed'
    }

    $queuedText = 'Continue the original task with the approved migration steps.'
    $queuedCipher = Protect-DiscordSecret -Value $queuedText
    if ($queuedCipher.Contains($queuedText, [System.StringComparison]::Ordinal)) {
        throw 'Plaintext continuation leaked into ciphertext'
    }
    if ((Unprotect-DiscordSecret -Ciphertext $queuedCipher) -cne $queuedText) {
        throw 'Queued continuation encrypted round trip failed'
    }

    if ($IsMacOS) {
        if ($queuedCipher -notmatch '^codex-discord:aesgcm:v1:') { throw 'macOS ciphertext lacks the authenticated encryption envelope' }
        $secondCipher = Protect-DiscordSecret -Value $queuedText
        if ($queuedCipher -ceq $secondCipher) { throw 'Encryption reused a nonce for repeated plaintext' }
        $cipherBytes = [Convert]::FromBase64String($queuedCipher.Substring('codex-discord:aesgcm:v1:'.Length))
        $cipherBytes[12] = $cipherBytes[12] -bxor 1
        $tampered = 'codex-discord:aesgcm:v1:' + [Convert]::ToBase64String($cipherBytes)
        foreach ($rejected in @($tampered, [Convert]::ToHexString([Text.Encoding]::Unicode.GetBytes($queuedText)))) {
            $accepted = $false
            try { [void](Unprotect-DiscordSecret -Ciphertext $rejected); $accepted = $true } catch { }
            if ($accepted) { throw 'Decryption accepted unauthenticated or tampered ciphertext' }
        }
        $fileMode = [IO.File]::GetUnixFileMode($secretPath)
        if (($fileMode -band 63) -ne 0) { throw 'Token file grants group or other users access' }

        $processInfo = [Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh'))
        foreach ($arg in @('-NoProfile', '-File', (Join-Path $sourceRoot 'unprotect-discord-pending-reply.ps1'))) { [void]$processInfo.ArgumentList.Add($arg) }
        $processInfo.UseShellExecute = $false
        $processInfo.RedirectStandardInput = $true
        $processInfo.RedirectStandardOutput = $true
        $processInfo.RedirectStandardError = $true
        $child = [Diagnostics.Process]::Start($processInfo)
        try {
            $child.StandardInput.Write($queuedCipher)
            $child.StandardInput.Close()
            $plainFromChild = $child.StandardOutput.ReadToEnd()
            $errorFromChild = $child.StandardError.ReadToEnd()
            $child.WaitForExit()
            if ($child.ExitCode -ne 0 -or $plainFromChild -cne $queuedText) { throw "Separate-process Keychain decryption failed: $errorFromChild" }
        } finally { $child.Dispose() }
    }

    try {
        Protect-DiscordBotToken -Token '   ' -Path (Join-Path $tempRoot 'blank.dpapi')
        throw 'Blank token was accepted'
    }
    catch {
        if ($_.Exception.Message -eq 'Blank token was accepted') {
            throw
        }
    }

    Write-Output 'PASS: Discord secrets use Windows DPAPI or macOS authenticated Keychain encryption'
}
finally {
    if ($IsMacOS -and (Test-Path -LiteralPath $testKeychain)) {
        [void](Invoke-DiscordKeychainCommand -Command @('delete-keychain', $testKeychain))
    }
    $env:CODEX_DISCORD_KEYCHAIN = $originalKeychain
    if ((Test-Path -LiteralPath $tempRoot) -and $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
