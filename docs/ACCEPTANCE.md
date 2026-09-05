# 双系统验收记录

基线：从 `main` 的 `d4726be` 创建 `codex/windows-macos-support`。本次保留原来的 Discord/通知业务逻辑，补齐系统适配与配置迁移。自动化测试不会连接真实 Discord 发送消息，也不会主动退出用户正在使用的 Codex。

## 功能覆盖

| 功能 | 验收方法 |
| --- | --- |
| 全部 11 个命令、自动补全、Modal、按钮 | 原有 commands/interactions 回归；逐请求 Guild/用户授权、Ephemeral、禁 mentions |
| 任务列表、详情、搜索 | 索引和详情回归；Windows 路径、POSIX 大小写、历史工作树归属与子任务过滤 |
| 新建任务、Git/非 Git/无项目 | journal、幂等与恢复回归；真实本机 Git 工作树创建、提交前失败清理 |
| 回复续接、继续队列、停止当前回合 | bridge/takeover/router 回归；提交前回退、提交后不确定状态、防止重复发送 |
| 完成、待确认、额度三个通知通道 | PowerShell 路由、来源频道、额度快照、消息映射、去重与长 JSON 测试 |
| rollout 补发、离线补收 | watcher/gateway/inbox 回归；持久游标、失败重试、去重及损坏状态处理 |
| 系统状态和系统测试 | health、dispatcher synthetic tests；快速/完整检查边界 |
| Windows 加密 | 原有 DPAPI 测试，在 Windows 原生 CI 执行 |
| macOS 加密 | 真实临时 Keychain；AES-GCM 往返、跨进程读取、篡改拒绝和密文格式检查 |
| 旧电脑配置迁移 | 密码加密包、错误密码/篡改拒绝、默认不覆盖、两文件提交失败回滚 |
| macOS 四种服务操作 | 真实隔离 launchd + 假桥接进程；自启选择保持、临时/长期切换 |
| 服务故障恢复 | SIGKILL 后 launchd 恢复；旧锁恢复；父进程退出后清理拒绝 TERM 的子进程 |
| 桌面控制台 | 原生编译、应用签名验证、实际进程身份读取、已签名 Codex 桌面状态读取 |
| 退出 Codex 的边界 | 原有 Windows 测试；macOS 受控子进程验证、PID 重用拒绝、孤儿子进程保留与退出等待 |
| 部署和恢复 | 固定白名单、哈希暂存、私有/未知文件保持、失败回滚、符号链接拒绝、服务选择恢复 |
| 原生通知修复 | portable-notify 测试；保留已有通知 wrapper；独立 guard 不控制桥接服务 |
| 仓库交付 | 语法检查、Git diff 检查、配置/Token/运行状态/本机路径扫描 |

## 当前记录

macOS 本机验证使用 Apple Silicon、Node.js 24 和 PowerShell 7.6。基线 Node 测试 400 项中 398 项通过，2 个关联失败来自 Windows 路径假设；新增回归覆盖了这些问题。

本机还实际验证了独立 App Server 的初始化、`project/list`、`thread/list` 与 `model/list`；未创建收费任务、未向 Discord 发测试消息。

本机完整验收已通过：437 项 Node 测试，21 套适用于 macOS 的 PowerShell 测试，Node/PowerShell 语法检查和仓库隐私检查。四套 Windows API 专用测试由 Windows CI 运行。GitHub Actions 结果随交付提交更新。运行方法：

```sh
pwsh -NoProfile -File ./tests/run-tests.ps1
```

## 未完成的真实环境验收

- 当前 Mac 版 Codex 的内部桌面工具接口拒绝外部 Node 进程。Unix socket 实现与失败/排队路径已覆盖，直接接管现有桌面任务尚不具备该版本的真实通过证据；详情见 [macOS 指南](MACOS.md)。
- 旧 Windows 账户已实际导出加密迁移包，本机已成功导入真实配置并将 Token 用 Keychain 重新加密。自动回归使用合成 Token，真实凭据不进入仓库。
- Discord 实际登录、11 个命令的真实交互、三频道消息投递，以及新建/继续任务的实际模型执行，需要导入真实配置后验收。
- 主动退出用户 Codex、关机/休眠/重新登录及网络中断后的真实恢复，需要在目标机器上安排测试。

这些项目没有被标成已通过。自动测试用于降低回归风险，不构成“零 bug”保证。
