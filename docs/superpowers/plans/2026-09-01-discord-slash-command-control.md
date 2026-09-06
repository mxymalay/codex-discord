# Discord Slash Commands 控制台 Implementation Plan

历史设计与实现记录：本文属于现名“码驿 · CodexRelay”的项目，保留当时的目录、服务标识、界面名称和示例。当前安装与更新请看[入门指南](../../GETTING-STARTED.md)，更名时保留的兼容标识见 [README](../../../README.md#兼容标识)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有私有 Discord Bot 中加入 10 个中文 Slash Commands，让唯一授权用户私密查询、新建和继续 Codex 主任务，管理继续队列、查询周额度并执行系统自检，同时简化任务通知标题。

**Architecture:** 保留 `discord-bridge.mjs` 单进程入口、现有通知回复轮询和 rollout 完成补发；新增 Gateway、Guild Command 注册、Interaction 路由、主任务索引和任务创建模块。`/新建任务` 通过 App Server 项目与线程协议创建持久任务，Git 项目先建立隔离工作树；所有完整正文按需读取，Slash 续接复用现有 App Server 与持久化队列，系统完整测试复用正式 Discord Bot 出站发送路径但禁止写任务映射。

**Tech Stack:** Node.js 24 内置 `fetch`、`WebSocket`、`node:test`、PowerShell 7.6、Discord API v10、Codex App Server JSON-RPC、Windows Task Scheduler、Git/GitHub。

**Spec:** `docs/superpowers/specs/2026-09-01-discord-slash-command-control.md`

## Global Constraints

- 使用 Discord 原生 Guild Slash Commands，不开放公网 Interaction Webhook。
- 只有 `discordGuildId` 与 `discordAllowedUserId` 同时匹配时才能读取或操作任务。
- 所有命令回复、分页、按钮、Modal 回执与错误均为 Ephemeral。
- 只索引 `session_index.jsonl` 中存在且 session metadata 判定为 user root 的侧边栏主任务。
- `/新建任务` 只接受 App Server `project/list` 返回的项目或固定的“无项目”值；不接受 Discord 提供本机路径或 Git ref。
- Git 项目使用 `codex/discord-` 前缀的隔离工作树；非 Git 项目使用保存目录；无项目默认使用 `%USERPROFILE%\Documents\Codex\Discord Tasks`。
- 任务通知标题固定为 `Codex 任务已完成` 或 `Codex 任务待确认`，任务名只在消息内部显示。
- 不持久化完整对话、Interaction Token、Bot Token、真实 Webhook URL 或完整用户继续指令。
- 现有通知回复、离线补收、30 秒队列重试、任务分类、额度算法与完成补发不得回归。
- 不新增第三方 Node 依赖；使用 Node 24 内置能力。
- 所有新行为先写失败测试、观察预期失败，再写最小实现。
- 运行中目录 `%CODEX_HOME%\mobile-notify` 的 `config.json`、DPAPI Token、日志和状态文件永不提交 Git。

## File Map

- Create `.gitignore`: 排除凭据、真实配置、日志、运行状态、临时文件和测试缓存。
- Create `config.example.json`: 可提交的无秘密配置模板。
- Create `discord-commands-lib.mjs`: 命令 schema、注册、鉴权、组件 ID、分页与通用 Interaction 响应。
- Create `discord-gateway-lib.mjs`: Gateway 握手、心跳、Resume、重连和 `INTERACTION_CREATE` 派发。
- Create `discord-task-index-lib.mjs`: 主任务资格、索引、全文读取、搜索、状态与运行时间。
- Create `discord-task-create-lib.mjs`: 项目列表、Git 工作树准备、安全回滚、`thread/start` 与 `turn/start`。
- Create `discord-interactions.mjs`: 10 个命令、autocomplete、按钮与 Modal 的运行时路由。
- Create `discord-health-lib.mjs`: 快速健康检查、Discord 权限计算和完整测试编排。
- Modify `discord-bridge-lib.mjs`: 统一 continuation request、持久化队列、取消与 Interaction 去重。
- Modify `discord-bridge.mjs`: 组合 Gateway、命令、索引、Interaction、队列和现有监听器。
- Modify `dispatcher.ps1`: 新增安全的三路系统测试入口，测试通知不写任务映射或额度历史。
- Modify startup/config/README files: 安全导入、命令注册、部署和操作说明。
- Create Node and PowerShell tests matching every new module.

---

### Task 1: Secure Git Baseline and Empty Repository Import

**Files:**
- Create: `.gitignore`
- Create: `config.example.json`
- Create: `tests/repository-hygiene.tests.ps1`
- Modify: `save-discord-token.ps1`
- Modify: `send-discord-bot-live-tests.ps1`
- Modify: `README.md`
- Modify: `tests/discord-bot-dispatcher.tests.ps1`
- Modify: `tests/discord-config.tests.ps1`
- Modify: `tests/discord-state.tests.ps1`
- Modify: `tests/discord-bridge.test.mjs`
- Modify: `tests/quota-usage-message.tests.ps1`
- Preserve locally but never copy/commit: `config.json`, `discord-token.dpapi`, `*.log`, `*-state.json`, `discord-message-map.json`

**Interfaces:**
- Consumes: empty remote `https://github.com/mxymalay/CodexRelay.git`.
- Produces: clean local repository on `main`, remote `origin`, sanitized source baseline, reusable `config.example.json`.

- [ ] **Step 1: Clone the empty repository into an isolated workspace**

Run:

```powershell
$repoRoot = Join-Path (Get-Location) 'codex-discord'
git clone https://github.com/mxymalay/CodexRelay.git $repoRoot
git -C $repoRoot switch -c main
```

Expected: clone reports an empty repository; current branch is `main`.

- [ ] **Step 2: Copy only source, tests and approved docs into the clone**

Copy the allowlisted source files, `tests/`, and `docs/superpowers/` from `$liveToolDir = Join-Path $env:CODEX_HOME 'mobile-notify'`; explicitly do not copy `config.json`, `*.dpapi`, `*.log`, `discord-inbox-state.json`, `discord-message-map.json`, `quota-state.json`, `rollout-watcher-state.json`, or `task-delivery-state.json`.

Run:

```powershell
$repoRoot = Join-Path (Get-Location) 'codex-discord'
Get-ChildItem -LiteralPath $repoRoot -Force
```

Expected: source and tests exist; none of the forbidden runtime files exist.

- [ ] **Step 3: Write the failing repository hygiene test**

```powershell
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
    ('C:' + '\Users\' + 'operator'),
    ('D:' + '\' + 'codex' + '-data')
)
foreach ($personalPath in $personalPaths) { if ($joined.Contains($personalPath)) { throw 'personal absolute path found' } }
$realIds = @('111111' + '111111111111','222222' + '222222222222','333333' + '333333333333')
foreach ($id in $realIds) { if ($joined.Contains($id)) { throw 'personal Discord deployment id found' } }
Write-Output 'PASS: repository contains no runtime state or personal deployment values'
```

- [ ] **Step 4: Run the hygiene test and observe the expected failure**

Run: `pwsh -NoProfile -File .\tests\repository-hygiene.tests.ps1`

Expected: FAIL on at least one personal absolute path or deployment ID.

- [ ] **Step 5: Add ignore rules and sanitized example config**

`.gitignore` must contain:

```gitignore
config.json
discord-token.dpapi
*.log
discord-inbox-state.json
discord-message-map.json
discord-task-index.json
discord-gateway-state.json
quota-state.json
rollout-watcher-state.json
task-delivery-state.json
.rollout-notification-*.json
*.tmp
node_modules/
coverage/
```

`config.example.json` must use fake Snowflakes and a relative token path:

```json
{
  "enabled": true,
  "provider": "discord-bot",
  "quotaNotifications": true,
  "discordApplicationId": "111111111111111111",
  "discordGuildId": "222222222222222222",
  "discordAllowedUserId": "333333333333333333",
  "discordTaskChannelId": "444444444444444444",
  "discordConfirmationChannelId": "555555555555555555",
  "discordQuotaChannelId": "666666666666666666",
  "discordTokenPath": ".\\discord-token.dpapi",
  "discordCodexPath": "codex",
  "discordProjectlessRoot": "%USERPROFILE%\\Documents\\Codex\\Discord Tasks",
  "discordWorktreeRoot": "%CODEX_HOME%\\worktrees\\discord"
}
```

- [ ] **Step 6: Remove personal defaults from source and fixtures**

Set `save-discord-token.ps1` parameter `ExpectedApplicationId` default to an empty string and validate only when a value is explicitly passed or read from config. Set `send-discord-bot-live-tests.ps1` default `ThreadId` and `Cwd` to empty, requiring explicit arguments for live use. Replace real Snowflakes in tests with the fake values from `config.example.json`; replace personal paths with `C:\workspace\demo` or `G:\tools\mobile-notify`. Remove the personal uninstall path from README and keep only `$env:USERPROFILE\.codex\config.toml` as prose.

- [ ] **Step 7: Run hygiene and existing regression tests**

Run:

```powershell
pwsh -NoProfile -File .\tests\repository-hygiene.tests.ps1
$failed = @()
Get-ChildItem .\tests\*.tests.ps1 | ForEach-Object { & pwsh -NoProfile -File $_.FullName; if ($LASTEXITCODE -ne 0) { $failed += $_.Name } }
node --test .\tests\*.test.mjs
if ($failed.Count) { throw ($failed -join ', ') }
```

Expected: hygiene PASS, every PowerShell script exits 0, Node reports 0 failed.

- [ ] **Step 8: Commit and publish the secure baseline**

Run:

```powershell
git status --short
git add .
git diff --cached --check
git commit -m "chore: import secure Discord bridge baseline"
git push -u origin main
git switch -c codex/discord-slash-commands
```

Expected: `main` exists on GitHub without runtime secrets; work continues on `codex/discord-slash-commands`.

---

### Task 2: Guild Command Definitions and Idempotent Registration

**Files:**
- Create: `discord-commands-lib.mjs`
- Create: `tests/discord-commands.test.mjs`

**Interfaces:**
- Produces: `buildGuildCommandDefinitions() -> Array<DiscordApplicationCommand>`.
- Produces: `registerGuildCommands({ token, applicationId, guildId, fetchImpl }) -> Promise<Array>`.
- Produces: `authorizeInteraction(interaction, config) -> { allowed: boolean, reason: string }`.
- Produces: `ephemeral(contentOrPayload) -> DiscordInteractionResponseData`.

- [ ] **Step 1: Write failing schema, registration and authorization tests**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGuildCommandDefinitions, registerGuildCommands, authorizeInteraction } from '../discord-commands-lib.mjs';

