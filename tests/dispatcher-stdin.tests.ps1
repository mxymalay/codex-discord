[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = [System.IO.Path]::GetFullPath((Join-Path $tempBase ('codex-dispatcher-stdin-{0}' -f [guid]::NewGuid().ToString('N'))))
if (-not $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe temporary test path: $tempRoot"
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Content)
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) { [void](New-Item -ItemType Directory -Path $parent -Force) }
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

try {
    $toolDir = Join-Path $tempRoot 'mobile-notify'
    [void](New-Item -ItemType Directory -Path $toolDir -Force)
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'dispatcher.ps1') -Destination (Join-Path $toolDir 'dispatcher.ps1')
    $dispatcher = Join-Path $toolDir 'dispatcher.ps1'
    $threadId = '11111111-1111-4111-8111-111111111111'
    $config = [ordered]@{
        enabled = $true
        provider = 'ntfy'
        endpoint = 'https://ntfy.invalid/test-topic'
        quotaEndpoint = 'https://ntfy.invalid/quota-topic'
        includeAssistantMessage = $true
        quotaNotifications = $false
        timeoutSeconds = 1
        previousNotify = @()
    }
    Write-Utf8NoBom -Path (Join-Path $toolDir 'config.json') -Content ($config | ConvertTo-Json -Depth 8)
    Write-Utf8NoBom -Path (Join-Path $tempRoot 'session_index.jsonl') -Content (([ordered]@{ id=$threadId; thread_name='长消息测试'; updated_at='2026-09-01T00:00:00Z' } | ConvertTo-Json -Compress) + "`n")
    $session = [ordered]@{
        timestamp = '2026-09-01T00:00:00.000Z'
        type = 'session_meta'
        payload = [ordered]@{ id=$threadId; session_id=$threadId; parent_thread_id=$null; thread_source='user'; source='vscode'; cwd='C:\workspace\demo' }
    }
    Write-Utf8NoBom -Path (Join-Path $tempRoot "sessions\2026\09\01\rollout-$threadId.jsonl") -Content (($session | ConvertTo-Json -Depth 10 -Compress) + "`n")

    $notification = [ordered]@{
        type = 'agent-turn-complete'
        'thread-id' = $threadId
        'turn-id' = '22222222-2222-4222-8222-222222222222'
        cwd = 'C:\workspace\demo'
        'input-messages' = @('检查长文本通知')
        'last-assistant-message' = ('完成。' + ('很长的结果。' * 12000))
    }
    $raw = $notification | ConvertTo-Json -Depth 8 -Compress
    if ($raw.Length -le 32767) { throw 'Test fixture is not long enough to reproduce the Windows command-line limit' }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = (Get-Command pwsh).Source
    foreach ($argument in @('-NoProfile', '-File', $dispatcher, '-MobileOnly', '-DryRun')) {
        [void]$startInfo.ArgumentList.Add($argument)
    }
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $process.StandardInput.Write($raw)
    $process.StandardInput.Close()
    $rawOutput = $process.StandardOutput.ReadToEnd().Trim()
    $errorOutput = $process.StandardError.ReadToEnd().Trim()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "Dispatcher stdin invocation failed with exit code $($process.ExitCode): $errorOutput" }
    $process.Dispose()
    if ([string]::IsNullOrWhiteSpace($rawOutput)) {
        $diagnosticLog = if (Test-Path -LiteralPath (Join-Path $toolDir 'mobile-notify.log')) {
            [System.IO.File]::ReadAllText((Join-Path $toolDir 'mobile-notify.log'))
        }
        else { '<no dispatcher log>' }
        throw "Dispatcher produced no output for a long stdin notification. Log: $diagnosticLog"
    }
    $message = $rawOutput | ConvertFrom-Json
    if (-not $message.PSObject.Properties['event'] -or [string]$message.event -ne 'user-task-complete') {
        throw "Dispatcher did not parse the long notification from stdin. Output: $rawOutput"
    }

    Write-Output 'PASS: dispatcher accepts long notification JSON over stdin'
}
finally {
    if ((Test-Path -LiteralPath $tempRoot) -and $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
