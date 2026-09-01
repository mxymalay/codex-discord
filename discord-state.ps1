Set-StrictMode -Version Latest

function New-DiscordTaskMappingState {
    return [pscustomobject][ordered]@{
        version = 1
        messages = [pscustomobject]@{}
    }
}

function Read-DiscordTaskMappingState {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return New-DiscordTaskMappingState
    }

    $raw = [System.IO.File]::ReadAllText([System.IO.Path]::GetFullPath($Path))
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return New-DiscordTaskMappingState
    }
    $state = $raw | ConvertFrom-Json
    if (-not $state.PSObject.Properties['version'] -or -not $state.PSObject.Properties['messages']) {
        throw 'Discord 任务映射文件格式无效'
    }
    return $state
}

function Get-DiscordStateMutexName {
    param([Parameter(Mandatory)][string]$Path)

    $normalized = [System.IO.Path]::GetFullPath($Path).ToLowerInvariant()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($normalized)
    $hash = [System.Security.Cryptography.SHA256]::HashData($bytes)
    $suffix = [Convert]::ToHexString($hash).Substring(0, 20)
    return "Local\CodexDiscordState-$suffix"
}

function Save-DiscordTaskMapping {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [string]$MessageId,
        [Parameter(Mandatory)] [string]$ThreadId,
        [Parameter(Mandatory)] [string]$Cwd,
        [Parameter(Mandatory)] [string]$ChannelId,
        [Parameter(Mandatory)] [string]$EventName
    )

    if ($MessageId -notmatch '\A\d{17,20}\z' -or $ChannelId -notmatch '\A\d{17,20}\z') {
        throw 'Discord 消息或频道 ID 无效'
    }
    if ($ThreadId -notmatch '\A[0-9a-fA-F-]{36}\z') {
        throw 'Codex 任务 ID 无效'
    }

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $parent = Split-Path -Parent $fullPath
    if (-not (Test-Path -LiteralPath $parent)) {
        [void](New-Item -ItemType Directory -Path $parent -Force)
    }

    $mutex = [System.Threading.Mutex]::new($false, (Get-DiscordStateMutexName -Path $fullPath))
    $lockTaken = $false
    try {
        $lockTaken = $mutex.WaitOne([TimeSpan]::FromSeconds(10))
        if (-not $lockTaken) {
            throw '等待 Discord 任务映射文件锁超时'
        }

        $state = Read-DiscordTaskMappingState -Path $fullPath
        $entry = [pscustomobject][ordered]@{
            threadId = $ThreadId
            cwd = $Cwd
            channelId = $ChannelId
            eventName = $EventName
            createdAt = [DateTimeOffset]::UtcNow.ToString('o')
        }
        $state.messages | Add-Member -NotePropertyName $MessageId -NotePropertyValue $entry -Force

        $properties = @($state.messages.PSObject.Properties)
        if ($properties.Count -gt 2000) {
            $removeCount = $properties.Count - 2000
            $properties |
                Sort-Object { [Int64]$_.Name } |
                Select-Object -First $removeCount |
                ForEach-Object { $state.messages.PSObject.Properties.Remove($_.Name) }
        }

        $json = $state | ConvertTo-Json -Depth 10
        $temporaryPath = Join-Path $parent ('.{0}.{1}.tmp' -f ([System.IO.Path]::GetFileName($fullPath)), $PID)
        try {
            [System.IO.File]::WriteAllText($temporaryPath, $json, [System.Text.UTF8Encoding]::new($false))
            Move-Item -LiteralPath $temporaryPath -Destination $fullPath -Force
        }
        finally {
            if (Test-Path -LiteralPath $temporaryPath) {
                Remove-Item -LiteralPath $temporaryPath -Force
            }
        }
    }
    finally {
        if ($lockTaken) {
            [void]$mutex.ReleaseMutex()
        }
        $mutex.Dispose()
    }
}
