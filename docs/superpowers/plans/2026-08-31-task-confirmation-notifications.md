# Task Confirmation Notifications Implementation Plan

历史设计与实现记录：本文属于现名“码驿 · CodexRelay”的项目，保留当时的目录、服务标识、界面名称和示例。当前安装与更新请看[入门指南](../../GETTING-STARTED.md)，更名时保留的兼容标识见 [README](../../../README.md#兼容标识)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Codex turns that still need user action to a dedicated ntfy confirmation topic while preserving final-task and quota topics.

**Architecture:** Add a deterministic classifier that consumes the last user task and last assistant message, then route eligible sidebar-root turns to either completion or confirmation notification rendering. Keep quota processing before task routing so quota events remain independent.

**Tech Stack:** Windows PowerShell 5.1, JSON configuration, ntfy HTTP API, standalone PowerShell regression tests.

**Spec:** `docs/superpowers/specs/2026-08-31-task-confirmation-notifications.md`

## Global Constraints

- Only exact sidebar root tasks may emit task or confirmation notifications.
- Subagents, heartbeats, title generators, malformed metadata, and background turns remain suppressed.
- `endpoint`, `confirmationEndpoint`, and `quotaEndpoint` must remain three distinct routes.
- Quota formatting, acceleration calculations, reset handling, and snapshot state are unchanged.
- Windows PowerShell 5.1 compatibility is mandatory.

---

### Task 1: Classification regression suite

**Files:**
- Create: `tests/task-confirmation-routing.tests.ps1`

**Interfaces:**
- Consumes: dispatcher CLI `dispatcher.ps1 <json> -MobileOnly -DryRun`.
- Produces: regression coverage for `user-task-confirmation-required` versus `user-task-complete`.

- [ ] **Step 1: Write the failing test**

Create fixture cases for explicit confirmation, plan-not-executed, diagnosis-only, post-implementation branch choice, dependency-install authorization, and true final completion. Assert the event name and dry-run endpoint for every case.

- [ ] **Step 2: Run test to verify it fails**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\task-confirmation-routing.tests.ps1`

Expected: confirmation cases incorrectly return `user-task-complete` before implementation.

- [ ] **Step 3: Keep the test isolated**

Copy the dispatcher into a GUID-named temporary Codex root, write root session metadata and a sidebar index, and delete only that verified temporary directory in `finally`.

### Task 2: Classifier and three-way routing

**Files:**
- Modify: `dispatcher.ps1`

**Interfaces:**
- Consumes: `Get-LastUserMessage`, notification `last-assistant-message`, and config `confirmationEndpoint`.
- Produces: `Get-TaskNotificationKind` returning `confirmation` or `complete`; `Invoke-ConfirmationNotifier` emitting `user-task-confirmation-required`.

- [ ] **Step 1: Implement the minimal classifier**

Normalize both messages. First detect explicit requests for confirmation, reply keywords, choice lists, authorization, or missing prerequisites. Then detect an actionable proposal combined with non-execution markers such as `尚未修改`, `只读诊断`, or `目前没有修改`. Default to `complete`.

- [ ] **Step 2: Route confirmation before completion**

After existing root-task eligibility succeeds, call the classifier. Send confirmation messages through `confirmationEndpoint`; otherwise call the existing completion notifier.

- [ ] **Step 3: Run the focused suite**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\task-confirmation-routing.tests.ps1`

Expected: all classification cases pass.

### Task 3: Configuration and documentation

**Files:**
- Modify: `config.json`
- Modify: `setup.ps1`
- Modify: `README.md`

**Interfaces:**
- Consumes: ntfy server inferred from the configured task endpoint.
- Produces: persisted `confirmationEndpoint` and setup output listing all three topics.

- [ ] **Step 1: Add the active confirmation topic**

Generate one random `codex-confirm-<guid>` ntfy URL and persist it as `confirmationEndpoint` without changing current task and quota URLs.

- [ ] **Step 2: Preserve future setup behavior**

When configuring ntfy, create `confirmationEndpoint` if missing and print task, confirmation, and quota subscription URLs.

- [ ] **Step 3: Document the three categories**

Explain classification precedence, topic keys, payload fields, and the fact that quota detection remains independent.

### Task 4: Full verification and live tests

**Files:**
- Test: `tests\*.tests.ps1`
- Verify: `dispatcher.ps1`, `setup.ps1`, `config.json`

**Interfaces:**
- Consumes: all existing standalone test scripts and active dispatcher configuration.
- Produces: PowerShell 5.1 parse evidence, regression results, and one ntfy test message per category.

- [ ] **Step 1: Run every regression suite**

Run each `tests\*.tests.ps1` with Windows PowerShell 5.1 and require exit code `0`.

- [ ] **Step 2: Validate configuration and guard state**

Parse both scripts, confirm the three endpoint topics are distinct, run the notification repair guard, and inspect new log lines for failures.

- [ ] **Step 3: Send live category tests**

Send one completion payload, one confirmation payload, and one quota status payload through the active dispatcher; confirm success log entries without exposing secret topic URLs in logs or message bodies.
