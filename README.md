# Codex Discord 私有命令控制台

这个工具把 Codex 的任务完成、待确认和周额度通知发送到三个独立的 Discord 频道，并在同一个私有 Bot 中提供 11 个中文 Slash Commands。桥接器只服务配置中的一个 Discord 服务器和一个授权用户；查询结果、按钮回执、Modal 回执和错误信息均为 Ephemeral，且禁用 mentions。

所有能力运行在一个 `Codex Discord Bridge` 进程中：Discord Gateway、Slash Commands、任务索引、新建/继续任务、通知回复补收、继续队列重试和 rollout 完成补发共享同一份状态。无需公网地址或第二个命令服务。

## 安装

要求 Windows、PowerShell 7、Node.js，以及可从当前环境启动的 Codex。克隆仓库后，在仓库目录执行：

```powershell
Copy-Item .\config.example.json .\config.json
```

编辑被 Git 忽略的 `config.json`，填入 Discord Application ID、Guild ID、唯一授权用户 ID，以及任务完成、待确认和额度三个频道 ID。不要把 Bot Token、Webhook 地址或个人目录写入受版本控制的文件。

在 Discord Developer Portal 中创建私有应用，并只安装到目标服务器。Bot 至少需要查看三个目标频道、发送消息、嵌入链接和读取消息历史的权限；安装时启用 `bot` 与 `applications.commands` scopes。不要把 Bot 加入无关服务器。

从剪贴板读取 Token，并用当前 Windows 用户的 DPAPI 保存：

```powershell
.\save-discord-token.ps1 -FromClipboard -AllowedUserId <Discord用户ID>
.\activate-discord-bot.ps1
.\install-discord-bridge-task.ps1
```

`config.json` 和 `discord-token.dpapi` 都已被 `.gitignore` 排除。计划任务只启动 `start-discord-bridge.ps1`；guard 每次启动子进程时动态查找 Node 和 Codex，因此 Codex 更新或 CC Switch 切换后不会继续固定旧的可执行文件路径。

首次安装或命令定义变化后，可单独注册并 GET 核验命令。该模式不会启动 Codex、Gateway、频道轮询或任务创建：

```powershell
node .\discord-bridge.mjs --register-commands --once
```

成功输出应确认 11 个 Guild Commands。正常服务由计划任务启动：

```powershell
Get-ScheduledTask -TaskName 'Codex Discord Bridge'
```

## Slash Commands

- `/任务列表 [状态]`：显示最近 10 个侧边栏主任务；仅正在运行/思考的任务显示“停止当前运行”。
- `/任务详情 任务`：按需读取原始任务和最新结果，并支持私密分页。
- `/任务搜索 关键词`：搜索项目、标题、任务正文和结果。
- `/新建任务 项目 [模型] [推理强度]`：从 Codex 已保存项目或“无项目”打开多行任务 Modal；模型与推理强度只在首次创建时选择。
- `/继续任务 任务`：向一个已有侧边栏主任务发送新的多行内容；优先直接转向该任务。
- `/继续队列`：查看统一的通知回复/Slash 继续队列，并取消尚未开始的项。
- `/额度`：只读最后一份本机周额度快照，不伪造刷新。
- `/系统状态`：显示 Gateway、REST、通知、rollout、索引、队列、额度和最近活动时间。
- `/系统测试 [类型]`：`快速`只做本机和 REST 检查；`完整`额外向三个频道各发送一条明确标注的测试通知。
- `/退出codex`：先显示可能中断的桌面主任务，再通过五分钟内有效的一次性二次确认退出 Codex 桌面端。
- `/帮助`：显示命令、隐私和离线限制。

自动补全、命令、按钮和 Modal 每次都会重新校验 Guild 和授权用户。任务详情与继续操作只接受已索引的侧边栏主任务；子智能体、后台回合、心跳和内部任务不会进入索引。

## 新建任务与工作目录

`/新建任务` 只接受 App Server `project/list` 返回的已保存项目 ID 或固定的“无项目”选项，不接受 Discord 中输入的本机路径、Git ref 或 Shell 参数。

