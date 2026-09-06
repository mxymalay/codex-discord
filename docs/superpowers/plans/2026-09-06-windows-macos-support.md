# Windows and macOS support

Status: merged into `main` through [PR #1](https://github.com/mxymalay/codex-discord/pull/1) on 2026-09-06. Merge commit: `0453c8213e32c1ef642e2c15c3cf98d5f9478310`; final tested head: `0131f333420f952d1fcb681f88b21079ee646bd7`. Their file trees match. Use `main` for installation and updates; `codex/windows-macos-support` is the historical development branch.

Goal: preserve all existing Discord commands and notification behavior while adding native macOS installation, service control, encryption, and desktop connectivity.

Architecture: retain the Node bridge and PowerShell 7 notification dispatcher on both platforms. Keep Windows DPAPI, Task Scheduler and WinForms behavior; provide macOS Keychain, launchd and a native control application through platform-specific adapters. Never replay uncertain task creation or remove worktrees without ownership proof.

## Implementation and acceptance

- [x] Paths: remove Windows-only task creation/index assumptions; test Windows drive/UNC paths, POSIX paths, spaces, Unicode, case-sensitive roots, real Git worktree creation and recovery.
- [x] Runtime: resolve CODEX_HOME and installed executables, use Windows named pipes or macOS user-owned Unix sockets; exercise framed IPC with a real socket fixture and read-only desktop discovery.
- [x] Secrets and notifications: keep Windows DPAPI; add authenticated macOS encryption with Keychain-backed key, preserving pending queues, routing, quota, duplicate suppression and all providers. Verify tampering fails closed.
- [x] Service/control: preserve temporary versus long-term choices; implement launchd ownership, restart, stop and verified desktop process control; generate a native four-action control app.
- [x] Deployment: validate allowlisted source files, stage and hash, back up and roll back on failure; preserve all private state and service preferences. Keep both deployment bundles complete.
- [x] Automated verification: run all Node tests and portable PowerShell suites on macOS; run Windows-specific PowerShell tests in Windows CI. Add a Windows/macOS CI matrix, syntax and repository hygiene checks. `3c08457` was an earlier passing milestone. Final head `0131f33` passed all four PR/push jobs: each macOS job had 567 Node tests, 563 passed, 0 failed, 4 skipped, and 26 PowerShell suites; each Windows job had 567 Node tests, 559 passed, 0 failed, 8 skipped, and 30 PowerShell suites. The [merged main CI](https://github.com/mxymalay/codex-discord/actions/runs/34005447078) also passed both platforms. Subsequent changes must pass the same applicable checks.
- [x] Documentation: document prerequisites, installation, migration limits for DPAPI state, recovery and feature acceptance results. Live Discord messaging and desktop quit require explicit test authorization and credentials; record any untested behavior.

The checked items record implementation and verification within the documented scope, not complete acceptance on both physical systems. The user approved merging with the remaining limits: active macOS desktop takeover, notification completeness during interruptions, deliberate desktop exit, shutdown/reboot and logout/login recovery remain unverified. Network and sleep/wake recovery passed the user's checks, with only a 23-second sleep recorded; two-minute or prolonged sleep was not established. See the [acceptance record](../../ACCEPTANCE.md) for evidence and remaining boundaries.

No source file, CI artifact or commit may contain local configuration, credentials, account-specific paths, conversation state or logs. A passing automated suite is evidence within its scope, not a guarantee of zero defects.
