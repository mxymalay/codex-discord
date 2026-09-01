# Discord Remote Codex Takeover and Service Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a confirmed Discord workflow that safely exits only the Codex desktop app before resuming a queued task, plus a native Windows control program for temporary and persistent bridge-service control.

**Architecture:** Discord interactions and the WinForms program both call one fixed-action PowerShell control backend. Pure Node.js takeover helpers own task snapshots and confirmation state, while the backend owns trusted Codex-process identification and Windows Scheduled Task state; neither frontend can supply arbitrary PIDs, paths, task names, or shell text.

**Tech Stack:** Node.js ESM and `node:test`, PowerShell 7, Windows Scheduled Tasks, Win32 process inspection, C# WinForms targeting .NET Framework 4.8, Discord Gateway/REST.

**Spec:** `docs/superpowers/specs/2026-09-01-remote-codex-takeover-and-service-control-design.md`

## Global Constraints

- Do not add `/协作任务`, fork threads, or permit two writers on one Codex task.
- Only terminate a verified `ChatGPT.exe` root under a Microsoft Store `OpenAI.Codex_*` package and its verified descendants; never terminate processes by `codex.exe` name alone.
- Every remote exit requires a fresh task-risk preview and a one-use, five-minute, authorized confirmation.
- Queue content must be durably persisted before any exit suggestion or retry.
- Temporary service actions must not change the long-term logon-start setting.
- Long-term disable must survive logon and must not be undone by `watch-notify.ps1`.
- Use only the installed Node.js, PowerShell 7, and .NET Framework 4.8 compiler; add no npm, NuGet, Electron, or .NET SDK dependency.
- Do not store Token, webhook URLs, complete Discord input, complete task contents, personal IDs, or personal absolute paths in source, logs, health files, plans, or tests.
- Automated and deployment verification must not terminate the real Codex desktop app; process termination is tested through injected operations.

---

## File Structure

### New files

- `codex-takeover-lib.mjs` — pure active-task snapshot, display ordering, new-task detection, and confirmation-state helpers.
- `discord-control-client.mjs` — bounded Node-to-PowerShell JSON client and atomic bridge-health writer.
- `codex-control-lib.ps1` — trusted Codex desktop process planning/stopping and bridge-service status/action functions.
- `codex-control.ps1` — fixed-action JSON command entrypoint used by Discord and the GUI.
- `control-app/CodexDiscordControl.cs` — WinForms status window and four action buttons.
- `build-control-app.ps1` — compile the WinForms source with the installed .NET Framework compiler.
- `install-control-app.ps1` — build/copy the EXE and create or update the Desktop shortcut.
- `deploy.ps1` — allowlisted live deployment that preserves secrets and runtime state.
- `tests/codex-takeover.test.mjs` — pure takeover model tests.
- `tests/discord-control-client.test.mjs` — bounded subprocess and health-file tests.
- `tests/codex-control.tests.ps1` — synthetic process-tree and service-mode tests.
- `tests/codex-control-app.tests.ps1` — compiler, headless status, and shortcut tests.
- `tests/deploy.tests.ps1` — allowlisted deployment and secret-preservation tests.

### Modified files

- `discord-commands-lib.mjs` — register `/退出Codex` and update the exact command set.
- `discord-bridge-lib.mjs` — persist and expose `active-writer` as the reason a continuation is queued.
- `discord-interactions.mjs` — render exit previews, handle confirmation buttons, and add takeover components to queued continuation receipts.
- `discord-bridge.mjs` — wire index refresh, control actions, exact queue retry, and bridge-health publication into the interaction router.
- `discord-bridge-startup.ps1` — runtime identity helpers shared by startup and service control.
- `start-discord-bridge.ps1` — atomically publish and clean supervisor identity.
- `watch-notify.ps1` — remove bridge reinstallation/restart behavior.
- `.gitignore` — exclude runtime identity, bridge health, and built EXE artifacts.
- `README.md` — document 11 commands, takeover behavior, GUI controls, offline limits, and stop semantics.
- Existing Node and PowerShell tests — update exact command counts and startup/guard expectations.

---

### Task 1: Pure Takeover Snapshot Model and Eleventh Command

**Files:**
- Create: `codex-takeover-lib.mjs`
- Create: `tests/codex-takeover.test.mjs`
- Modify: `discord-commands-lib.mjs:8-66`
- Modify: `tests/discord-commands.test.mjs:9-75`
- Modify: `tests/discord-bridge.test.mjs:30-70`

**Interfaces:**
- Produces: `buildTakeoverSnapshot(taskIndex, { targetThreadId = null, limit = 10 } = {}) -> { activeIds, items, total, remaining }`.
- Produces: `hasNewActiveTasks(previousSnapshot, currentSnapshot) -> boolean`.
- Produces: `createTakeoverUiState({ id, kind, userId, guildId, targetThreadId, queueId, snapshot, nowMs }) -> TakeoverUiState` with `expiresAt = nowMs + 300000`.
- Produces: `validateTakeoverUiState(state, { kind, userId, guildId, nowMs }) -> { ok, reason }`.
- Consumes: task-index records with `threadId`, `taskName`, `status`, and `lastActivityAt`.

- [ ] **Step 1: Write failing takeover-model tests**

```js
function task(threadId, status, minute) {
  return {
    threadId,
    taskName: `任务 ${threadId}`,
    status,
    lastActivityAt: `2026-09-01T12:${String(minute).padStart(2, '0')}:00.000Z`,
  };
}

test('takeover snapshot lists only running and confirmation main tasks with target first', () => {
  const snapshot = buildTakeoverSnapshot({ tasks: [
    task('done', 'completed', 3),
    task('other', 'running', 4),
    task('target', 'confirmation-required', 1),
  ] }, { targetThreadId: 'target', limit: 10 });
  assert.deepEqual(snapshot.items.map((item) => item.threadId), ['target', 'other']);
  assert.deepEqual(snapshot.activeIds, ['other', 'target']);
  assert.equal(snapshot.remaining, 0);
});

test('new active task invalidates an existing confirmation but completed tasks do not', () => {
  const before = buildTakeoverSnapshot({ tasks: [task('a', 'running', 1)] });
  const added = buildTakeoverSnapshot({ tasks: [task('a', 'running', 1), task('b', 'running', 2)] });
  const reduced = buildTakeoverSnapshot({ tasks: [task('a', 'completed', 3)] });
  assert.equal(hasNewActiveTasks(before, added), true);
  assert.equal(hasNewActiveTasks(before, reduced), false);
});
```

- [ ] **Step 2: Update command tests to expect exactly 11 commands including `/退出Codex`**

```js
assert.deepEqual(commands.map((item) => item.name), [
  '任务列表', '任务详情', '任务搜索', '新建任务', '继续任务',
  '继续队列', '额度', '系统状态', '系统测试', '退出Codex', '帮助',
]);
```

- [ ] **Step 3: Run the focused tests and verify they fail**

Run: `node --test .\tests\codex-takeover.test.mjs .\tests\discord-commands.test.mjs .\tests\discord-bridge.test.mjs`

Expected: FAIL because `codex-takeover-lib.mjs` and `/退出Codex` do not exist and production bridge fixtures still return 10 commands.

- [ ] **Step 4: Implement the pure snapshot and UI-state functions**