test('defines exactly the approved ten Chinese guild commands', () => {
  const commands = buildGuildCommandDefinitions();
  assert.deepEqual(commands.map((item) => item.name), [
    '任务列表','任务详情','任务搜索','新建任务','继续任务','继续队列','额度','系统状态','系统测试','帮助',
  ]);
  const systemTest = commands.find((item) => item.name === '系统测试');
  assert.equal(systemTest.options[0].required, false);
  assert.deepEqual(systemTest.options[0].choices.map((item) => item.name), ['快速','完整']);
});

test('registers commands with the guild PUT endpoint', async () => {
  const calls = [];
  await registerGuildCommands({
    token: 'test-token', applicationId: '111', guildId: '222',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response('[]', { status: 200 }); },
  });
  assert.equal(calls[0].url, 'https://discord.com/api/v10/applications/111/guilds/222/commands');
  assert.equal(calls[0].options.method, 'PUT');
});

test('rejects wrong guild and wrong user', () => {
  const config = { discordGuildId: '222', discordAllowedUserId: '333' };
  assert.equal(authorizeInteraction({ guild_id: '999', member: { user: { id: '333' } } }, config).allowed, false);
  assert.equal(authorizeInteraction({ guild_id: '222', member: { user: { id: '999' } } }, config).allowed, false);
});
```

- [ ] **Step 2: Run tests and observe missing module failure**

Run: `node --test .\tests\discord-commands.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement all ten command definitions**

Use Discord option type `3` for strings. `任务列表` gets optional `状态` choices `全部/运行中/待确认/已完成/失败`; `任务详情` and `继续任务` get required autocomplete `任务`; `任务搜索` gets required `关键词`; `新建任务` gets required autocomplete `项目`; `系统测试` gets optional `类型` choices `快速/完整`. The remaining commands have no options.

```javascript
export const COMMAND_NAMES = Object.freeze([
  '任务列表','任务详情','任务搜索','新建任务','继续任务','继续队列','额度','系统状态','系统测试','帮助',
]);

export function authorizeInteraction(interaction, config) {
  if (String(interaction?.guild_id ?? '') !== String(config.discordGuildId)) return { allowed: false, reason: 'wrong-guild' };
  const userId = String(interaction?.member?.user?.id ?? interaction?.user?.id ?? '');
  if (userId !== String(config.discordAllowedUserId)) return { allowed: false, reason: 'wrong-user' };
  return { allowed: true, reason: 'authorized' };
}

export function ephemeral(payload) {
  const data = typeof payload === 'string' ? { content: payload } : { ...payload };
  return { ...data, flags: 64, allowed_mentions: { parse: [] } };
}
```

- [ ] **Step 4: Implement guild registration with Discord error details sanitized**

`registerGuildCommands` sends `PUT /applications/{applicationId}/guilds/{guildId}/commands`, uses `Authorization: Bot <token>`, parses JSON, honors 429 `retry_after` once, and throws `Discord command registration failed: <status>` without including response headers or Token.

- [ ] **Step 5: Run focused and complete Node tests**

Run:

