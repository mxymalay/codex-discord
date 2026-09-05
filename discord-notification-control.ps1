Set-StrictMode -Version Latest

function Read-DiscordNotificationControlConfig {
    param([Parameter(Mandatory)][string]$Path)
    try { $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] { return $null }
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Notification configuration must be a regular file'
    }
    $text = [IO.File]::ReadAllText($Path)
    $document = [Text.Json.JsonDocument]::Parse($text)
    if ($document.RootElement.ValueKind -ne [Text.Json.JsonValueKind]::Object) {
        $document.Dispose()
        throw 'Notification configuration must be a JSON object'
    }
    return [pscustomobject]@{ Document=$document; Text=$text }
}

function Write-DiscordNotificationControlConfig {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][object]$Original,
        [AllowNull()][string]$EnabledJson,
        [switch]$RemoveEnabled
    )
    $temporaryPath = Join-Path ([IO.Path]::GetDirectoryName($Path)) ('.discord-notification-control-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $stream = [IO.FileStream]::new($temporaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
                & /bin/chmod 600 $temporaryPath
                if ($LASTEXITCODE -ne 0) { throw 'Unable to protect temporary notification configuration' }
            }
            $writer = [Text.Json.Utf8JsonWriter]::new($stream)
            try {
                $writer.WriteStartObject()
                foreach ($property in $Original.Document.RootElement.EnumerateObject()) {
                    if ($property.Name -ceq 'enabled') { continue }
                    $property.WriteTo($writer)
                }
                if (-not $RemoveEnabled) {
                    $value = [Text.Json.JsonDocument]::Parse($EnabledJson)
                    try { $writer.WritePropertyName('enabled'); $value.RootElement.WriteTo($writer) }
                    finally { $value.Dispose() }
                }
                $writer.WriteEndObject()
                $writer.Flush()
            } finally { $writer.Dispose() }
            $stream.Flush($true)
        } finally { $stream.Dispose() }
        $current = Read-DiscordNotificationControlConfig -Path $Path
        try {
            if ($null -eq $current -or $current.Text -cne $Original.Text) { throw 'Notification configuration changed during update' }
        } finally { if ($null -ne $current) { $current.Document.Dispose() } }
        # Replace one complete document in the same directory; readers never see partial JSON.
        [IO.File]::Replace($temporaryPath, $Path, [NullString]::Value)
    }
    finally { if ([IO.File]::Exists($temporaryPath)) { [IO.File]::Delete($temporaryPath) } }
}

function Set-DiscordNotificationsEnabled {
    param([Parameter(Mandatory)][string]$ToolDir, [Parameter(Mandatory)][bool]$Enabled)
    $path = [IO.Path]::Combine([IO.Path]::GetFullPath($ToolDir), 'config.json')
    $original = Read-DiscordNotificationControlConfig -Path $path
    if ($null -eq $original) { return [pscustomobject]@{ Exists=$false; HadEnabled=$false; EnabledJson=$null } }
    try {
        $enabledValue = [Text.Json.JsonElement]::new()
        $hadEnabled = $original.Document.RootElement.TryGetProperty('enabled', [ref]$enabledValue)
        $enabledJson = if ($hadEnabled) { $enabledValue.GetRawText() } else { $null }
        $snapshot = [pscustomobject]@{ Exists=$true; HadEnabled=$hadEnabled; EnabledJson=$enabledJson }
        $desired = if ($Enabled) { 'true' } else { 'false' }
        if ($hadEnabled -and $enabledJson -ceq $desired) { return $snapshot }
        Write-DiscordNotificationControlConfig -Path $path -Original $original -EnabledJson $desired
        return $snapshot
    } finally { $original.Document.Dispose() }
}

function Restore-DiscordNotificationsEnabled {
    param([Parameter(Mandatory)][string]$ToolDir, [Parameter(Mandatory)][object]$Snapshot)
    if (-not $Snapshot.Exists) { return }
    $path = [IO.Path]::Combine([IO.Path]::GetFullPath($ToolDir), 'config.json')
    $current = Read-DiscordNotificationControlConfig -Path $path
    if ($null -eq $current) { throw 'Notification configuration disappeared before restoration' }
    try {
        Write-DiscordNotificationControlConfig -Path $path -Original $current -EnabledJson $Snapshot.EnabledJson -RemoveEnabled:(-not $Snapshot.HadEnabled)
    } finally { $current.Document.Dispose() }
}
