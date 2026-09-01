[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = [System.IO.Path]::GetFullPath((Join-Path $tempBase ('codex-dispatcher-system-test-{0}' -f [guid]::NewGuid().ToString('N'))))
if (-not $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe temporary test path: $tempRoot" }

function Write-Utf8NoBom([string]$Path, [string]$Content) {
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) { [void](New-Item -ItemType Directory -Path $parent -Force) }
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

try {
    $toolDir = Join-Path $tempRoot 'mobile-notify'
    [void](New-Item -ItemType Directory -Path $toolDir -Force)
    foreach ($name in @('dispatcher.ps1', 'discord-state.ps1', 'discord-http.ps1', 'discord-secret.ps1')) {
        $source = Join-Path $sourceRoot $name
        if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $toolDir $name) }
    }
    $dispatcher = Join-Path $toolDir 'dispatcher.ps1'
    $config = [ordered]@{
        enabled = $true
        provider = 'discord-bot'
        quotaNotifications = $true
        discordTaskChannelId = '444444444444444444'
        discordConfirmationChannelId = '555555555555555555'
        discordQuotaChannelId = '666666666666666666'
        discordTokenPath = '.\\discord-token.dpapi'
        timeoutSeconds = 1
        previousNotify = @()
    }
    Write-Utf8NoBom (Join-Path $toolDir 'config.json') ($config | ConvertTo-Json -Depth 8)
    $quotaPath = Join-Path $toolDir 'quota-state.json'
    $quotaSentinel = '{"sentinel":"unchanged"}'
    Write-Utf8NoBom $quotaPath $quotaSentinel

    foreach ($kind in @('task', 'confirmation', 'quota')) {
        $result = @(& $dispatcher -MobileOnly -DryRun -SystemTestEvent $kind) -join "`n" | ConvertFrom-Json
        $expectedChannel = [string]$config."discord$($kind.Substring(0,1).ToUpperInvariant())$($kind.Substring(1))ChannelId"
        if ($kind -eq 'task') { $expectedChannel = [string]$config.discordTaskChannelId }
        if ([string]$result.channelId -ne $expectedChannel) { throw "wrong $kind test channel" }
        if (-not [bool]$result.syntheticTest) { throw "$kind test payload not marked synthetic" }
        if ([bool]$result.saveTaskMapping) { throw "$kind synthetic test would create a task mapping" }
        $payloadJson = $result.payload | ConvertTo-Json -Depth 12
        if (-not $payloadJson.Contains('系统测试')) { throw "$kind payload is not clearly labelled" }
        if (@($result.payload.allowed_mentions.parse).Count -ne 0) { throw "$kind payload enabled mentions" }
    }

    if ((Get-Content -Raw -LiteralPath $quotaPath -Encoding UTF8) -ne $quotaSentinel) { throw 'quota synthetic test changed quota-state.json' }
    if (Test-Path -LiteralPath (Join-Path $toolDir 'discord-message-map.json')) { throw 'synthetic tests created a task mapping file' }
    Write-Output 'PASS: dispatcher synthetic system tests are isolated'
}
finally {
    if ((Test-Path -LiteralPath $tempRoot) -and $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
