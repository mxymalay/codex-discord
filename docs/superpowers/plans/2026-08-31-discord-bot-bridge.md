# Discord Bot 双向 Codex 桥接 Implementation Plan

历史设计与实现记录：本文属于现名“码驿 · CodexRelay”的项目，保留当时的目录、服务标识、界面名称和示例。当前安装与更新请看[入门指南](../../GETTING-STARTED.md)，更名时保留的兼容标识见 [README](../../../README.md#兼容标识)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一个私有 Discord Bot 替换三条 Incoming Webhook，并把授权用户对任务通知的自由文字回复续接到原 Codex 根任务。

**Architecture:** 现有 PowerShell 分发器继续负责分类与额度计算，改用 Discord Bot REST 发送并保存消息映射；独立 Node.js 常驻进程轮询两个任务频道，通过 Codex App Server 恢复原任务。Bot Token 使用 Windows DPAPI 加密。

**Tech Stack:** PowerShell 7.6、Node.js 24 内置 `fetch`/`node:test`/`child_process`、Discord API v10、Codex App Server JSON-RPC、Windows Task Scheduler。

**Spec:** `docs/superpowers/specs/2026-08-31-discord-bot-bridge.md`

## Global Constraints

- 不在配置、日志、测试输出或命令行参数中出现真实 Bot Token。
- 只处理侧边栏根任务；不得削弱现有子智能体与内部回合过滤。
- 任务完成、任务待确认、额度变化使用三个固定频道。
- 只有授权用户对已映射任务通知的非空文字回复才可启动 Codex。
- App Server 恢复失败时不得创建新任务。
- 每个新行为先写失败测试并观察预期失败，再写最小实现。

---

### Task 1: DPAPI 凭据和 Bot 配置迁移

**Files:**
- Create: `discord-secret.ps1`
- Create: `save-discord-token.ps1`
- Create: `tests/discord-secret.tests.ps1`
- Modify: `config.json`

**Interfaces:**
- Produces: `Protect-DiscordBotToken([string]$Token,[string]$Path)` 和 `Unprotect-DiscordBotToken([string]$Path) -> string`。
- Produces config keys: `discordApplicationId`, `discordGuildId`, `discordAllowedUserId`, `discordTaskChannelId`, `discordConfirmationChannelId`, `discordQuotaChannelId`, `discordTokenPath`。

- [ ] **Step 1: 写 DPAPI 往返与脱敏失败测试**

```powershell
. $secretModule
Protect-DiscordBotToken -Token 'test.token.value' -Path $secretPath
$plain = Unprotect-DiscordBotToken -Path $secretPath
if ($plain -ne 'test.token.value') { throw 'DPAPI round trip failed' }
if ((Get-Content -Raw $secretPath) -match 'test\.token\.value') { throw 'plaintext leaked' }
```

- [ ] **Step 2: 运行测试并确认因函数不存在而失败**

Run: `pwsh -NoProfile -File .\tests\discord-secret.tests.ps1`

Expected: FAIL，错误包含 `Protect-DiscordBotToken is not recognized`。

- [ ] **Step 3: 实现 DPAPI 模块和剪贴板保存脚本**

```powershell
function Protect-DiscordBotToken {
    param([string]$Token,[string]$Path)
    $secure = ConvertTo-SecureString -String $Token -AsPlainText -Force
    $cipher = ConvertFrom-SecureString -SecureString $secure
    [System.IO.File]::WriteAllText($Path, $cipher, [Text.UTF8Encoding]::new($false))
}
```

保存脚本验证 Discord Token 形状、调用 Discord 应用端点发现应用所有者、从三条旧 Webhook 只读解析频道 ID，写入新配置但不输出任何 URL 或 Token。

- [ ] **Step 4: 运行测试并确认通过**

Run: `pwsh -NoProfile -File .\tests\discord-secret.tests.ps1`

Expected: `PASS: Discord token DPAPI storage`。

### Task 2: Bot REST 出站和任务消息映射

**Files:**
- Create: `discord-state.ps1`
- Create: `tests/discord-bot-dispatcher.tests.ps1`
- Modify: `dispatcher.ps1`

**Interfaces:**
- Consumes: `Unprotect-DiscordBotToken` 和三个频道 ID。
- Produces: `New-DiscordBotPayload`、`Send-DiscordBotMessage`、`Save-DiscordTaskMapping`。
- Produces: `discord-message-map.json`。

- [ ] **Step 1: 写 `discord-bot` DryRun 路由失败测试**

```powershell
$result = & $dispatcher $notificationJson -MobileOnly -DryRun | ConvertFrom-Json
if ($result.provider -ne 'discord-bot') { throw 'wrong provider' }
if ($result.channelId -ne $taskChannelId) { throw 'wrong task channel' }
if (@($result.payload.allowed_mentions.parse).Count -ne 0) { throw 'mentions enabled' }
```

覆盖完成绿色、待确认橙色、额度蓝色以及三个不同频道。

- [ ] **Step 2: 运行测试并确认 provider 不受支持而失败**

Run: `pwsh -NoProfile -File .\tests\discord-bot-dispatcher.tests.ps1`

Expected: FAIL，错误指出 `discord-bot` 未实现或 channelId 缺失。

- [ ] **Step 3: 实现 Bot REST 发送和原子映射保存**

```powershell
$headers = @{ Authorization = "Bot $botToken" }
$uri = "https://discord.com/api/v10/channels/$channelId/messages"
$response = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers `
    -ContentType 'application/json; charset=utf-8' -Body $bytes
Save-DiscordTaskMapping -MessageId $response.id -ThreadId $threadId -Cwd $cwd
```

`DryRun` 只输出 channelId 和 payload。正式发送不记录 Authorization Header；额度消息不写任务映射。

- [ ] **Step 4: 运行新测试与原有全部 PowerShell 测试**

Run: `Get-ChildItem .\tests\*.tests.ps1 | ForEach-Object { pwsh -NoProfile -File $_.FullName }`

Expected: 每个测试脚本输出 PASS，退出码均为 0。

### Task 3: 自由回复桥接和 Codex App Server 客户端

**Files:**
- Create: `discord-bridge-lib.mjs`
- Create: `discord-bridge.mjs`
- Create: `tests/discord-bridge.test.mjs`
- Create: `get-discord-token.ps1`

**Interfaces:**
- Consumes: `config.json`、`discord-message-map.json`、DPAPI Token。
- Produces: `isEligibleReply(message,config,map) -> boolean`。
- Produces: `resumeCodexThread({threadId,cwd,text,codexPath}) -> Promise<{turnId}>`。
- Produces: `discord-inbox-state.json` 和脱敏确认消息。

- [ ] **Step 1: 写自由回复路由失败测试**

```javascript
test('accepts arbitrary text only when replying to a mapped task message', () => {
  const result = classifyReply(replyMessage, config, mapping);
  assert.equal(result.accepted, true);
  assert.equal(result.text, '可以，但先备份，只做前两项。');
});
```

同时覆盖非授权用户、独立消息、额度频道、空文字、重复消息和未知引用全部拒绝。

- [ ] **Step 2: 运行 Node 测试并确认模块不存在而失败**

Run: `node --test .\tests\discord-bridge.test.mjs`

Expected: FAIL，错误为无法导入 `discord-bridge-lib.mjs`。

- [ ] **Step 3: 实现纯函数、REST 轮询、游标和去重**

```javascript
const response = await fetch(`${apiBase}/channels/${channelId}/messages?after=${cursor}&limit=100`, {
  headers: { Authorization: `Bot ${token}` },
});
const messages = (await response.json()).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
```

首次运行把两个任务频道最新消息设为基线；后续只处理更大的 Snowflake。遇到 429 使用响应中的 `retry_after`。

- [ ] **Step 4: 实现 App Server JSON-RPC 续接**

```javascript
send({method:'initialize',id:1,params:{clientInfo:{name:'codex-discord-bridge',version:'1.0.0'}}});
send({method:'initialized',params:{}});
send({method:'thread/resume',id:2,params:{threadId}});
send({method:'turn/start',id:3,params:{threadId,input:[{type:'text',text}]}});
```

等待 `turn/start` 返回成功后标记 Discord 消息已投递；保持子进程直到 turn 完成或超时。恢复失败时通过 Bot API 回复失败原因，不创建新任务。

- [ ] **Step 5: 运行 Node 测试并确认通过**

Run: `node --test .\tests\discord-bridge.test.mjs`

Expected: 所有测试 PASS，0 failed。

### Task 4: 开机自启、守护和离线补收

**Files:**
- Create: `start-discord-bridge.ps1`
- Create: `install-discord-bridge-task.ps1`
- Create: `tests/discord-bridge-startup.tests.ps1`
- Modify: `watch-notify.ps1`

**Interfaces:**
- Produces: 单实例桥接进程和计划任务 `Codex Discord Bridge`。
- Consumes: `discord-inbox-state.json` 游标。

- [ ] **Step 1: 写单实例与计划任务参数失败测试**

```powershell
$command = Get-BridgeTaskCommand -ToolDir $toolDir -NodePath $nodePath
if ($command -notmatch 'start-discord-bridge\.ps1') { throw 'wrong task command' }
if ($command -match 'discord-token|Bot\s+') { throw 'secret in task command' }
```

- [ ] **Step 2: 运行测试并确认函数不存在而失败**

Run: `pwsh -NoProfile -File .\tests\discord-bridge-startup.tests.ps1`

Expected: FAIL，错误指出启动函数不存在。

- [ ] **Step 3: 实现隐藏启动、互斥锁和登录计划任务**

启动脚本使用命名 Mutex `Local\CodexDiscordBridge`；任务操作只包含 PowerShell 脚本路径，不包含 Token。`watch-notify.ps1` 发现进程退出时重新启动。

- [ ] **Step 4: 运行启动测试并检查计划任务定义**

Run: `pwsh -NoProfile -File .\tests\discord-bridge-startup.tests.ps1`

Expected: PASS，计划任务命令中无秘密。

### Task 5: 迁移、实测和文档

**Files:**
- Modify: `README.md`
- Modify: `config.json`
- Preserve temporarily: three legacy Discord Webhook URLs for rollback until live verification succeeds

**Interfaces:**
- Consumes: 用户已复制的 Bot Token、已安装私有 Bot 和现有三个频道。
- Produces: 活动 provider `discord-bot`、运行中的桥接计划任务和三条真实测试通知。

- [ ] **Step 1: 从剪贴板加密保存 Token并自动发现授权用户**

Run: `pwsh -NoProfile -File .\save-discord-token.ps1 -FromClipboard`

Expected: 只输出 `Bot Token 已加密保存` 和已发现 ID 的末四位，不输出 Token。

- [ ] **Step 2: 运行全量自动化验证**

Run: `Get-ChildItem .\tests\*.tests.ps1 | ForEach-Object { pwsh -NoProfile -File $_.FullName }; node --test .\tests\*.test.mjs`

Expected: 所有脚本退出码 0，Node 0 failed。

- [ ] **Step 3: 发送三类真实 Bot 测试通知**

分别触发 `user-task-complete`、`user-task-confirmation-required` 和 `quota-status`，人工确认发送者为 `Codex Bridge` 且频道、颜色、字段正确。

- [ ] **Step 4: 进行双向回复实测**

在任务待确认测试通知上回复唯一测试文字，确认桥接日志显示 `turn/start accepted`，原 Codex 任务出现同一文字，且再次产生正确通知。

- [ ] **Step 5: 安装并验证登录计划任务**

Run: `pwsh -NoProfile -File .\install-discord-bridge-task.ps1`

Expected: 计划任务 Ready，桥接进程运行，Token 不出现在任务参数或日志。

- [ ] **Step 6: 更新 README 并停用活动 Webhook 配置**

README 只说明 Bot 方案。活动配置清空 `endpoint`、`confirmationEndpoint`、`quotaEndpoint`；旧 URL 在用户确认服务器端删除前保存在 `legacyDiscordWebhooks`，不得再用于发送。
