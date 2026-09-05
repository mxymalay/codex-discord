$repo = Split-Path -Parent $PSScriptRoot
$forbiddenFiles = @(
    'config.json','discord-token.dpapi','discord-token.keychain','discord-inbox-state.json','discord-message-map.json',
    'discord-task-index.json','discord-gateway-state.json','quota-state.json','rollout-watcher-state.json',
    'task-delivery-state.json','discord-bridge-runtime.json','discord-bridge-health.json',
    'discord-bridge.log','discord-bridge-guard.log','mobile-notify.log','notify-guard.log'
)
$trackedRelativePaths = @(& git -c core.quotepath=false -C $repo ls-files)
if ($LASTEXITCODE -ne 0 -or $trackedRelativePaths.Count -eq 0) { throw 'could not enumerate repository-tracked files' }
$repositoryFiles = @($trackedRelativePaths | ForEach-Object {
    $fullPath = Join-Path $repo $_
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { throw "tracked source file is unavailable: $_" }
    Get-Item -LiteralPath $fullPath -Force
})
foreach ($file in $repositoryFiles) {
    if ($forbiddenFiles -ccontains $file.Name -or $file.Extension -ieq '.log') { throw "runtime file tracked candidate: $($file.Name)" }
    if ($file.Name -match '(?i)^(?:discord-inbox-state|discord-task-index)\.corrupt-.*\.json$|^\.rollout-notification-.*\.json$') { throw "runtime recovery file tracked candidate: $($file.Name)" }
    if ($file.Extension -in @('.exe','.lnk','.discord-migration','.keychain-db')) { throw "built, secret migration or shortcut artifact tracked candidate: $($file.Name)" }
    if ($file.Name -match '(?i)\.codex-discord-deploy\.|\.backup\.|\.stage\.|\.rollback\.') { throw "deployment artifact tracked candidate: $($file.Name)" }
}
$binaryExtensions = @(
    '.7z','.bin','.bmp','.dll','.doc','.docx','.exe','.gif','.gz','.ico','.jpeg','.jpg',
    '.lnk','.pdf','.pdb','.png','.ppt','.pptx','.tar','.ttf','.webp','.woff','.woff2',
    '.xls','.xlsx','.zip'
)
$utf8 = [System.Text.UTF8Encoding]::new($false, $true)
$text = foreach ($file in $repositoryFiles) {
    if ($binaryExtensions -contains $file.Extension.ToLowerInvariant()) { continue }
    $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
    if ($bytes -contains 0) { continue }
    try {
        $utf8.GetString($bytes)
    } catch {
        throw "tracked non-binary file is not valid UTF-8: $($file.Name)"
    }
}
$joined = $text -join "`n"
if ($joined -match 'https://discord\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]{20,}') { throw 'real webhook pattern found' }
if ($joined -match '(?m)(?<![A-Za-z0-9_])["'']?(?:discordToken|botToken|token|clientSecret|discordClientSecret)["'']?(?![A-Za-z0-9_])[ \t]*[:=][ \t]*["''][A-Za-z0-9_./+=-]{24,}["'']') { throw 'plaintext token or secret assignment found' }
if ($joined -match '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----') { throw 'private key material found' }

$profilePath = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
if ([string]::IsNullOrWhiteSpace($profilePath)) { $profilePath = $env:USERPROFILE }
$personalPaths = @($profilePath)
if (-not [string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
    $personalPaths += Split-Path -Parent $env:CODEX_HOME
}
foreach ($personalPath in @($personalPaths | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)) {
    $pathPattern = [regex]::Escape($personalPath.TrimEnd('\','/')).Replace('\\', '[\\/]+')
    if ($joined -match $pathPattern) { throw 'personal absolute path found' }
}

$personalUserNames = @($env:USERNAME, (Split-Path -Leaf $profilePath)) |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
    Select-Object -Unique
foreach ($personalUserName in $personalUserNames) {
    # Hosted CI service account names are ordinary source vocabulary, not a
    # developer's private identity. Absolute path and credential scans still run.
    if ($env:GITHUB_ACTIONS -eq 'true' -and $personalUserName -in @('runner', 'runneradmin')) { continue }
    $userPattern = '(?<![A-Za-z0-9])' + [regex]::Escape($personalUserName) + '(?![A-Za-z0-9])'
    if ($joined -match $userPattern) { throw 'personal user name found' }
}
$gitIgnore = Get-Content -Raw -LiteralPath (Join-Path $repo '.gitignore')
foreach ($pattern in @('*.exe','*.lnk','*.log','*.tmp','*.corrupt-*.json','.rollout-notification-*.json','config.json','discord-token.dpapi','discord-token.keychain','*.discord-migration','discord-bridge-runtime.json','discord-bridge-health.json')) {
    if (($gitIgnore -split "`r?`n") -cnotcontains $pattern) { throw "gitignore is missing runtime artifact pattern: $pattern" }
}
Write-Output 'PASS: repository contains no runtime state or personal deployment values'
