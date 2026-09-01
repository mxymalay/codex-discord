$repo = Split-Path -Parent $PSScriptRoot
$forbiddenFiles = @('config.json','discord-token.dpapi','discord-inbox-state.json','discord-message-map.json','quota-state.json','rollout-watcher-state.json','task-delivery-state.json')
foreach ($name in $forbiddenFiles) {
    if (Test-Path -LiteralPath (Join-Path $repo $name)) { throw "runtime file tracked candidate: $name" }
}
$text = Get-ChildItem $repo -Recurse -File |
    Where-Object { $_.FullName -notmatch '\\.git\\' } |
    ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName -ErrorAction SilentlyContinue }
$joined = $text -join "`n"
if ($joined -match 'https://discord\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]{20,}') { throw 'real webhook pattern found' }
$personalPaths = @(
    ('C:' + '\\Users\\' + '86166'),
    ('G:' + '\\' + 'Codex' + 'Data')
)
foreach ($personalPath in $personalPaths) { if ($joined.Contains($personalPath)) { throw 'personal absolute path found' } }
$realIds = @(('154397' + '9587627647036'), ('154396' + '9985800446053'), ('148378' + '9348146118708'))
foreach ($id in $realIds) { if ($joined.Contains($id)) { throw 'personal Discord deployment id found' } }
Write-Output 'PASS: repository contains no runtime state or personal deployment values'
