$repo = Split-Path -Parent $PSScriptRoot
$forbiddenFiles = @(
    'config.json','discord-token.dpapi','discord-inbox-state.json','discord-message-map.json',
    'discord-task-index.json','discord-gateway-state.json','quota-state.json','rollout-watcher-state.json',
    'task-delivery-state.json','discord-bridge-runtime.json','discord-bridge-health.json',
    'discord-bridge.log','discord-bridge-guard.log','mobile-notify.log','notify-guard.log'
)
$trackedRelativePaths = @(& git -c core.quotepath=false -C $repo ls-files)
if ($LASTEXITCODE -ne 0 -or $trackedRelativePaths.Count -eq 0) { throw 'could not enumerate repository-tracked files' }
$repositoryFiles = @($trackedRelativePaths |
    Where-Object { $_ -notmatch '^\.superpowers/|^docs/superpowers/' } |
    ForEach-Object {
        $fullPath = Join-Path $repo $_
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { throw "tracked source file is unavailable: $_" }
        Get-Item -LiteralPath $fullPath -Force
    })
foreach ($file in $repositoryFiles) {
    if ($forbiddenFiles -ccontains $file.Name -or $file.Extension -ieq '.log') { throw "runtime file tracked candidate: $($file.Name)" }
    if ($file.Name -match '(?i)^(?:discord-inbox-state|discord-task-index)\.corrupt-.*\.json$|^\.rollout-notification-.*\.json$') { throw "runtime recovery file tracked candidate: $($file.Name)" }
    if ($file.Extension -in @('.exe','.lnk')) { throw "built or shortcut artifact tracked candidate: $($file.Name)" }
    if ($file.Name -match '(?i)\.codex-discord-deploy\.|\.backup\.|\.stage\.|\.rollback\.') { throw "deployment artifact tracked candidate: $($file.Name)" }
}
$textExtensions = @('.cs','.json','.md','.mjs','.ps1','.toml','.txt','.yml','.yaml')
$text = $repositoryFiles |
    Where-Object { $textExtensions -contains $_.Extension } |
    ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName -ErrorAction SilentlyContinue }
$joined = $text -join "`n"
if ($joined -match 'https://discord\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]{20,}') { throw 'real webhook pattern found' }
if ($joined -match '(?m)^\s*(?:discordToken|botToken|token)\s*[:=]\s*["''][A-Za-z0-9_.-]{24,}["'']') { throw 'plaintext token assignment found' }
$personalPaths = @(
    ('C:' + '\Users\' + '86166'),
    ('G:' + '\' + 'Codex' + 'Data')
)
foreach ($personalPath in $personalPaths) { if ($joined.Contains($personalPath)) { throw 'personal absolute path found' } }
$realIds = @(('154397' + '9587627647036'), ('154396' + '9985800446053'), ('148378' + '9348146118708'))
foreach ($id in $realIds) { if ($joined.Contains($id)) { throw 'personal Discord deployment id found' } }
$gitIgnore = Get-Content -Raw -LiteralPath (Join-Path $repo '.gitignore')
foreach ($pattern in @('*.exe','*.lnk','*.log','*.tmp','*.corrupt-*.json','.rollout-notification-*.json','config.json','discord-token.dpapi','discord-bridge-runtime.json','discord-bridge-health.json')) {
    if (($gitIgnore -split "`r?`n") -cnotcontains $pattern) { throw "gitignore is missing runtime artifact pattern: $pattern" }
}
Write-Output 'PASS: repository contains no runtime state or personal deployment values'
