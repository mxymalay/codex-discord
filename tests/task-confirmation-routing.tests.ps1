[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceDispatcher = Join-Path (Split-Path -Parent $PSScriptRoot) 'dispatcher.ps1'
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = Join-Path $tempBase ('codex-confirmation-routing-tests-{0}' -f [guid]::NewGuid().ToString('N'))
$tempRoot = [System.IO.Path]::GetFullPath($tempRoot)

if (-not $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe temporary test path: $tempRoot"
}

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )

    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) {
        [void](New-Item -ItemType Directory -Path $parent -Force)
    }
    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

function Invoke-NotificationCase {
    param(
        [string]$UserMessage,
        [string]$AssistantMessage
    )

    $notification = [ordered]@{
        type = 'agent-turn-complete'
        'thread-id' = $script:rootId
        'turn-id' = [guid]::NewGuid().ToString()
        cwd = 'C:\workspace\demo-project'
        'input-messages' = @($UserMessage)
        'last-assistant-message' = $AssistantMessage
    }
    $raw = $notification | ConvertTo-Json -Depth 8 -Compress
    $output = @(& $script:testDispatcher $raw -MobileOnly -DryRun)
    $text = (($output | ForEach-Object { [string]$_ }) -join "`n").Trim()
    if ([string]::IsNullOrWhiteSpace($text)) {
        throw 'Dispatcher did not emit a notification'
    }
    return ($text | ConvertFrom-Json)
}

$rootId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
$failures = @()

