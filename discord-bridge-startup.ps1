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
        [Parameter(Mandatory)][string]$NodePath
    )

    $fullToolDir = [System.IO.Path]::GetFullPath($ToolDir)
    $bridgePath = Join-Path $fullToolDir 'discord-bridge.mjs'
    return [pscustomobject][ordered]@{
        TaskName = 'Codex Discord Bridge'
        Execute = [System.IO.Path]::GetFullPath($NodePath)
        Arguments = ConvertTo-ScheduledTaskArgument -Value $bridgePath
        WorkingDirectory = $fullToolDir
    }
}
