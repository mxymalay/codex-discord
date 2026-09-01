[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
$secretModule = Join-Path $sourceRoot 'discord-secret.ps1'
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = [System.IO.Path]::GetFullPath((Join-Path $tempBase ('codex-discord-secret-tests-{0}' -f [guid]::NewGuid().ToString('N'))))

if (-not $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe temporary test path: $tempRoot"
}

try {
    [void](New-Item -ItemType Directory -Path $tempRoot -Force)
    . $secretModule

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

    $plain = Unprotect-DiscordBotToken -Path $secretPath
    if ($plain -cne $testToken) {
        throw 'DPAPI round trip failed'
    }

    $queuedText = 'Continue the original task with the approved migration steps.'
    $queuedCipher = Protect-DiscordSecret -Value $queuedText
    if ($queuedCipher.Contains($queuedText, [System.StringComparison]::Ordinal)) {
        throw 'Plaintext continuation leaked into DPAPI ciphertext'
    }
    if ((Unprotect-DiscordSecret -Ciphertext $queuedCipher) -cne $queuedText) {
        throw 'Queued continuation DPAPI round trip failed'
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

    Write-Output 'PASS: Discord token DPAPI storage'
}
finally {
    if ((Test-Path -LiteralPath $tempRoot) -and $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
