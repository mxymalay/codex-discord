# 码驿 · CodexRelay 从零安装：Windows 与 macOS

两套系统都有桌面的 **码驿 · CodexRelay 控制台**：Windows 是原生 EXE 和快捷方式，macOS 是原生 `.app` 和桌面入口。安装完成后可以直接点按钮管理服务，不必一直开着终端。本指南适合收到代码后首次安装的人；已有旧电脑配置的人先看末尾的迁移说明。

每位使用者准备自己的 Codex 账户、Discord Bot、服务器和 Token。分享源码或仓库链接即可；不要打包正在运行的 `mobile-notify` 目录，其中包含私有配置、密文 Token 和任务状态。

更名只更新产品和桌面显示名称；已有运行目录、程序和服务标识继续兼容，详见 [README 的兼容说明](../README.md#兼容标识)。

## 1. 准备环境和源码

安装并登录 Codex 桌面端，至少启动过一次，让本机生成 Codex 配置和会话目录。再安装：

- [Node.js 24 LTS](https://nodejs.org/en/download)。
- PowerShell 7：[Windows 安装说明](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows)、[macOS 安装说明](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-macos)。Windows 后续命令要在 **PowerShell 7** 中执行。
- Git，用于获取源码、更新和创建 Git 项目任务。Mac 还需要 Xcode Command Line Tools：执行 `xcode-select --install`，完成系统安装后用 `xcode-select -p` 确认。

重新打开终端，确认 `node --version` 为 `v24.x`、`pwsh --version` 为 `7.x`，并且 `git --version` 可执行。Windows 原生控制台通过系统的 .NET Framework C# 编译器构建，Mac 通过 `xcrun clang` 构建。

Windows/macOS 支持已合入 `main`，新安装和更新都使用主分支。把源码放在普通工作目录，例如“文稿/项目”，不要放在桌面或下面的运行目录内：

```sh
git clone --branch main https://github.com/mxymalay/CodexRelay.git
cd CodexRelay
```

也可在[主分支页面](https://github.com/mxymalay/CodexRelay/tree/main)选择 **Code → Download ZIP** 并完整解压，然后在解压后的仓库根目录打开终端。GitHub ZIP 解压后的源码文件夹通常叫 `CodexRelay-main`；分享的源码包可能叫 `CodexRelay`，以包含 `README.md` 和安装脚本的文件夹为准。仓库已公开，可直接分享链接或仅含源码的压缩包；每位使用者仍需配置自己的 Bot 和凭据。仓库不需要额外执行 `npm install`。

默认 Codex 数据目录为 Windows 的 `%USERPROFILE%\.codex`、Mac 的 `~/.codex`；运行目录是其中的 `mobile-notify`。已有自定义 `CODEX_HOME` 的人沿用它，且必须是绝对路径；不要为安装本工具另建一个与 Codex 实际使用位置不同的数据目录。

## 2. 创建自己的 Discord Bot

1. 准备一个自己管理的 Discord 服务器，新建三个不同的**普通文字频道**，例如“任务完成”“任务待确认”“额度通知”。频道消息会包含任务内容，请只让预期接收者和 Bot 看见。
2. 打开 [Discord Developer Portal](https://discord.com/developers/applications)，选择 **New Application**。在 **General Information** 记录 **Application ID**；在 **Bot → Reset Token** 取得 **Bot Token**，保存在密码管理器中。这里需要 Bot Token，不能用账户 Token、Client Secret 或 Public Key。[Discord 官方创建步骤](https://docs.discord.com/developers/quick-start/getting-started)
3. 在 **Bot → Privileged Gateway Intents** 开启 **Message Content Intent**，用于读取你对通知的文字回复。Presence 和 Server Members 不需要开启。Message Content 限制也作用于 REST；本项目通过 REST 补读回复，即使 Slash Commands 正常，也不能据此判断回复内容权限已就绪。[Discord 官方 Intent 说明](https://docs.discord.com/developers/events/gateway#http-restrictions)
4. 在 **Installation** 启用 **Guild Install**。本工具使用服务器内命令。在 Bot 页面关闭 **Public Bot** 可限制为只有自己能邀请；保持 **Requires OAuth2 Code Grant** 关闭。使用下面的邀请地址，把 `APPLICATION_ID` 替换成刚才的 Application ID，在浏览器打开，选择自己的目标服务器并授权。安装账户需有管理服务器权限。[Discord 官方 Bot 授权流程](https://docs.discord.com/developers/topics/oauth2#bot-authorization-flow)

```text
https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&scope=bot%20applications.commands&permissions=84992&integration_type=0
```

这里使用 `bot` 和 `applications.commands` scopes。`84992` 对应 **View Channels、Send Messages、Embed Links、Read Message History**；不用 Administrator。检查三个频道的权限覆盖，确保 Bot 在每个频道实际拥有这四项权限，自己能使用应用命令和回复消息。[Discord 官方权限表](https://docs.discord.com/developers/topics/permissions#bitwise-permission-flags)

本项目通过 Gateway 接收交互，**Interactions Endpoint URL 留空**即可，无需公网服务器、ngrok 或 Webhook URL。

## 3. 收集六个 ID

Discord 用户设置 → **Advanced / 高级 → Developer Mode / 开发者模式**。右键自己的用户、服务器图标或频道，分别复制对应的 ID；这些是数字字符串，不是用户名、频道名或邀请链接。[Discord 官方 ID 获取说明](https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID)

稍后在运行目录的 `config.json` 填写以下六项，保留 JSON 的双引号。三个频道必须属于同一个服务器且互不相同。

| 配置字段 | 填什么 |
| --- | --- |
| `discordApplicationId` | Developer Portal 的 Application ID |
| `discordGuildId` | 目标服务器 ID |
| `discordAllowedUserId` | 唯一获准操作 Bot 的你自己的用户 ID |
| `discordTaskChannelId` | “任务完成”频道 ID |
| `discordConfirmationChannelId` | “任务待确认”频道 ID |
| `discordQuotaChannelId` | “额度通知”频道 ID |

示例里重复的 `111…` 到 `666…` 全是占位值，必须全部替换。新装只需这六个 ID，不需要旧 Webhook。只编辑运行目录的私有 `config.json`，不要改受版本控制的示例文件，也不要把 Token 写进 JSON。

## 4A. Windows 首次安装

在**源码仓库根目录的同一个 PowerShell 7 窗口**执行。此步骤先复制运行文件并构建控制台，不联网注册、不启动服务：

```powershell
$src = (Get-Location).Path
$codexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$live = Join-Path $codexRoot 'mobile-notify'
$desktop = [Environment]::GetFolderPath('Desktop')
New-Item -ItemType Directory -Path $live -Force | Out-Null
.\deploy.ps1 -SourceRoot $src -LiveRoot $live -DesktopPath $desktop -SkipLiveActions
if (-not (Test-Path (Join-Path $live 'config.json'))) {
    Copy-Item .\config.example.json (Join-Path $live 'config.json')
}
Set-Location $live
notepad .\config.json
```

填好第 3 步的六个 ID。把 `discordWorktreeRoot` 改成自己的绝对路径，例如 Codex 数据目录下的 `worktrees/discord`，避免未设置 `CODEX_HOME` 时留下未展开的占位符；JSON 路径可用 `/`，或把 `\` 写成 `\\`。`discordProjectlessRoot` 可以保留示例的 `%USERPROFILE%` 路径。

保存文件后，**重新复制 Bot Token** 到剪贴板，替换下面命令中的 `<你的Discord用户ID>` 并执行：

```powershell
.\save-discord-token.ps1 -FromClipboard -AllowedUserId '<你的Discord用户ID>'
.\activate-discord-bot.ps1
node .\discord-bridge.mjs --register-commands --once
.\install-control-app.ps1 -SourceRoot $src -ToolDir $live -DesktopPath $desktop -ShortcutOnly
.\repair-notify.ps1 -CodexRoot $codexRoot
.\install-discord-bridge-task.ps1
.\codex-control.ps1 -Action status
Start-Process .\CodexDiscordControl.exe
```

每一步成功后再继续。Token 保存时会联网核对 Bot 身份，随后用当前 Windows 用户的 DPAPI 加密。命令注册应报告并核验 **11 个 Guild Commands**；计划任务安装会立即启动服务并启用当前用户登录自启。桌面会出现 **码驿 · CodexRelay 控制台** 快捷方式。

`repair-notify.ps1` 安装 Codex 原生通知 hook；若以后其他工具覆盖了 notify 设置，再运行它。新装流程不假定旧版通知修复 guard 已存在。已有自定义通知处理器的人应先备份 Codex 的 `config.toml`，再核对自己的通知设置。

## 4B. macOS 首次安装

在**源码仓库根目录的终端**执行：

```sh
node ./install-macos.mjs
cd "${CODEX_HOME:-$HOME/.codex}/mobile-notify"
open -t ./config.json
```

第一次安装会生成本机配置、编译原生 App，并建立桌面的 **码驿 · CodexRelay 控制台.app** 入口。输出 `configurationRequired: true` 表示接下来需要配置，不是安装失败；此时不会注册命令或启动桥接。按第 3 步填满六个 ID，使用纯文本保存。安装器已设置 Mac 的 Token 路径、工作树和无项目目录。

桌面入口指向运行目录内保留原名的 `Codex Discord 控制台.app`。下面的 `open` 命令打开默认桌面入口；安装到自定义桌面目录时，使用该目录中的同名入口。

**重新复制 Bot Token**，替换下面命令中的 `<你的Discord用户ID>`，逐条执行：

```sh
pwsh -NoProfile -File ./save-discord-token.ps1 -FromClipboard -AllowedUserId '<你的Discord用户ID>'
pwsh -NoProfile -File ./activate-discord-bot.ps1
node ./discord-bridge.mjs --register-commands --once
pwsh -NoProfile -File ./repair-notify.ps1
node ./discord-macos-notify-guard.mjs --action enable
node ./discord-macos-control.mjs --action enable-long-term
node ./discord-macos-control.mjs --action status
open "$HOME/Desktop/码驿 · CodexRelay 控制台.app"
```

每一步成功后再继续。Token 文件是 `discord-token.keychain`，加密密钥存在当前用户的 Keychain；保持 Keychain 可访问，按系统提示允许访问。独立 notify guard 只修复通知 hook，不会重新开启被你长期停用的桥接服务。已有自定义通知处理器时，先备份 Codex 的 `config.toml` 再运行 repair。

Mac 使用这些 `.mjs` 安装与控制入口，不运行 Windows 的 `deploy.ps1` 或计划任务安装脚本。非标准运行时路径、自定义 Keychain 及当前 Codex 桌面接管限制见 [macOS 指南](MACOS.md)。当前 Mac 桌面版本可能拒绝外部桥接直接接管活动任务；本机服务能启动不代表该能力已通过真实验收。

## 5. 桌面怎么用，怎样确认装好了

双击桌面的 **码驿 · CodexRelay 控制台**。两平台均显示服务、自启、Discord、Codex 桌面端、继续队列和最后活动状态，每两秒刷新。Mac 右上角的小圈表示自动刷新，后台轮询只更新变化的状态文字；按钮只在执行操作时禁用。关闭控制台窗口后，桥接仍在后台运行。

| 按钮 | 现在的服务与本机通知 | 下次用户登录 |
| --- | --- | --- |
| 临时开启 | 启动，并恢复通知 | 保留原来的自启选择 |
| 临时停止 | 停止，同时暂停通知 | 保留原来的自启选择 |
| 长期开启 | 启动，并恢复通知 | 自动启动 |
| 长期停用 | 停止并暂停通知，弹出确认 | 不自动启动 |

停止会同时关闭本工具的手机通知开关；Codex 原生通知 hook 即使继续被调用，也不会向配置的通知频道投递。重新开启恢复通知；临时停止保留原自启选择，下次计划服务真正启动时恢复通知。其他工具原有的通知处理器仍保留。

长期停用保留配置、Token、队列和历史。上述按钮管理桥接服务；Discord 的 `/退出codex` 是另一个会中断桌面任务的操作，不要拿它测试安装。

在目标服务器使用自己的授权 Discord 账户，依次检查：

1. 输入 `/帮助`，确认能看到本 Bot 的 11 个命令及私密回复。
2. 执行 `/系统状态`，检查 Gateway、通知、索引和队列状态。
3. 执行 `/系统测试`，把 `类型` 选为 **快速**；通过后再选 **完整**。完整测试会向三个配置频道**各发送一条明确标记的测试通知**，不创建 Codex 任务，也不写正式任务消息映射。
4. 如需验证任务功能，用 `/新建任务` 创建一个你愿意实际执行的小任务，确认结果回到发起频道，再回复该条正式任务通知。完整测试产生的消息没有任务映射，不能用它验证续接。

桥接所在电脑必须开机、已登录、唤醒并联网；关闭 Codex 桌面端不会自动关闭桥接。休眠时 Slash Commands 不能执行，已进入本地队列的内容和可补读的频道回复在恢复后继续处理。更多边界见 [README](../README.md) 和[验收记录](ACCEPTANCE.md)。

开发者验证源码时，在**源码根目录**运行：

```sh
pwsh -NoProfile -File ./tests/run-tests.ps1
```

这是自动回归测试，不会代替你自己的 Discord Token、频道权限及真实消息验收。

## 6. 更新与常见恢复

更新前回到**源码根目录**。Git 用户先运行 `git status`，确认本地修改已经妥善保存。旧仓库克隆先检查 remote 地址：

```sh
git remote get-url origin
```

若仍指向旧仓库名，按现有协议选择一条命令更新地址；HTTPS 用户保留 HTTPS，SSH 用户保留 SSH，不需要更换登录方式或密钥：

原地址使用 HTTPS 时：

```sh
git remote set-url origin https://github.com/mxymalay/CodexRelay.git
```

原地址使用 SSH 时，改用这一条：

```sh
git remote set-url origin git@github.com:mxymalay/CodexRelay.git
```

现有本地源码文件夹可以保留原名，不影响更新。随后依次执行以下命令；即使以前安装的是 `codex/windows-macos-support`，以后也切换到 `main` 获取更新：

```sh
git fetch origin
git switch main
git pull --ff-only
```

如果切换或快进更新失败，先保留本地修改并处理提示，不要强制覆盖。ZIP 用户从[主分支页面](https://github.com/mxymalay/CodexRelay/tree/main)下载最新源码并解压到独立目录。获取源码后，继续运行下面对应平台的部署命令；仅执行 Git 更新或解压 ZIP 不会更新后台运行的文件。部署会保留原自启选择和私有状态。

Windows 可在解压后的源码根目录双击 `update-windows.cmd`，它会更新默认运行目录并保留原服务选择。旧服务如果已经停止，更新时会同步关闭本工具的通知开关。源码目录仍须独立于桌面和运行目录；请先阅读窗口中的错误或成功信息。

ZIP 用户先在资源管理器中右键压缩包，选择 **全部解压缩 / Extract All → 提取**，再进入解压后的源码文件夹（通常为 `CodexRelay-main` 或 `CodexRelay`）。确认 `update-windows.cmd` 和 `update-windows.ps1` 位于同一文件夹，再双击 CMD。直接在压缩包中运行会只临时提取 CMD，导致找不到配套脚本；新版启动器会对此提示完整解压。

也可以在 PowerShell 7 手动执行：

```powershell
$codexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
.\deploy.ps1 -SourceRoot (Get-Location).Path -LiveRoot (Join-Path $codexRoot 'mobile-notify') -DesktopPath ([Environment]::GetFolderPath('Desktop'))
```

macOS / 终端：

```sh
node ./deploy-macos.mjs --source-root "$PWD" \
  --live-root "${CODEX_HOME:-$HOME/.codex}/mobile-notify" --desktop-path "$HOME/Desktop"
```

| 现象 | 先检查什么 |
| --- | --- |
| 桌面入口或控制台被误删 | 用上面的部署命令重新生成；不要用示例覆盖私有配置 |
| Token 保存提示“剪贴板中的令牌不属于当前配置的 Discord 应用” | Application ID 与刚复制的 Bot Token 是否属于同一个应用 |
| 提示“旧 Discord 三路配置不完整” | 六个 ID 是否都已填写，三个频道 ID 是否有效且不同；新装无需补 Webhook |
| 命令不显示 | Bot 是否已邀请到正确服务器；重新执行 `node ./discord-bridge.mjs --register-commands --once`，确认 11 个命令核验成功 |
| Bot 离线或无响应 | 控制台服务状态、网络、电脑是否唤醒；运行目录的 `discord-bridge.log`；Mac 的 PowerShell 路径及 Keychain 是否可访问 |
| 测试提示频道不可用 | Guild/频道 ID、频道权限覆盖、Bot 是否有四项必要权限 |
| Slash 正常但文字回复不续接 | Message Content Intent、Read Message History、是否使用授权账户回复正式任务消息；额度通知和测试消息不能续接 |
| Token 丢失或失效 | 在 Developer Portal 重置，重新复制并运行本平台保存 Token 的命令，再临时停止/开启桥接；Token 不粘贴到聊天或命令参数 |
| Windows 拒绝执行下载的脚本 | 确认源码来源后，先在下载 ZIP 的文件属性中“解除锁定”并重新解压；受组织策略管理的电脑按其规则处理 |
| 更新提示找不到 `update-windows.ps1`，路径含 `Temp` 和 `.zip` | 关闭窗口，右键 ZIP 选择“全部解压缩”，从解压后的文件夹重新运行；不要直接在压缩包中双击 CMD |
| Windows 提示 C# compiler unavailable / Mac 提示 xcrun 失败 | 修复系统 .NET Framework 开发编译器 / 完成 Xcode Command Line Tools 安装，再部署 |

保存 Token 后可从剪贴板历史中清除它。需要求助时只提供脱敏错误和测试结果，不发送 `config.json`、Token 文件或任务状态文件。

## 可选：自己的旧电脑迁移

迁移用于**同一个人的旧 Bot 和配置**，不是把自己的凭据交给另一位新用户。Windows DPAPI 文件无法直接搬到 Mac 或另一个 Windows 账户解密。

在旧电脑的原 Windows 账户中，用主分支源码中的 `export-discord-migration.ps1` 生成口令加密包；在新电脑用 `import-discord-migration.ps1` 导入。脚本交互询问口令，包和口令分开保管。具体命令见 [Windows → macOS 迁移步骤](MACOS.md#从旧-windows-电脑恢复配置和-token)。

新电脑应**先导入，再安装**，避免首次安装的占位配置触发默认拒绝覆盖。若已经生成了占位配置，停止目标桥接、确认目标和备份后，才用导入器的 `-ReplaceExisting`。导入成功后安装、激活、注册和启用服务；无需再次从剪贴板保存同一 Token。

先处理旧机队列并停止旧桥接，再开启新机桥接，避免两个实例同时消费同一个 Bot 的消息。旧版本的“停止桥接”不会暂停独立通知脚本；应先在旧 Windows 安装主分支的最新版本，再点“临时停止”或“长期停用”，确保旧机器的通知开关也已关闭。迁移包不包含 Codex 登录、任务数据库、项目文件、待执行回复或旧任务映射；这些不会因为导入 Bot 设置而出现在新电脑。