```powershell
node --test .\tests\discord-commands.test.mjs
node --test .\tests\*.test.mjs
```

Expected: 0 failed.

- [ ] **Step 6: Commit**

```powershell
git add discord-commands-lib.mjs tests/discord-commands.test.mjs
git commit -m "feat: define and register Discord slash commands"
```

---

### Task 3: Discord Gateway Connection and Interaction Delivery

**Files:**
- Create: `discord-gateway-lib.mjs`
- Create: `tests/discord-gateway.test.mjs`

**Interfaces:**
- Produces: `createGatewayClient({ token, fetchImpl, WebSocketImpl, onInteraction, onStatus, timers })`.
- Returned client: `{ start(): Promise<void>, stop(): Promise<void>, getStatus(): GatewayStatus }`.
- `GatewayStatus`: `{ state, sessionId, lastHeartbeatAt, lastAckAt, lastEventAt, reconnectCount, lastError }`, with no Token or interaction payload.

- [ ] **Step 1: Write failing HELLO, heartbeat, READY and interaction tests**

```javascript
test('identifies after HELLO and dispatches INTERACTION_CREATE once', async () => {
  const interactions = [];
  const socket = new FakeWebSocket();
  const client = createGatewayClient({
    token: 'test-token',
    fetchImpl: async () => new Response(JSON.stringify({ url: 'wss://gateway.discord.test' })),
    WebSocketImpl: class { constructor() { return socket; } },
    onInteraction: async (value) => interactions.push(value.id),
    onStatus: () => {},
    timers: fakeTimers,
  });
  await client.start();
  socket.receive({ op: 10, d: { heartbeat_interval: 45000 } });
  assert.equal(socket.sent.some((frame) => frame.op === 2 && frame.d.intents === 1), true);
  socket.receive({ op: 0, t: 'READY', s: 1, d: { session_id: 'session-1', resume_gateway_url: 'wss://resume.test' } });
  socket.receive({ op: 0, t: 'INTERACTION_CREATE', s: 2, d: { id: 'interaction-1' } });
  socket.receive({ op: 0, t: 'INTERACTION_CREATE', s: 2, d: { id: 'interaction-1' } });
  assert.deepEqual(interactions, ['interaction-1']);
});
```

Also test opcode 7 reconnect, opcode 9 invalid session, missed heartbeat ACK, and Resume payload using the prior `session_id` and sequence.

- [ ] **Step 2: Run tests and observe missing module failure**

Run: `node --test .\tests\discord-gateway.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement Gateway state machine**

```javascript
const OP = Object.freeze({ DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 });

function identifyPayload(token) {
  return { op: OP.IDENTIFY, d: { token, intents: 1, properties: { os: 'windows', browser: 'codex-discord', device: 'codex-discord' } } };
}

