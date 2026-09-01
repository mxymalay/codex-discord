[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceDispatcher = Join-Path (Split-Path -Parent $PSScriptRoot) 'dispatcher.ps1'
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = Join-Path $tempBase ('codex-notify-routing-tests-{0}' -f [guid]::NewGuid().ToString('N'))
$tempRoot = [System.IO.Path]::GetFullPath($tempRoot)

if (-not $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe temporary test path: $tempRoot"
}

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )

    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) {
        [void](New-Item -ItemType Directory -Path $parent -Force)
    }
    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

function New-SessionFixture {
    param(
        [string]$Id,
        [hashtable]$Metadata,
        [switch]$Corrupt
    )

    $sessionPath = Join-Path $tempRoot "sessions\2026\08\31\rollout-2026-08-31T00-00-00-$Id.jsonl"
    if ($Corrupt) {
        Write-Utf8NoBom -Path $sessionPath -Content '{not-json'
        return
    }

    $payload = [ordered]@{ id = $Id }
    foreach ($key in $Metadata.Keys) {
        $payload[$key] = $Metadata[$key]
    }
    $entry = [ordered]@{
        timestamp = '2026-08-31T00:00:00.000Z'
        type = 'session_meta'
        payload = $payload
    }
    Write-Utf8NoBom -Path $sessionPath -Content (($entry | ConvertTo-Json -Depth 12 -Compress) + "`n")
}

function Invoke-DispatcherCase {
    param(
        [string]$ThreadId,
        [string]$InputMessage = 'complete user request'
    )

    $notification = [ordered]@{
        type = 'agent-turn-complete'
        'thread-id' = $ThreadId
        'turn-id' = [guid]::NewGuid().ToString()
        cwd = 'C:\workspace\demo'
        'input-messages' = @($InputMessage)
        'last-assistant-message' = 'task complete'
    }
    $raw = $notification | ConvertTo-Json -Depth 8 -Compress
    $output = @(& $testDispatcher $raw -MobileOnly -DryRun)
    return (($output | ForEach-Object { [string]$_ }) -join "`n").Trim()
}

$rootId = '11111111-1111-4111-8111-111111111111'
$legacyRootId = '22222222-2222-4222-8222-222222222222'
$childId = '33333333-3333-4333-8333-333333333333'
$nestedChildId = '44444444-4444-4444-8444-444444444444'
$indexedChildId = '55555555-5555-4555-8555-555555555555'
$rootWithoutIndexId = '66666666-6666-4666-8666-666666666666'
$corruptId = '77777777-7777-4777-8777-777777777777'
$unknownId = '88888888-8888-4888-8888-888888888888'
$sourceOnlyChildId = '99999999-9999-4999-8999-999999999999'
$parentOnlyChildId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
$sessionOnlyChildId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
$unknownSourceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
$minimalLegacyRootId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

$failures = @()

