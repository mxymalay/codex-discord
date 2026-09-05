# macOS 安装与 Windows 迁移

两套系统共用 11 个 Slash Commands、通知格式与路由、回复队列、任务索引、新建任务、额度快照和 rollout 补发逻辑。Windows 使用 DPAPI、计划任务和 WinForms；macOS 使用 Keychain、launchd 和 AppKit 控制台。仍需 PowerShell 7 来运行完整通知逻辑。

## 环境

安装 Node.js 24、PowerShell 7、Git 和 Xcode Command Line Tools。PowerShell 支持 Apple Silicon 和 Intel 的安装包或独立压缩包，见 [Microsoft 官方安装说明](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-macos)。原生控制台通过 `xcrun clang` 编译。

```sh
node --version
pwsh --version
git --version
xcode-select -p
```

找不到开发工具时，先运行 `xcode-select --install` 并完成系统安装。Codex 可从 PATH、`/Applications/Codex.app`、`/Applications/ChatGPT.app` 或用户 Applications 目录发现，也可用 `CODEX_DISCORD_CODEX_PATH` 指定绝对路径。非标准 PowerShell 安装设置 `CODEX_DISCORD_PWSH_PATH` 为其可执行文件绝对路径。

`CODEX_HOME` 优先指定 Codex 数据目录，默认是 `~/.codex`。运行文件默认安装到其 `mobile-notify` 子目录。仓库检出目录不会被误认为 Codex 数据目录。自启保存安装时所需环境变量，之后修改运行时路径应重新部署。

## 从旧 Windows 电脑恢复配置和 Token

必须在原来使用该项目的 Windows 账户中操作。配置通常位于 `%CODEX_HOME%\mobile-notify`；未设置 `CODEX_HOME` 时是 `%USERPROFILE%\.codex\mobile-notify`。`config.json` 不保存明文 Bot Token；Token 路径由其中的 `discordTokenPath` 指定，通常为 `discord-token.dpapi`。

Windows DPAPI 文件不能由 macOS 或其他 Windows 账户直接解密。本仓库的导出脚本在原账户内解密，然后立即生成密码加密的迁移包；Mac 导入后用自己的 Keychain 密钥重新加密 Token。Token、迁移密码均不应粘贴到聊天、命令参数或 Git 中。

旧电脑取得此兼容分支的代码后，在仓库目录使用 **PowerShell 7**：

```powershell
$codexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
pwsh -NoProfile -File .\export-discord-migration.ps1 -ToolDir (Join-Path $codexRoot 'mobile-notify') -Destination .\settings.discord-migration
```

按提示输入迁移密码。把 `settings.discord-migration` 复制到 Mac，密码通过独立方式保管。在 Mac 的仓库目录导入：

```sh
pwsh -NoProfile -File ./import-discord-migration.ps1 \
  -PackagePath ./settings.discord-migration -ToolDir "${CODEX_HOME:-$HOME/.codex}/mobile-notify"
```

默认拒绝覆盖已存在的配置和 Token。若目标已经是自己要替换的配置，先停止目标 Mac 的桥接服务并备份，再显式添加 `-ReplaceExisting`。错误密码、损坏的包或加密失败会拒绝导入；提交过程抛错时恢复原文件。导入期间突然断电仍需检查保留的迁移目录。导入后运行下面的 macOS 安装步骤。

迁移包只包含 Discord ID、Token 和支持的通知偏好。它不搬运任务数据库、Windows 本机路径、旧 `previousNotify`、运行状态或继续队列。请先在旧电脑处理未完成队列。旧任务需要其原始 Codex 会话和项目文件；只迁移 Bot 设置不会把旧电脑上的任务变成本机任务。

完成切换前停止旧电脑的桥接服务，避免两个实例用同一 Bot 同时消费消息。确认 Mac 可用后再长期停用旧服务。导出失败且原账户无法解密时，需要在 Discord Developer Portal 重置 Token，并在两台机器上更新它。

## 安装、启动和控制

```sh
node ./install-macos.mjs
```

已有迁移配置时安装器保留配置；首次无配置时创建本机示例并要求填写 Discord ID。手动配置也可参考 `config.macos.example.json`。从终端安全保存 Token：

