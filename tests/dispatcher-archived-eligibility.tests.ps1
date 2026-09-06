[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Load only function definitions: no dispatcher setup, delivery, or live state access.
$source = Join-Path (Split-Path -Parent $PSScriptRoot) 'dispatcher.ps1'
$parseErrors = $null
$tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'Dispatcher parse failed.' }
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
        . ([scriptblock]::Create($statement.Extent.Text))
    }
}
function Get-VerifiedDiscordTurnOriginRecord { param($Notification) return $null }

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('dispatcher-archive-tests-' + [guid]::NewGuid().ToString('N'))
$threadId = '11111111-1111-4111-8111-111111111111'
$turnId = '22222222-2222-4222-8222-222222222222'
$otherId = '33333333-3333-4333-8333-333333333333'
$otherTurn = '44444444-4444-4444-8444-444444444444'
$notification = [pscustomobject]@{ 'thread-id' = $threadId; 'turn-id' = $turnId }
$failures = New-Object 'System.Collections.Generic.List[string]'
$caseCount = 0

function Write-FixtureText {
    param([string]$Path, [string]$Text)
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path))
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}
function New-RootMetadata {
    return [pscustomobject]@{ id = $threadId; session_id = $threadId; thread_source = 'user'; source = 'vscode'; parent_thread_id = $null }
}
function New-MetadataEntry {
    param([object]$Metadata = (New-RootMetadata))
    return [pscustomobject]@{ type = 'session_meta'; payload = $Metadata }
}
function New-TurnEvent {
    param([string]$Type, [string]$Id = $turnId)
    return [pscustomobject]@{ type = 'event_msg'; payload = @{ type = $Type; turn_id = $Id } }
}
function Write-Archive {
    param([string]$Name = 'rollout', [object[]]$Entries = @((New-MetadataEntry), (New-TurnEvent 'task_started'), (New-TurnEvent 'task_complete')))
    $path = Join-Path $archiveRoot ($Name + '-' + $threadId + '.jsonl')
    $lines = @($Entries | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 20 })
    Write-FixtureText $path (($lines -join "`n") + "`n")
    return $path
}
function Assert-Eligibility {
    param([bool]$Allowed)
    $result = Get-TaskNotificationEligibility -Notification $notification
    if ($result.Allowed -ne $Allowed) { throw "Expected Allowed=$Allowed; got $($result.Allowed): $($result.Reason)" }
}
function Test-Case {
    param([string]$Name, [scriptblock]$Body)
    $script:caseCount++
    $caseRoot = Join-Path $tempRoot ([string]$script:caseCount)
    $sessionsPath = Join-Path $caseRoot 'sessions'
    $archiveRoot = Join-Path $caseRoot 'archived_sessions'
    $sessionIndexPath = Join-Path $caseRoot 'session_index.jsonl'
    [void][IO.Directory]::CreateDirectory($sessionsPath)
    [void][IO.Directory]::CreateDirectory($archiveRoot)
    Write-FixtureText $sessionIndexPath ((@{ id = $threadId; thread_name = 'synthetic root' } | ConvertTo-Json -Compress) + "`n")
    try { & $Body; Write-Host "PASS $Name" }
    catch { $failures.Add("$Name : $($_.Exception.Message)"); Write-Host "FAIL $Name : $($_.Exception.Message)" }
}

