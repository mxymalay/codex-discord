[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceDispatcher = Join-Path (Split-Path -Parent $PSScriptRoot) 'dispatcher.ps1'
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = [System.IO.Path]::GetFullPath((Join-Path $tempBase ('codex-notify-live-tests-{0}' -f [guid]::NewGuid().ToString('N'))))

if (-not $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe temporary test path: $tempRoot"
}

function Get-Value {
    param(
        [object]$Object,
        [string]$Name,
        $DefaultValue
    )

    if ($null -eq $Object) {
        return $DefaultValue
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) {
        return $DefaultValue
    }
    return $property.Value
}

function Get-MetadataFromFile {
    param([string]$Path)

    foreach ($line in @(Get-Content -LiteralPath $Path -TotalCount 20 -Encoding UTF8)) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }
        try {
            $entry = $line | ConvertFrom-Json
        }
        catch {
            continue
        }
        if ([string](Get-Value -Object $entry -Name 'type' -DefaultValue '') -eq 'session_meta') {
            return (Get-Value -Object $entry -Name 'payload' -DefaultValue $null)
        }
    }
    return $null
}

function Test-IsChildMetadata {
    param([object]$Metadata)

    $id = [string](Get-Value -Object $Metadata -Name 'id' -DefaultValue '')
    $threadSource = [string](Get-Value -Object $Metadata -Name 'thread_source' -DefaultValue '')
    $parentId = [string](Get-Value -Object $Metadata -Name 'parent_thread_id' -DefaultValue '')
    $sessionId = [string](Get-Value -Object $Metadata -Name 'session_id' -DefaultValue '')
    $source = Get-Value -Object $Metadata -Name 'source' -DefaultValue $null
    $sourceHasSubagent = $false
    if ($null -ne $source) {
        $property = $source.PSObject.Properties['subagent']
        $sourceHasSubagent = $null -ne $property -and $null -ne $property.Value
    }

    return ($threadSource -ieq 'subagent') -or
        $sourceHasSubagent -or
        (-not [string]::IsNullOrWhiteSpace($parentId)) -or
        ((-not [string]::IsNullOrWhiteSpace($sessionId)) -and $sessionId -ine $id)
}

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )

    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

$rootSample = [pscustomobject]@{ Id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
$childSample = [pscustomobject]@{ Id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
$indexedChildSample = [pscustomobject]@{ Id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }

try {
    $toolDir = Join-Path $tempRoot 'mobile-notify'
    $sessionDir = Join-Path $tempRoot 'sessions\samples'
    [void](New-Item -ItemType Directory -Path $toolDir -Force)
    [void](New-Item -ItemType Directory -Path $sessionDir -Force)
    Copy-Item -LiteralPath $sourceDispatcher -Destination (Join-Path $toolDir 'dispatcher.ps1')
    $samples = @($rootSample, $childSample)
    if ($null -ne $indexedChildSample -and $indexedChildSample.Id -ine $childSample.Id) {
        $samples += $indexedChildSample
    }
    $index = @(
        [ordered]@{ id = $rootSample.Id; thread_name = 'fixture root'; updated_at = '2026-09-01T00:00:00Z' },
        [ordered]@{ id = $indexedChildSample.Id; thread_name = 'fixture indexed child'; updated_at = '2026-09-01T00:00:00Z' }
    )
    Write-Utf8NoBom -Path (Join-Path $tempRoot 'session_index.jsonl') -Content (($index | ForEach-Object { $_ | ConvertTo-Json -Compress }) -join "`n")
    foreach ($sample in $samples) {
        $isRoot = $sample.Id -eq $rootSample.Id
        $metadata = [ordered]@{
            id = $sample.Id
            session_id = if ($isRoot) { $sample.Id } else { $rootSample.Id }
            parent_thread_id = if ($isRoot) { $null } else { $rootSample.Id }
            thread_source = if ($isRoot) { 'user' } else { 'subagent' }
            source = 'vscode'
        }
        $entry = [ordered]@{ timestamp = '2026-09-01T00:00:00.000Z'; type = 'session_meta'; payload = $metadata }
        Write-Utf8NoBom -Path (Join-Path $sessionDir ("rollout-$($sample.Id).jsonl")) -Content (($entry | ConvertTo-Json -Depth 8 -Compress) + "`n")
    }

    $config = [ordered]@{
        enabled = $true
        provider = 'ntfy'
        endpoint = 'https://ntfy.invalid/task-topic'
        quotaEndpoint = 'https://ntfy.invalid/quota-topic'
        token = ''
        includeAssistantMessage = $true
        quotaNotifications = $false
        timeoutSeconds = 1
        previousNotify = @()
    }
    Write-Utf8NoBom -Path (Join-Path $toolDir 'config.json') -Content ($config | ConvertTo-Json -Depth 8)
    $testDispatcher = Join-Path $toolDir 'dispatcher.ps1'

    function Invoke-Sample {
        param([string]$ThreadId)

        $notification = [ordered]@{
            type = 'agent-turn-complete'
            'thread-id' = $ThreadId
            'turn-id' = [guid]::NewGuid().ToString()
            cwd = 'C:\workspace\live-shape-test'
            'input-messages' = @('live metadata shape test')
            'last-assistant-message' = 'complete'
        }
        $raw = $notification | ConvertTo-Json -Depth 8 -Compress
        return ((@(& $testDispatcher $raw -MobileOnly -DryRun) | ForEach-Object { [string]$_ }) -join "`n").Trim()
    }

    $rootResult = Invoke-Sample -ThreadId $rootSample.Id
    if ([string]::IsNullOrWhiteSpace($rootResult)) {
        throw "Fixture sidebar root did not notify: $($rootSample.Id)"
    }
    $rootMessage = $rootResult | ConvertFrom-Json
    if ([string](Get-Value -Object $rootMessage -Name 'event' -DefaultValue '') -ne 'user-task-complete') {
        throw "Fixture sidebar root returned the wrong event: $rootResult"
    }

    foreach ($sample in @($samples | Where-Object { $_.Id -ine $rootSample.Id })) {
        $childResult = Invoke-Sample -ThreadId $sample.Id
        if (-not [string]::IsNullOrWhiteSpace($childResult)) {
            throw "Fixture child-agent sample emitted a task notification: $($sample.Id) -> $childResult"
        }
    }

    Write-Output "PASS: fixture root $($rootSample.Id); blocked $($samples.Count - 1) fixture child sample(s)"
}
finally {
    if ((Test-Path -LiteralPath $tempRoot) -and $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
