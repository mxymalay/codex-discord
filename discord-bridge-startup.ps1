Set-StrictMode -Version Latest

function ConvertTo-ScheduledTaskArgument {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Value)

    return '"' + $Value.Replace('"', '""') + '"'
}

function Get-DiscordBridgeTaskDefinition {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ToolDir,
        [Parameter(Mandatory)][string]$PowerShellPath
    )

    $fullToolDir = [System.IO.Path]::GetFullPath($ToolDir)
    $startupPath = Join-Path $fullToolDir 'start-discord-bridge.ps1'
    return [pscustomobject][ordered]@{
        TaskName = 'Codex Discord Bridge'
        Execute = [System.IO.Path]::GetFullPath($PowerShellPath)
        Arguments = '-NoProfile -File ' + (ConvertTo-ScheduledTaskArgument -Value $startupPath)
        WorkingDirectory = $fullToolDir
    }
}

function Format-BridgeGuardLogEntry {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Category,
        [Nullable[int]]$ExitCode,
        [Nullable[long]]$DurationMs,
        [DateTimeOffset]$Timestamp = [DateTimeOffset]::UtcNow
    )

    $allowedCategories = @('guard-started', 'bridge-exited', 'bridge-launch-failed', 'guard-event')
    $stableCategory = if ($allowedCategories -ccontains $Category) { $Category } else { 'guard-event' }
    $parts = @(
        $Timestamp.ToUniversalTime().ToString('o'),
        ('event={0}' -f $stableCategory)
    )
    if ($null -ne $ExitCode) {
        $parts += 'exitCode={0}' -f [int]$ExitCode
    }
    if ($null -ne $DurationMs) {
        $parts += 'durationMs={0}' -f [Math]::Max(0, [long]$DurationMs)
    }
    return $parts -join ' '
}