- Git 项目：在 `discordWorktreeRoot` 下创建 `codex/discord-...` 分支和隔离工作树。任务创建后保留工作树，以便继续执行。
- 确认不是 Git 工作树的已保存项目：直接使用该项目的保存目录。
- 无项目：使用 `discordProjectlessRoot`，默认可配置为 `%USERPROFILE%\Documents\Codex\Discord Tasks`。

工作树计划会在外部文件操作前持久化。若失败发生在 `thread/start` 前，启动恢复只清理能证明属于该操作的工作树和分支；线程一旦可能已经创建，就保留现场而不猜测删除。重复 Interaction ID 返回已持久化结果，不重复创建线程或工作树。

## 通知回复、队列与离线行为

任务完成和待确认消息都支持长按回复任意文本。桥接器只接受授权用户对已映射 Bot 消息的回复，并精确续接那条消息所属的原任务，不新建任务。已知任务频道中的普通独立文本不会被误发给 Codex，Bot 会提示用户长按回复任务消息或使用 `/继续任务`；额度频道回复一律忽略。

通知回复和 `/继续任务` 共用同一套续接逻辑：先把消息转向指定任务；转向暂不可用时进入持久化队列，并显示“中断当前运行并立即继续 / 取消排队 / 保持排队”三按钮。红色按钮只停止目标任务的当前一轮，不结束任务、不删除任务、也不退出 Codex；只有精确中断失败后才显示“退出整个 Codex 并立即继续”的最终兜底。

续接成功回执带“查看当前运行状态”按钮。点击后实时刷新并显示进行中、待确认或已完成卡片；进行中卡片使用灰色左侧边框，并按“项目名 / 任务名 / 任务”展示。该查询不会中断任务。

`/退出codex` 不会直接结束程序。它先刷新活动主任务并显示风险预览，用户按下二次确认后还会复核清单；出现新活动任务时旧确认失效。退出范围只限于已验证的 Microsoft Store Codex 桌面进程树，不会按名称结束其他 `codex.exe`。

从 Discord `/新建任务` 或 `/继续任务` 发起的工作，其待确认和最终结果发送回发起任务的原频道；多项任务不会串频道。不会转发 commentary、工具调用或其他“任务进行中”过程信息。Codex 桌面端自己发起的任务仍整理到固定的“任务完成”或“任务待确认”频道，额度变化仍只发额度频道。

桥接服务驻留在本机，Codex 桌面端可以关闭，不会因此让 Bot 下线。电脑仍必须开机、保持 Windows 用户已登录、处于唤醒状态并已联网；关机、休眠、注销或 Bot 离线期间不能执行 Slash Commands。Discord 会保留普通频道回复，下一次电脑恢复、登录并联网后，桥接器从持久游标补读；已进入本地队列的内容会在重启后继续恢复。

Codex 原生 `notify` 仍是快速通知通道。桥接器同时监听 rollout 的 `task_complete`，在原生通知未送达时补发，并通过 turn ID 去重。两条旧路径都由单进程集成保留。

## Windows 控制台与四种运行方式

桌面的 `Codex Discord 控制台` 使用仓库 `assets` 中的专用图标，每两秒刷新桥接服务、开机自启、Discord、Codex 桌面端、继续队列和最后活动状态。桥接服务以隐藏窗口方式在后台运行，不会常驻一个终端窗口。四个按钮的含义是：

- `临时开启`：立即运行桥接，但不改变长期自启设置；若长期处于停用，下一次登录不会自动恢复。
- `临时停止`：立即停止桥接，但不改变长期自启设置；若长期开启，下次登录仍会自动运行。
- `长期开启`：立即运行桥接，并启用当前 Windows 用户登录时自动启动。
- `长期停用`：停止桥接并禁用登录自启；通知 guard 不会越权重新安装或拉起它。Token、队列和历史状态均保留。

临时操作只改变“现在是否运行”，不会偷偷改变长期选择。要重新运行，打开控制台选择对应的开启按钮；要长期停用，使用按钮并确认，也可以执行：

```powershell
pwsh -NoProfile -File .\codex-control.ps1 -Action disable-long-term
```

## 安全部署、更新与恢复