function resumePayload(token, sessionId, sequence) {
  return { op: OP.RESUME, d: { token, session_id: sessionId, seq: sequence } };
}
```

Fetch `/gateway/bot`, connect with `?v=10&encoding=json`, heartbeat at the server interval with jitter on the first beat, require ACK before the next interval, and reconnect with capped exponential backoff `1s, 2s, 4s, 8s, 15s`. Keep `sessionId` only in memory.

- [ ] **Step 4: Add duplicate delivery protection**

Keep an in-memory LRU Set of the most recent 1,000 Interaction IDs; add an ID before awaiting `onInteraction`, and never invoke the handler twice for the same ID during one process lifetime.

- [ ] **Step 5: Run focused and full Node tests**

Run:

```powershell
node --test .\tests\discord-gateway.test.mjs
node --test .\tests\*.test.mjs
```

Expected: heartbeat/Resume/reconnect tests pass and existing bridge tests remain green.

- [ ] **Step 6: Commit**

```powershell
git add discord-gateway-lib.mjs tests/discord-gateway.test.mjs
git commit -m "feat: add Discord gateway interaction client"
```

---

### Task 4: Sidebar Root Task Index, Details, Search and Runtime

**Files:**
- Create: `discord-task-index-lib.mjs`
- Create: `tests/discord-task-index.test.mjs`

**Interfaces:**
- Produces: `isUserRootSession(meta, sidebarEntry) -> boolean`.
- Produces: `buildTaskIndex({ sessionsRoot, sessionIndexPath, messageMapPath, previousIndex, nowMs }) -> Promise<TaskIndex>`.
- Produces: `readTaskDetail(record) -> Promise<TaskDetail>`.
- Produces: `searchTasks({ index, keyword, limit }) -> Promise<TaskSummary[]>`.
- Produces: `writeTaskIndexAtomic(indexPath, index)` and `readTaskIndex(indexPath)`.
- `TaskRecord`: `{ threadId, projectId, projectName, taskName, status, createdAt, lastActivityAt, startedAt, completedAt, runtimeMs, rolloutPath, offset, worktreePath, worktreeBranch }`.

- [ ] **Step 1: Write failing fixture tests for root filtering and task parsing**

```javascript
test('indexes sidebar user roots and excludes subagents and parented sessions', async () => {
  await writeJsonl(sessionIndexPath, [
    { id: 'root-1', thread_name: '主任务' },
    { id: 'child-1', thread_name: '子任务' },
  ]);
  await writeJsonl(rootRollout, [
    { timestamp: '2026-09-01T00:00:00Z', type: 'session_meta', payload: { id: 'root-1', thread_source: 'user', cwd: 'C:\\workspace\\demo' } },
    { timestamp: '2026-09-01T00:01:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { timestamp: '2026-09-01T00:02:00Z', type: 'event_msg', payload: { type: 'user_message', message: '检查通知' } },
    { timestamp: '2026-09-01T00:06:00Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: '已完成。' } },
  ]);
  await writeJsonl(childRollout, [
    { timestamp: '2026-09-01T00:00:00Z', type: 'session_meta', payload: { id: 'child-1', thread_source: 'subagent', parent_thread_id: 'root-1' } },
  ]);
  const index = await buildTaskIndex({ sessionsRoot, sessionIndexPath, messageMapPath, nowMs: Date.parse('2026-09-01T00:07:00Z') });
  assert.deepEqual(index.tasks.map((item) => item.threadId), ['root-1']);
  assert.equal(index.tasks[0].runtimeMs, 300000);
});
```

Add cases for `source.subagent`, mismatched `session_id`, missing sidebar entry, running turn, `user-task-confirmation-required` overlay from the latest message map, failed/aborted turn, missing rollout and invalid JSON lines.

Also assert that saved-project sessions expose `projectId`/`projectName`, and that sessions created in a managed Discord worktree expose `worktreePath`/`worktreeBranch` without treating those fields as proof of root-task eligibility.

- [ ] **Step 2: Run tests and observe missing module failure**

Run: `node --test .\tests\discord-task-index.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement exact root eligibility**

```javascript
export function isUserRootSession(meta, sidebarEntry) {
  if (!meta || !sidebarEntry || String(meta.id ?? '') !== String(sidebarEntry.id ?? '')) return false;
  if (String(meta.thread_source ?? '') === 'subagent') return false;
  if (meta.thread_source && String(meta.thread_source) !== 'user') return false;
  if (meta.source?.subagent != null) return false;
  if (String(meta.parent_thread_id ?? '')) return false;
  if (meta.session_id && String(meta.session_id) !== String(meta.id)) return false;
  return true;
}
```

Read the last `session_index.jsonl` entry per ID. Scan only `rollout-*.jsonl`, parse `session_meta`, saved project metadata, runtime workspace roots, `task_started`, `user_message`, `agent_message`, `task_complete`, aborted/failed events and timestamps. Recover managed worktree metadata only when the path is under the configured Discord worktree root and the branch has the `codex/discord-` prefix. Never use file mtime as precise task runtime.

- [ ] **Step 4: Implement detail extraction and lazy in-memory search cache**

`readTaskDetail` returns the first real user task text, latest completed assistant result and page-safe raw Markdown. `searchTasks` normalizes Unicode case and whitespace, scores exact task-name match above project match above body match, sorts equal scores by `lastActivityAt`, and returns at most 10 by default. Cache full normalized text by `rolloutPath + offset` only in memory.

- [ ] **Step 5: Implement atomic index persistence and corruption backup**

Write `discord-task-index.json` through a same-directory temporary file and rename. On invalid JSON, rename the bad file to `discord-task-index.corrupt-<ISO-without-colons>.json`, return an empty index, and rebuild from sessions.

- [ ] **Step 6: Run focused and complete tests**

Run:

```powershell
node --test .\tests\discord-task-index.test.mjs
node --test .\tests\*.test.mjs
```

Expected: all root/status/runtime/search/corruption tests pass; Node 0 failed.

- [ ] **Step 7: Commit**

```powershell
git add discord-task-index-lib.mjs tests/discord-task-index.test.mjs
git commit -m "feat: index Codex sidebar root tasks"
```

---

### Task 5: Saved Projects, Automatic Worktrees and New Codex Tasks

**Files:**
- Create: `discord-task-create-lib.mjs`
- Create: `tests/discord-task-create.test.mjs`
- Modify: `discord-bridge-lib.mjs`
- Modify: `tests/discord-bridge.test.mjs`

**Interfaces:**
- Produces: `listCodexProjects({ codexPath, processCwd, clientFactory }) -> Promise<Project[]>`.
- Produces: `createProjectCatalog({ loader, ttlMs, now }) -> { warm(), choices(focused), refresh(), getById(id), status() }`.
- Produces: `resolveProjectSelection({ projects, selectionId, projectlessRoot }) -> ProjectSelection`.
- Produces: `prepareTaskWorkspace({ selection, worktreeRoot, operationId, gitRunner, now }) -> Promise<PreparedWorkspace>`.
- Produces: `startNewCodexTask({ selection, workspace, text, interactionId, codexPath, processCwd, clientFactory }) -> Promise<{ threadId, turnId, taskName, completion, workspace }>`.
- Produces: `createNewTaskOnce({ state, interactionId, ...args }) -> Promise<CreateTaskResult>` and persists `state.createdTasksByInteraction[interactionId]`.
- Produces: `recoverInterruptedTaskCreations({ state, worktreeRoot, gitRunner, nowMs }) -> Promise<RecoveryResult[]>`.
- `ProjectSelection`: `{ kind: 'project'|'projectless', projectId, projectName, roots }`.
- `PreparedWorkspace`: `{ mode: 'worktree'|'local'|'projectless', cwd, runtimeWorkspaceRoots, branchName, worktreePath, cleanupBeforeThreadStart }`.

- [ ] **Step 1: Write failing project-list, workspace-routing and App Server order tests**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_PROJECT, listCodexProjects, resolveProjectSelection, prepareTaskWorkspace,
  startNewCodexTask, createNewTaskOnce,
} from '../discord-task-create-lib.mjs';

test('lists saved projects through project/list', async () => {
  const methods = [];
  const projects = await listCodexProjects({
    codexPath: 'codex', processCwd: 'C:\\workspace',
    clientFactory: () => fakeAppServer(methods, { 'project/list': { data: [{ id: 'p1', name: 'POS', roots: [{ path: 'C:\\repo' }] }] } }),
  });
  assert.deepEqual(methods, ['initialize', 'initialized', 'project/list']);
  assert.equal(projects[0].id, 'p1');
});

test('uses a worktree for git and all saved roots for runtime access', async () => {
  const calls = [];
  const prepared = await prepareTaskWorkspace({
    selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo', 'C:\\shared'] },
    worktreeRoot: 'G:\\codex-worktrees', operationId: 'abc123', now: new Date('2026-09-01T01:02:03Z'),
    gitRunner: fakeGitRunner(calls, { isRepo: true, defaultRef: 'origin/main' }),
  });
  assert.equal(prepared.mode, 'worktree');
  assert.equal(prepared.branchName.startsWith('codex/discord-20260901-010203-'), true);
  assert.deepEqual(prepared.runtimeWorkspaceRoots, [prepared.worktreePath, 'C:\\shared']);
  assert.equal(calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add'), true);
});

test('starts a durable thread before its first turn', async () => {
  const methods = [];
  const result = await startNewCodexTask({
    selection: { kind: 'project', projectId: 'p1', projectName: 'POS', roots: ['C:\\repo'] },
    workspace: { mode: 'local', cwd: 'C:\\repo', runtimeWorkspaceRoots: ['C:\\repo'] },
    text: '检查支付流程', interactionId: 'interaction-1', codexPath: 'codex', processCwd: 'C:\\repo',
    clientFactory: () => fakeAppServer(methods, {
      'thread/start': { thread: { id: 'thread-1', name: null } },
      'turn/start': { turn: { id: 'turn-1' } },
    }),
  });
  assert.deepEqual(methods, ['initialize', 'initialized', 'thread/start', 'turn/start']);
  assert.equal(result.threadId, 'thread-1');
  assert.equal(result.taskName, '生成中');
  assert.equal(result.workspace.cwd, 'C:\\repo');
});
```

Add tests for `NO_PROJECT`, missing/deleted project, non-Git local routing, multiple roots, missing remote HEAD fallback to `HEAD`, generated branch prefix, duplicate Interaction returning the recorded thread, pre-thread worktree cleanup, and post-thread `turn/start` failure preserving the thread/worktree.

Also test that the project catalog serves autocomplete from its warmed cache without waiting for I/O, refreshes expired data in the background, keeps the last good catalog after a refresh error, and exposes the refresh timestamp/error category without leaking paths.

- [ ] **Step 2: Run tests and observe missing module failure**

Run: `node --test .\tests\discord-task-create.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Export the reusable App Server client and initialization helper**

In `discord-bridge-lib.mjs`, export `AppServerClient` and add:

```javascript
export async function initializeAppServerClient(client) {
  await client.request({ method: 'initialize', id: 1, params: { clientInfo: { name: 'codex-discord-bridge', version: '1.0.0' } } });
  client.send({ method: 'initialized', params: {} });
}
```

Change `resumeCodexThread` to call this helper without changing its request order or existing completion behavior.

- [ ] **Step 4: Implement project listing and validated selection**

`listCodexProjects` initializes one App Server client, pages `project/list` with `{ cursor, limit: 100 }` until `nextCursor` is null, closes the client and returns projects in server order. Export `NO_PROJECT = '__projectless__'`. `resolveProjectSelection` accepts only an exact returned project ID or `NO_PROJECT`; it resolves `%USERPROFILE%` in `projectlessRoot`, creates no directory during autocomplete, rejects empty/missing roots, and never accepts a Discord path.

`createProjectCatalog` warms once during bridge startup, refreshes on a 60-second TTL, and makes autocomplete plus the initial Modal launch strictly cache-only so Discord receives its response within the deadline. An expired lookup returns the last good list immediately and starts one deduplicated background refresh. Modal submission performs an authoritative refresh after an Ephemeral defer before starting a task.

- [ ] **Step 5: Implement automatic workspace preparation with strict cleanup guards**

Use `spawn` with an argument array, never a Shell string. Detect Git with `git -C <root> rev-parse --show-toplevel`. Resolve base with `git -C <root> symbolic-ref --short refs/remotes/origin/HEAD`; on failure use `git -C <root> rev-parse HEAD`. Generate branch `codex/discord-YYYYMMDD-HHmmss-<6 lowercase hex>` and worktree path `<worktreeRoot>/<operationId>`.

Before `git worktree remove --force` or `git branch -D`, verify the resolved worktree path is a descendant of the configured `worktreeRoot`, the branch starts with `codex/discord-`, and both values were created by the current operation. Successful task creation returns a no-op cleanup so completed tasks retain their workspace.

- [ ] **Step 6: Implement `thread/start`, `turn/start` and persistent idempotence**

Send:

```javascript
const threadResult = await client.request({ method: 'thread/start', id: 2, params: {
  ephemeral: false,
  projectId: selection.kind === 'project' ? selection.projectId : null,
  cwd: workspace.cwd,
  runtimeWorkspaceRoots: workspace.runtimeWorkspaceRoots,
  threadSource: 'user',
} });
const turnResult = await client.request({ method: 'turn/start', id: 3, params: {
  threadId: threadResult.thread.id,
  input: [{ type: 'text', text }],
  cwd: workspace.cwd,
  runtimeWorkspaceRoots: workspace.runtimeWorkspaceRoots,
  clientUserMessageId: interactionId,
  turnTrigger: 'discord-slash-command',
} });
```

Record `{ status: 'creating' }` before workspace mutation, `{ status: 'workspace-ready', workspace }` after preparation, `{ status: 'thread-created', threadId, workspace }` immediately after `thread/start`, and `{ status: 'started', threadId, turnId, workspace }` after `turn/start`. A duplicate Interaction returns the recorded result and never calls Git or App Server twice. If `turn/start` fails after thread creation, persist `status: 'first-turn-failed'` and return the thread ID. The successful result includes the prepared workspace metadata so the Interaction router can add the new thread to the in-memory task index immediately while the normal rollout rebuild remains the source of truth.

On a caught failure before `thread/start`, call the operation-owned cleanup and persist `status: 'failed-before-thread'`. On process startup, recover stale `creating`/`workspace-ready` records: clean only recorded worktrees and branches that pass the same root/prefix/operation ownership guards, then mark them `recovered-failed`; never remove a workspace once a `threadId` exists.

- [ ] **Step 7: Run focused and full Node tests**

Run:

```powershell
node --test .\tests\discord-task-create.test.mjs .\tests\discord-bridge.test.mjs
node --test .\tests\*.test.mjs
```

Expected: project/worktree/App Server/idempotence tests pass and existing resume tests remain green.

- [ ] **Step 8: Commit**

```powershell
git add discord-task-create-lib.mjs discord-bridge-lib.mjs tests/discord-task-create.test.mjs tests/discord-bridge.test.mjs
git commit -m "feat: create Codex tasks from saved projects"
```

---

### Task 6: Private Query Commands, Autocomplete, Pagination and Help

**Files:**
- Create: `discord-interactions.mjs`
- Create: `tests/discord-interactions.test.mjs`
- Modify: `discord-commands-lib.mjs`
- Modify: `tests/discord-commands.test.mjs`

**Interfaces:**
- Produces: `createInteractionRouter(dependencies) -> { handle(interaction), sweepExpiredUiState(nowMs) }`.
- Produces: `paginateMarkdown(text, maximumLength = 3800) -> string[]`.
- Produces: renderers `renderTaskList`, `renderTaskDetail`, `renderSearchResults`, `renderQuota`, `renderSystemStatus`, `renderHelp`.
- Consumes: Task 2 command/auth helpers, Task 4 index/detail/search functions and Task 5 project/task creation functions.

- [ ] **Step 1: Write failing private response, autocomplete and pagination tests**

```javascript
test('task detail autocomplete returns at most 25 authorized root tasks', async () => {
  const responses = [];
  const router = createInteractionRouter(makeDependencies({ respond: async (body) => responses.push(body) }));
  await router.handle(makeAutocompleteInteraction('任务详情', '门店'));
  assert.equal(responses[0].type, 8);
  assert.equal(responses[0].data.choices.length <= 25, true);
  assert.equal(responses[0].data.choices.every((item) => item.value.startsWith('root-')), true);
});

test('new task project autocomplete returns saved projects plus no-project', async () => {
  const responses = [];
  const router = createInteractionRouter(makeDependencies({
    projects: [{ id: 'project-1', name: 'POS' }],
    respond: async (body) => responses.push(body),
  }));
  await router.handle(makeAutocompleteInteraction('新建任务', ''));
  assert.equal(responses[0].type, 8);
  assert.deepEqual(responses[0].data.choices.map((item) => item.value), ['project-1', '__projectless__']);
});

test('new task opens a private modal and creates exactly once on submit', async () => {
  const created = [];
  const dependencies = makeDependencies({
    createNewTaskOnce: async (input) => { created.push(input); return { status: 'started', threadId: 'thread-1', taskName: '生成中', workspace: { mode: 'worktree' } }; },
  });
  const modal = await dispatchCommand(makeCommandInteraction('新建任务', { 项目: 'project-1' }), dependencies);
  assert.equal(modal.type, 9);
  const receipt = await dispatchModal(makeModalSubmit(modal.data.custom_id, '检查支付流程'), dependencies);
  assert.equal(receipt.data.flags & 64, 64);
  assert.equal(created.length, 1);
});

test('every command response is ephemeral', async () => {
  const response = await dispatchCommand(makeCommandInteraction('任务列表'), makeDependencies());
  assert.equal(response.data.flags & 64, 64);
  assert.deepEqual(response.data.allowed_mentions.parse, []);
});

test('pagination closes and reopens fenced code blocks', () => {
  const pages = paginateMarkdown('```js\n' + 'const value = 1;\n'.repeat(400) + '```', 500);
  assert.equal(pages.every((page) => (page.match(/```/g) ?? []).length % 2 === 0), true);
});
```

Also cover unauthorized task/project autocomplete returning zero choices, project autocomplete truncation to 25, deleted project between autocomplete and submit, duplicate new-task Modal submission, page buttons, expired random UI IDs, no task result, stale quota timestamp, no quota snapshot and all ten `/帮助` command names.

- [ ] **Step 2: Run tests and observe missing router failure**

Run: `node --test .\tests\discord-interactions.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement Discord REST interaction helpers**

