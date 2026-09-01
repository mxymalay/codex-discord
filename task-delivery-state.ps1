Set-StrictMode -Version Latest

function New-TaskDeliveryState {
    return [pscustomobject][ordered]@{
        version = 1
        delivered = [pscustomobject]@{}
    }
}

function Read-TaskDeliveryState {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return New-TaskDeliveryState
    }
    $raw = [System.IO.File]::ReadAllText([System.IO.Path]::GetFullPath($Path))
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return New-TaskDeliveryState
    }
    $state = $raw | ConvertFrom-Json
    if (-not $state.PSObject.Properties['version'] -or -not $state.PSObject.Properties['delivered']) {
        throw '任务通知去重状态文件格式无效'
    }
    return $state
}

function Get-TaskDeliveryMutexName {
    param([Parameter(Mandatory)][string]$Path)

    $normalized = [System.IO.Path]::GetFullPath($Path).ToLowerInvariant()
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($normalized))
    }
    finally {
        $sha.Dispose()
    }
    $suffix = ([BitConverter]::ToString($hash) -replace '-', '').Substring(0, 20)
    return "Local\CodexTaskDelivery-$suffix"
}

function Save-TaskDeliveryState {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][object]$State
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $parent = Split-Path -Parent $fullPath
    if (-not (Test-Path -LiteralPath $parent)) {
        [void](New-Item -ItemType Directory -Path $parent -Force)
    }
    $temporaryPath = Join-Path $parent ('.{0}.{1}.tmp' -f ([System.IO.Path]::GetFileName($fullPath)), $PID)
    try {
        $json = $State | ConvertTo-Json -Depth 8
        [System.IO.File]::WriteAllText($temporaryPath, $json, [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporaryPath -Destination $fullPath -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
    }
}

function Invoke-TaskNotificationOnce {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$TurnId,
        [Parameter(Mandatory)][scriptblock]$Action
    )

    if ($TurnId -notmatch '\A[0-9a-fA-F-]{36}\z') {
        throw 'Codex 回合 ID 无效，无法执行任务通知去重'
    }

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $mutex = [System.Threading.Mutex]::new($false, (Get-TaskDeliveryMutexName -Path $fullPath))
    $lockTaken = $false
    try {
        $lockTaken = $mutex.WaitOne([TimeSpan]::FromSeconds(20))
        if (-not $lockTaken) {
            throw '等待任务通知去重锁超时'
        }
        $state = Read-TaskDeliveryState -Path $fullPath
        if ($state.delivered.PSObject.Properties[$TurnId]) {
            return $false
        }

        & $Action

        $state.delivered | Add-Member -NotePropertyName $TurnId -NotePropertyValue ([DateTimeOffset]::UtcNow.ToString('o')) -Force
        $properties = @($state.delivered.PSObject.Properties)
        if ($properties.Count -gt 2000) {
            $properties |
                Sort-Object { [DateTimeOffset]::Parse([string]$_.Value) } |
                Select-Object -First ($properties.Count - 2000) |
                ForEach-Object { $state.delivered.PSObject.Properties.Remove($_.Name) }
        }
        Save-TaskDeliveryState -Path $fullPath -State $state
        return $true
    }
    finally {
        if ($lockTaken) {
            [void]$mutex.ReleaseMutex()
        }
        $mutex.Dispose()
    }
}