try {
    Test-Case 'active metadata retains existing eligibility without an exact turn span' {
        Write-FixtureText (Join-Path $sessionsPath ('rollout-' + $threadId + '.jsonl')) (((New-MetadataEntry) | ConvertTo-Json -Compress -Depth 10) + "`n")
        Assert-Eligibility $true
    }
    Test-Case 'unique archived sidebar root with exact completed turn is eligible' {
        [void](Write-Archive)
        Assert-Eligibility $true
    }
    Test-Case 'archive fallback still requires sidebar membership' {
        [void](Write-Archive)
        Remove-Item -LiteralPath $sessionIndexPath
        Assert-Eligibility $false
    }
    Test-Case 'another archived turn cannot authorize the requested turn' {
        [void](Write-Archive -Entries @((New-MetadataEntry), (New-TurnEvent 'task_started' $otherTurn), (New-TurnEvent 'task_complete' $otherTurn)))
        Assert-Eligibility $false
    }
    Test-Case 'same thread archive without the target turn does not create ambiguity' {
        [void](Write-Archive 'target')
        [void](Write-Archive 'other' @((New-MetadataEntry), (New-TurnEvent 'task_started' $otherTurn), (New-TurnEvent 'task_complete' $otherTurn)))
        Assert-Eligibility $true
    }
    foreach ($kind in @('wrong-thread', 'subagent', 'source-subagent', 'parent', 'session-mismatch', 'unknown-source')) {
        Test-Case "archived $kind metadata is denied" {
            $metadata = New-RootMetadata
            switch ($kind) {
                'wrong-thread' { $metadata.id = $otherId }
                'subagent' { $metadata.thread_source = 'subagent' }
                'source-subagent' { $metadata.source = [pscustomobject]@{ subagent = @{ thread_spawn = @{ parent_thread_id = $otherId } } } }
                'parent' { $metadata.parent_thread_id = $otherId }
                'session-mismatch' { $metadata.session_id = $otherId }
                'unknown-source' { $metadata.thread_source = 'automation' }
            }
            [void](Write-Archive -Entries @((New-MetadataEntry $metadata), (New-TurnEvent 'task_started'), (New-TurnEvent 'task_complete')))
            Assert-Eligibility $false
        }
    }
    Test-Case 'two exact archived turn claimants are denied' {
        [void](Write-Archive 'first')
        [void](Write-Archive 'second')
        Assert-Eligibility $false
    }
    foreach ($badText in @('{broken', "{broken`n", '')) {
        Test-Case 'valid archive plus an unclassifiable candidate is denied' {
            [void](Write-Archive 'valid')
            Write-FixtureText (Join-Path $archiveRoot ('unknown-' + $threadId + '.jsonl')) $badText
            Assert-Eligibility $false
        }
    }
    Test-Case 'inherited child metadata before the current root span is harmless' {
        $old = New-RootMetadata
        $old.id = $otherId
        $old.thread_source = 'subagent'
        [void](Write-Archive -Entries @((New-MetadataEntry $old), (New-MetadataEntry), (New-TurnEvent 'task_started'), (New-TurnEvent 'task_complete')))
        Assert-Eligibility $true
    }
    Test-Case 'metadata changing inside the target span is denied' {
        [void](Write-Archive -Entries @((New-MetadataEntry), (New-TurnEvent 'task_started'), (New-MetadataEntry), (New-TurnEvent 'task_complete')))
        Assert-Eligibility $false
    }
    Test-Case 'interrupted target span is denied' {
        [void](Write-Archive -Entries @((New-MetadataEntry), (New-TurnEvent 'task_started'), (New-TurnEvent 'task_started' $otherTurn), (New-TurnEvent 'task_complete')))
        Assert-Eligibility $false
    }
    Test-Case 'duplicate target span is denied' {
        [void](Write-Archive -Entries @((New-MetadataEntry), (New-TurnEvent 'task_started'), (New-TurnEvent 'task_complete'), (New-TurnEvent 'task_started'), (New-TurnEvent 'task_complete')))
        Assert-Eligibility $false
    }
    Test-Case 'target completion without a start is denied' {
        [void](Write-Archive -Entries @((New-MetadataEntry), (New-TurnEvent 'task_complete')))
        Assert-Eligibility $false
    }
    Test-Case 'unfinished target span is denied' {
        [void](Write-Archive -Entries @((New-MetadataEntry), (New-TurnEvent 'task_started')))
        Assert-Eligibility $false
    }
    Test-Case 'unterminated final JSON line is denied' {
        $path = Write-Archive
        Write-FixtureText $path ([IO.File]::ReadAllText($path).TrimEnd([char]10))
        Assert-Eligibility $false
    }
    Test-Case 'line over eight MiB is denied even with valid target evidence' {
        $path = Write-Archive
        [IO.File]::AppendAllText($path, ('{"type":"padding","payload":"' + ('x' * (8 * 1024 * 1024)) + '"}' + "`n"), (New-Object Text.UTF8Encoding($false)))
        Assert-Eligibility $false
    }
    foreach ($kind in @('root', 'intermediate', 'candidate')) {
        Test-Case "archive $kind symlink is denied" {
            $outside = Join-Path $caseRoot 'outside'
            [void][IO.Directory]::CreateDirectory($outside)
            $directoryLinkType = if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { 'Junction' } else { 'SymbolicLink' }
            if ($kind -eq 'root') {
                $path = Write-Archive
                Move-Item -LiteralPath $path -Destination $outside
                Remove-Item -LiteralPath $archiveRoot
                [void](New-Item -ItemType $directoryLinkType -Path $archiveRoot -Target $outside -ErrorAction Stop)
            }
            elseif ($kind -eq 'intermediate') {
                [void](Write-Archive)
                [void](New-Item -ItemType $directoryLinkType -Path (Join-Path $archiveRoot 'linked') -Target $outside -ErrorAction Stop)
            }
            else {
                $path = Write-Archive
                $target = Join-Path $outside ([IO.Path]::GetFileName($path))
                Move-Item -LiteralPath $path -Destination $target
                [void](New-Item -ItemType SymbolicLink -Path $path -Target $target -ErrorAction Stop)
            }
            Assert-Eligibility $false
        }
    }
}
finally { if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force } }
if ($failures.Count -gt 0) { throw ($failures -join "`n") }
Write-Host "PASS all $caseCount archived eligibility cases"
