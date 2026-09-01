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
