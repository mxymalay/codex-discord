[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = [System.IO.Path]::GetFullPath((Join-Path $tempBase ('codex-notify-setup-tests-{0}' -f [guid]::NewGuid().ToString('N'))))

if (-not $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe temporary test path: $tempRoot"
}

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )

    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

try {
    [void](New-Item -ItemType Directory -Path $tempRoot -Force)
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'setup.ps1') -Destination (Join-Path $tempRoot 'setup.ps1')
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'dispatcher.ps1') -Destination (Join-Path $tempRoot 'dispatcher.ps1')

    $config = [ordered]@{
        enabled = $true
        provider = 'ntfy'
        endpoint = 'https://ntfy.sh/original-task-topic'
        quotaEndpoint = 'https://ntfy.sh/existing-quota-topic'
        token = ''
        includeAssistantMessage = $false
        quotaNotifications = $true
        timeoutSeconds = 8
        previousNotify = @()
    }
    Write-Utf8NoBom -Path (Join-Path $tempRoot 'config.json') -Content ($config | ConvertTo-Json -Depth 8)

    $setup = Join-Path $tempRoot 'setup.ps1'
    & $setup ntfy 'new-task-topic' -IncludeMessage -SkipTest | Out-Null
    $first = Get-Content -Raw -LiteralPath (Join-Path $tempRoot 'config.json') -Encoding UTF8 | ConvertFrom-Json

    if ([string]$first.endpoint -ne 'https://ntfy.sh/new-task-topic') {
        throw "Unexpected task endpoint: $($first.endpoint)"
    }
    if ([string]$first.quotaEndpoint -ne 'https://ntfy.sh/existing-quota-topic') {
        throw "Quota endpoint was replaced: $($first.quotaEndpoint)"
    }
    if ([string]$first.confirmationEndpoint -notmatch '^https://ntfy\.sh/codex-confirm-[0-9a-f]{32}$') {
        throw "Confirmation endpoint was not generated correctly: $($first.confirmationEndpoint)"
    }
    if (-not [bool]$first.includeAssistantMessage) {
        throw 'IncludeMessage was not persisted'
    }

    $confirmationEndpoint = [string]$first.confirmationEndpoint
    & $setup ntfy 'second-task-topic' -IncludeMessage -SkipTest | Out-Null
    $second = Get-Content -Raw -LiteralPath (Join-Path $tempRoot 'config.json') -Encoding UTF8 | ConvertFrom-Json

    if ([string]$second.confirmationEndpoint -ne $confirmationEndpoint) {
        throw 'Existing confirmation endpoint was replaced on reconfiguration'
    }
    if ([string]$second.quotaEndpoint -ne 'https://ntfy.sh/existing-quota-topic') {
        throw 'Existing quota endpoint was replaced on reconfiguration'
    }

    $topics = @(@([string]$second.endpoint, [string]$second.confirmationEndpoint, [string]$second.quotaEndpoint) | Select-Object -Unique)
    if ($topics.Count -ne 3) {
        throw 'Task, confirmation, and quota endpoints are not distinct'
    }

    Write-Output 'PASS: setup creates and preserves a distinct confirmation endpoint'
}
finally {
    if ((Test-Path -LiteralPath $tempRoot) -and $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