```sh
cd "${CODEX_HOME:-$HOME/.codex}/mobile-notify"
pwsh -NoProfile -File ./save-discord-token.ps1 -FromClipboard -AllowedUserId '<Discord用户ID>'
pwsh -NoProfile -File ./activate-discord-bot.ps1
node ./discord-bridge.mjs --register-commands --once
node ./discord-macos-control.mjs --action enable-long-term
open './Codex Discord 控制台.app'
```

`-FromStdin` 也可从受信任的密码管理器安全接收 Token；不要用带 Token 字面量的 Shell 命令。macOS 密文文件为 `discord-token.keychain`，AES-GCM 密钥保存在当前账户 Keychain 中。Keychain 必须已解锁；首次访问时系统可能要求允许访问。若配置 `CODEX_DISCORD_KEYCHAIN` 使用独立 Keychain，应让该 Keychain 在服务运行时可访问。

控制台每两秒刷新服务、自启、Discord、桌面端、队列和最近活动。四个按钮与 Windows 含义一致：

| 操作 | 当前服务 | 下次登录自启 |
| --- | --- | --- |
| 临时开启 / `start-temporary` | 启动 | 保留原选择 |
| 临时停止 / `stop-temporary` | 停止 | 保留原选择 |
| 长期开启 / `enable-long-term` | 启动 | 启用 |
| 长期停用 / `disable-long-term` | 停止 | 禁用 |

所有操作只控制安装目录对应的用户服务；Token、配置和队列保留。可随时查询：

```sh
node ./discord-macos-control.mjs --action status
```

修复 Codex 原生通知 hook 使用 `pwsh -NoProfile -File ./repair-notify.ps1`。还可以安装独立的通知修复 guard：

```sh
node ./discord-macos-notify-guard.mjs --action enable
node ./discord-macos-notify-guard.mjs --action status
# 完全移除通知前，先停止 guard：
node ./discord-macos-notify-guard.mjs --action disable
```

guard 只修复通知 hook，独立于桥接服务，不会改变桥接服务的长期启停选择。桥接器自身保留 rollout 完成补发。关闭桌面 App 不会关闭桥接服务，但电脑必须开机、登录、唤醒并联网。

## 更新和隔离验收

```sh
node ./deploy-macos.mjs --source-root "$PWD" \
  --live-root "${CODEX_HOME:-$HOME/.codex}/mobile-notify" --desktop-path "$HOME/Desktop"
```

部署使用固定文件白名单、SHA-256 暂存校验和时间戳备份，出错时回滚已提交文件，保留配置、Token、队列、历史和原自启选择。目标目录必须存在且互不重叠。`--skip-live-actions` 只复制和编译，不改桌面入口、不注册命令或启动服务，适合隔离目录验收。不要把隔离测试目录设为当前生产目录。

```sh
pwsh -NoProfile -File ./tests/run-tests.ps1
```

测试入口在 macOS 执行全部适用 Node/PowerShell 测试，Windows API 专用四套测试交给 Windows 执行。GitHub Actions 同时跑 Windows 和 macOS。真实 Discord `/系统测试 完整` 会向三个频道各发一条测试消息，应在确定测试范围后手动触发。

## 当前桌面接口限制

本项目的“直接转向正在运行的桌面任务”使用 Codex 桌面内部接口。2026-09-06 验证的 macOS 桌面版本对该接口启用了进程身份校验，外部 Node 桥接进程被拒绝。代码不会关闭或绕过校验。Unix socket 传输已通过真实本地 socket 测试，但这不能证明当前桌面应用允许外部桥接访问。

独立 App Server 的初始化、项目列表、任务列表和模型列表已在本机通过只读验证；协议见 [OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server)。若桌面拒绝接管，桥接保留原来的安全回退：提交前失败才尝试 App Server，活动写入冲突排队；已提交而结果未知的请求不自动重复发送。不能把这些回退视为当前桌面版本完整接管能力已验收。

Windows 原机器、真实 Discord 凭据、实际消息投递、休眠/重新登录及主动退出桌面端，需要在目标设备上最终验收。自动测试通过不等同于保证没有缺陷。