try {
    $toolDir = Join-Path $tempRoot 'mobile-notify'
    [void](New-Item -ItemType Directory -Path $toolDir -Force)
    Copy-Item -LiteralPath $sourceDispatcher -Destination (Join-Path $toolDir 'dispatcher.ps1')
    $testDispatcher = Join-Path $toolDir 'dispatcher.ps1'

    $config = [ordered]@{
        enabled = $true
        provider = 'ntfy'
        endpoint = 'https://ntfy.invalid/task-topic'
        confirmationEndpoint = 'https://ntfy.invalid/confirmation-topic'
        quotaEndpoint = 'https://ntfy.invalid/quota-topic'
        token = ''
        includeAssistantMessage = $true
        quotaNotifications = $false
        timeoutSeconds = 1
        previousNotify = @()
    }
    Write-Utf8NoBom -Path (Join-Path $toolDir 'config.json') -Content ($config | ConvertTo-Json -Depth 8)

    $indexEntry = [ordered]@{
        id = $rootId
        thread_name = '通知分类测试任务'
        updated_at = '2026-08-31T00:00:00Z'
    }
    Write-Utf8NoBom -Path (Join-Path $tempRoot 'session_index.jsonl') -Content (($indexEntry | ConvertTo-Json -Compress) + "`n")

    $sessionEntry = [ordered]@{
        timestamp = '2026-08-31T00:00:00.000Z'
        type = 'session_meta'
        payload = [ordered]@{
            id = $rootId
            session_id = $rootId
            parent_thread_id = $null
            thread_source = 'user'
            source = 'vscode'
            originator = 'Codex Desktop'
        }
    }
    $sessionPath = Join-Path $tempRoot "sessions\2026\08\31\rollout-2026-08-31T00-00-00-$rootId.jsonl"
    Write-Utf8NoBom -Path $sessionPath -Content (($sessionEntry | ConvertTo-Json -Depth 12 -Compress) + "`n")

    $cases = @(
        [pscustomobject]@{
            Name = 'explicit plan confirmation question'
            User = '公斤重量不要自动添加后缀'
            Assistant = '修改方案：统一显示正则实际捕获值，不改识别规则，并增加回归测试。按这个方案修改，可以吗？'
            Event = 'user-task-confirmation-required'
            Endpoint = 'https://ntfy.invalid/confirmation-topic'
        },
        [pscustomobject]@{
            Name = 'direct revision asks approval without plan keyword'
            User = '修复规则保存后无法匹配的问题'
            Assistant = '已经定位前后处理不一致，建议统一规则文本、修复旧自动规则并增加完整回放验证。按这版直接改，可以吗？'
            Event = 'user-task-confirmation-required'
            Endpoint = 'https://ntfy.invalid/confirmation-topic'
        },
        [pscustomobject]@{
            Name = 'future investigation direction asks approval'
            User = '我想知道怎么定义内部卡片，在 /card/admin 管理吗？有的门店需要但没法配置，你有什么建议'
            Assistant = '这是一次方案咨询（Spike），先不改代码。我准备核对三件事：内置卡片目前在哪里定义、/card/admin 能管理到哪一层、门店级可选能力现有数据结构是否能承载。然后给你一个尽量不增加普通门店负担的建议。按这个方向查可以吗？'
            Event = 'user-task-confirmation-required'
            Endpoint = 'https://ntfy.invalid/confirmation-topic'
        },
        [pscustomobject]@{
            Name = 'preparatory investigation remains pending without question'
            User = '排查内部卡片为什么不能按门店配置'
            Assistant = '先不改代码。我准备核对后端数据结构、管理端入口和门店启用逻辑，然后给出实施建议。'
            Event = 'user-task-confirmation-required'
            Endpoint = 'https://ntfy.invalid/confirmation-topic'
        },
        [pscustomobject]@{
            Name = 'optimization proposal not executed'
            User = '我们的安装包能不能优化，现在体积是不是有点大？'
            Assistant = '建议按这个顺序优化：先验证 PyInstaller MERGE，再拆分后台支付逻辑，最后把诊断工具做成可选包。目前没有修改代码或安装包。'
            Event = 'user-task-confirmation-required'
            Endpoint = 'https://ntfy.invalid/confirmation-topic'
        },
        [pscustomobject]@{
            Name = 'execution task receives proposal without pending disclaimer'
            User = '优化安装包体积并验证启动速度'
            Assistant = '实施方案：先合并 PyInstaller 共享依赖，再拆分后台支付与 Qt 图形逻辑，最后重新构建两版安装包并测量启动速度。'
            Event = 'user-task-confirmation-required'
            Endpoint = 'https://ntfy.invalid/confirmation-topic'
        },
        [pscustomobject]@{
            Name = 'read only diagnosis still needs implementation'
            User = '修复商品匹配预览只显示一行的问题'
            Assistant = '根因在后端诊断溯源，需要让正式预处理同步保留物理行来源，并把拆分、合并结构带回编辑器。当前我只做了只读诊断，尚未修改代码。'
            Event = 'user-task-confirmation-required'
            Endpoint = 'https://ntfy.invalid/confirmation-topic'
        },
        [pscustomobject]@{
            Name = 'implementation complete but branch choice pending'
            User = '完成样式提取和浏览器适配'
            Assistant = "验证结果全部通过，变更保存在隔离工作树，尚未提交或合并。`n`nImplementation complete. What would you like to do?`n1. Merge back to main locally`n2. Push and create a Pull Request`n3. Keep the branch as-is`n`nWhich option?"
            Event = 'user-task-confirmation-required'
            Endpoint = 'https://ntfy.invalid/confirmation-topic'
        },
        [pscustomobject]@{
            Name = 'dependency installation authorization'
            User = '启动这个 Java 项目'
            Assistant = '机器上没有 Maven，当前 Java 是 1.8，项目要求 Java 17+ 和 Maven 3.6+。你回复“安装”，我就直接帮你装好并验证 mvn spring-boot:run。'
            Event = 'user-task-confirmation-required'
            Endpoint = 'https://ntfy.invalid/confirmation-topic'
        },
        [pscustomobject]@{
            Name = 'completed implementation'
            User = '修复商品匹配预览并增加测试'
            Assistant = '已完成商品匹配预览修复，并增加定向回归测试。验证结果：后端 88/88、Node 137/137、UI 83/83 全部通过。'
            Event = 'user-task-complete'
            Endpoint = 'https://ntfy.invalid/task-topic'
        },
        [pscustomobject]@{
            Name = 'analysis only requested is complete'
            User = '只分析安装包为什么变大，不要修改代码或重新打包'
            Assistant = '分析完成：主要体积来自多个 EXE 重复携带 PyQt 运行时。建议后续验证共享运行时；按你的要求没有修改代码或安装包。'
            Event = 'user-task-complete'
            Endpoint = 'https://ntfy.invalid/task-topic'
        },
        [pscustomobject]@{
            Name = 'plan only requested is complete'
            User = '只给我一份安装包优化方案，不要执行或修改代码'
            Assistant = '优化方案：先做共享运行时原型，再拆分后台服务依赖，最后比较两版包体积。方案已整理完成。'
            Event = 'user-task-complete'
            Endpoint = 'https://ntfy.invalid/task-topic'
        },
        [pscustomobject]@{
            Name = 'completed work may include nonblocking recommendation'
            User = '修复商品匹配预览并增加测试'
            Assistant = '已完成商品匹配预览修复，全部测试通过。建议以后新增样本时继续保留这组回归测试。'
            Event = 'user-task-complete'
            Endpoint = 'https://ntfy.invalid/task-topic'
        },
        [pscustomobject]@{
            Name = 'completion report may document confirmation examples'
            User = '修复任务确认分类误判'
            Assistant = ('已修复。这条真实回复现在会识别为任务确认。' + "`n`n" + '新增识别：' + "`n`n" + '- “按这个方向查、核对、分析，可以吗”' + "`n" + '- “先不改代码，我准备调查”' + "`n`n" + '真实原文干跑通过，全部既有回归通过，修改已经完成。')
            Event = 'user-task-complete'
            Endpoint = 'https://ntfy.invalid/task-topic'
        },
        [pscustomobject]@{
            Name = 'inline quoted confirmation examples do not reopen completed task'
            User = '修复任务确认分类误判'
            Assistant = '已完成分类器修复；新增规则会识别“按这个方向查可以吗”和“先不改代码，我准备调查”，13 个测试全部通过。'
            Event = 'user-task-complete'
            Endpoint = 'https://ntfy.invalid/task-topic'
        },
        [pscustomobject]@{
            Name = 'ordinary question mark is not confirmation'
            User = '解释为什么缓存清理无效'
            Assistant = '原因是请求命中了后端持久化数据，而不是旧样本或本地缓存。为什么清理缓存无效？因为缓存从未参与这条读取路径。解释已完成。'
            Event = 'user-task-complete'
            Endpoint = 'https://ntfy.invalid/task-topic'
        },
        [pscustomobject]@{
            Name = 'terminal question defaults to confirmation'
            User = '给我一些门店配置建议'
            Assistant = '我已经列出三种可选方向。你更倾向哪一种？'
            Event = 'user-task-confirmation-required'
            Endpoint = 'https://ntfy.invalid/confirmation-topic'
        },
        [pscustomobject]@{
            Name = 'completed opening overrides explanatory terminal question'
            User = '修复缓存读取错误并验证'
            Assistant = '已完成缓存读取修复，全部测试通过。结果说明清楚了吗？'
            Event = 'user-task-complete'
            Endpoint = 'https://ntfy.invalid/task-topic'
        },
        [pscustomobject]@{
            Name = 'explicit choice still overrides completed opening'
            User = '完成实现后让我决定如何处理分支'
            Assistant = '已完成实现并通过全部测试。请选择合并回主分支还是保留当前分支。'
            Event = 'user-task-confirmation-required'
            Endpoint = 'https://ntfy.invalid/confirmation-topic'
        }
    )

    foreach ($case in $cases) {
        try {
            $message = Invoke-NotificationCase -UserMessage $case.User -AssistantMessage $case.Assistant
            if ([string]$message.event -ne $case.Event) {
                $failures += "[$($case.Name)] expected event=$($case.Event), got $($message.event)"
            }
            if ([string]$message.endpoint -ne $case.Endpoint) {
                $failures += "[$($case.Name)] expected endpoint=$($case.Endpoint), got $($message.endpoint)"
            }
            if ($case.Event -eq 'user-task-confirmation-required') {
                if ([string]$message.title -notlike 'Codex 任务待确认*') {
                    $failures += "[$($case.Name)] unexpected confirmation title: $($message.title)"
                }
                if ([string]$message.body -notmatch '待确认：') {
                    $failures += "[$($case.Name)] confirmation body is missing 待确认 field"
                }
            }
        }
        catch {
            $failures += "[$($case.Name)] $($_.Exception.Message)"
        }
    }

    if ($failures.Count -gt 0) {
        throw ($failures -join "`n")
    }

    Write-Output "PASS: $($cases.Count) task confirmation routing cases"
}
finally {
    if ((Test-Path -LiteralPath $tempRoot) -and $tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
