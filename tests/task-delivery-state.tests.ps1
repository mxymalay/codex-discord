[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $sourceRoot 'task-delivery-state.ps1')

$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = [System.IO.Path]::GetFullPath((Join-Path $tempBase ('codex-task-delivery-state-{0}' -f [guid]::NewGuid().ToString('N'))))
if (-not $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe temporary test path: $tempRoot"
}

try {
    [void](New-Item -ItemType Directory -Path $tempRoot -Force)
    $statePath = Join-Path $tempRoot 'task-delivery-state.json'
    $turnId = '11111111-1111-4111-8111-111111111111'
    $calls = 0

    $first = Invoke-TaskNotificationOnce -Path $statePath -TurnId $turnId -Action { $script:calls++ }
    $second = Invoke-TaskNotificationOnce -Path $statePath -TurnId $turnId -Action { $script:calls++ }
    if (-not $first -or $second -or $calls -ne 1) {
        throw "Duplicate turn was not suppressed: first=$first second=$second calls=$calls"
    }

    $failedTurnId = '22222222-2222-4222-8222-222222222222'
    try {
        Invoke-TaskNotificationOnce -Path $statePath -TurnId $failedTurnId -Action { throw 'temporary send failure' }
        throw 'Expected the first send attempt to fail'
    }
    catch {
        if ($_.Exception.Message -ne 'temporary send failure') { throw }
    }
    $retried = Invoke-TaskNotificationOnce -Path $statePath -TurnId $failedTurnId -Action { $script:calls++ }
    if (-not $retried -or $calls -ne 2) {
        throw 'A failed send was incorrectly marked as delivered'
    }

    $state = Read-TaskDeliveryState -Path $statePath
    if (@($state.delivered.PSObject.Properties).Count -ne 2) {
        throw 'Delivered turn state did not persist both successful sends'
    }

    Write-Output 'PASS: task delivery state suppresses duplicates and retries failures'
}
finally {
    if ((Test-Path -LiteralPath $tempRoot) -and $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
