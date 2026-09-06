# 码驿 · CodexRelay

码驿 · CodexRelay 把 Codex 的任务完成、待确认和周额度通知发送到三个独立的 Discord 频道，并在同一个私有 Bot 中提供 11 个中文 Slash Commands。桥接器只服务配置中的一个 Discord 服务器和一个授权用户；查询结果、按钮回执、Modal 回执和错误信息均为 Ephemeral，且禁用 mentions。

Discord Gateway、Slash Commands、任务索引、新建/继续任务、通知回复补收、继续队列重试和 rollout 完成补发由同一个码驿 · CodexRelay 桥接进程管理，共享桥接状态。Codex 原生通知 hook 是独立通知入口；控制台停止桥接时也会暂停本工具的通知。无需公网地址或第二个命令服务。

Windows/macOS 支持已合入 `main`，首次安装和后续更新都从主分支获取源码。当前 Mac 的活动桌面任务接管仍受接口权限限制；已通过与未完成的项目见 [验收记录](docs/ACCEPTANCE.md)。

公开源码仓库为 [mxymalay/CodexRelay](https://github.com/mxymalay/CodexRelay)，可以直接分享仓库链接。每位使用者使用自己的 Codex 账户和 Discord Bot；公开源码不包含个人配置或凭据。

## 安装

首次安装或把源码交给别人，请从 [中文新手指南：Windows / macOS 完整流程](docs/GETTING-STARTED.md) 开始，包含自己的 Discord Bot 配置、桌面控制台安装和真实通知测试。

两套系统都需要 PowerShell 7、Node.js 24，以及已安装、登录并启动过的 Codex。Mac 另需 Xcode Command Line Tools 来构建原生控制台。

```sh
git clone --branch main https://github.com/mxymalay/CodexRelay.git
cd CodexRelay
```

| 系统 | 首次安装 | Token 存储 | 后台服务与控制台 |
| --- | --- | --- | --- |
| Windows | [Windows 完整步骤](docs/GETTING-STARTED.md#4a-windows-首次安装) | 当前用户 DPAPI | Task Scheduler、原生 EXE 与桌面快捷方式 |
| macOS | [Mac 完整步骤](docs/GETTING-STARTED.md#4b-macos-首次安装) | Keychain 密钥与本地密文文件 | launchd、原生 App 与桌面入口 |

每位使用者配置自己的 Discord Bot、服务器、授权用户及三个频道。新手指南包含 Message Content Intent、邀请权限、六个配置 ID、保存 Token、命令注册、启动和测试的完整顺序。配置写在本机运行目录中；Token、配置及任务状态不随源码分享。

已有旧 Windows 配置的人使用 [Windows → macOS 迁移流程](docs/MACOS.md#从旧-windows-电脑恢复配置和-token)。迁移包只搬运 Bot 配置和加密 Token，不会搬运 Codex 账户、项目或任务历史。

## Slash Commands

- `/任务列表 [状态]`：显示最近 10 个侧边栏主任务，并把正在运行/思考的任务置顶。
- `/任务详情 任务`：按需读取原始任务和最新结果，并支持私密分页；仅当前确实在运行时显示“停止当前运行”。
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
- 无项目：使用 `discordProjectlessRoot`；默认 Windows 为 `%USERPROFILE%\Documents\Codex\Discord Tasks`，macOS 为 `~/Documents/Codex/Discord Tasks`。

工作树计划会在外部文件操作前持久化。若失败发生在 `thread/start` 前，启动恢复只清理能证明属于该操作的工作树和分支；线程一旦可能已经创建，就保留现场而不猜测删除。重复 Interaction ID 返回已持久化结果，不重复创建线程或工作树。

## 通知回复、队列与离线行为

任务完成和待确认消息都支持长按回复任意文本。桥接器只接受授权用户对已映射 Bot 消息的回复，并精确续接那条消息所属的原任务，不新建任务。已知任务频道中的普通独立文本不会被误发给 Codex，Bot 会提示用户长按回复任务消息或使用 `/继续任务`；额度频道回复一律忽略。

通知回复和 `/继续任务` 共用同一套续接逻辑：先把消息转向指定任务；因写入者占用（active-writer）等原因暂时无法转向时，进入持久化队列，并显示“中断当前运行并立即继续 / 取消排队 / 保持排队”三按钮。红色按钮只停止目标任务的当前一轮，不结束任务、不删除任务、也不退出 Codex；只有精确中断失败后才显示“退出整个 Codex 并立即继续”的最终兜底。

续接成功回执带“查看当前运行状态”按钮。点击后实时刷新并显示进行中、待确认或已完成卡片；进行中卡片使用灰色左侧边框，并按“项目名 / 任务名 / 任务”展示。该查询不会中断任务。

当前 Mac 桌面版本拒绝外部桥接访问活动任务的内部控制接口；独立 App Server 创建任务或续接已完成任务的通过结果，不能视作正在运行的桌面任务已可接管。当前限制与回退边界见 [macOS 指南](docs/MACOS.md#当前桌面接口限制)。

`/退出codex` 不会直接结束程序。它先刷新活动主任务并显示风险预览，用户按下二次确认后还会复核清单；出现新活动任务时旧确认失效。Windows 核验 Microsoft Store Codex 桌面进程身份，macOS 核验 Codex 应用签名和进程身份；两者仅处理核验过的桌面进程树。Mac 主动退出及退出后的恢复仍属于未完成的实机验收。

从 Discord `/新建任务` 或 `/继续任务` 发起的工作，会向发起任务的原频道发送该任务的待确认和最终结果；多项任务不会串频道。不会转发 commentary、工具调用或其他“任务进行中”过程信息。Codex 桌面端自己发起的任务仍整理到固定的“任务完成”或“任务待确认”频道，额度变化仍只发额度频道。

桥接服务驻留在本机，Codex 桌面端可以关闭，不会因此让 Bot 下线。电脑仍必须开机、保持当前系统用户已登录、处于唤醒状态并已联网；关机、休眠、注销或 Bot 离线期间不能执行 Slash Commands。Discord 会保留普通频道回复，下一次电脑恢复、登录并联网后，桥接器从持久游标补读；已进入本地队列的内容会在重启后继续恢复。

Codex 原生 `notify` 仍是快速通知通道。桥接器同时监听 rollout 的 `task_complete`，在原生通知未送达时补发，并通过 turn ID 去重。原生 hook 与桥接补发共享投递去重状态；各发送入口会重读通知开关，停止服务后也会暂停独立 hook 的本工具通知。

## Windows / macOS 控制台与四种运行方式

两套系统的桌面入口均为 `码驿 · CodexRelay 控制台`，每两秒刷新桥接服务、登录自启、Discord、Codex 桌面端、继续队列和最后活动状态。Mac 右上角小圈提示刷新，只更新变化的文字，后台轮询时按钮保持可用。桥接服务在后台运行，关闭控制台窗口后仍会运行。四个按钮的含义是：

- `临时开启`：立即运行桥接，但不改变长期自启设置；若长期处于停用，下一次登录不会自动恢复。
- `临时停止`：立即停止桥接并暂停本工具的通知，但不改变长期自启设置；若长期开启，下次登录仍会自动运行并恢复通知。
- `长期开启`：立即运行桥接，并启用当前系统用户登录时自动启动。
- `长期停用`：停止桥接、暂停本工具的通知并禁用登录自启；通知 guard 不会越权重新安装或拉起它。Token、队列和历史状态均保留。

临时操作保留长期自启选择。要重新运行，打开控制台选择对应的开启按钮；要长期停用，使用“长期停用”按钮并确认。日常操作见 [控制台使用说明](docs/GETTING-STARTED.md#5-桌面怎么用怎样确认装好了)，Mac 命令行入口见 [Mac 服务控制](docs/MACOS.md)。

## 兼容标识

产品名和桌面显示名称现为 **码驿 · CodexRelay**、**码驿 · CodexRelay 控制台**。以下内部名称保留，用于识别已有安装、恢复服务和读取原配置与密文；不要手动重命名运行文件或重建 Token。

| 保留内容 | 兼容标识 |
| --- | --- |
| 运行目录与脚本 | `mobile-notify`、`discord-*.mjs`、`discord-*.ps1` 等现有脚本名 |
| Windows 程序与计划任务 | `CodexDiscordControl.exe`、`Codex Discord Bridge` |
| Mac 安装目录内的应用 bundle | `Codex Discord 控制台.app` |
| 凭据与状态 | 现有 DPAPI/Keychain 标识、密文格式、配置键、环境变量及运行状态文件名 |

Mac 桌面的新入口 `码驿 · CodexRelay 控制台.app` 指向运行目录内的 `Codex Discord 控制台.app`；两者不是两套安装。历史设计与实现记录中的旧目录、分支和服务名称保留为历史证据，GitHub 链接已更新到新仓库地址。

## 安全部署、更新与恢复

先从 `main` 获取最新源码，再部署到运行目录。Git 安装和旧功能分支切换步骤见 [更新指南](docs/GETTING-STARTED.md#6-更新与常见恢复)；ZIP 安装先完整解压，不能直接在压缩包中双击启动器。

Windows：在解压后的源码根目录双击 `update-windows.cmd`，或在 PowerShell 7 中运行：

```powershell
.\update-windows.cmd
```

macOS：在源码根目录的终端运行：

```sh
node ./deploy-macos.mjs --source-root "$PWD" \
  --live-root "${CODEX_HOME:-$HOME/.codex}/mobile-notify" --desktop-path "$HOME/Desktop"
```

部署只复制固定白名单，暂存并校验 SHA-256，将被覆盖的旧文件保存在时间戳备份中，再更新运行文件并重建桌面控制台。配置、Token、队列、额度、任务索引、健康状态、日志和其他未知文件会保留。已停止的旧服务在更新后也会暂停本工具通知。

桌面入口或生成的控制台被误删时，重新执行对应平台的部署步骤即可重建。隔离部署验证可使用 Windows 的 `-SkipLiveActions` 或 macOS 的 `--skip-live-actions`；这两个选项均跳过服务启停、命令注册和桌面入口修改。

部署失败会以非零状态退出，已提交的文件自动回滚；输出中的备份目录会保留，可人工恢复。部署不会调用 `/退出codex`，也不会结束 Codex 桌面端。长期停用的用户选择会保留，不会因更新而擅自改成长期开启。

Markdown 标题、字段名和列表结构由 Bot 生成；来自任务或用户的值会先转义、截断并禁用 mentions。`config.json`、Token 密文文件、运行时 JSON、日志、备份、EXE、生成的 App 和快捷方式属于 live 状态或生成物，不进入 Git、不提交到仓库。

## 系统测试

快速检查不向频道发送消息，检查 Token 解密、Gateway、Discord REST、三个频道权限、任务索引、继续队列、临时原子写、额度状态和 rollout 监听。完整检查会产生三条真实且标记清楚的测试通知；它们不写任务消息映射、不创建 Codex 任务，也不修改额度历史。

双系统完整回归测试使用统一入口。它在 Windows 上运行 Windows API 测试，在 macOS 上运行平台适用的 PowerShell 测试和原生服务/控制台验收；两者都运行全部适用的 Node 测试及语法、仓库检查。

```sh
pwsh -NoProfile -File ./tests/run-tests.ps1
```

主分支运行 Windows/macOS CI。实际验证结果、代码基线及剩余实机项目见 [验收记录](docs/ACCEPTANCE.md)；自动测试不替代自己的 Token、频道权限和实际通知验收。

## 状态文件与恢复

- `config.json`：私有 Guild、授权用户、频道和工作目录配置；不含明文 Token。
- `discord-token.dpapi`：仅当前 Windows 用户可解密的 Bot Token。
- `discord-token.keychain`：macOS 本地 Token 密文，加密密钥保存在当前用户的 Keychain 中。
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

在新版控制台点“临时停止”或“长期停用”，会同时停止桥接和暂停本工具的通知；只在系统任务管理工具里结束桥接进程，无法关闭独立通知 hook。若要完全移除通知工具，再把 Codex 配置中的 `notify` 恢复为 `config.json` 的 `previousNotify` 记录。旧 ntfy、Bark、PushPlus 和通用 Webhook 配置仍由 `setup.ps1` 管理，不参与 Slash Command 控制台。
