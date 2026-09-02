[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = [System.IO.Path]::GetFullPath((Join-Path $tempBase ('codex-discord-tests-{0}' -f [guid]::NewGuid().ToString('N'))))

if (-not $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe temporary test path: $tempRoot"
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Content)

    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) {
        [void](New-Item -ItemType Directory -Path $parent -Force)
    }
    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

function Invoke-TaskCase {
    param([string]$UserMessage, [string]$AssistantMessage)

    $turnId = [guid]::NewGuid().ToString()
    $notification = [ordered]@{
        type = 'agent-turn-complete'
        'thread-id' = $script:rootId
        'turn-id' = $turnId
        cwd = 'C:\workspace\demo-project'
        'input-messages' = @($UserMessage)
        'last-assistant-message' = $AssistantMessage
    }
    $turnContext = [ordered]@{
        timestamp = '2026-08-31T00:00:01.000Z'
        type = 'turn_context'
        payload = [ordered]@{ turn_id = $turnId; model = 'gpt-5.6-sol'; effort = 'ultra' }
    }
    Add-Content -LiteralPath $script:sessionPath -Value ($turnContext | ConvertTo-Json -Depth 8 -Compress) -Encoding UTF8
    $raw = $notification | ConvertTo-Json -Depth 8 -Compress
    $output = @(& $script:testDispatcher $raw -MobileOnly -DryRun)
    return ((($output | ForEach-Object { [string]$_ }) -join "`n").Trim() | ConvertFrom-Json)
}

$failures = @()
$rootId = 'f1111111-1111-4111-8111-111111111111'
$taskWebhook = 'https://discord.com/api/webhooks/111111/task-secret'
$confirmationWebhook = 'https://discord.com/api/webhooks/222222/confirmation-secret'
$quotaWebhook = 'https://discord.com/api/webhooks/333333/quota-secret'

