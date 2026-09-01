# Codex 任务、确认与额度通知

这个工具接收 Codex 的 `agent-turn-complete` 事件，只为侧边栏主任务发送通知。子智能体、内部后台回合、自动标题、环境检查和中间过程不会发送。通知分成三个并列的 Discord 频道：

- **任务完成**：主任务真正结束，绿色 Embed。
- **任务待确认**：Codex 在等待方案选择、授权或下一步决定，橙色 Embed。
- **额度变化**：周额度增加、减少与使用速度，蓝色 Embed。

每条任务通知分别显示项目名、任务名、任务和结果，并禁用 `@everyone` 等自动提及。

## Discord 双向回复

任务完成和任务待确认频道使用 Discord Bot 发送。直接“回复”某一条 Bot 通知即可自由输入，例如：

```text
再检查一次，重点验证 Windows 7。
可以，但先备份，只执行前两项。
结果可以，继续补一组回归测试。
```

桥接器只接受配置中指定的服务器、两个任务频道和唯一授权用户，并要求回复一条已映射的 Bot 通知。它会把文本续接到原 Codex 任务，不会另建任务。额度频道的回复一律忽略。

如果原任务正在 Codex 桌面端打开，回复会进入本机队列；任务释放后每 30 秒自动重试，无需再发第二条。电脑关机时 Discord 会保存消息，下一次登录后补读。

## Bot 配置与启动

Bot Token 只从剪贴板读取，并使用当前 Windows 用户的 DPAPI 加密保存；不要把 Token 写进聊天、Discord 消息或普通配置文件。

```powershell
# 首次配置或重置 Token 后重新保存；把 <你的Discord用户ID> 换成数字 ID
.\save-discord-token.ps1 -FromClipboard -AllowedUserId <你的Discord用户ID>

# 激活 Bot 三路通知
.\activate-discord-bot.ps1

# 安装并立即启动登录计划任务
.\install-discord-bridge-task.ps1
```

查看后台状态：

```powershell
Get-ScheduledTask -TaskName 'Codex Discord Bridge'
```

计划任务直接运行桥接进程；Task Scheduler 和现有通知守护器都会在异常退出后重新拉起。桥接器每次启动还会重新查找当前安装的 `codex.exe`，因此 Codex 更新或 CC Switch 切换后不依赖旧的版本目录。

## 漏发保护与去重

Codex 原生 `notify` 仍作为快速通道使用。桥接器同时增量监听本机 rollout 中的 `task_complete` 事件：原生通知没有在 6 秒内送达时自动补发；已经送达的回合按任务回合 ID 去重，不会重复通知。长结果通过 UTF-8 临时文件交给发送器，不受 Windows 命令行长度限制。

监听游标、当前未完成回合和待重试通知都会持久化。Codex、CC Switch 或守护进程重启后会从上次位置继续；首次启用只基线既有完成记录，不会把历史任务重新发送。

## 判定规则

任务确认优先于“已完成部分工作”：明确要求确认、选择或回复；只完成诊断并提供尚未执行的方案；实现完成但仍要求选择合并、推送或保留分支；缺少依赖并等待安装授权，都会进入任务待确认。除首句明确以“已完成、已修复、已实现”等完成语开头外，最终一句以问号结尾也会进入任务待确认。

修改、构建、测试或交付已经完成，且不再等待用户动作时，才进入任务完成。

## 额度提醒

额度变化独立发送。工具比较 Codex 本机保存的官方用量快照，只要剩余百分比增加或降低就通知，并显示：

```text
额度：92% → 91%
距上次变化：1小时12分钟
本次使用速度：比上次更快
距下次更新还有：4天18小时
按当前速度连续使用：约2天6小时后用完
按重置至今平均速度：约4天1小时后用完
```

首次运行只建立基线。Codex 空闲时本机不会产生新快照，所以关机或未使用期间发生的恢复，会在下一次 Codex 刷新用量后提醒。

## 文件与日志

- `config.json`：频道 ID、授权用户 ID、开关和旧 Webhook 回滚信息；不含明文 Bot Token。
- `discord-token.dpapi`：仅当前 Windows 用户可解密的 Bot Token。
- `discord-message-map.json`：Discord 通知到 Codex 任务的映射。
- `discord-inbox-state.json`：补读游标、已处理回复和待重试队列。
- `rollout-watcher-state.json`：任务完成监听游标、当前回合和待补发队列。
- `task-delivery-state.json`：已成功发送的任务回合 ID，用于原生通知与补发通知去重。
- `mobile-notify.log`：通知发送日志。
- `discord-bridge.log`：双向桥接日志，不记录 Token 和完整用户回复。

推送或桥接失败只写日志，不会使 Codex 主任务失败。

## 旧通道与回滚

旧 Discord Webhook 保存在 `config.json` 的 `legacyDiscordWebhooks` 中，但不会作为当前发送通道。旧 ntfy、Bark、PushPlus 和通用 Webhook 配置仍可通过 `setup.ps1` 使用。

需要完全移除此工具时，把 `$env:USERPROFILE\.codex\config.toml` 中的 `notify` 改回 `config.json` 里 `previousNotify` 所列的命令，并停用 `Codex Discord Bridge` 计划任务。