Implement callback POST `/interactions/{id}/{token}/callback`, deferred callback type `5` with `flags: 64`, autocomplete type `8`, Modal type `9`, and edit original response PATCH `/webhooks/{applicationId}/{interactionToken}/messages/@original`. Interaction Token remains only in the active call stack.

- [ ] **Step 4: Implement task/project autocomplete and private new-task Modal**

`/任务详情` and `/继续任务` autocomplete by root-task title/project/status. `/新建任务` reads the warmed project catalog, filters saved projects by the focused text, appends the fixed `NO_PROJECT` choice, and returns at most 25 choices without blocking on App Server I/O. Selecting a project opens a type `9` Modal with a required multiline `任务内容` field (1–4000 characters); random 15-minute UI state stores only user/guild/project selection and never a supplied path or Interaction Token.

On Modal submit, reauthorize the user, re-read saved projects, reject a deleted or changed selection, defer Ephemeral, call `createNewTaskOnce`, and immediately insert the returned thread/workspace metadata into the in-memory index. Render project, task name (`生成中` allowed), task ID suffix, workspace mode and a safely normalized path. If `turn/start` failed after `thread/start`, report the retained task ID and workspace instead of claiming full success.

- [ ] **Step 5: Implement list, detail, search and help handlers**

`/任务列表` defaults to 10 and status `全部`; `/任务搜索` rejects blank text and returns at most 10; `/帮助` lists all ten commands, explains `新建任务` workspace routing and states the offline limitation. Store pagination payload under a random 96-bit ID with `{ userId, guildId, pages, page, expiresAt }` for 15 minutes.

