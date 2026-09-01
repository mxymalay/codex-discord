[CmdletBinding()]
param(
    [switch]$Quiet,

    [string]$CodexRoot = (Join-Path $env:USERPROFILE '.codex'),

    [string]$PowerShellPath
)

$ErrorActionPreference = 'Stop'

$codexRoot = [System.IO.Path]::GetFullPath($CodexRoot)
$configPath = Join-Path $codexRoot 'config.toml'
$notifierPath = Join-Path $codexRoot 'mobile-notify\dispatcher.ps1'
$logPath = Join-Path $codexRoot 'mobile-notify\notify-guard.log'
if ([string]::IsNullOrWhiteSpace($PowerShellPath)) {
    $PowerShellPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
}
$PowerShellPath = [System.IO.Path]::GetFullPath($PowerShellPath)

function Write-GuardLog {
    param([string]$Message)

    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
    if (-not $Quiet) {
        Write-Output $line
    }
}

function ConvertTo-TomlBasicString {
    param([string]$Value)

    return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}

if (-not (Test-Path -LiteralPath $configPath)) {
    Write-GuardLog "Codex config is missing: $configPath"
    exit 1
}

if (-not (Test-Path -LiteralPath $notifierPath)) {
    Write-GuardLog "Notification dispatcher is missing: $notifierPath"
    exit 1
}

$directNotify = 'notify = [{0}, "-NoProfile", "-File", {1}]' -f `
    (ConvertTo-TomlBasicString $PowerShellPath), `
    (ConvertTo-TomlBasicString $notifierPath)
$previousNotifyJson = ConvertTo-Json -InputObject @(
    $PowerShellPath,
    '-NoProfile',
    '-File',
    $notifierPath
) -Compress
$previousNotifyToml = ConvertTo-TomlBasicString $previousNotifyJson

for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
        $text = [System.IO.File]::ReadAllText($configPath)
        $notifyPattern = '(?m)^notify\s*=.*$'
        $currentMatch = [regex]::Match($text, $notifyPattern)
        $desiredNotify = $directNotify
        if ($currentMatch.Success -and $currentMatch.Value -match 'codex-computer-use\.exe' -and $currentMatch.Value -match '"--previous-notify"') {
            $nestedPattern = '("--previous-notify"\s*,\s*)"(?:\\.|[^"\\])*"'
            $nestedMatch = [regex]::Match($currentMatch.Value, $nestedPattern)
            if ($nestedMatch.Success) {
                $desiredNotify = [regex]::Replace(
                    $currentMatch.Value,
                    $nestedPattern,
                    { param($match) $match.Groups[1].Value + $previousNotifyToml },
                    1
                )
            }
        }

        if ($currentMatch.Success -and $currentMatch.Value -eq $desiredNotify) {
            exit 0
        }

        if ($currentMatch.Success) {
            $updated = [regex]::Replace($text, $notifyPattern, $desiredNotify, 1)
        }
        else {
            $updated = $desiredNotify + [Environment]::NewLine + $text
        }

        $temporaryPath = Join-Path (Split-Path -Parent $configPath) ('.config.toml.notify-guard-{0}.tmp' -f $PID)
        [System.IO.File]::WriteAllText($temporaryPath, $updated, (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $temporaryPath -Destination $configPath -Force
        Write-GuardLog 'Restored Codex ntfy notification hook.'
        exit 0
    }
    catch {
        if ($attempt -eq 5) {
            Write-GuardLog ("Failed to restore notification hook after 5 attempts: {0}" -f $_.Exception.Message)
            exit 1
        }
        Start-Sleep -Milliseconds (200 * $attempt)
    }
}
