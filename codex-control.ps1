[CmdletBinding()]
param([string]$Action)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$allowedActions = @('status', 'stop-codex', 'start-temporary', 'stop-temporary', 'enable-long-term', 'disable-long-term')
if ($allowedActions -notcontains $Action) {
    [pscustomobject]@{ ok=$false; action='invalid'; errorCategory='invalid-action' } | ConvertTo-Json -Compress
    exit 1
}

try {
    $toolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    . (Join-Path $toolDir 'codex-control-lib.ps1')
    $result = Invoke-CodexControlAction -Action $Action -ToolDir $toolDir
    $result | ConvertTo-Json -Depth 8 -Compress
    if ($result.ok) { exit 0 }
    exit 1
}
catch {
    [pscustomobject]@{ ok=$false; action=$Action; errorCategory='control-action-failed' } | ConvertTo-Json -Compress
    exit 1
}