- [ ] **Step 6: Implement quota and system status renderers**

Read but never rewrite `quota-state.json`. Render percentage transition, time since change, faster/slower comparison, reset countdown and both exhaustion projections using existing stored fields. Include the snapshot timestamp and label it stale when older than 15 minutes. `/系统状态` renders Gateway state, rollout last progress, index timestamp/count, queue count, quota timestamp and sanitized latest error category.

- [ ] **Step 7: Run focused and full tests**

Run:

```powershell
node --test .\tests\discord-interactions.test.mjs .\tests\discord-commands.test.mjs
node --test .\tests\*.test.mjs
```

Expected: command/follow-up responses are Ephemeral, autocomplete uses type `8`, Modal launch uses type `9`, and project/task autocomplete, new-task idempotence, pagination and stale data cases pass.

- [ ] **Step 8: Commit**

```powershell
git add discord-interactions.mjs discord-commands-lib.mjs tests/discord-interactions.test.mjs tests/discord-commands.test.mjs
git commit -m "feat: add private Discord task command console"
```

---

### Task 7: Continue Task Modal and Unified Continue Queue

**Files:**
- Modify: `discord-bridge-lib.mjs`
- Modify: `discord-bridge.mjs`
- Modify: `discord-interactions.mjs`
- Modify: `tests/discord-bridge.test.mjs`
- Modify: `tests/discord-interactions.test.mjs`

**Interfaces:**
- Produces: `createContinuationRequest({ source, requestId, threadId, cwd, text, channelId, replyToMessageId, createdAt })`.
- Produces: `enqueueContinuation(state, request)`, `listContinuations(state)`, `cancelContinuation(state, queueId, now)`, `markContinuationDelivered(state, queueId, now)`.
- Produces: `dispatchContinuation(request) -> Promise<{ status: 'started'|'queued'|'failed', queueId?, turnId?, reason? }>`.
- Persists: `pendingContinuations`, bounded `processedInteractions` and `createdTasksByInteraction` in `discord-inbox-state.json` version 2, with migration from version 1 `pendingReplies` and preservation of any Task 5 create records.

- [ ] **Step 1: Write failing queue migration, idempotence and cancellation tests**

```javascript
test('migrates reply queue and stores slash queue without interaction token', () => {
  const state = migrateInboxState({
    version: 1,
    cursors: {},
    processedMessageIds: [],
    pendingReplies: { 'message-1': oldPending },
    createdTasksByInteraction: { 'create-1': { status: 'started', threadId: 'root-new' } },
  });
  const request = createContinuationRequest({
    source: 'slash', requestId: 'interaction-1', threadId: 'root-1', cwd: 'C:\\workspace\\demo',
    text: '重新检查一次', createdAt: '2026-09-01T00:00:00Z',
  });
  enqueueContinuation(state, request);
  assert.equal(JSON.stringify(state).includes('interaction-token'), false);
  assert.equal(listContinuations(state).length, 2);
  assert.equal(state.createdTasksByInteraction['create-1'].threadId, 'root-new');
});

test('cancels only a continuation that has not started', () => {
  assert.equal(cancelContinuation(state, queuedId, now).status, 'cancelled');
  assert.equal(cancelContinuation(state, startedId, now).status, 'already-started');
});
```

Also test duplicate Modal submission, same `requestId` twice, blank text, unknown/root-filtered thread, active writer queuing, queued retry delivery and legacy Discord reply acknowledgements.

- [ ] **Step 2: Run focused tests and observe missing APIs**

Run:

```powershell
node --test .\tests\discord-bridge.test.mjs .\tests\discord-interactions.test.mjs
```

Expected: FAIL because continuation APIs and Modal routing do not exist.

- [ ] **Step 3: Refactor current mapped reply flow behind `dispatchContinuation`**

Move Codex `resumeCodexThread` invocation and active-writer handling into one source-neutral function. Reply-origin requests retain `channelId` and `replyToMessageId` so delivery acknowledgements still use `sendDiscordReply`; Slash-origin requests persist no Interaction Token and report later status through `/继续队列`.

- [ ] **Step 4: Implement `/继续任务` Modal and Modal submit handler**

Modal `custom_id` references a 15-minute random UI state entry containing only authorized user ID, guild ID and validated root `threadId`. The text input uses style `2`, label `继续内容`, minimum length 1 and maximum length 4000. On submit, defer Ephemeral, revalidate the task, call `dispatchContinuation`, and edit the original response with started/queued/failed status.

- [ ] **Step 5: Implement `/继续队列` and cancel buttons**