try {
    $toolDir = Join-Path $tempRoot 'mobile-notify'
    [void](New-Item -ItemType Directory -Path $toolDir -Force)
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'dispatcher.ps1') -Destination (Join-Path $toolDir 'dispatcher.ps1')
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'setup.ps1') -Destination (Join-Path $toolDir 'setup.ps1')
    $testDispatcher = Join-Path $toolDir 'dispatcher.ps1'
    $testSetup = Join-Path $toolDir 'setup.ps1'

    $config = [ordered]@{
        enabled = $true
        provider = 'discord'
        endpoint = $taskWebhook
        confirmationEndpoint = $confirmationWebhook
        quotaEndpoint = $quotaWebhook
        token = ''
        includeAssistantMessage = $true
        quotaNotifications = $false
        timeoutSeconds = 1
        previousNotify = @()
    }
    Write-Utf8NoBom -Path (Join-Path $toolDir 'config.json') -Content ($config | ConvertTo-Json -Depth 8)

    $indexEntry = [ordered]@{
        id = $rootId
        thread_name = 'Discord 格式测试任务'
        updated_at = '2026-08-31T00:00:00Z'
    }
    Write-Utf8NoBom -Path (Join-Path $tempRoot 'session_index.jsonl') -Content (($indexEntry | ConvertTo-Json -Compress) + "`n")

    $sessionEntry = [ordered]@{
        timestamp = '2026-08-31T00:00:00.000Z'
        type = 'session_meta'
        payload = [ordered]@{
            id = $rootId
            session_id = $rootId
            parent_thread_id = $null
            thread_source = 'user'
            source = 'vscode'
            originator = 'Codex Desktop'
        }
    }
    $sessionPath = Join-Path $tempRoot "sessions\2026\08\31\rollout-2026-08-31T00-00-00-$rootId.jsonl"
    $script:sessionPath = $sessionPath
    Write-Utf8NoBom -Path $sessionPath -Content (($sessionEntry | ConvertTo-Json -Depth 12 -Compress) + "`n")

    $completed = Invoke-TaskCase -UserMessage '完成 Discord 通知接入' -AssistantMessage '已完成 Discord 通知接入，全部测试通过。'
    if ([string]$completed.endpoint -ne $taskWebhook) {
        $failures += "[complete route] expected task webhook, got $($completed.endpoint)"
    }
    if ([int]$completed.payload.embeds[0].color -ne 3066993) {
        $failures += "[complete color] expected green 3066993, got $($completed.payload.embeds[0].color)"
    }
    $completedFields = @($completed.payload.embeds[0].fields)
    if (($completedFields | Where-Object { $_.name -eq '项目名' }).value -ne 'demo\-project') {
        $failures += '[complete fields] project field is missing or incorrect'
    }
    if (($completedFields | Where-Object { $_.name -eq '任务名' }).value -ne 'Discord 格式测试任务') {
        $failures += '[complete fields] task name field is missing or incorrect'
    }
    if (($completedFields | Where-Object { $_.name -eq '任务' }).value -ne '完成 Discord 通知接入') {
        $failures += '[complete fields] task field is missing or incorrect'
    }
    if (($completedFields | Where-Object { $_.name -eq '结果' }).value -ne '已完成 Discord 通知接入，全部测试通过。') {
        $failures += '[complete fields] result field is missing or incorrect'
    }
    if ([string]$completed.payload.embeds[0].footer.text -ne '由 5.6 Sol Ultra 支持') {
        $failures += '[complete footer] model and reasoning effort support line is missing or incorrect'
    }
    if (@($completed.payload.allowed_mentions.parse).Count -ne 0) {
        $failures += '[allowed mentions] Discord payload must disable automatic mentions'
    }

    $confirmation = Invoke-TaskCase -UserMessage '安装缺少的依赖' -AssistantMessage '需要安装 JDK 17 和 Maven。现在直接安装，可以吗？'
    if ([string]$confirmation.endpoint -ne $confirmationWebhook) {
        $failures += "[confirmation route] expected confirmation webhook, got $($confirmation.endpoint)"
    }
    if ([int]$confirmation.payload.embeds[0].color -ne 15965202) {
        $failures += "[confirmation color] expected orange 15965202, got $($confirmation.payload.embeds[0].color)"
    }
    $confirmationFields = @($confirmation.payload.embeds[0].fields)
    if (($confirmationFields | Where-Object { $_.name -eq '待确认' }).value -ne '需要安装 JDK 17 和 Maven。现在直接安装，可以吗？') {
        $failures += '[confirmation fields] confirmation field is missing or incorrect'
    }
    if ([string]$confirmation.payload.embeds[0].footer.text -ne '由 5.6 Sol Ultra 支持') {
        $failures += '[confirmation footer] model and reasoning effort support line is missing or incorrect'
    }

    $ntfyConfig = [ordered]@{
        enabled = $true
        provider = 'ntfy'
        endpoint = 'https://ntfy.sh/original-task'
        confirmationEndpoint = 'https://ntfy.sh/original-confirmation'
        quotaEndpoint = 'https://ntfy.sh/original-quota'
        token = ''
        includeAssistantMessage = $true
        quotaNotifications = $true
        timeoutSeconds = 8
        previousNotify = @()
    }
    Write-Utf8NoBom -Path (Join-Path $toolDir 'config.json') -Content ($ntfyConfig | ConvertTo-Json -Depth 8)

    try {
        $setupOutput = @(& $testSetup discord -Value $taskWebhook -ConfirmationValue $confirmationWebhook -QuotaValue $quotaWebhook -IncludeMessage -SkipTest 6>&1) -join "`n"
        $saved = Get-Content -Raw -LiteralPath (Join-Path $toolDir 'config.json') -Encoding UTF8 | ConvertFrom-Json
        if ([string]$saved.provider -ne 'discord' -or [string]$saved.endpoint -ne $taskWebhook -or [string]$saved.confirmationEndpoint -ne $confirmationWebhook -or [string]$saved.quotaEndpoint -ne $quotaWebhook) {
            $failures += '[setup routes] setup did not save all three Discord webhooks'
        }
        if ([string]$saved.ntfyEndpoint -ne 'https://ntfy.sh/original-task' -or [string]$saved.ntfyConfirmationEndpoint -ne 'https://ntfy.sh/original-confirmation' -or [string]$saved.ntfyQuotaEndpoint -ne 'https://ntfy.sh/original-quota') {
            $failures += '[setup rollback] setup did not preserve all three ntfy endpoints'
        }
        if ($setupOutput -match 'task-secret|confirmation-secret|quota-secret') {
            $failures += '[setup secrecy] setup printed a Discord webhook secret'
        }
    }
    catch {
        $failures += "[setup discord] $($_.Exception.Message)"
    }

    if ($failures.Count -gt 0) {
        throw ($failures -join "`n")
    }

    Write-Output 'PASS: Discord webhook routing, embeds, and setup'
}
finally {
    if ((Test-Path -LiteralPath $tempRoot) -and $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