```js
export const TAKEOVER_TTL_MS = 5 * 60_000;
const INTERRUPTIBLE = new Set(['running', 'confirmation-required']);

export function buildTakeoverSnapshot(taskIndex, { targetThreadId = null, limit = 10 } = {}) {
  const active = (Array.isArray(taskIndex?.tasks) ? taskIndex.tasks : [])
    .filter((item) => INTERRUPTIBLE.has(String(item?.status)))
    .sort((a, b) => {
      if (String(a.threadId) === String(targetThreadId)) return -1;
      if (String(b.threadId) === String(targetThreadId)) return 1;
      return Date.parse(String(b.lastActivityAt ?? '')) - Date.parse(String(a.lastActivityAt ?? ''));
    });
  return {
    activeIds: active.map((item) => String(item.threadId)).sort(),
    items: active.slice(0, limit).map((item) => ({
      threadId: String(item.threadId),
      taskName: String(item.taskName || '未命名任务'),
      status: String(item.status),
      target: String(item.threadId) === String(targetThreadId),
    })),
    total: active.length,
    remaining: Math.max(0, active.length - limit),
  };
}

export function hasNewActiveTasks(previous, current) {
  const allowed = new Set(previous?.activeIds ?? []);
  return (current?.activeIds ?? []).some((threadId) => !allowed.has(threadId));
}
```

- [ ] **Step 5: Add `/退出Codex` to the immutable command set**

```js
export const COMMAND_NAMES = Object.freeze([
  '任务列表', '任务详情', '任务搜索', '新建任务', '继续任务',
  '继续队列', '额度', '系统状态', '系统测试', '退出Codex', '帮助',
]);

// In buildGuildCommandDefinitions():
command('退出Codex', '查看风险并退出 Codex 桌面端'),
```

- [ ] **Step 6: Run the focused tests and verify they pass**

Run: `node --test .\tests\codex-takeover.test.mjs .\tests\discord-commands.test.mjs .\tests\discord-bridge.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit the pure model and command registration**

```powershell
git add codex-takeover-lib.mjs discord-commands-lib.mjs tests/codex-takeover.test.mjs tests/discord-commands.test.mjs tests/discord-bridge.test.mjs
git commit -m "feat: define remote Codex takeover command"
```

---

### Task 2: Trusted Codex Desktop Process Control Backend

**Files:**
- Create: `codex-control-lib.ps1`
- Create: `codex-control.ps1`
- Create: `tests/codex-control.tests.ps1`

**Interfaces:**
- Produces: `Test-CodexDesktopRootPath -Path <string> -> bool`.
- Produces: `Get-CodexDesktopProcessPlan -Processes <object[]> -> { Roots, ProcessIds, CreationTimes }`.
- Produces: `Stop-CodexDesktop -Operations <hashtable> -GraceMilliseconds <int> -> result object`.
- Produces: `Get-CodexControlStatus -Operations <hashtable> -ToolDir <string> -> status object`.
- Produces: `codex-control.ps1 -Action status|stop-codex|start-temporary|stop-temporary|enable-long-term|disable-long-term`, always writing one JSON object to stdout.
- Operations contract: `GetProcesses`, `RequestClose`, `StopProcess`, and `Sleep` scriptblocks; production operations use CIM/Get-Process/Stop-Process, tests inject fakes.

- [ ] **Step 1: Write failing process whitelist and tree tests**

```powershell
. (Join-Path $sourceRoot 'codex-control-lib.ps1')
$trusted = 'C:\Program Files\WindowsApps\OpenAI.Codex_1.2.3.0_x64__publisher\app\ChatGPT.exe'
$processes = @(
    [pscustomobject]@{ ProcessId=100; ParentProcessId=10; Name='ChatGPT.exe'; ExecutablePath=$trusted; CreationDate='20260901120000.000000+480' },
    [pscustomobject]@{ ProcessId=101; ParentProcessId=100; Name='codex.exe'; ExecutablePath='C:\Users\test\AppData\Local\OpenAI\Codex\bin\v\codex.exe'; CreationDate='20260901120001.000000+480' },
    [pscustomobject]@{ ProcessId=200; ParentProcessId=10; Name='codex.exe'; ExecutablePath='C:\tools\codex.exe'; CreationDate='20260901120002.000000+480' }
)
$plan = Get-CodexDesktopProcessPlan -Processes $processes
if (@($plan.Roots).ProcessId -ne 100) { throw 'trusted root not selected' }
if ((@($plan.ProcessIds) -join ',') -ne '100,101') { throw 'tree boundary is wrong' }
```

- [ ] **Step 2: Write failing stop-operation tests that prove descendants stop before the root and ambiguous paths fail closed**

```powershell
$events = [System.Collections.Generic.List[string]]::new()
$ops = @{
    GetProcesses = { $processes }
    RequestClose = { param($processId) $events.Add("close:$processId"); $false }
    StopProcess = { param($processId, $creationDate) $events.Add("stop:$processId:$creationDate") }
    Sleep = { param($milliseconds) $events.Add("sleep:$milliseconds") }
}
$result = Stop-CodexDesktop -Operations $ops -GraceMilliseconds 10
if (-not $result.ok -or $events.IndexOf('stop:101:20260901120001.000000+480') -gt $events.IndexOf('stop:100:20260901120000.000000+480')) {
    throw 'verified tree did not stop child before root'
}
```

- [ ] **Step 3: Run the PowerShell test and verify it fails**

Run: `pwsh -NoProfile -File .\tests\codex-control.tests.ps1`

Expected: FAIL because the control library does not exist.

- [ ] **Step 4: Implement path validation and a deterministic process plan**

```powershell
function Test-CodexDesktopRootPath {
    param([AllowNull()][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    $normalized = [System.IO.Path]::GetFullPath($Path)
    return $normalized -match '(?i)\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$'
}

function Get-CodexDesktopProcessPlan {
    param([Parameter(Mandatory)][object[]]$Processes)
    $roots = @($Processes | Where-Object {
        $_.Name -ieq 'ChatGPT.exe' -and (Test-CodexDesktopRootPath -Path $_.ExecutablePath)
    })
    # Walk only descendants whose parent is already inside a trusted root tree.
    # Return stable PID order plus each PID's observed CreationDate for revalidation.
}
```

- [ ] **Step 5: Implement close-then-force behavior using only injected, revalidated operations**

```powershell
function Stop-CodexDesktop {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Operations,
        [ValidateRange(0,10000)][int]$GraceMilliseconds = 3000
    )
    $before = @(& $Operations.GetProcesses)
    $plan = Get-CodexDesktopProcessPlan -Processes $before
    if (@($plan.Roots).Count -eq 0) {
        return [pscustomobject]@{ ok=$true; alreadyStopped=$true; stoppedProcessCount=0 }
    }
    foreach ($root in @($plan.Roots)) { [void](& $Operations.RequestClose $root.ProcessId) }
    & $Operations.Sleep $GraceMilliseconds
    # Refresh, re-check PID + CreationDate + ancestry, then stop descendants before roots.
}
```

- [ ] **Step 6: Implement the fixed-action JSON entrypoint with fail-closed errors**

```powershell
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('status','stop-codex','start-temporary','stop-temporary','enable-long-term','disable-long-term')]
    [string]$Action
)
$toolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $toolDir 'codex-control-lib.ps1')
try {
    $result = Invoke-CodexControlAction -Action $Action -ToolDir $toolDir
    $result | ConvertTo-Json -Depth 8 -Compress
    exit ($(if ($result.ok) { 0 } else { 1 }))
} catch {
    [pscustomobject]@{ ok=$false; action=$Action; errorCategory='control-action-failed' } |
        ConvertTo-Json -Compress
    exit 1
}
```

- [ ] **Step 7: Run the process-control tests and verify they pass**

Run: `pwsh -NoProfile -File .\tests\codex-control.tests.ps1`

Expected: `PASS: Codex desktop control boundaries`.

- [ ] **Step 8: Commit the trusted desktop control backend**

```powershell
git add codex-control-lib.ps1 codex-control.ps1 tests/codex-control.tests.ps1
git commit -m "feat: add trusted Codex desktop control backend"
```

---

### Task 3: Bridge Runtime Identity and Four Service Modes

**Files:**
- Modify: `codex-control-lib.ps1`
- Modify: `discord-bridge-startup.ps1`
- Modify: `start-discord-bridge.ps1`
- Modify: `watch-notify.ps1`
- Modify: `.gitignore`
- Modify: `tests/codex-control.tests.ps1`
- Modify: `tests/discord-bridge-startup.tests.ps1`
- Modify: `tests/repair-notify.tests.ps1`
- Modify: `tests/repository-hygiene.tests.ps1`

**Interfaces:**
- Produces: `Write-BridgeRuntimeIdentity -Path -Mode scheduled|temporary -ProcessId -CreationTimeUtc -ToolDir`.
- Produces: `Read-ValidatedBridgeRuntimeIdentity -Path -Processes -> identity|null`.
- Produces: `Get-ControlPathHash -Path <string> -> lowercase SHA-256 hex`, used to bind runtime identity to one normalized tool directory.
- Extends: `Invoke-CodexControlAction` with all four service actions.
- Service operations contract: `GetTask`, `InstallTask`, `EnableTask`, `DisableTask`, `StartTask`, `StopTask`, `StartDetached`, and `StopRuntime` scriptblocks.
- Consumes: fixed scheduled task name `Codex Discord Bridge` and the existing `start-discord-bridge.ps1` path.

- [ ] **Step 1: Add failing tests for temporary versus long-term semantics**

```powershell
function New-FakeBridgeOperations {
    param([Parameter(Mandatory)][hashtable]$State)
    return @{
        GetTask = { [pscustomobject]@{ installed=$true; enabled=$State.enabled; running=($State.running -and $State.mode -eq 'scheduled') } }
        InstallTask = { $State.installed=$true }
        EnableTask = { $State.enabled=$true }
        DisableTask = { $State.enabled=$false }
        StartTask = { $State.running=$true; $State.mode='scheduled' }
        StopTask = { $State.running=$false; $State.mode=$null }
        StartDetached = { param($startupPath,$mode) $State.running=$true; $State.mode=$mode }
        StopRuntime = { param($runtime) $State.running=$false; $State.mode=$null }
    }
}

