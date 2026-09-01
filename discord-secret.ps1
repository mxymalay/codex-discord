Set-StrictMode -Version Latest

function Protect-DiscordSecret {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw '要加密的 Discord 内容不能为空'
    }
    $secure = ConvertTo-SecureString -String $Value -AsPlainText -Force
    return ConvertFrom-SecureString -SecureString $secure
}

function Unprotect-DiscordSecret {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Ciphertext)

    try {
        $secure = ConvertTo-SecureString -String $Ciphertext
        $credential = [System.Management.Automation.PSCredential]::new('discord-secret', $secure)
        return $credential.GetNetworkCredential().Password
    }
    catch {
        throw '无法使用当前 Windows 账户解密 Discord 内容'
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
    }

    $cipher = Protect-DiscordSecret -Value $Token
    $temporaryPath = Join-Path $parent ('.{0}.{1}.tmp' -f ([System.IO.Path]::GetFileName($fullPath)), $PID)

    try {
        [System.IO.File]::WriteAllText($temporaryPath, $cipher, [System.Text.UTF8Encoding]::new($false))
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
        throw '无法使用当前 Windows 账户解密 Discord Bot Token'
    }
}
