# Windows and macOS support

Goal: preserve all existing Discord commands and notification behavior while adding native macOS installation, service control, encryption, and desktop connectivity.

Architecture: retain the Node bridge and PowerShell 7 notification dispatcher on both platforms. Keep Windows DPAPI, Task Scheduler and WinForms behavior; provide macOS Keychain, launchd and a native control application through platform-specific adapters. Never replay uncertain task creation or remove worktrees without ownership proof.

## Implementation and acceptance

- [x] Paths: remove Windows-only task creation/index assumptions; test Windows drive/UNC paths, POSIX paths, spaces, Unicode, case-sensitive roots, real Git worktree creation and recovery.
- [x] Runtime: resolve CODEX_HOME and installed executables, use Windows named pipes or macOS user-owned Unix sockets; exercise framed IPC with a real socket fixture and read-only desktop discovery.
- [x] Secrets and notifications: keep Windows DPAPI; add authenticated macOS encryption with Keychain-backed key, preserving pending queues, routing, quota, duplicate suppression and all providers. Verify tampering fails closed.
- [x] Service/control: preserve temporary versus long-term choices; implement launchd ownership, restart, stop and verified desktop process control; generate a native four-action control app.
- [x] Deployment: validate allowlisted source files, stage and hash, back up and roll back on failure; preserve all private state and service preferences. Keep both deployment bundles complete.
- [ ] Verification: run all Node tests and portable PowerShell suites on macOS; run Windows-specific PowerShell tests in Windows CI. Add a Windows/macOS CI matrix, syntax and repository hygiene checks.
- [x] Documentation: document prerequisites, installation, migration limits for DPAPI state, recovery and feature acceptance results. Live Discord messaging and desktop quit require explicit test authorization and credentials; record any untested behavior.

No source file, CI artifact or commit may contain local configuration, credentials, account-specific paths, conversation state or logs. A passing automated suite is evidence within its scope, not a guarantee of zero defects.
