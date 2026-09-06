# Discord Bot 双向 Codex 桥接设计

历史设计与实现记录：本文属于现名“码驿 · CodexRelay”的项目，保留当时的目录、服务标识、界面名称和示例。当前安装与更新请看[入门指南](../../GETTING-STARTED.md)，更名时保留的兼容标识见 [README](../../../README.md#兼容标识)。

## 目标

把现有三条 Discord Incoming Webhook 替换为一个私有 Discord Bot。Bot 继续向“任务完成”“任务待确认”“额度变化”三个频道发送富文本通知，并允许唯一授权用户通过回复具体任务通知，向原 Codex 主任务追加任意中文或英文文本。

## 已确认约束

- 只通知 Codex 侧边栏中的根任务；子智能体、后台回合、心跳和内部英文提示继续由现有分发器过滤。
- 任务完成、任务待确认和额度变化仍是三个独立频道。
- 回复内容不使用固定命令表；只要是授权用户对已映射任务通知的文字回复，就原样转交原任务。
- 额度频道不接受 Codex 任务回复。
- 不通过聊天、配置文件、日志或命令行参数保存明文 Bot Token。
- 电脑关机时不执行；下一次 Windows 登录后补收未处理回复。
- 新链路完成实测前保留旧 Webhook 地址用于回滚；通过后从活动配置移除，再由用户确认是否在 Discord 服务器端删除。

## 架构

### 出站通知

`dispatcher.ps1` 保留现有事件分类、主任务过滤、任务文案和额度算法。Discord provider 改为 `discord-bot`，使用 Bot Token 调用 Discord REST `POST /channels/{channelId}/messages`。任务通知成功后，把 Discord 消息 ID 与 Codex `thread-id`、`turn-id`、`cwd`、事件类型和频道 ID 写入 `discord-message-map.json`。

### 入站回复

新增常驻 Node.js 进程 `discord-bridge.mjs`。它定期读取任务完成与任务待确认频道中新消息，按 Snowflake ID 递增处理。只有同时满足以下条件的消息才会转交：

1. `guild_id` 等于配置服务器；
2. `channel_id` 属于两个任务频道之一；
3. `author.id` 等于授权用户；
4. 消息引用的 `message_id` 存在于任务映射；
5. 文字正文非空；
6. Discord 消息 ID 尚未成功投递。

普通独立消息、Bot 自己的消息、其他成员消息、额度频道回复和找不到映射的旧通知全部忽略。

### Codex 续接

桥接进程为每条已接受回复启动本机 `codex app-server`，完成 `initialize`/`initialized` 握手，调用 `thread/resume` 恢复映射中的根任务，再调用 `turn/start` 把 Discord 正文作为新的用户文本。进程保持到对应 turn 完成或明确失败，Codex 原有通知 Hook 会继续负责后续完成/待确认通知。

### 凭据

`discord-token.dpapi` 只保存 Windows DPAPI 加密串。`save-discord-token.ps1` 从剪贴板读取一次 Token、验证格式并加密；`get-discord-token.ps1` 只向调用进程的标准输出返回解密值。所有日志只记录是否配置，不记录 Token、Authorization Header 或旧 Webhook URL。

### 状态文件

- `discord-message-map.json`：通知消息 ID 到 Codex 根任务的映射，使用互斥锁和临时文件原子替换，保留最近 5,000 条或 90 天。
- `discord-inbox-state.json`：两个任务频道的最后扫描 Snowflake 和已成功投递消息 ID；首次启动以当时最新消息建立基线，后续启动补收基线之后的回复。
- `discord-bridge.log`：只写事件 ID、任务 ID 后八位、状态和经过清洗的错误类型。

## Discord 配置

- 应用 ID：`111111111111111111`。
- 服务器 ID：`222222222222222222`。
- 任务完成频道：`444444444444444444`。
- 任务待确认频道：`555555555555555555`。
- 额度变化频道：`666666666666666666`。
- Bot 为私有，默认安装链接为 `None`。
- 权限仅为 View Channels、Send Messages、Embed Links、Read Message History。
- Message Content Intent 已启用。

授权用户 ID 在本地保存 Token 后，通过 Discord `GET /oauth2/applications/@me` 的应用所有者字段自动发现，不要求用户在聊天中发送。

## 错误处理

- Discord 429：遵守 `retry_after`，不丢失扫描游标。
- Discord 401/403：停止出站或入站操作，写入脱敏日志并保持旧通知 Hook 不影响 Codex 任务。
- App Server 无法恢复任务：不创建新任务，向原 Discord 回复发送失败提示。
- `turn/start` 已接受后才把 Discord 消息标记为成功投递。
- 同一 Discord 消息重复出现时只处理一次。
- 映射文件损坏时保存带时间戳的只读备份并从空状态启动，不把损坏内容覆盖进配置。

## 开机运行

新增 `start-discord-bridge.ps1`，定位当前 Node 和 Codex 可执行文件，以隐藏窗口启动桥接。Windows 计划任务 `Codex Discord Bridge` 在用户登录时启动；现有 `watch-notify.ps1` 继续修复 Codex notify Hook，并检查桥接进程是否存在。

## 验收标准

1. 三类 Bot 测试通知分别到达正确频道，Embed 颜色和项目名、任务名、任务、结果字段正确。
2. Discord 消息由 Bot 账号而不是 Incoming Webhook 发送。
3. 回复任务待确认通知的任意文本能出现在原 Codex 任务并启动新一轮。
4. 回复任务完成通知可以重新检查或继续任务。
5. 独立消息、其他用户消息、额度频道回复、子智能体完成都不触发原任务。
6. 桥接重启后不重复执行旧回复，并能补收停机期间的新回复。
7. 全部自动化测试通过，日志与配置中没有明文 Token。