try {
    $toolDir = Join-Path $tempRoot 'mobile-notify'
    [void](New-Item -ItemType Directory -Path $toolDir -Force)
    Copy-Item -LiteralPath $sourceDispatcher -Destination (Join-Path $toolDir 'dispatcher.ps1')
    $testDispatcher = Join-Path $toolDir 'dispatcher.ps1'

    $config = [ordered]@{
        enabled = $true
        provider = 'ntfy'
        endpoint = 'https://ntfy.invalid/test-topic'
        quotaEndpoint = 'https://ntfy.invalid/quota-topic'
        token = ''
        includeAssistantMessage = $true
        quotaNotifications = $false
        timeoutSeconds = 1
        previousNotify = @()
    }
    Write-Utf8NoBom -Path (Join-Path $toolDir 'config.json') -Content ($config | ConvertTo-Json -Depth 8)

    $sidebarEntries = @(
        [ordered]@{ id = $rootId; thread_name = 'sidebar root task'; updated_at = '2026-08-31T00:00:00Z' },
        [ordered]@{ id = $legacyRootId; thread_name = 'legacy root task'; updated_at = '2026-08-31T00:00:00Z' },
        [ordered]@{ id = $indexedChildId; thread_name = 'indexed child task'; updated_at = '2026-08-31T00:00:00Z' },
        [ordered]@{ id = $corruptId; thread_name = 'corrupt metadata task'; updated_at = '2026-08-31T00:00:00Z' },
        [ordered]@{ id = $sourceOnlyChildId; thread_name = 'source-only child task'; updated_at = '2026-08-31T00:00:00Z' },
        [ordered]@{ id = $parentOnlyChildId; thread_name = 'parent-only child task'; updated_at = '2026-08-31T00:00:00Z' },
        [ordered]@{ id = $sessionOnlyChildId; thread_name = 'session-only child task'; updated_at = '2026-08-31T00:00:00Z' },
        [ordered]@{ id = $unknownSourceId; thread_name = 'unknown-source task'; updated_at = '2026-08-31T00:00:00Z' },
        [ordered]@{ id = $minimalLegacyRootId; thread_name = 'minimal legacy root task'; updated_at = '2026-08-31T00:00:00Z' }
    )
    $indexLines = @($sidebarEntries | ForEach-Object { $_ | ConvertTo-Json -Compress })
    Write-Utf8NoBom -Path (Join-Path $tempRoot 'session_index.jsonl') -Content (($indexLines -join "`n") + "`n")

    New-SessionFixture -Id $rootId -Metadata @{
        session_id = $rootId
        parent_thread_id = $null
        thread_source = 'user'
        source = 'vscode'
        originator = 'Codex Desktop'
    }
    New-SessionFixture -Id $legacyRootId -Metadata @{
        session_id = $legacyRootId
        parent_thread_id = $null
        source = 'vscode'
        originator = 'Codex Desktop'
    }
    New-SessionFixture -Id $childId -Metadata @{
        session_id = $rootId
        parent_thread_id = $rootId
        thread_source = 'subagent'
        source = @{ subagent = @{ thread_spawn = @{ parent_thread_id = $rootId; depth = 1; agent_path = '/root/audit'; agent_nickname = 'Ada' } } }
    }
    New-SessionFixture -Id $nestedChildId -Metadata @{
        session_id = $rootId
        parent_thread_id = $childId
        thread_source = 'subagent'
        source = @{ subagent = @{ thread_spawn = @{ parent_thread_id = $childId; depth = 2; agent_path = $null; agent_nickname = 'Bohr' } } }
    }
    New-SessionFixture -Id $indexedChildId -Metadata @{
        session_id = $rootId
        parent_thread_id = $rootId
        thread_source = 'subagent'
        source = @{ subagent = @{ thread_spawn = @{ parent_thread_id = $rootId; depth = 1; agent_path = $null; agent_nickname = 'Turing' } } }
    }
    New-SessionFixture -Id $rootWithoutIndexId -Metadata @{
        session_id = $rootWithoutIndexId
        parent_thread_id = $null
        thread_source = 'user'
        source = 'vscode'
    }
    New-SessionFixture -Id $corruptId -Metadata @{} -Corrupt
    New-SessionFixture -Id $sourceOnlyChildId -Metadata @{
        session_id = $sourceOnlyChildId
        parent_thread_id = $null
        source = @{ subagent = @{ thread_spawn = @{ depth = 1; agent_path = $null } } }
    }
    New-SessionFixture -Id $parentOnlyChildId -Metadata @{
        session_id = $parentOnlyChildId
        parent_thread_id = $rootId
        source = 'vscode'
    }
    New-SessionFixture -Id $sessionOnlyChildId -Metadata @{
        session_id = $rootId
        parent_thread_id = $null
        source = 'vscode'
    }
    New-SessionFixture -Id $unknownSourceId -Metadata @{
        session_id = $unknownSourceId
        parent_thread_id = $null
        thread_source = 'automation'
        source = 'vscode'
    }
    New-SessionFixture -Id $minimalLegacyRootId -Metadata @{
        parent_thread_id = $null
        source = 'vscode'
    }

    $cases = @(
        [pscustomobject]@{ Name = 'sidebar root task notifies'; ThreadId = $rootId; Input = 'complete user request'; ShouldNotify = $true },
        [pscustomobject]@{ Name = 'legacy root metadata notifies'; ThreadId = $legacyRootId; Input = 'complete legacy task'; ShouldNotify = $true },
        [pscustomobject]@{ Name = 'direct child does not notify'; ThreadId = $childId; Input = 'return your review now'; ShouldNotify = $false },
        [pscustomobject]@{ Name = 'nested child does not notify'; ThreadId = $nestedChildId; Input = 'complete bounded audit'; ShouldNotify = $false },
        [pscustomobject]@{ Name = 'indexed child still does not notify'; ThreadId = $indexedChildId; Input = 'review implementation'; ShouldNotify = $false },
        [pscustomobject]@{ Name = 'root absent from sidebar does not notify'; ThreadId = $rootWithoutIndexId; Input = 'hidden root task'; ShouldNotify = $false },
        [pscustomobject]@{ Name = 'corrupt session metadata does not notify'; ThreadId = $corruptId; Input = 'corrupt metadata'; ShouldNotify = $false },
        [pscustomobject]@{ Name = 'unknown thread does not notify'; ThreadId = $unknownId; Input = 'unknown thread'; ShouldNotify = $false },
        [pscustomobject]@{ Name = 'subagent source marker alone blocks notification'; ThreadId = $sourceOnlyChildId; Input = 'source-only child'; ShouldNotify = $false },
        [pscustomobject]@{ Name = 'parent thread marker alone blocks notification'; ThreadId = $parentOnlyChildId; Input = 'parent-only child'; ShouldNotify = $false },
        [pscustomobject]@{ Name = 'parent session mismatch alone blocks notification'; ThreadId = $sessionOnlyChildId; Input = 'session-only child'; ShouldNotify = $false },
        [pscustomobject]@{ Name = 'unrecognized thread source fails closed'; ThreadId = $unknownSourceId; Input = 'unknown source'; ShouldNotify = $false },
        [pscustomobject]@{ Name = 'minimal indexed legacy root still notifies'; ThreadId = $minimalLegacyRootId; Input = 'minimal legacy root'; ShouldNotify = $true },
        [pscustomobject]@{ Name = 'root heartbeat does not notify'; ThreadId = $rootId; Input = '<heartbeat>check</heartbeat>'; ShouldNotify = $false },
        [pscustomobject]@{ Name = 'root title generator does not notify'; ThreadId = $rootId; Input = 'You are a helpful assistant. Create a short title for a task'; ShouldNotify = $false }
    )

    foreach ($case in $cases) {
        $result = Invoke-DispatcherCase -ThreadId $case.ThreadId -InputMessage $case.Input
        $didNotify = -not [string]::IsNullOrWhiteSpace($result)
        if ($didNotify -ne $case.ShouldNotify) {
            $failures += "[$($case.Name)] expected ShouldNotify=$($case.ShouldNotify), got $didNotify. Output: $result"
            continue
        }
        if ($didNotify) {
            try {
                $message = $result | ConvertFrom-Json
                if ([string]$message.event -ne 'user-task-complete') {
                    $failures += "[$($case.Name)] expected event=user-task-complete, got $($message.event)"
                }
            }
            catch {
                $failures += "[$($case.Name)] output was not valid notification JSON: $result"
            }
        }
    }

    if ($failures.Count -gt 0) {
        throw ($failures -join "`n")
    }

    Write-Output "PASS: $($cases.Count) dispatcher routing cases"
}
finally {
    if ((Test-Path -LiteralPath $tempRoot) -and $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