Show queue ID suffix, project/task, safe 120-character summary, source `通知回复` or `Slash 命令`, enqueue time, last attempt and status. Cancel button stores a random UI state reference to the stable queue ID; cancellation atomically updates state and then refreshes the Ephemeral list.

- [ ] **Step 6: Run focused, Node-wide and PowerShell regression tests**

Run:

```powershell
node --test .\tests\discord-bridge.test.mjs .\tests\discord-interactions.test.mjs
node --test .\tests\*.test.mjs
$failed = @(); Get-ChildItem .\tests\*.tests.ps1 | ForEach-Object { & pwsh -NoProfile -File $_.FullName; if ($LASTEXITCODE -ne 0) { $failed += $_.Name } }; if ($failed.Count) { throw ($failed -join ', ') }
```

Expected: migrated reply behavior and new Slash queue behavior pass; no existing test fails.

- [ ] **Step 7: Commit**

```powershell
git add discord-bridge-lib.mjs discord-bridge.mjs discord-interactions.mjs tests/discord-bridge.test.mjs tests/discord-interactions.test.mjs
git commit -m "feat: continue Codex tasks from Discord commands"
```

---

### Task 8: Quick and Full System Tests and Notification Title Simplification

**Files:**
- Create: `discord-health-lib.mjs`
- Create: `tests/discord-health.test.mjs`
- Create: `tests/dispatcher-system-test.tests.ps1`
- Modify: `dispatcher.ps1`
- Modify: `discord-interactions.mjs`
- Modify: `tests/discord-interactions.test.mjs`
- Modify: `tests/discord-bot-dispatcher.tests.ps1`

**Interfaces:**
- Produces: `computeEffectivePermissions({ guild, member, roles, channel }) -> bigint`.
- Produces: `runQuickHealthChecks(dependencies) -> Promise<HealthCheck[]>`.
- Produces: `runFullHealthChecks(dependencies) -> Promise<HealthCheck[]>`.
- `HealthCheck`: `{ key, label, ok, latencyMs, detail }`, with sanitized detail.
- Adds dispatcher parameter: `[ValidateSet('', 'task', 'confirmation', 'quota')] [string]$SystemTestEvent = ''`.

- [ ] **Step 1: Write failing permission and quick-check tests**

```javascript
test('quick health check is read-only and verifies send/embed permissions', async () => {
  const writes = [];
  const result = await runQuickHealthChecks(makeHealthDependencies({ writes }));
  assert.equal(result.every((item) => typeof item.ok === 'boolean'), true);
  assert.deepEqual(writes, []);
  assert.equal(result.find((item) => item.key === 'task-channel-permissions').ok, true);
});

test('full check continues after one outbound channel failure', async () => {
  const result = await runFullHealthChecks(makeHealthDependencies({ failKind: 'confirmation' }));
  assert.equal(result.find((item) => item.key === 'task-probe').ok, true);
  assert.equal(result.find((item) => item.key === 'confirmation-probe').ok, false);
  assert.equal(result.find((item) => item.key === 'quota-probe').ok, true);
});
```

- [ ] **Step 2: Write failing PowerShell tests for fixed titles and non-mapped synthetic notifications**

Extend `tests/discord-bot-dispatcher.tests.ps1`:

```powershell
if ([string]$completed.payload.embeds[0].title -ne 'Codex 任务已完成') { throw 'completed title contains task name or separator' }
if ([string]$confirmation.payload.embeds[0].title -ne 'Codex 任务待确认') { throw 'confirmation title contains task name or separator' }
$completedJson = $completed.payload | ConvertTo-Json -Depth 12
if (-not $completedJson.Contains('Discord Bot 测试任务')) { throw 'task name disappeared from completed body' }
$confirmationJson = $confirmation.payload | ConvertTo-Json -Depth 12
if (-not $confirmationJson.Contains('Discord Bot 测试任务')) { throw 'task name disappeared from confirmation body' }
```

In `tests/dispatcher-system-test.tests.ps1`, assert that synthetic notifications never enter the task mapping or quota history:

```powershell
$result = & $dispatcher -MobileOnly -DryRun -SystemTestEvent task | ConvertFrom-Json
if ([string]$result.channelId -ne [string]$config.discordTaskChannelId) { throw 'wrong task test channel' }
if (-not [bool]$result.syntheticTest) { throw 'test payload not marked synthetic' }
if ([bool]$result.saveTaskMapping) { throw 'synthetic test would create a task mapping' }
```

Repeat for `confirmation` and `quota`; assert quota test does not update `quota-state.json`.

- [ ] **Step 3: Run tests and observe missing health module/dispatcher parameter failures**

Run:

```powershell
node --test .\tests\discord-health.test.mjs
pwsh -NoProfile -File .\tests\dispatcher-system-test.tests.ps1
pwsh -NoProfile -File .\tests\discord-bot-dispatcher.tests.ps1
```

Expected: Node import fails, PowerShell rejects `SystemTestEvent`, and the existing dispatcher test fails because notification titles still contain `· <任务名>`.

- [ ] **Step 4: Implement effective Discord permission calculation and quick checks**

Use Guild owner/admin shortcut, combine `@everyone` plus member roles, then apply channel overwrites in Discord order: everyone deny/allow, combined role deny/allow, member deny/allow. Require permission bits View Channel `1<<10`, Send Messages `1<<11`, Embed Links `1<<14`. Quick checks decrypt Token, verify Gateway state, GET the guild/member/roles/three channels, parse index/queue/quota state, probe atomic writes only in a temporary file, and verify rollout watcher offsets or last progress timestamp.

- [ ] **Step 5: Add dispatcher synthetic test path**

When `SystemTestEvent` is set, construct one clearly labeled Embed using the existing `Send-MobileMessage` and configured channel selection. Set `synthetic-test = true` on the in-memory notification. In `Send-MobileMessage`, skip `Save-DiscordTaskMapping` whenever that flag is true. The quota synthetic path calls no snapshot/usage function and never writes `quota-state.json`.

In the normal task routes, set the completion title exactly to `Codex 任务已完成` and the confirmation title exactly to `Codex 任务待确认`. Keep project name, task name, task text and result/confirmation request in the Embed fields/body; only remove the title suffix and `·` separator.

- [ ] **Step 6: Implement full check orchestration and command handler**

Full mode runs quick checks, then spawns PowerShell 7 three times with `-MobileOnly -SystemTestEvent task|confirmation|quota`, measures each call, continues after failure and renders one Ephemeral report. Omitted `/系统测试 类型` maps to `快速`; only `完整` emits the three channel messages.

- [ ] **Step 7: Run focused and full regression suites**

Run:

```powershell
node --test .\tests\discord-health.test.mjs .\tests\discord-interactions.test.mjs
pwsh -NoProfile -File .\tests\dispatcher-system-test.tests.ps1
pwsh -NoProfile -File .\tests\discord-bot-dispatcher.tests.ps1
node --test .\tests\*.test.mjs
$failed = @(); Get-ChildItem .\tests\*.tests.ps1 | ForEach-Object { & pwsh -NoProfile -File $_.FullName; if ($LASTEXITCODE -ne 0) { $failed += $_.Name } }; if ($failed.Count) { throw ($failed -join ', ') }
```

Expected: quick mode has zero outbound calls; full mode has three independent probes; all regressions pass.

- [ ] **Step 8: Commit**

```powershell
git add discord-health-lib.mjs discord-interactions.mjs dispatcher.ps1 tests/discord-health.test.mjs tests/discord-interactions.test.mjs tests/dispatcher-system-test.tests.ps1 tests/discord-bot-dispatcher.tests.ps1
git commit -m "feat: add health checks and simplify task titles"
```

---

### Task 9: Single-Process Integration, Deployment, Live Verification and Documentation

**Files:**
- Modify: `discord-bridge.mjs`
- Modify: `discord-bridge-startup.ps1`
- Modify: `start-discord-bridge.ps1`
- Modify: `install-discord-bridge-task.ps1`
- Modify: `README.md`
- Modify: `tests/discord-bridge-startup.tests.ps1`
- Create runtime, ignored: `discord-task-index.json`

**Interfaces:**
- Consumes: Tasks 2-8 modules and existing `config.json`/DPAPI Token.
- Produces: one scheduled `Codex Discord Bridge` process with notifications, replies, completion fallback, Gateway, commands, task index and queue retry.
- Adds CLI: `node discord-bridge.mjs --register-commands --once` registers and verifies Guild Commands without entering the service loop.

- [ ] **Step 1: Write failing integration/startup tests**

```javascript
test('bridge composition starts registration, index and gateway without disabling existing pollers', async () => {
  const events = [];
  const app = createBridgeApplication(makeBridgeDependencies(events));
  await app.start();
  assert.deepEqual(events.slice(0, 6), [
    'commands-registered','index-ready','task-creation-recovered',
    'project-catalog-ready','gateway-started','legacy-pollers-started',
  ]);
  await app.stop();
});
```

PowerShell startup test asserts the task still launches only `start-discord-bridge.ps1`, contains no Token, and locates Node/Codex dynamically after CC Switch.

- [ ] **Step 2: Run integration tests and observe missing composition failure**

Run:

```powershell
node --test .\tests\discord-bridge.test.mjs
pwsh -NoProfile -File .\tests\discord-bridge-startup.tests.ps1
```

Expected: FAIL because Gateway/command composition is not wired.

- [ ] **Step 3: Refactor `discord-bridge.mjs` into a testable application lifecycle**

Export `createBridgeApplication(dependencies)` and keep `main()` as the thin production adapter. Startup order: validate config/token/task-creation roots, resolve executables, register commands, load/rebuild index and inbox state, recover only stale pre-thread task creations, warm the saved-project catalog, initialize Interaction dependencies, start Gateway, initialize existing rollout state, then enter the existing poll loop. Shutdown stops Gateway, persists index/state, waits active turns with a bounded timeout, and leaves scheduled-task restart behavior unchanged.

- [ ] **Step 4: Add `--register-commands --once` and status timestamps**

The CLI registers commands, fetches them back, verifies the exact 10 names and exits 0 without polling channels or starting Codex. Production runtime records last registration, index update, Gateway event, rollout progress, notification send, task creation and queue retry timestamps for `/系统状态`.

- [ ] **Step 5: Update README with installation, commands and recovery**

Document clone/setup, copy `config.example.json` to ignored `config.json`, DPAPI Token save, private Bot permissions, scheduled-task installation, all 10 commands, saved-project and no-project creation rules, Git worktree lifecycle, quick/full system tests, offline limits, state files and recovery. Do not include personal IDs, absolute user paths, Token or Webhook URLs.

- [ ] **Step 6: Run the entire automated verification suite**

Run:

```powershell
pwsh -NoProfile -File .\tests\repository-hygiene.tests.ps1
$failed = @(); Get-ChildItem .\tests\*.tests.ps1 | ForEach-Object { & pwsh -NoProfile -File $_.FullName; if ($LASTEXITCODE -ne 0) { $failed += $_.Name } }; if ($failed.Count) { throw ($failed -join ', ') }
node --test .\tests\*.test.mjs
node --check .\discord-bridge.mjs
node --check .\discord-interactions.mjs
git diff --check
```

Expected: every PowerShell test exits 0, Node 0 failed, syntax checks and whitespace check pass.

- [ ] **Step 7: Commit, push the feature branch and preserve live config**

```powershell
git add .
git diff --cached --check
git commit -m "feat: add private Discord slash command console"
git push -u origin codex/discord-slash-commands
```

Before deployment, back up only changed live source files to a timestamped directory under `%CODEX_HOME%\mobile-notify-backups\<timestamp>`; do not copy or overwrite live `config.json`, DPAPI Token, logs or state JSON. Update the existing live config structurally, preserving every existing field while adding `discordProjectlessRoot` and `discordWorktreeRoot` only when absent; never replace the file with `config.example.json`.

- [ ] **Step 8: Deploy source files and restart the scheduled bridge**

Copy only tracked runtime source/scripts from the verified repository to `$liveToolDir = Join-Path $env:CODEX_HOME 'mobile-notify'`, run `repair-notify.ps1`, stop and start the `Codex Discord Bridge` scheduled task, and confirm exactly one bridge process is running.

Run:

```powershell
$liveToolDir = Join-Path $env:CODEX_HOME 'mobile-notify'
node (Join-Path $liveToolDir 'discord-bridge.mjs') --register-commands --once
Get-ScheduledTask -TaskName 'Codex Discord Bridge' | Select-Object TaskName,State
```

Expected: command registration verifies 10 names; scheduled task state is Running.

- [ ] **Step 9: Perform live API and behavior verification**

Verify via Discord REST that the 10 Guild Commands exist. Run the internal full health test entry to produce exactly one marked message in each configured channel and confirm none were added to `discord-message-map.json`. Confirm `/系统测试 类型:快速` logic makes no outbound calls through automated tests. Ask the authorized user to invoke `/帮助`, `/任务列表`, `/任务详情`, `/额度`, `/继续任务`, `/继续队列` and `/新建任务` from Discord. For `/新建任务`, smoke-test one safe saved project or the configured no-project directory, verify one sidebar task and one first turn were created, and repeat the same Interaction fixture in the automated test to prove idempotence; inspect only sanitized status/log entries and never copy private command content into logs.

- [ ] **Step 10: Final review and merge recommendation**

Run:

```powershell
git status --short
git log --oneline --decorate -8
git diff main...HEAD --stat
```

Expected: clean working tree, feature branch published, live bridge running, 10 commands registered, no pending automated failures. Present the user with the feature branch and recommend merging `codex/discord-slash-commands` into `main` after their Discord interaction smoke test.