$state = [ordered]@{ enabled=$false; running=$false; mode=$null }
$ops = New-FakeBridgeOperations -State $state
[void](Invoke-CodexBridgeServiceAction -Action 'start-temporary' -ToolDir $sourceRoot -Operations $ops)
if (-not $state.running -or $state.enabled) { throw 'temporary start changed long-term setting' }
[void](Invoke-CodexBridgeServiceAction -Action 'enable-long-term' -ToolDir $sourceRoot -Operations $ops)
if (-not $state.running -or -not $state.enabled -or $state.mode -ne 'scheduled') { throw 'long-term enable did not adopt scheduled ownership' }
[void](Invoke-CodexBridgeServiceAction -Action 'stop-temporary' -ToolDir $sourceRoot -Operations $ops)
if ($state.running -or -not $state.enabled) { throw 'temporary stop changed long-term setting' }
[void](Invoke-CodexBridgeServiceAction -Action 'disable-long-term' -ToolDir $sourceRoot -Operations $ops)
if ($state.running -or $state.enabled) { throw 'long-term disable did not persist' }
```

- [ ] **Step 2: Replace the old guard test with a failing test that forbids bridge restart coupling**

```powershell
$watchSource = Get-Content -Raw -LiteralPath (Join-Path $sourceRoot 'watch-notify.ps1')
if ($watchSource -match 'Codex Discord Bridge|install-discord-bridge-task|Start-ScheduledTask') {
    throw 'notification guard still overrides Discord bridge service state'
}
if ($watchSource -notmatch 'repair-notify\.ps1') { throw 'notification repair was removed' }
```

- [ ] **Step 3: Run startup and control tests and verify they fail**

Run: `pwsh -NoProfile -File .\tests\codex-control.tests.ps1; pwsh -NoProfile -File .\tests\discord-bridge-startup.tests.ps1; pwsh -NoProfile -File .\tests\repair-notify.tests.ps1`

Expected: FAIL because runtime identity/service actions are absent and the notification guard still starts the bridge.

- [ ] **Step 4: Add atomic runtime identity helpers and supervisor lifecycle publication**

```powershell
function Get-ControlPathHash {
    param([Parameter(Mandatory)][string]$Path)
    $normalized = [System.IO.Path]::GetFullPath($Path).TrimEnd('\').ToUpperInvariant()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($normalized)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

$runtimePath = Join-Path $toolDir 'discord-bridge-runtime.json'
$identity = [ordered]@{
    version = 1
    processId = $PID
    creationTimeUtc = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o')
    mode = $(if ($env:CODEX_DISCORD_START_MODE -eq 'temporary') { 'temporary' } else { 'scheduled' })
    toolDirHash = Get-ControlPathHash -Path $toolDir
}
Write-ControlJsonAtomic -Path $runtimePath -Value $identity
try {
    # Existing mutex and bridge restart loop.
} finally {
    Remove-ControlRuntimeIdentity -Path $runtimePath -ExpectedProcessId $PID
}
```

- [ ] **Step 5: Implement idempotent service actions without accepting caller-supplied task names or paths**

```powershell
switch ($Action) {
    'start-temporary' {
        if (-not $status.running) {
            if ($status.autoStartEnabled) { & $Operations.StartTask }
            else { & $Operations.StartDetached $startupPath 'temporary' }
        }
    }
    'stop-temporary' { if ($status.running) { & $Operations.StopRuntime $status.runtime } }
    'enable-long-term' {
        if (-not $status.taskInstalled) { & $Operations.InstallTask }
        & $Operations.EnableTask
        if ($status.runtime.mode -eq 'temporary') { & $Operations.StopRuntime $status.runtime }
        & $Operations.StartTask
    }
    'disable-long-term' {
        if ($status.taskInstalled) { & $Operations.DisableTask }
        if ($status.running) { & $Operations.StopRuntime $status.runtime }
    }
}
```

- [ ] **Step 6: Remove all Discord bridge management from `watch-notify.ps1`**

```powershell
while ($true) {
    try { & $repairScript -Quiet }
    catch {
        Add-Content -LiteralPath $logPath -Value ('{0} Guard check failed: {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $_.Exception.Message) -Encoding UTF8
    }
    Start-Sleep -Seconds 2
}
```

- [ ] **Step 7: Exclude runtime artifacts and extend repository hygiene checks**

```text
discord-bridge-runtime.json
discord-bridge-health.json
CodexDiscordControl.exe
```

Add `discord-bridge-runtime.json` and `discord-bridge-health.json` to the runtime-file deny list in `tests/repository-hygiene.tests.ps1`.

- [ ] **Step 8: Run the PowerShell test group and verify it passes**

Run: `$failed=@(); Get-ChildItem .\tests\*.tests.ps1 | ForEach-Object { & pwsh -NoProfile -File $_.FullName; if ($LASTEXITCODE -ne 0) { $failed += $_.Name } }; if ($failed.Count) { throw ($failed -join ', ') }`

Expected: every PowerShell test prints PASS and `$failed` remains empty.

- [ ] **Step 9: Commit service lifecycle control**

```powershell
git add .gitignore codex-control-lib.ps1 discord-bridge-startup.ps1 start-discord-bridge.ps1 watch-notify.ps1 tests/codex-control.tests.ps1 tests/discord-bridge-startup.tests.ps1 tests/repair-notify.tests.ps1 tests/repository-hygiene.tests.ps1
git commit -m "feat: add explicit Discord bridge service modes"
```

---

### Task 4: Bounded Node Control Client and Bridge Health Snapshot

**Files:**
- Create: `discord-control-client.mjs`
- Create: `tests/discord-control-client.test.mjs`
- Modify: `discord-bridge.mjs`
- Modify: `codex-control-lib.ps1`
- Modify: `tests/discord-bridge.test.mjs`
- Modify: `tests/codex-control.tests.ps1`

**Interfaces:**
- Produces: `runCodexControlAction({ action, powershellPath, controlPath, spawnImpl, timeoutMs = 15000 }) -> Promise<object>`.
- Produces: `writeBridgeHealthAtomic(path, status, { fsImpl } = {}) -> Promise<void>`.
- Produces: bridge health schema `{ version, observedAt, gateway, discordRest, queueCount, startedAt, lastActivityAt, latestEventCategory }`.
- Consumes: only the six fixed control action strings; rejects all other action values before spawning PowerShell.

- [ ] **Step 1: Write failing bounded-client tests**

```js
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

function fakeSpawn(calls, stdoutText, exitCode) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('close', 1);
    queueMicrotask(() => {
      child.stdout.end(stdoutText);
      child.stderr.end();
      child.emit('close', exitCode);
    });
    return child;
  };
}

test('control client passes only one allowlisted action and parses one JSON response', async () => {
  const calls = [];
  const result = await runCodexControlAction({
    action: 'status', powershellPath: 'pwsh.exe', controlPath: 'C:\\safe\\codex-control.ps1',
    spawnImpl: fakeSpawn(calls, '{"ok":true,"action":"status"}\n', 0),
  });
  assert.deepEqual(calls[0].args, ['-NoProfile', '-File', 'C:\\safe\\codex-control.ps1', '-Action', 'status']);
  assert.equal(result.ok, true);
  await assert.rejects(() => runCodexControlAction({ action: 'stop-codex; calc', powershellPath: 'pwsh.exe', controlPath: 'x' }), /invalid control action/i);
});
```

- [ ] **Step 2: Write failing health snapshot tests for atomic replacement and sanitization**

```js
await writeBridgeHealthAtomic(target, {
  gateway: { state: 'ready', lastError: 'Token must-not-appear' },
  queueCount: 2,
  latestErrorCategory: 'gateway-timeout',
});
const saved = JSON.parse(await fs.readFile(target, 'utf8'));
assert.equal(saved.gateway.state, 'ready');
assert.equal(JSON.stringify(saved).includes('must-not-appear'), false);
assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith('.tmp')), []);
```

- [ ] **Step 3: Run the client and bridge tests and verify they fail**

Run: `node --test .\tests\discord-control-client.test.mjs .\tests\discord-bridge.test.mjs`

Expected: FAIL because the client and health writer do not exist.

- [ ] **Step 4: Implement the allowlisted subprocess protocol with timeout and bounded output**

```js
const ACTIONS = new Set(['status', 'stop-codex', 'start-temporary', 'stop-temporary', 'enable-long-term', 'disable-long-term']);
export async function runCodexControlAction({ action, powershellPath, controlPath, spawnImpl = spawn, timeoutMs = 15_000 }) {
  if (!ACTIONS.has(action)) throw new Error('Invalid control action');
  const child = spawnImpl(powershellPath, ['-NoProfile', '-File', controlPath, '-Action', action], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Cap stdout/stderr at 64 KiB, kill on timeout, parse only stdout JSON,
  // and return sanitized categories without embedding stderr.
}
```

- [ ] **Step 5: Publish a sanitized health file on startup, status transitions, and a ten-second heartbeat**

Add `bridgeHealthPath` beside the existing runtime paths. Extend `createBridgeApplication` with an injected `publishHealth(context)` callback, call it after startup and state changes, and manage a ten-second interval as a lifecycle resource that is cleared during `stop()`.

```js
const health = {
  version: 1,
  observedAt: new Date().toISOString(),
  gateway: { state: String(status.gateway?.state ?? 'unknown') },
  discordRest: { state: String(status.discordRest?.state ?? 'unknown') },
  queueCount: Number(status.queueCount ?? 0),
  startedAt: context.startedAt,
  lastActivityAt: latestTimestamp(status.timestamps),
  latestEventCategory: sanitizedCategory(status.latestErrorCategory),
};
await writeBridgeHealthAtomic(bridgeHealthPath, health);
```

- [ ] **Step 6: Make PowerShell `status` merge validated runtime identity, Scheduled Task state, health, queue count, and Codex desktop state**

```powershell
return [pscustomobject][ordered]@{
    ok = $true
    action = 'status'
    service = [ordered]@{ running=$runtimeValid; autoStartEnabled=$taskEnabled; mode=$runtimeMode }
    discord = [ordered]@{ state=$health.gateway.state; lastActivityAt=$health.lastActivityAt }
    desktop = [ordered]@{ running=(@($desktopPlan.Roots).Count -gt 0) }
    queueCount = [int]$queueCount
}
```

- [ ] **Step 7: Run focused Node and PowerShell tests and verify they pass**

Run: `node --test .\tests\discord-control-client.test.mjs .\tests\discord-bridge.test.mjs; pwsh -NoProfile -File .\tests\codex-control.tests.ps1`

Expected: PASS.

- [ ] **Step 8: Commit the control client and health publication**

```powershell
git add discord-control-client.mjs discord-bridge.mjs codex-control-lib.ps1 tests/discord-control-client.test.mjs tests/discord-bridge.test.mjs tests/codex-control.tests.ps1
git commit -m "feat: publish bridge control health"
```

---

### Task 5: `/退出Codex` Preview and Confirmed Exit

**Files:**
- Modify: `discord-interactions.mjs`
- Modify: `discord-bridge.mjs`
- Modify: `tests/discord-interactions.test.mjs`
- Modify: `tests/discord-bridge.test.mjs`

**Interfaces:**
- Router consumes: `refreshTaskIndex() -> Promise<TaskIndex>`.
- Router consumes: `getCodexControlStatus() -> Promise<ControlStatus>`.
- Router consumes: `stopCodexDesktop() -> Promise<ControlResult>`.
- Router consumes: `buildTakeoverSnapshot` and the `uiState` map already owned by `createInteractionRouter`.
- Produces component IDs: `takeover-confirm:<16-char-id>` and `takeover-cancel:<16-char-id>`.

- [ ] **Step 1: Write failing interaction tests for preview, privacy, and no-desktop behavior**

```js
await router.handle(commandInteraction('退出Codex'));
const preview = responses.shift().data;
assert.equal(preview.flags, 64);
assert.match(preview.embeds[0].description, /Codex 正在运行/);
assert.match(preview.embeds[0].description, /门店任务 1/);
assert.deepEqual(preview.components[0].components.map((button) => button.label), ['确认强制退出', '取消']);

dependencies.getCodexControlStatus = async () => ({ ok: true, desktop: { running: false } });
await router.handle(commandInteraction('退出Codex', {}, { id: 'exit-2' }));
assert.match(responses.shift().data.content, /未运行/);
```

- [ ] **Step 2: Write failing confirmation tests for expiry, one-use behavior, cross-user rejection, and new active tasks**

```js
await router.handle(componentInteraction(confirmId));
assert.equal(stopCalls, 1);
await router.handle(componentInteraction(confirmId, { id: 'repeat' }));
assert.match(responses.shift().data.content, /已使用|过期|无效/);

// Refresh adds a new running task after preview.
await router.handle(componentInteraction(changedConfirmId));
assert.equal(stopCalls, 1);
assert.match(responses.shift().data.embeds[0].description, /新任务/);
```

- [ ] **Step 3: Run the focused interaction tests and verify they fail**

Run: `node --test .\tests\discord-interactions.test.mjs .\tests\discord-bridge.test.mjs`

Expected: FAIL because `/退出Codex` has no command route or component handlers.

- [ ] **Step 4: Implement a renderer that never exposes IDs or paths**

```js
export function renderTakeoverPreview(snapshot, { desktopRunning, targetThreadId = null } = {}) {
  if (!desktopRunning) return { content: 'Codex 桌面端未运行，无需退出。' };
  const lines = snapshot.items.map((item, index) =>
    `${index + 1}. ${escapeMarkdown(item.taskName)}（${item.status === 'confirmation-required' ? '待确认' : '正在执行'}${item.target ? '，目标任务' : ''}）`);
  if (snapshot.remaining > 0) lines.push(`另有 ${snapshot.remaining} 个任务未列出。`);
  return { embeds: [{ description: `## Codex 正在运行\n\n${lines.length ? lines.join('\n') : '未检测到运行中主任务。'}\n\n⚠️ 强制退出可能中断以上桌面任务。` }] };
}
```

- [ ] **Step 5: Add command and component handlers with fresh-index comparison**

On `/退出Codex`, defer if index refresh/control inspection may exceed Discord's initial-response window. Store a five-minute `takeover-exit` state only after both reads succeed. On confirm: atomically mark state consumed, refresh again, reject if `hasNewActiveTasks` is true, otherwise call `stopCodexDesktop` once. Cancel deletes/consumes the state without calling the backend.

```js
if (name === '退出Codex') return beginTakeoverExit(dependencies, interaction);

const confirm = customId.match(/^takeover-confirm:([A-Za-z0-9_-]{16})$/u);
if (confirm) return confirmTakeoverExit(dependencies, interaction, confirm[1]);
```

- [ ] **Step 6: Wire production dependencies through the bounded client**

```js
const refreshTaskIndex = async () => {
  const rebuilt = await buildTaskIndex({
    sessionsRoot,
    sessionIndexPath,
    messageMapPath: mappingPath,
    previousIndex: context.taskIndex,
    discordWorktreeRoot: context.config.discordWorktreeRoot,
    nowMs: Date.now(),
  });
  replaceIndex(context.taskIndex, rebuilt);
  await writeTaskIndexAtomic(taskIndexPath, context.taskIndex);
  context.recordActivity('lastIndexUpdateAt', rebuilt.generatedAt);
  return context.taskIndex;
};

refreshTaskIndex,
getCodexControlStatus: () => runCodexControlAction({
  action: 'status', powershellPath: context.executables.powershellPath, controlPath,
}),
stopCodexDesktop: () => runCodexControlAction({
  action: 'stop-codex', powershellPath: context.executables.powershellPath, controlPath,
}),
```

- [ ] **Step 7: Run interaction and bridge tests and verify they pass**

Run: `node --test .\tests\discord-interactions.test.mjs .\tests\discord-bridge.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit the standalone remote-exit workflow**

```powershell
git add discord-interactions.mjs discord-bridge.mjs tests/discord-interactions.test.mjs tests/discord-bridge.test.mjs
git commit -m "feat: add confirmed Discord Codex exit"
```

---

### Task 6: Active-Writer Takeover Recommendation and Immediate Exact Retry

**Files:**
- Modify: `discord-bridge-lib.mjs`
- Modify: `discord-interactions.mjs`
- Modify: `discord-bridge.mjs`
- Modify: `tests/discord-bridge.test.mjs`
- Modify: `tests/discord-interactions.test.mjs`

**Interfaces:**
- Extends queued continuation records with `blockedReason: 'active-writer'` only when that error is observed.
- Extends `dispatchContinuation` queued result with `reason: 'active-writer'`.
- Router consumes: `retryContinuation(queueId) -> Promise<ContinuationResult>`.
- Produces component IDs: `takeover-continue:<16-char-id>` and `takeover-keep:<16-char-id>`.
- Reuses the five-minute takeover state and fresh-task comparison from Task 1/5.

- [ ] **Step 1: Write a failing durability test for the active-writer reason**

```js
const result = await dispatchContinuation(request, {
  state, encryptText: async () => 'cipher', persistState,
  resumeCodexThread: async () => { throw new Error('thread already has an active writer'); },
});
assert.deepEqual({ status: result.status, reason: result.reason }, { status: 'queued', reason: 'active-writer' });
assert.equal(listContinuations(state)[0].blockedReason, 'active-writer');
```

- [ ] **Step 2: Write failing UI tests for the recommendation buttons and exact queue binding**

```js
async function submitContinueModal(router, responses) {
  await router.handle(commandInteraction('继续任务', { 任务: 'root-1' }));
  const modal = responses.shift();
  assert.equal(modal.type, 9);
  await router.handle(modalSubmit(modal.data.custom_id, '继续处理该任务', {
    fieldId: '继续内容', id: 'continue-submit-active-writer',
  }));
  assert.equal(responses.shift().type, 5);
}

dependencies.dispatchContinuation = async () => ({ status: 'queued', reason: 'active-writer', queueId: 'queue-1' });
await submitContinueModal(router, responses);
assert.match(edits[0].content, /已安全排队/);
assert.deepEqual(edits[0].components[0].components.map((button) => button.label), ['退出 Codex 并立即继续', '保持排队']);

await router.handle(componentInteraction(takeoverContinueId));
assert.deepEqual(retriedQueueIds, ['queue-1']);
```

- [ ] **Step 3: Write a failing test proving no desktop means no destructive button**

```js
dependencies.getCodexControlStatus = async () => ({ ok: true, desktop: { running: false } });
await submitContinueModal(router, responses);
assert.match(edits[0].content, /其他 CLI|插件|继续排队/);
assert.equal(Boolean(edits[0].components), false);
```

- [ ] **Step 4: Run focused tests and verify they fail**

Run: `node --test .\tests\discord-bridge.test.mjs .\tests\discord-interactions.test.mjs`

Expected: FAIL because queued results do not retain the blocking reason and receipts contain no takeover controls.

- [ ] **Step 5: Persist the blocking reason only after the queued downgrade is durable**

```js
const queued = state.pendingContinuations[existing.queueId];
queued.status = 'queued';
queued.blockedReason = 'active-writer';
return { status: 'queued', queueId: existing.queueId, reason: 'active-writer' };
```

Clear `blockedReason` when a subsequent claim starts and when the item becomes confirmed-start/delivered/failed, so stale reasons cannot generate an incorrect takeover suggestion.

- [ ] **Step 6: Return a structured continuation receipt instead of flattening the result too early**

Make the modal submission promise resolve to `{ result, payload }`. For active-writer, call the same index refresh and status inspection used by `/退出Codex`, store `{ kind: 'takeover-continue', queueId, targetThreadId, snapshot }`, and render the two buttons. All existing started/uncertain/failed text remains unchanged.

```js
if (result.status === 'queued' && result.reason === 'active-writer') {
  return buildQueuedTakeoverReceipt(dependencies, interaction, result, state.threadId);
}
return { content: continuationReceipt(result) };
```

- [ ] **Step 7: Implement keep-queued and confirmed-exit-and-retry handlers**

`takeover-keep` consumes only the UI state and returns “请求保持排队，可通过 /继续队列 查看或取消”。 `takeover-continue` refreshes the task snapshot, stops the verified desktop app, then calls `retryContinuation(state.queueId)` exactly once. Started returns the turn suffix; queued remains queued; uncertain states that automatic retries are disabled.

```js
const result = await dependencies.retryContinuation(state.queueId);
return editOriginal(dependencies, interaction, {
  content: result.status === 'started'
    ? `Codex 已退出，目标任务已开始继续执行。本轮 ID：…${String(result.turnId).slice(-8)}`
    : 'Codex 退出操作已完成，但目标仍被占用；请求将继续排队。',
  components: [],
});
```

- [ ] **Step 8: Wire exact retry to the persisted queue item**

```js
retryContinuation: async (queueId) => {
  const item = listContinuations(context.inboxState).find((entry) => entry.queueId === queueId);
  if (!item || item.status !== 'queued') return { status: 'failed', reason: 'not-found' };
  return startContinuation({ token: context.token, config: context.config, state: context.inboxState, request: item, trackActiveResource: context.trackActiveResource });
},
```

- [ ] **Step 9: Run continuation and interaction tests and verify they pass**

Run: `node --test .\tests\discord-bridge.test.mjs .\tests\discord-interactions.test.mjs`

Expected: PASS, including existing uncertain-start and exactly-once persistence tests.

- [ ] **Step 10: Commit the active-writer takeover flow**

```powershell
git add discord-bridge-lib.mjs discord-interactions.mjs discord-bridge.mjs tests/discord-bridge.test.mjs tests/discord-interactions.test.mjs
git commit -m "feat: offer safe takeover for queued continuations"
```

---

### Task 10: Reliable Discord-Origin Tasks, Project Attribution, Markdown, and Source-Channel Routing

**Files:**
- Modify: `discord-task-index-lib.mjs`
- Modify: `discord-task-create-lib.mjs`
- Modify: `discord-bridge-lib.mjs`
- Modify: `discord-interactions.mjs`
- Modify: `discord-bridge.mjs`
- Modify: `rollout-completion-watcher-lib.mjs`
- Modify: `dispatcher.ps1`
- Modify: `tests/discord-task-index.test.mjs`
- Modify: `tests/discord-task-create.test.mjs`
- Modify: `tests/discord-bridge.test.mjs`
- Modify: `tests/discord-interactions.test.mjs`
- Modify: `tests/rollout-completion-watcher.test.mjs`
- Modify: `tests/discord-bot-dispatcher.tests.ps1`

**Incident evidence and required behavior:**
- Discord interaction `1544329941024374935` created root thread `01a05d0a-5a8f-71f2-b5e1-96fe962224b5` at 20:55:55 and completed normally at 21:08:15, but dispatcher logged `Non-sidebar/subagent turn skipped` because the root was absent from the desktop sidebar index.
- A Discord-created root is a user-owned main task even when the desktop sidebar database does not list it. Its subagents remain internal and must never be promoted.
- Every Discord-originated new task or continuation sends its completed/confirmation result to the guild channel in which that Discord interaction or reply originated. Desktop-originated completion/confirmation and quota events continue to use the three configured fixed channels.
- Every Discord-originated root turn also streams its own commentary and concise tool progress to the originating channel. It never streams child-agent events, raw tool output, source code dumps, full command lines, tokens, or private absolute paths. Desktop-originated turns remain notification-only.
- `/任务列表`, detail, and search must include Discord-created roots and must infer saved projects for desktop tasks whose rollout/sidebar metadata omit project fields.
- All slash-command renderers use consistent Discord Markdown headings and bold field labels while escaping user-controlled metadata and suppressing mentions.

**Interfaces:**
- `inferSavedProject({ cwd, worktreePath, projectId, projectName }, projects)` canonicalizes Windows paths and selects the saved project with the longest containing root. Explicit valid project identity wins; a Discord worktree uses its persisted creation selection rather than matching the generated worktree path.
- Inbox state persists a bounded `discordTurnOrigins` map keyed by exact turn id with `threadId`, `guildId`, `channelId`, `source`, `createdAt`, optional project identity, and delivery state. It never stores an Interaction token.
- Each origin record persists a rollout byte cursor plus bounded event/message dedupe ids. Restart resumes after the last durably sent root event.
- `resolveDiscordOrigin(notification, state)` returns an origin only when turn id, thread id, guild id, and channel snowflake all validate and match exactly.
- Completion dispatch may add a trusted internal `discord-origin-channel-id` to the notification. `dispatcher.ps1` accepts that override only for task completion/confirmation events and a valid 17–20 digit channel id; quota and desktop-originated events ignore it.
- If the origin channel send fails, one attempt goes to the configured task/confirmation fallback channel with a short routing warning. Delivery is marked only after a successful send.

- [ ] **Step 1: Write failing project-attribution tests**

Cover explicit project metadata, case-insensitive canonical Windows roots, longest-root selection, sibling-prefix rejection, saved worktree provenance, and tasks outside every project. Prove the current production pattern (`cwd` under `C:\Users\86166\Desktop\ygf` with null metadata) resolves to `ygf` rather than `无项目`.

- [ ] **Step 2: Write failing provenance and source-channel tests**

Cover new-task modal and slash/reply continuation origins, exact guild/channel/turn/thread binding, state migration and bounded retention, root-vs-subagent discrimination, desktop fallback routing, invalid/cross-guild channel rejection, send failure fallback, progress cursor restart recovery, and duplicate suppression.

- [ ] **Step 3: Reproduce the 20:56 incident as a regression test**

Use a synthetic Discord-created root absent from the sidebar index, followed by `task_complete`. Assert it remains a main task, is merged into list/detail/search, routes to its origin channel, records delivery, and does not replay after restart. A child agent rollout with the same root thread id must still be skipped.

Before completion, feed root commentary, tool start/completion, long/raw tool output, and child-agent events. Assert commentary and sanitized one-line tool state reach the origin channel in order; raw output/code/secrets/absolute private paths and child-agent events never appear. Coalesce bursts to respect Discord rate limits without dropping the latest state.

- [ ] **Step 4: Write failing Markdown contract tests**

Assert visible Markdown structure for task list/detail/search, new-task receipt, continuation queue/receipt, quota, system status, health report, help, and errors. Field labels such as `项目`, `任务`, `状态`, `额度`, `距上次变化`, and `距下次更新还有` are bold; user-controlled values remain escaped and mentions remain disabled.

- [ ] **Step 5: Implement project inference and merge Discord-created roots**

Warm the saved-project catalog before the first index build and pass a stable project snapshot plus creation state into startup and periodic rebuilds. Merge only persisted root `threadId` values from `createdTasksByInteraction`; update their status and result from the exact root rollout. Never merge child-agent rollout ids.

- [ ] **Step 6: Persist turn origins at the successful start boundary**

For new tasks and every Discord-originated continuation, persist origin metadata immediately after an exact `turnId` is known and before reporting success. Preserve the record after continuation queue pruning until a bounded terminal retention period expires. Send a durable `任务已开始` channel acknowledgement once the origin record commits.

- [ ] **Step 7: Route, recover, and acknowledge reliably**

Enrich terminal notifications from exact origin records. Tail only the exact root rollout for that turn and send root commentary plus sanitized tool lifecycle summaries to its source channel; persist the cursor only after each successful send. Keep failed/skipped origin deliveries pending, retry without duplicates, and recover completed Discord-created roots after restart. Persist the creation receipt outcome; if `editOriginal` fails while the Interaction token is still in memory, attempt one ephemeral follow-up and record only a redacted failure category if both fail.

- [ ] **Step 8: Implement consistent Markdown rendering**

Use renderer-owned Markdown around escaped values. Do not escape renderer syntax and do not allow user values to create headings, mentions, links, or code fences accidentally.

- [ ] **Step 9: Run focused and complete regression suites**

Run:

```powershell
node --test .\tests\discord-task-index.test.mjs .\tests\discord-task-create.test.mjs .\tests\discord-bridge.test.mjs .\tests\discord-interactions.test.mjs .\tests\rollout-completion-watcher.test.mjs
pwsh -NoProfile -File .\tests\discord-bot-dispatcher.tests.ps1
node --test .\tests\*.test.mjs
$failed=@(); Get-ChildItem .\tests\*.tests.ps1 | ForEach-Object { & pwsh -NoProfile -File $_.FullName; if ($LASTEXITCODE -ne 0) { $failed += $_.Name } }; if ($failed.Count) { throw ($failed -join ', ') }
```

Expected: the incident regression sends start, root progress, and final output exactly once to the source channel; child/raw events are absent; desktop fixtures remain on fixed channels; every full suite passes.

- [ ] **Step 10: Commit the reliability fix**

```powershell
git add discord-task-index-lib.mjs discord-task-create-lib.mjs discord-bridge-lib.mjs discord-interactions.mjs discord-bridge.mjs rollout-completion-watcher-lib.mjs dispatcher.ps1 tests/discord-task-index.test.mjs tests/discord-task-create.test.mjs tests/discord-bridge.test.mjs tests/discord-interactions.test.mjs tests/rollout-completion-watcher.test.mjs tests/discord-bot-dispatcher.tests.ps1
git commit -m "fix: deliver Discord-origin task results reliably"
```

---

### Task 7: Native WinForms Control Program

**Files:**
- Create: `control-app/CodexDiscordControl.cs`
- Create: `build-control-app.ps1`
- Create: `install-control-app.ps1`
- Create: `tests/codex-control-app.tests.ps1`

**Interfaces:**
- GUI invokes only `codex-control.ps1 -Action <allowlisted-action>` located beside the deployed EXE.
- GUI supports `--status-json` for non-visual smoke testing; it prints backend JSON and exits without showing a window.
- Build output: `CodexDiscordControl.exe` in an explicitly supplied output directory.
- Installer creates/updates `Codex Discord 控制台.lnk` whose target is the live EXE and working directory is the live tool directory.
- The Git repository is the recovery source of truth: C# source, build script, and installer are committed. If the installed EXE or Desktop shortcut was deleted, running `install-control-app.ps1` rebuilds the EXE from repository source, copies the fixed backend beside it, and restores the shortcut in one command.

- [ ] **Step 1: Write a failing compiler and headless-status test**

```powershell
& (Join-Path $sourceRoot 'build-control-app.ps1') -OutputDirectory $buildRoot
if ($LASTEXITCODE -ne 0) { throw 'control app build failed' }
$exe = Join-Path $buildRoot 'CodexDiscordControl.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw 'control app executable missing' }
$status = & $exe --status-json | ConvertFrom-Json
if ($null -eq $status.ok -or $null -eq $status.service) { throw 'headless status schema invalid' }
```

- [ ] **Step 2: Write a failing shortcut test using a temporary Desktop folder**

```powershell
& (Join-Path $sourceRoot 'install-control-app.ps1') -ToolDir $installRoot -DesktopPath $desktopRoot -SourceRoot $sourceRoot
$shortcutPath = Join-Path $desktopRoot 'Codex Discord 控制台.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
if ([System.IO.Path]::GetFullPath($shortcut.TargetPath) -ne [System.IO.Path]::GetFullPath((Join-Path $installRoot 'CodexDiscordControl.exe'))) {
    throw 'shortcut target is stale'
}
```

Delete the temporary installed EXE and shortcut, run the same installer again, and assert both are rebuilt/restored from committed project sources without relying on a pre-existing binary.

- [ ] **Step 3: Run the GUI tests and verify they fail**

Run: `pwsh -NoProfile -File .\tests\codex-control-app.tests.ps1`

Expected: FAIL because the build, installer, and C# source do not exist.

- [ ] **Step 4: Implement a no-dependency .NET Framework build script**

```powershell
$compilerCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) { throw '.NET Framework C# compiler is unavailable' }
& $compiler /nologo /target:winexe /optimize+ `
    /reference:System.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll `
    /out:$outputPath $sourcePath
if ($LASTEXITCODE -ne 0) { throw 'Control app compilation failed' }
```

- [ ] **Step 5: Implement the WinForms status model and asynchronous fixed actions**

The form has six labeled status rows, four action buttons, a refresh button, and a result strip. A `System.Windows.Forms.Timer` fires every two seconds. Backend calls use `ProcessStartInfo` with `UseShellExecute=false`, `CreateNoWindow=true`, and an action selected from a C# enum; no textbox content enters process arguments.

```csharp
private enum ControlAction {
    Status, StartTemporary, StopTemporary, EnableLongTerm, DisableLongTerm
}

private static readonly IReadOnlyDictionary<ControlAction,string> ActionNames =
    new Dictionary<ControlAction,string> {
        { ControlAction.Status, "status" },
        { ControlAction.StartTemporary, "start-temporary" },
        { ControlAction.StopTemporary, "stop-temporary" },
        { ControlAction.EnableLongTerm, "enable-long-term" },
        { ControlAction.DisableLongTerm, "disable-long-term" },
    };
```

`DisableLongTerm` first shows a local confirmation dialog. While an action runs, all four action buttons are disabled. Exceptions map to a short Chinese error string; stdout/stderr and paths are not displayed.

- [ ] **Step 6: Implement installation and shortcut update**

Build from committed `control-app/CodexDiscordControl.cs` into the requested `ToolDir`, copy the fixed control backend beside the EXE, then use `WScript.Shell.CreateShortcut` to set `TargetPath`, `WorkingDirectory`, and description. The installer accepts testable `SourceRoot`, `ToolDir`, and `DesktopPath` parameters but never deletes files outside those exact locations. The EXE always resolves the backend beside itself; there is no `--tool-dir` override.

- [ ] **Step 7: Run GUI build, headless status, and shortcut tests**

Run: `pwsh -NoProfile -File .\tests\codex-control-app.tests.ps1`

Expected: `PASS: Codex Discord control app build and shortcut`.

- [ ] **Step 8: Commit the control program**

```powershell
git add control-app/CodexDiscordControl.cs build-control-app.ps1 install-control-app.ps1 tests/codex-control-app.tests.ps1
git commit -m "feat: add Windows bridge control app"
```

---

### Task 8: Safe Deployment Automation and User Documentation

**Files:**
- Create: `deploy.ps1`
- Create: `tests/deploy.tests.ps1`
- Modify: `README.md`
- Modify: `discord-interactions.mjs`
- Modify: `tests/discord-interactions.test.mjs`
- Modify: `tests/repository-hygiene.tests.ps1`

**Interfaces:**
- `deploy.ps1 -SourceRoot -LiveRoot -DesktopPath [-SkipLiveActions]` copies only an internal allowlist, backs up overwritten files, preserves runtime/secret files, builds the EXE, and installs the shortcut.
- `renderHelp()` lists all 11 commands and explains remote exit, local-only availability, queued takeover, and the four service modes.

- [ ] **Step 1: Write a failing deployment test that plants secrets and unrelated state in a temporary live directory**

```powershell
Set-Content -LiteralPath (Join-Path $liveRoot 'config.json') -Value 'private-config'
Set-Content -LiteralPath (Join-Path $liveRoot 'discord-token.dpapi') -Value 'private-token'
Set-Content -LiteralPath (Join-Path $liveRoot 'unrelated.txt') -Value 'keep'
& (Join-Path $sourceRoot 'deploy.ps1') -SourceRoot $sourceRoot -LiveRoot $liveRoot -DesktopPath $desktopRoot -SkipLiveActions
if ((Get-Content -Raw (Join-Path $liveRoot 'config.json')) -ne 'private-config') { throw 'config overwritten' }
if ((Get-Content -Raw (Join-Path $liveRoot 'discord-token.dpapi')) -ne 'private-token') { throw 'token overwritten' }
if ((Get-Content -Raw (Join-Path $liveRoot 'unrelated.txt')) -ne 'keep') { throw 'unrelated file changed' }
```

- [ ] **Step 2: Write failing help/README assertions for the new command and four button meanings**

```js
const help = renderHelp();
assert.match(help, /\/退出Codex/);
assert.match(help, /确认.*中断|中断.*确认/);
assert.match(help, /临时开启|控制台/);
```

- [ ] **Step 3: Run deployment, help, and hygiene tests and verify they fail**

Run: `pwsh -NoProfile -File .\tests\deploy.tests.ps1; node --test .\tests\discord-interactions.test.mjs; pwsh -NoProfile -File .\tests\repository-hygiene.tests.ps1`

Expected: FAIL because `deploy.ps1` and documentation are absent.

- [ ] **Step 4: Implement allowlisted backup/copy/build/install behavior**

```powershell
$deployFiles = @(
    'discord-bridge.mjs','discord-bridge-lib.mjs','discord-commands-lib.mjs','discord-interactions.mjs',
    'codex-takeover-lib.mjs','discord-control-client.mjs','codex-control-lib.ps1','codex-control.ps1',
    'discord-bridge-startup.ps1','start-discord-bridge.ps1','watch-notify.ps1','install-discord-bridge-task.ps1',
    'build-control-app.ps1','install-control-app.ps1','control-app\CodexDiscordControl.cs'
)
$forbidden = @('config.json','discord-token.dpapi','discord-inbox-state.json','discord-message-map.json')
if (@($deployFiles | Where-Object { $forbidden -contains $_ }).Count) { throw 'Deployment allowlist contains runtime state' }
```

Resolve and validate `SourceRoot`, `LiveRoot`, backup root, and Desktop path before writes. Copy each existing live destination into a timestamped backup directory, then copy source files. `-SkipLiveActions` stops before Scheduled Task, Discord registration, or live shortcut actions so tests remain isolated.

- [ ] **Step 5: Update help and README with exact user-visible behavior**

Document that the bridge runs with Codex desktop closed but requires a logged-in, awake, networked PC; `/继续任务` can offer a confirmed desktop exit; `/退出Codex` lists risks first; and the control app's temporary actions preserve the long-term setting.

- [ ] **Step 6: Run deployment, interaction, and hygiene tests and verify they pass**

Run: `pwsh -NoProfile -File .\tests\deploy.tests.ps1; node --test .\tests\discord-interactions.test.mjs; pwsh -NoProfile -File .\tests\repository-hygiene.tests.ps1`

Expected: PASS and no personal paths or secrets in tracked content.

- [ ] **Step 7: Commit deployment and documentation**

```powershell
git add deploy.ps1 tests/deploy.tests.ps1 README.md discord-interactions.mjs tests/discord-interactions.test.mjs tests/repository-hygiene.tests.ps1
git commit -m "docs: add takeover deployment and controls"
```

---

### Task 9: Full Verification, Review, Integration, and Live Deployment

**Files:**
- Verify: all files changed in Tasks 1–8
- Runtime-only deployment: live `mobile-notify` directory and Desktop shortcut; do not commit live config or state

**Interfaces:**
- Consumes: `deploy.ps1`, the complete test suite, and Guild command registration-only mode.
- Produces: a merged `main`, pushed repository, backed-up live deployment, 11 verified Guild commands, running bridge, readable control app status, and Desktop shortcut.

- [ ] **Step 1: Run every Node test**

Run: `node --test .\tests\*.test.mjs`

Expected: all tests pass with zero failures, cancellations, or skipped takeover tests.

- [ ] **Step 2: Run every PowerShell test in isolated child processes**

Run: `$failed=@(); Get-ChildItem .\tests\*.tests.ps1 | ForEach-Object { & pwsh -NoProfile -File $_.FullName; if ($LASTEXITCODE -ne 0) { $failed += $_.Name } }; if ($failed.Count) { throw ($failed -join ', ') }`

Expected: every file passes and `$failed` is empty.

- [ ] **Step 3: Run syntax and repository checks**

Run:

```powershell
Get-ChildItem -File *.mjs | ForEach-Object { node --check $_.FullName }
$parseErrors=@(); Get-ChildItem -File *.ps1 | ForEach-Object { [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$null,[ref]$parseErrors) }; if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
pwsh -NoProfile -File .\tests\repository-hygiene.tests.ps1
git diff --check
git status --short
```

Expected: all syntax checks pass; only intentional tracked implementation changes exist before their commits, and the final worktree is clean.

- [ ] **Step 4: Request code review and address only verified findings**

Review against the approved spec with special focus on process-tree whitelist, one-use confirmations, queue durability, scheduled-task state, and secret preservation. If a finding changes code, reproduce it with a failing test, apply one fix, rerun the focused suite, and commit the fix separately.

- [ ] **Step 5: Merge the feature branch into `main` and push**

Run:

```powershell
git switch main
git merge --no-ff codex/remote-takeover-control-app
git push origin main
```

Expected: merge succeeds without conflict and `origin/main` points to the merge commit.

- [ ] **Step 6: Resolve live paths safely and deploy from `main`**

Run:

```powershell
$sourceRoot = (Resolve-Path .).Path
$liveRoot = Join-Path $env:CODEX_HOME 'mobile-notify'
$desktopPath = [Environment]::GetFolderPath('Desktop')
if (-not (Test-Path -LiteralPath $liveRoot -PathType Container)) { throw 'Live mobile-notify directory not found' }
& .\deploy.ps1 -SourceRoot $sourceRoot -LiveRoot $liveRoot -DesktopPath $desktopPath
```

Expected: the script prints the backup location, copies only allowlisted files, builds the EXE, creates/updates the shortcut, and preserves config, Token, queue, index, quota, and notification state.

- [ ] **Step 7: Register and verify exactly 11 live Guild commands without exposing secrets**

Run:

```powershell
Push-Location $liveRoot
try { node .\discord-bridge.mjs --register-commands --once }
finally { Pop-Location }
```

Expected: output confirms 11 verified Guild commands and contains no Token or webhook URL.

- [ ] **Step 8: Verify live service and GUI status without exiting Codex**

Run:

```powershell
$status = & (Join-Path $liveRoot 'codex-control.ps1') -Action status | ConvertFrom-Json
if (-not $status.ok) { throw 'Live control status failed' }
if (-not $status.service.running) { throw 'Discord bridge is not running' }
$shortcut = Join-Path $desktopPath 'Codex Discord 控制台.lnk'
if (-not (Test-Path -LiteralPath $shortcut)) { throw 'Desktop control shortcut missing' }
```

Expected: bridge running, auto-start state accurately reported, Discord state readable, queue count numeric, Codex desktop status readable, and shortcut present. Do not invoke `stop-codex` during verification.

- [ ] **Step 9: Perform one controlled bridge restart and recheck health**

Run:

```powershell
Stop-ScheduledTask -TaskName 'Codex Discord Bridge'
Start-ScheduledTask -TaskName 'Codex Discord Bridge'
Start-Sleep -Seconds 3
$status = & (Join-Path $liveRoot 'codex-control.ps1') -Action status | ConvertFrom-Json
if (-not $status.service.running) { throw 'Bridge did not recover after controlled restart' }
```

Expected: exactly one supervisor/Node bridge instance, healthy Gateway or connecting state, no new fatal log category, and no real Codex desktop termination.

- [ ] **Step 10: Report the deployed result and first-use boundary**

Report the merge commit, backup path, live status, Desktop shortcut, exact command name `/退出Codex`, and that the first real process exit will occur only when the authorized user intentionally presses the Discord confirmation button.
