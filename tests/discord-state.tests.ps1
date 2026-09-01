[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $sourceRoot 'discord-state.ps1')

$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = [System.IO.Path]::GetFullPath((Join-Path $tempBase ('codex-discord-state-tests-{0}' -f [guid]::NewGuid().ToString('N'))))
if (-not $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe temporary test path: $tempRoot"
}

try {
    [void](New-Item -ItemType Directory -Path $tempRoot -Force)
    $statePath = Join-Path $tempRoot 'discord-message-map.json'

    Save-DiscordTaskMapping `
        -Path $statePath `
        -MessageId '777777777777777701' `
        -ThreadId '11111111-1111-4111-8111-111111111111' `
        -Cwd 'C:\workspace\demo' `
        -ChannelId '444444444444444444' `
        -EventName 'user-task-complete'

    Save-DiscordTaskMapping `
        -Path $statePath `
        -MessageId '777777777777777702' `
        -ThreadId '22222222-2222-4222-8222-222222222222' `
        -Cwd 'C:\workspace\demo-two' `
        -ChannelId '555555555555555555' `
        -EventName 'user-task-confirmation-required'

    $state = Read-DiscordTaskMappingState -Path $statePath
    if ([int]$state.version -ne 1) {
        throw 'Discord mapping state version is incorrect'
    }
    $first = $state.messages.PSObject.Properties['777777777777777701'].Value
    $second = $state.messages.PSObject.Properties['777777777777777702'].Value
    if ([string]$first.threadId -ne '11111111-1111-4111-8111-111111111111' -or [string]$first.eventName -ne 'user-task-complete') {
        throw 'First Discord task mapping is incorrect'
    }
    if ([string]$second.cwd -ne 'C:\workspace\demo-two' -or [string]$second.channelId -ne '555555555555555555') {
        throw 'Second Discord task mapping is incorrect'
    }

    Write-Output 'PASS: Discord task message mapping state'
}
finally {
    if ((Test-Path -LiteralPath $tempRoot) -and $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