在仓库根目录执行下面一条部署命令，可更新受控运行文件、重建 EXE、更新桌面快捷方式和恢复服务。部署只复制固定白名单，先完整暂存并校验 SHA-256，再把将被覆盖的旧文件放入时间戳备份；不会复制或覆盖配置、Token、队列、额度、任务索引、健康状态、日志或其他未知文件。

```powershell
.\deploy.ps1 -SourceRoot (Resolve-Path .).Path -LiveRoot (Join-Path $env:CODEX_HOME 'mobile-notify') -DesktopPath ([Environment]::GetFolderPath('Desktop'))
```

如果只删除了桌面快捷方式或 `CodexDiscordControl.exe`，从仓库再次执行同一条命令即可重建并恢复。若只想验证安全文件部署和 EXE 构建，可向一个隔离目录使用 `-SkipLiveActions`；它不会停止/启动服务、注册 Discord 命令或改桌面快捷方式。

部署失败会以非零状态退出，已提交的文件自动回滚；输出中的备份目录会保留，可人工恢复。部署不会调用 `/退出codex`，也不会结束 Codex 桌面端。长期停用的用户选择会保留，不会因更新而擅自改成长期开启。

Markdown 标题、字段名和列表结构由 Bot 生成；来自任务或用户的值会先转义、截断并禁用 mentions。`config.json`、`discord-token.dpapi`、运行时 JSON、日志、备份、EXE 和快捷方式属于 live 状态或生成物，不进入 Git、不提交到仓库。

## 系统测试

快速检查不向频道发送消息，检查 Token 解密、Gateway、Discord REST、三个频道权限、任务索引、继续队列、临时原子写、额度状态和 rollout 监听。完整检查会产生三条真实且标记清楚的测试通知；它们不写任务消息映射、不创建 Codex 任务，也不修改额度历史。

开发时可运行 focused 测试：

```powershell
node --test .\tests\discord-bridge.test.mjs .\tests\discord-commands.test.mjs .\tests\discord-gateway.test.mjs .\tests\discord-interactions.test.mjs
pwsh -NoProfile -File .\tests\discord-bridge-startup.tests.ps1
```

完整验证：

```powershell
pwsh -NoProfile -File .\tests\repository-hygiene.tests.ps1
$failed = @(); Get-ChildItem .\tests\*.tests.ps1 | ForEach-Object { & pwsh -NoProfile -File $_.FullName; if ($LASTEXITCODE -ne 0) { $failed += $_.Name } }; if ($failed.Count) { throw ($failed -join ', ') }
node --test .\tests\*.test.mjs
node --check .\discord-bridge.mjs
node --check .\discord-interactions.mjs
git diff --check
```

## 状态文件与恢复

- `config.json`：私有 Guild、授权用户、频道和工作目录配置；不含明文 Token。
- `discord-token.dpapi`：仅当前 Windows 用户可解密的 Bot Token。
- `discord-message-map.json`：正式任务通知到 Codex 任务的回复映射。
- `discord-inbox-state.json`：频道游标、Interaction 去重、新建任务 journal 和统一继续队列。
- `discord-task-index.json`：可重建的侧边栏主任务元数据；不保存完整对话。
- `rollout-watcher-state.json`：rollout 文件偏移、活动回合和待补发通知。
- `task-delivery-state.json`：原生通知与补发通知的 turn 去重状态。
- `quota-state.json`：`/额度` 只读的最后已知额度快照。
- `discord-bridge.log`：脱敏的组件类别和短 ID，不记录 Token 或完整用户输入。
- `discord-bridge-runtime.json`、`discord-bridge-health.json`：当前 supervisor 身份和脱敏健康快照；可重建，不提交。

索引丢失或损坏时从 `sessions` 与侧边栏索引重建。继续队列和任务创建 journal 不会根据不完整数据猜测重放外部操作。Token、配置、日志和运行时 JSON 不应提交、发布或用示例文件覆盖。

## 停用与回滚

先停止或禁用 `Codex Discord Bridge` 计划任务。若要完全移除通知工具，再把 Codex 配置中的 `notify` 恢复为 `config.json` 的 `previousNotify` 记录。旧 ntfy、Bark、PushPlus 和通用 Webhook 配置仍由 `setup.ps1` 管理，不参与 Slash Command 控制台。
