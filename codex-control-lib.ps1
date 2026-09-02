Set-StrictMode -Version Latest

$bridgeStartupPath = Join-Path $PSScriptRoot 'discord-bridge-startup.ps1'
if (-not (Test-Path -LiteralPath $bridgeStartupPath -PathType Leaf)) {
    throw 'Discord bridge startup helpers are missing'
}
. $bridgeStartupPath

function Get-CodexDesktopProgramFilesPath {
    [CmdletBinding()]
    param()

    $programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
    if ([string]::IsNullOrWhiteSpace($programFiles)) {
        return $null
    }
    try {
        return [System.IO.Path]::GetFullPath($programFiles).TrimEnd([char[]]@('\', '/'))
    }
    catch {
        return $null
    }
}

function ConvertTo-CodexDesktopCanonicalPath {
    [CmdletBinding()]
    param([AllowNull()][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }
    try {
        return [System.IO.Path]::GetFullPath($Path)
    }
    catch {
        return $null
    }
}

function Get-CodexDesktopPackageRoot {
    [CmdletBinding()]
    param([AllowNull()][string]$Path)

    $normalized = ConvertTo-CodexDesktopCanonicalPath -Path $Path
    $programFiles = Get-CodexDesktopProgramFilesPath
    if ($null -eq $normalized -or $null -eq $programFiles) {
        return $null
    }

    $windowsApps = [System.IO.Path]::GetFullPath((Join-Path $programFiles 'WindowsApps')).TrimEnd([char[]]@('\', '/'))
    $prefix = $windowsApps + '\'
    if (-not $normalized.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $null
    }

    $relative = $normalized.Substring($prefix.Length)
    $segments = @($relative -split '[\\/]')
    if ($segments.Count -lt 2 -or [string]::IsNullOrWhiteSpace($segments[0])) {
        return $null
    }
    if ($segments[0] -notmatch '\AOpenAI\.Codex_[^\\/]+\z') {
        return $null
    }

    return (Join-Path $windowsApps $segments[0])
}

function Test-CodexDesktopRootPath {
    [CmdletBinding()]
    param([AllowNull()][string]$Path)

    $normalized = ConvertTo-CodexDesktopCanonicalPath -Path $Path
    $packageRoot = Get-CodexDesktopPackageRoot -Path $normalized
    if ($null -eq $normalized -or $null -eq $packageRoot) {
        return $false
    }

    $expected = Join-Path (Join-Path $packageRoot 'app') 'ChatGPT.exe'
    return $normalized.Equals($expected, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-ControlProcessProperty {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Process,
        [Parameter(Mandatory)][string]$Name
    )

    $property = $Process.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function ConvertTo-ControlCreationTime {
    [CmdletBinding()]
    param([AllowNull()][object]$Value)

    if ($Value -is [DateTimeOffset]) {
        return $Value.ToUniversalTime()
    }
    if ($Value -is [DateTime]) {
        return ([DateTimeOffset]$Value).ToUniversalTime()
    }
    $text = [string]$Value
    if ($text -notmatch '\A(?<stamp>\d{14})\.(?<microseconds>\d{6})(?<sign>[+-])(?<offset>\d{3})\z') {
        return $null
    }
    try {
        $localTime = [DateTime]::ParseExact(
            ($Matches.stamp + '.' + $Matches.microseconds),
            'yyyyMMddHHmmss.ffffff',
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::None
        )
        $offsetMinutes = [int]$Matches.offset
        if ($offsetMinutes -gt 840) {
            return $null
        }
        if ($Matches.sign -eq '-') {
            $offsetMinutes = -$offsetMinutes
        }
        return ([DateTimeOffset]::new($localTime, [TimeSpan]::FromMinutes($offsetMinutes))).ToUniversalTime()
    }
    catch {
        return $null
    }
}

function ConvertTo-CodexDesktopProcessRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)][object]$Process)

    $rawProcessId = Get-ControlProcessProperty -Process $Process -Name 'ProcessId'
    $rawParentProcessId = Get-ControlProcessProperty -Process $Process -Name 'ParentProcessId'
    $rawCreationDate = Get-ControlProcessProperty -Process $Process -Name 'CreationDate'
    $processId = 0
    $parentProcessId = 0
    $hasValidProcessId = ($null -ne $rawProcessId -and [int]::TryParse(([string]$rawProcessId), [ref]$processId) -and $processId -gt 0)
    $hasValidParentProcessId = ($null -ne $rawParentProcessId -and [int]::TryParse(([string]$rawParentProcessId), [ref]$parentProcessId) -and $parentProcessId -ge 0)
    $creationTimeUtc = ConvertTo-ControlCreationTime -Value $rawCreationDate
    $executablePath = [string](Get-ControlProcessProperty -Process $Process -Name 'ExecutablePath')
    $canonicalExecutablePath = ConvertTo-CodexDesktopCanonicalPath -Path $executablePath
    return [pscustomobject]@{
        Process = $Process
        ProcessId = $processId
        HasValidProcessId = $hasValidProcessId
        ParentProcessId = $parentProcessId
        HasValidParentProcessId = $hasValidParentProcessId
        Name = [string](Get-ControlProcessProperty -Process $Process -Name 'Name')
        ExecutablePath = $executablePath
        CreationDate = $rawCreationDate
        CreationTimeUtc = $creationTimeUtc
        HasCreationTime = ($null -ne $creationTimeUtc)
        HasExecutablePath = ($null -ne $canonicalExecutablePath)
        PackageRoot = Get-CodexDesktopPackageRoot -Path $canonicalExecutablePath
    }
}

function New-EmptyCodexDesktopProcessPlan {
    return [pscustomobject][ordered]@{
        IsValid = $true
        ErrorCategory = $null
        Roots = @()
        ProcessIds = @()
        CreationTimes = [ordered]@{}
        StopProcessIds = @()
        RootByProcessId = @{}
    }
}

function New-UnverifiableCodexDesktopProcessPlan {
    return [pscustomobject][ordered]@{
        IsValid = $false
        ErrorCategory = 'process-tree-unverifiable'
        Roots = @()
        ProcessIds = @()
        CreationTimes = [ordered]@{}
        StopProcessIds = @()
        RootByProcessId = @{}
    }
}

function Get-CodexDesktopProcessPlan {
    [CmdletBinding()]
    param([Parameter(Mandatory)][object[]]$Processes)

    $records = [System.Collections.Generic.List[object]]::new()
    foreach ($process in @($Processes)) {
        if ($null -eq $process) {
            continue
        }
        $record = ConvertTo-CodexDesktopProcessRecord -Process $process
        if ($null -ne $record) {
            $records.Add($record)
        }
    }

    $byProcessId = @{}
    foreach ($record in $records) {
        if (-not $record.HasValidProcessId) {
            continue
        }
        $key = [string]$record.ProcessId
        if ($byProcessId.ContainsKey($key)) {
            return New-UnverifiableCodexDesktopProcessPlan
        }
        $byProcessId[$key] = $record
    }

    $trustedCandidates = @($records | Where-Object {
        $_.Name -ieq 'ChatGPT.exe' -and (Test-CodexDesktopRootPath -Path $_.ExecutablePath)
    })
    if (@($trustedCandidates | Where-Object { -not $_.HasValidProcessId -or -not $_.HasCreationTime -or -not $_.HasValidParentProcessId -or -not $_.HasExecutablePath }).Count -gt 0) {
        return New-UnverifiableCodexDesktopProcessPlan
    }

    $roots = @($trustedCandidates | Where-Object {
        $parentKey = [string]$_.ParentProcessId
        if (-not $byProcessId.ContainsKey($parentKey)) {
            return $true
        }
        $parent = $byProcessId[$parentKey]
        if (-not $parent.HasExecutablePath) {
            return $false
        }
        if ($null -ne $parent.PackageRoot -and $parent.PackageRoot.Equals($_.PackageRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $false
        }
        return $true
    } | Sort-Object ProcessId)
    if ($roots.Count -eq 0) {
        return New-EmptyCodexDesktopProcessPlan
    }

    $childrenByParent = @{}
    foreach ($record in $records) {
        $parentKey = [string]$record.ParentProcessId
        if (-not $childrenByParent.ContainsKey($parentKey)) {
            $childrenByParent[$parentKey] = [System.Collections.Generic.List[object]]::new()
        }
        $childrenByParent[$parentKey].Add($record)
    }

    $seen = [System.Collections.Generic.HashSet[int]]::new()
    $queue = [System.Collections.Generic.Queue[object]]::new()
    $orderedRecords = [System.Collections.Generic.List[object]]::new()
    $rootByProcessId = @{}
    foreach ($root in $roots) {
        [void]$seen.Add($root.ProcessId)
        $queue.Enqueue([pscustomobject]@{ Record=$root; Depth=0; RootProcessId=$root.ProcessId })
    }
    while ($queue.Count -gt 0) {
        $item = $queue.Dequeue()
        $orderedRecords.Add([pscustomobject]@{ Record=$item.Record; Depth=$item.Depth; RootProcessId=$item.RootProcessId })
        $rootByProcessId[[string]$item.Record.ProcessId] = $item.RootProcessId
        $children = if ($childrenByParent.ContainsKey([string]$item.Record.ProcessId)) { @($childrenByParent[[string]$item.Record.ProcessId]) } else { @() }
        foreach ($child in @($children | Sort-Object ProcessId)) {
            if (-not $item.Record.HasValidProcessId -or -not $item.Record.HasValidParentProcessId -or -not $item.Record.HasCreationTime -or -not $item.Record.HasExecutablePath -or -not $child.HasValidProcessId -or -not $child.HasValidParentProcessId -or -not $child.HasCreationTime -or -not $child.HasExecutablePath -or $child.CreationTimeUtc -le $item.Record.CreationTimeUtc) {
                return New-UnverifiableCodexDesktopProcessPlan
            }
            if ($seen.Add($child.ProcessId)) {
                $queue.Enqueue([pscustomobject]@{ Record=$child; Depth=($item.Depth + 1); RootProcessId=$item.RootProcessId })
            }
        }
    }

    $creationTimes = @{}
    foreach ($item in $orderedRecords) {
        $creationTimes[[int]$item.Record.ProcessId] = $item.Record.CreationDate
    }
    return [pscustomobject][ordered]@{
        IsValid = $true
        ErrorCategory = $null
        Roots = @($roots | ForEach-Object { $_.Process })
        ProcessIds = @($orderedRecords | ForEach-Object { $_.Record.ProcessId })
        CreationTimes = $creationTimes
        StopProcessIds = @($orderedRecords | Sort-Object @{ Expression = { $_.Depth }; Descending = $true }, @{ Expression = { $_.Record.ProcessId }; Descending = $true } | ForEach-Object { $_.Record.ProcessId })
        RootByProcessId = $rootByProcessId
    }
}

function Test-CodexDiscordBridgeTaskDefinitionCurrent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Task,
        [Parameter(Mandatory)][string]$ToolDir,
        [Parameter(Mandatory)][string]$PowerShellPath
    )

    try {
        if ($null -eq $Task.PSObject.Properties['Actions']) { return $false }
        $actions = @($Task.Actions)
        if ($actions.Count -ne 1 -or $null -eq $actions[0]) { return $false }
        $action = $actions[0]
        foreach ($propertyName in @('Execute', 'Arguments', 'WorkingDirectory')) {
            if ($null -eq $action.PSObject.Properties[$propertyName] -or [string]::IsNullOrWhiteSpace([string]$action.$propertyName)) {
                return $false
            }
        }

        $expected = Get-DiscordBridgeTaskDefinition -ToolDir $ToolDir -PowerShellPath $PowerShellPath
        $actualExecute = [System.IO.Path]::GetFullPath([string]$action.Execute)
        $actualWorkingDirectory = [System.IO.Path]::GetFullPath([string]$action.WorkingDirectory)
        return (
            [string]::Equals($actualExecute, $expected.Execute, [System.StringComparison]::OrdinalIgnoreCase) -and
            [string]::Equals([string]$action.Arguments, $expected.Arguments, [System.StringComparison]::Ordinal) -and
            [string]::Equals($actualWorkingDirectory, $expected.WorkingDirectory, [System.StringComparison]::OrdinalIgnoreCase)
        )
    }
    catch {
        return $false
    }
}

function New-CodexControlOperations {
    [CmdletBinding()]
    param()

    return @{
        GetProcesses = {
            @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | ForEach-Object {
                [pscustomobject]@{
                    ProcessId = $_.ProcessId
                    ParentProcessId = $_.ParentProcessId
                    Name = $_.Name
                    ExecutablePath = $_.ExecutablePath
                    CreationDate = $_.CreationDate
                }
            })
        }
        OpenProcess = {
            param([int]$ProcessId)
            $process = Get-Process -Id $ProcessId -ErrorAction Stop
            [void]$process.Handle
            return [pscustomobject]@{
                ProcessId = $process.Id
                StartTimeUtc = $process.StartTime.ToUniversalTime()
                Process = $process
            }
        }
        RequestClose = {
            param([Parameter(Mandatory)][object]$BoundProcess)
            try {
                return [bool]$BoundProcess.Process.CloseMainWindow()
            }
            catch {
                return $false
            }
        }
        StopProcess = {
            param([Parameter(Mandatory)][object]$BoundProcess)
            $BoundProcess.Process.Kill()
        }
        Sleep = {
            param([int]$Milliseconds)
            Start-Sleep -Milliseconds $Milliseconds
        }
        GetTask = {
            $task = Get-ScheduledTask -TaskName 'Codex Discord Bridge' -ErrorAction SilentlyContinue
            if ($null -eq $task) { return [pscustomobject]@{ installed=$false; enabled=$false; running=$false; definitionCurrent=$false } }
            $enabled = -not ([string]$task.State).Equals('Disabled', [System.StringComparison]::OrdinalIgnoreCase)
            if ($null -ne $task.Settings -and $null -ne $task.Settings.PSObject.Properties['Enabled']) {
                $enabled = [bool]$task.Settings.Enabled
            }
            $definitionCurrent = $false
            try {
                $powerShellPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
                $definitionCurrent = Test-CodexDiscordBridgeTaskDefinitionCurrent -Task $task -ToolDir $PSScriptRoot -PowerShellPath $powerShellPath
            }
            catch {}
            return [pscustomobject]@{ installed=$true; enabled=$enabled; running=($task.State -eq 'Running'); definitionCurrent=$definitionCurrent }
        }
        InstallTask = {
            $installScript = Join-Path $PSScriptRoot 'install-discord-bridge-task.ps1'
            & $installScript | Out-Null
        }
        EnableTask = { Enable-ScheduledTask -TaskName 'Codex Discord Bridge' -ErrorAction Stop | Out-Null }
        DisableTask = { Disable-ScheduledTask -TaskName 'Codex Discord Bridge' -ErrorAction Stop | Out-Null }
        StartTask = { Start-ScheduledTask -TaskName 'Codex Discord Bridge' -ErrorAction Stop }
        StopTask = { Stop-ScheduledTask -TaskName 'Codex Discord Bridge' -ErrorAction Stop }
        GetNotificationGuardTask = {
            $tasks = @(Get-ScheduledTask -TaskPath '\' -TaskName 'Codex ntfy Notification Guard' -ErrorAction SilentlyContinue)
            if ($tasks.Count -eq 0) { return $null }
            if ($tasks.Count -ne 1) { throw 'notification guard task identity is ambiguous' }
            $task = $tasks[0]
            $enabled = -not ([string]$task.State).Equals('Disabled', [System.StringComparison]::OrdinalIgnoreCase)
            if ($null -ne $task.Settings -and $null -ne $task.Settings.PSObject.Properties['Enabled']) {
                $enabled = [bool]$task.Settings.Enabled
            }
            [pscustomobject]@{
                enabled = $enabled
                running = ($task.State -eq 'Running')
                actions = @($task.Actions)
                taskPath = [string]$task.TaskPath
                taskName = [string]$task.TaskName
                principal = $task.Principal
                triggers = @($task.Triggers)
                settings = $task.Settings
                definitionXml = Export-ScheduledTask -TaskPath '\' -TaskName 'Codex ntfy Notification Guard' -ErrorAction Stop
            }
        }
        GetPowerShellPath = { (Get-Command pwsh.exe -ErrorAction Stop).Source }
        GetCurrentUserIdentity = {
            $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
            [pscustomobject]@{ Name=$identity.Name; Sid=$identity.User.Value }
        }
        StopNotificationGuardTask = { Stop-ScheduledTask -TaskPath '\' -TaskName 'Codex ntfy Notification Guard' -ErrorAction Stop }
        StartNotificationGuardTask = { Start-ScheduledTask -TaskPath '\' -TaskName 'Codex ntfy Notification Guard' -ErrorAction Stop }
        EnableNotificationGuardTask = { Enable-ScheduledTask -TaskPath '\' -TaskName 'Codex ntfy Notification Guard' -ErrorAction Stop | Out-Null }
        DisableNotificationGuardTask = { Disable-ScheduledTask -TaskPath '\' -TaskName 'Codex ntfy Notification Guard' -ErrorAction Stop | Out-Null }
        StartDetached = {
            param([Parameter(Mandatory)][string]$StartupPath, [Parameter(Mandatory)][ValidateSet('temporary')][string]$Mode)
            $powerShellPath = (Get-Command pwsh -ErrorAction Stop).Source
            $previousMode = $env:CODEX_DISCORD_START_MODE
            $env:CODEX_DISCORD_START_MODE = $Mode
            try {
                Start-Process -FilePath $powerShellPath -ArgumentList @('-NoProfile', '-File', $StartupPath) -WindowStyle Hidden -ErrorAction Stop | Out-Null
            }
            finally {
                if ($null -eq $previousMode) { Remove-Item -LiteralPath 'Env:CODEX_DISCORD_START_MODE' -ErrorAction SilentlyContinue }
                else { $env:CODEX_DISCORD_START_MODE = $previousMode }
            }
        }
        OpenBridgeProcess = {
            param([Parameter(Mandatory)][int]$ProcessId)
            $process = Get-Process -Id $ProcessId -ErrorAction Stop
            [void]$process.Handle
            return [pscustomobject]@{ ProcessId=$process.Id; StartTimeUtc=$process.StartTime.ToUniversalTime(); Process=$process }
        }
        CloseBridgeProcess = { param($BoundProcess) $BoundProcess.Process.Dispose() }
        StopRuntimeTree = {
            param([Parameter(Mandatory)][object]$BoundProcess)
            $BoundProcess.Process.Kill($true)
        }
        WaitForRuntimeExit = {
            param([Parameter(Mandatory)][object]$BoundProcess, [Parameter(Mandatory)][int]$Milliseconds)
            return $BoundProcess.Process.WaitForExit($Milliseconds)
        }
        WaitForRuntimeRelease = {
            param([Parameter(Mandatory)][int]$Milliseconds)
            try {
                $mutex = [System.Threading.Mutex]::OpenExisting('Local\CodexDiscordBridge')
            }
            catch [System.Threading.WaitHandleCannotBeOpenedException] { return $true }
            try {
                $owned = $false
                try { $owned = $mutex.WaitOne($Milliseconds) }
                catch [System.Threading.AbandonedMutexException] { $owned = $true }
                if (-not $owned) { return $false }
                $mutex.ReleaseMutex()
                return $true
            }
            finally { $mutex.Dispose() }
        }
        OpenBridgeJob = { param([string]$ToolDir) Initialize-BridgeJobNative; $h=[CodexBridgeJobNative]::OpenJobObject(0xC,$false,(Get-BridgeJobName $ToolDir)); if($h -eq [IntPtr]::Zero){throw 'bridge-job-open-failed'}; [pscustomobject]@{Handle=$h} }
        TestBridgeJobMembership = { param($Job,$Bound) $v=$false; if(-not [CodexBridgeJobNative]::IsProcessInJob($Bound.Process.Handle,$Job.Handle,[ref]$v)){throw 'bridge-job-membership-failed'}; $v }
        TerminateBridgeJob = { param($Job) if(-not [CodexBridgeJobNative]::TerminateJobObject($Job.Handle,1)){throw 'bridge-job-terminate-failed'} }
        GetBridgeJobActiveProcesses = { param($Job) $a=New-Object CodexBridgeJobNative+Accounting; if(-not [CodexBridgeJobNative]::QueryInformationJobObject($Job.Handle,1,[ref]$a,[Runtime.InteropServices.Marshal]::SizeOf($a),[IntPtr]::Zero)){throw 'bridge-job-query-failed'}; [int]$a.ActiveProcesses }
        CloseBridgeJob = { param($Job) Close-BridgeJob $Job.Handle }
    }
}

function ConvertFrom-CodexControlCommandLine {
    [CmdletBinding()]
    param([AllowEmptyString()][string]$Arguments)

    $tokens = [System.Collections.Generic.List[string]]::new()
    $current = [System.Text.StringBuilder]::new()
    $quoted = $false
    $tokenStarted = $false
    foreach ($character in $Arguments.ToCharArray()) {
        if ($character -eq '"') {
            $quoted = -not $quoted
            $tokenStarted = $true
            continue
        }
        if ([char]::IsWhiteSpace($character) -and -not $quoted) {
            if ($tokenStarted) {
                $tokens.Add($current.ToString())
                [void]$current.Clear()
                $tokenStarted = $false
            }
            continue
        }
        [void]$current.Append($character)
        $tokenStarted = $true
    }
    if ($quoted) { return $null }
    if ($tokenStarted) { $tokens.Add($current.ToString()) }
    return @($tokens)
}

function Test-CodexNotificationGuardTaskIdentity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Task,
        [Parameter(Mandatory)][string]$ToolDir,
        [Parameter(Mandatory)][string]$PowerShellPath,
        [Parameter(Mandatory)][object]$CurrentUserIdentity
    )

    try {
        if (-not ([string]$Task.taskPath).Equals('\', [System.StringComparison]::Ordinal) -or
            -not ([string]$Task.taskName).Equals('Codex ntfy Notification Guard', [System.StringComparison]::Ordinal)) { return $false }
        if ([string]::IsNullOrWhiteSpace([string]$Task.definitionXml)) { return $false }
        $trustedPowerShell = [System.IO.Path]::GetFullPath($PowerShellPath)
        $expectedScript = [System.IO.Path]::GetFullPath((Join-Path $ToolDir 'watch-notify.ps1'))
        $trustedWorkingDirectory = [System.IO.Path]::GetFullPath($ToolDir).TrimEnd('\','/')
        $testAction = {
            param([object]$Action)
            try {
                $execute = [System.IO.Path]::GetFullPath([string]$Action.Execute)
                if (-not $execute.Equals($trustedPowerShell, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
                $workingDirectory = [string]$Action.WorkingDirectory
                if (-not [string]::IsNullOrWhiteSpace($workingDirectory) -and
                    -not [System.IO.Path]::GetFullPath($workingDirectory).TrimEnd('\','/').Equals($trustedWorkingDirectory, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
                $arguments = @(ConvertFrom-CodexControlCommandLine -Arguments ([string]$Action.Arguments))
                if ($null -eq $arguments -or $arguments.Count -lt 3) { return $false }
                $sawNoProfile = $false
                $sawNonInteractive = $false
                $sawWindowStyle = $false
                for ($index = 0; $index -lt $arguments.Count; $index++) {
                    $argument = [string]$arguments[$index]
                    if ($argument.Equals('-NoProfile', [System.StringComparison]::OrdinalIgnoreCase) -and -not $sawNoProfile) { $sawNoProfile=$true; continue }
                    if ($argument.Equals('-NonInteractive', [System.StringComparison]::OrdinalIgnoreCase) -and -not $sawNonInteractive) { $sawNonInteractive=$true; continue }
                    if ($argument.Equals('-WindowStyle', [System.StringComparison]::OrdinalIgnoreCase) -and -not $sawWindowStyle) {
                        if (($index + 1) -ge $arguments.Count -or -not ([string]$arguments[$index + 1]).Equals('Hidden', [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
                        $sawWindowStyle=$true; $index++; continue
                    }
                    if ($argument.Equals('-File', [System.StringComparison]::OrdinalIgnoreCase)) {
                        if (-not $sawNoProfile -or ($index + 2) -ne $arguments.Count) { return $false }
                        $scriptPath = [System.IO.Path]::GetFullPath([string]$arguments[$index + 1])
                        return $scriptPath.Equals($expectedScript, [System.StringComparison]::OrdinalIgnoreCase)
                    }
                    return $false
                }
                return $false
            }
            catch { return $false }
        }.GetNewClosure()

        $actions = @($Task.actions)
        if ($actions.Count -ne 1 -or -not (& $testAction $actions[0])) { return $false }

        $document = [System.Xml.XmlDocument]::new()
        $document.PreserveWhitespace = $false
        $document.LoadXml([string]$Task.definitionXml)
        $namespace = [System.Xml.XmlNamespaceManager]::new($document.NameTable)
        $namespace.AddNamespace('task', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
        if ($document.DocumentElement.LocalName -cne 'Task' -or $document.DocumentElement.NamespaceURI -cne 'http://schemas.microsoft.com/windows/2004/02/mit/task') { return $false }

        $principals = @($document.SelectNodes('/task:Task/task:Principals/task:Principal', $namespace))
        if ($principals.Count -ne 1) { return $false }
        $principal = $principals[0]
        $principalId = [string]$principal.GetAttribute('id')
        if ([string]::IsNullOrWhiteSpace($principalId)) { return $false }
        $principalUser = [string]$principal.SelectSingleNode('task:UserId', $namespace).InnerText
        $trustedUsers = @([string]$CurrentUserIdentity.Name, [string]$CurrentUserIdentity.Sid) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        if ($trustedUsers.Count -eq 0 -or -not @($trustedUsers | Where-Object { $principalUser.Equals($_, [System.StringComparison]::OrdinalIgnoreCase) }).Count) { return $false }
        if ([string]$principal.SelectSingleNode('task:LogonType', $namespace).InnerText -cne 'InteractiveToken') { return $false }
        $runLevel = $principal.SelectSingleNode('task:RunLevel', $namespace)
        # Task Scheduler's schema default is LeastPrivilege when RunLevel is omitted.
        if ($null -ne $runLevel -and [string]$runLevel.InnerText -cne 'LeastPrivilege') { return $false }

        $triggers = @($document.SelectNodes('/task:Task/task:Triggers/*', $namespace))
        if ($triggers.Count -ne 1 -or $triggers[0].LocalName -cne 'LogonTrigger') { return $false }
        $triggerEnabled = $triggers[0].SelectSingleNode('task:Enabled', $namespace)
        if ($null -ne $triggerEnabled -and ([string]$triggerEnabled.InnerText).Equals('false', [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
        $triggerUser = $triggers[0].SelectSingleNode('task:UserId', $namespace)
        if ($null -ne $triggerUser -and -not @($trustedUsers | Where-Object { ([string]$triggerUser.InnerText).Equals($_, [System.StringComparison]::OrdinalIgnoreCase) }).Count) { return $false }

        $settings = @($document.SelectNodes('/task:Task/task:Settings', $namespace))
        if ($settings.Count -ne 1) { return $false }
        $multipleInstances = $settings[0].SelectSingleNode('task:MultipleInstancesPolicy', $namespace)
        if ($null -eq $multipleInstances -or [string]$multipleInstances.InnerText -cne 'IgnoreNew') { return $false }
        $allowDemandStart = $settings[0].SelectSingleNode('task:AllowStartOnDemand', $namespace)
        if ($null -ne $allowDemandStart -and -not ([string]$allowDemandStart.InnerText).Equals('true', [System.StringComparison]::OrdinalIgnoreCase)) { return $false }

        $xmlActions = @($document.SelectNodes('/task:Task/task:Actions/*', $namespace))
        if ($xmlActions.Count -ne 1 -or $xmlActions[0].LocalName -cne 'Exec') { return $false }
        $actionsParent = $xmlActions[0].ParentNode
        if (-not ([string]$actionsParent.GetAttribute('Context')).Equals($principalId, [System.StringComparison]::Ordinal)) { return $false }
        $xmlCommand = $xmlActions[0].SelectSingleNode('task:Command', $namespace)
        $xmlArguments = $xmlActions[0].SelectSingleNode('task:Arguments', $namespace)
        $xmlWorkingDirectory = $xmlActions[0].SelectSingleNode('task:WorkingDirectory', $namespace)
        if ($null -eq $xmlCommand -or $null -eq $xmlArguments) { return $false }
        $xmlAction = [pscustomobject]@{
            Execute = [string]$xmlCommand.InnerText
            Arguments = [string]$xmlArguments.InnerText
            WorkingDirectory = if ($null -eq $xmlWorkingDirectory) { '' } else { [string]$xmlWorkingDirectory.InnerText }
        }
        if (-not (& $testAction $xmlAction)) { return $false }
        return $true
    }
    catch { return $false }
}

function Get-CodexNotificationGuardDefinitionHash {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$DefinitionXml,
        [string]$TaskPath = '\',
        [string]$TaskName = 'Codex ntfy Notification Guard'
    )

    try {
        $document = [System.Xml.XmlDocument]::new()
        $document.PreserveWhitespace = $false
        $document.LoadXml($DefinitionXml)
        $namespace = [System.Xml.XmlNamespaceManager]::new($document.NameTable)
        $namespace.AddNamespace('task', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
        foreach ($enabledNode in @($document.SelectNodes('//task:Settings/task:Enabled', $namespace))) {
            [void]$enabledNode.ParentNode.RemoveChild($enabledNode)
        }
        $identityText = $TaskPath + "`n" + $TaskName + "`n" + $document.OuterXml
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($identityText)
        return [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    }
    catch { return $null }
}

function Get-CodexNotificationGuardStatus {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Operations,
        [Parameter(Mandatory)][string]$ToolDir
    )

    foreach ($name in @('GetNotificationGuardTask','GetPowerShellPath','GetCurrentUserIdentity')) {
        if (-not $Operations.ContainsKey($name) -or $Operations[$name] -isnot [scriptblock]) {
            return [pscustomobject]@{ ok=$false; errorCategory='invalid-guard-operations' }
        }
    }
    try {
        $task = & $Operations.GetNotificationGuardTask
        if ($null -eq $task) {
            return [pscustomobject][ordered]@{ ok=$true; exists=$false; trusted=$true; enabled=$false; running=$false }
        }
        $trusted = Test-CodexNotificationGuardTaskIdentity -Task $task -ToolDir $ToolDir -PowerShellPath (& $Operations.GetPowerShellPath) -CurrentUserIdentity (& $Operations.GetCurrentUserIdentity)
        $definitionHash = Get-CodexNotificationGuardDefinitionHash -DefinitionXml ([string]$task.definitionXml) -TaskPath ([string]$task.taskPath) -TaskName ([string]$task.taskName)
        if ([string]::IsNullOrWhiteSpace($definitionHash)) { $trusted = $false }
        return [pscustomobject][ordered]@{
            ok = $true
            exists = $true
            trusted = [bool]$trusted
            enabled = [bool]$task.enabled
            running = [bool]$task.running
            definitionHash = $definitionHash
        }
    }
    catch { return [pscustomobject]@{ ok=$false; errorCategory='guard-status-failed' } }
}

function Invoke-CodexNotificationGuardAction {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('stop','start','enable','disable')][string]$Action,
        [Parameter(Mandatory)][hashtable]$Operations,
        [Parameter(Mandatory)][string]$ToolDir,
        [ValidateRange(1,100)][int]$PollAttempts = 10,
        [ValidateRange(0,30000)][int]$PollMilliseconds = 100
    )

    $operationByAction = @{
        stop='StopNotificationGuardTask'; start='StartNotificationGuardTask'
        enable='EnableNotificationGuardTask'; disable='DisableNotificationGuardTask'
    }
    $operationName = $operationByAction[$Action]
    if (-not $Operations.ContainsKey($operationName) -or $Operations[$operationName] -isnot [scriptblock]) {
        return [pscustomobject]@{ ok=$false; action=$Action; errorCategory='invalid-guard-operations' }
    }
    $initial = Get-CodexNotificationGuardStatus -Operations $Operations -ToolDir $ToolDir
    if (-not $initial.ok) { return [pscustomobject]@{ ok=$false; action=$Action; errorCategory=$initial.errorCategory } }
    if (-not $initial.exists) { return [pscustomobject]@{ ok=$false; action=$Action; errorCategory='guard-task-missing' } }
    if (-not $initial.trusted) { return [pscustomobject]@{ ok=$false; action=$Action; errorCategory='guard-identity-untrusted' } }

    $needsAction = switch ($Action) {
        stop { $initial.running }
        start { -not $initial.running }
        enable { -not $initial.enabled }
        disable { $initial.enabled }
    }
    try {
        if ($needsAction) { & $Operations[$operationName] }
        $final = $initial
        for ($attempt = 0; $attempt -lt $PollAttempts; $attempt++) {
            $final = Get-CodexNotificationGuardStatus -Operations $Operations -ToolDir $ToolDir
            $sameDefinition = $final.ok -and -not [string]::IsNullOrWhiteSpace([string]$final.definitionHash) -and
                ([string]$final.definitionHash).Equals([string]$initial.definitionHash, [System.StringComparison]::OrdinalIgnoreCase)
            $complete = $final.ok -and $final.exists -and $final.trusted -and $sameDefinition -and $(switch ($Action) {
                stop { -not $final.running -and $final.enabled -eq $initial.enabled }
                start { $final.running -and $final.enabled -eq $initial.enabled }
                enable { $final.enabled -and $final.running -eq $initial.running }
                disable { -not $final.enabled -and $final.running -eq $initial.running }
            })
            if ($complete) { return [pscustomobject][ordered]@{ ok=$true; action=$Action; guard=$final } }
            if ($attempt -lt ($PollAttempts - 1) -and $Operations.ContainsKey('Sleep')) { & $Operations.Sleep $PollMilliseconds }
        }
        return [pscustomobject][ordered]@{ ok=$false; action=$Action; errorCategory='guard-action-incomplete'; guard=$final }
    }
    catch {
        $fresh = Get-CodexNotificationGuardStatus -Operations $Operations -ToolDir $ToolDir
        return [pscustomobject][ordered]@{ ok=$false; action=$Action; errorCategory='guard-action-failed'; guard=$fresh }
    }
}

function Test-CodexBridgeBoundRuntimeIdentity {
    [CmdletBinding()]
    param([Parameter(Mandatory)][object]$BoundProcess, [Parameter(Mandatory)][object]$Runtime)

    $processId = Get-ControlProcessProperty -Process $BoundProcess -Name 'ProcessId'
    $actualTime = ConvertTo-BridgeRuntimeTimeUtc -Value (Get-ControlProcessProperty -Process $BoundProcess -Name 'StartTimeUtc')
    $expectedTime = ConvertTo-BridgeRuntimeTimeUtc -Value $Runtime.creationTimeUtc
    return ($null -ne $processId -and [int]$processId -eq [int]$Runtime.processId -and $null -ne $actualTime -and $null -ne $expectedTime -and $actualTime.UtcDateTime.Ticks -eq $expectedTime.UtcDateTime.Ticks)
}

function Stop-CodexBridgeRuntime {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Runtime,
        [Parameter(Mandatory)][hashtable]$Operations,
        [string]$ToolDir,
        [scriptblock]$BeforeTerminate,
        [ValidateRange(1,30000)][int]$TimeoutMilliseconds = 5000
    )

    $required = if ($Operations.ContainsKey('OpenBridgeJob')) { @('OpenBridgeProcess','OpenBridgeJob','TestBridgeJobMembership','TerminateBridgeJob','GetBridgeJobActiveProcesses','WaitForRuntimeRelease','CloseBridgeJob') } else { @('OpenBridgeProcess','StopRuntimeTree','WaitForRuntimeExit','WaitForRuntimeRelease') }
    foreach ($name in $required) {
        if (-not $Operations.ContainsKey($name) -or $Operations[$name] -isnot [scriptblock]) { return [pscustomobject]@{ ok=$false; errorCategory='invalid-service-operations' } }
    }
    $bound = $null
    $job = $null
    try {
        $bound = & $Operations.OpenBridgeProcess ([int]$Runtime.processId)
        if (-not (Test-CodexBridgeBoundRuntimeIdentity -BoundProcess $bound -Runtime $Runtime)) { return [pscustomobject]@{ ok=$false; errorCategory='runtime-identity-revalidation-failed' } }
        if ($Operations.ContainsKey('OpenBridgeJob') -and $Operations.OpenBridgeJob -is [scriptblock]) {
            $job=& $Operations.OpenBridgeJob $ToolDir
            try {
                if(-not (& $Operations.TestBridgeJobMembership $job $bound)){return [pscustomobject]@{ok=$false;errorCategory='runtime-job-membership-failed'}}
                if ($null -ne $BeforeTerminate) { & $BeforeTerminate }
                & $Operations.TerminateBridgeJob $job
                $deadline=[Environment]::TickCount64+$TimeoutMilliseconds
                do { if((& $Operations.GetBridgeJobActiveProcesses $job) -eq 0){break}; if([Environment]::TickCount64 -ge $deadline){return [pscustomobject]@{ok=$false;errorCategory='runtime-stop-timeout'}}; if($Operations.ContainsKey('Sleep')){& $Operations.Sleep 10} } while($true)
                if(-not (& $Operations.WaitForRuntimeRelease ([Math]::Max(1,$deadline-[Environment]::TickCount64)))){return [pscustomobject]@{ok=$false;errorCategory='runtime-release-timeout'}}
                return [pscustomobject]@{ok=$true}
            } finally { & $Operations.CloseBridgeJob $job }
        }
        $descendants = @()
        if ($Operations.ContainsKey('GetBridgeDescendants') -and $Operations.GetBridgeDescendants -is [scriptblock]) {
            $descendants = @(& $Operations.GetBridgeDescendants $bound)
            foreach ($child in $descendants) {
                if ($null -eq $child -or $null -eq (Get-ControlProcessProperty -Process $child -Name 'ProcessId') -or $null -eq (Get-ControlProcessProperty -Process $child -Name 'StartTimeUtc')) { return [pscustomobject]@{ ok=$false; errorCategory='runtime-tree-unverifiable' } }
            }
        }
        & $Operations.StopRuntimeTree $bound
        if ($descendants.Count -gt 0 -and $Operations.ContainsKey('StopBoundProcess') -and $Operations.StopBoundProcess -is [scriptblock]) { foreach ($child in $descendants) { & $Operations.StopBoundProcess $child } }
        foreach ($process in @($bound) + @($descendants)) { if (-not (& $Operations.WaitForRuntimeExit $process $TimeoutMilliseconds)) { return [pscustomobject]@{ ok=$false; errorCategory='runtime-stop-timeout' } } }
        if (-not (& $Operations.WaitForRuntimeRelease $TimeoutMilliseconds)) { return [pscustomobject]@{ ok=$false; errorCategory='runtime-release-timeout' } }
        return [pscustomobject]@{ ok=$true }
    }
    catch { return [pscustomobject]@{ ok=$false; errorCategory='runtime-stop-failed' } }
    finally { if ($null -ne $bound -and $Operations.ContainsKey('CloseBridgeProcess')) { try { & $Operations.CloseBridgeProcess $bound } catch {} } }
}

function Test-CodexBridgeJobOperations { param([hashtable]$Operations) foreach($name in @('OpenBridgeJob','TestBridgeJobMembership','TerminateBridgeJob','GetBridgeJobActiveProcesses','WaitForRuntimeRelease','CloseBridgeJob')){if(-not $Operations.ContainsKey($name) -or $Operations[$name] -isnot [scriptblock]){return $false}};return $true }

function Get-CodexBridgeServiceStatus {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Operations,
        [Parameter(Mandatory)][string]$ToolDir
    )

    if (-not $Operations.ContainsKey('GetTask') -or $Operations.GetTask -isnot [scriptblock]) {
        return [pscustomobject]@{ ok=$false; errorCategory='invalid-service-operations' }
    }
    try {
        $task = & $Operations.GetTask
        if ($null -eq $task) {
            $task = [pscustomobject]@{ installed=$false; enabled=$false; running=$false; definitionCurrent=$false }
        }
        $taskDefinitionCurrent = if (-not [bool]$task.installed) {
            $false
        }
        elseif ($null -eq $task.PSObject.Properties['definitionCurrent']) {
            $true
        }
        else {
            [bool]$task.definitionCurrent
        }
        $runtime = $null
        if ($Operations.ContainsKey('GetRuntime') -and $Operations.GetRuntime -is [scriptblock]) { $runtime = & $Operations.GetRuntime }
        else {
            $candidate = Read-BridgeRuntimeIdentityCandidate -Path (Join-Path $ToolDir 'discord-bridge-runtime.json') -ToolDir $ToolDir
            if ($null -ne $candidate -and $Operations.ContainsKey('OpenBridgeProcess') -and $Operations.OpenBridgeProcess -is [scriptblock]) {
            try {
                $bound = & $Operations.OpenBridgeProcess ([int]$candidate.processId)
                try { if (Test-CodexBridgeBoundRuntimeIdentity -BoundProcess $bound -Runtime $candidate) { $runtime = $candidate } }
                finally { if ($Operations.ContainsKey('CloseBridgeProcess')) { & $Operations.CloseBridgeProcess $bound } }
                }
                catch {}
            }
        }
        return [pscustomobject][ordered]@{
            ok = $true
            taskInstalled = [bool]$task.installed
            taskDefinitionCurrent = $taskDefinitionCurrent
            autoStartEnabled = [bool]$task.enabled
            taskRunning = [bool]$task.running
            running = ($null -ne $runtime)
            runtime = $runtime
        }
    }
    catch {
        return [pscustomobject]@{ ok=$false; errorCategory='service-status-failed' }
    }
}

function Invoke-CodexBridgeServiceAction {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('start-temporary', 'stop-temporary', 'enable-long-term', 'disable-long-term')][string]$Action,
        [Parameter(Mandatory)][string]$ToolDir,
        [Parameter(Mandatory)][hashtable]$Operations,
        [ValidateRange(1,100)][int]$PollAttempts = 10,
        [ValidateRange(0,30000)][int]$PollMilliseconds = 250
    )

    $requiredByAction = @{
        'start-temporary' = @('GetTask', 'StartTask', 'StartDetached')
        'stop-temporary' = @('GetTask', 'StopTask')
        'enable-long-term' = @('GetTask', 'InstallTask', 'EnableTask', 'StartTask', 'StopTask')
        'disable-long-term' = @('GetTask', 'DisableTask', 'StopTask')
    }
    foreach ($operationName in $requiredByAction[$Action]) {
        if (-not $Operations.ContainsKey($operationName) -or $Operations[$operationName] -isnot [scriptblock]) {
            return [pscustomobject]@{ ok=$false; action=$Action; errorCategory='invalid-service-operations' }
        }
    }
    function New-ServiceActionFailure([string]$Category) {
        $fresh = Get-CodexBridgeServiceStatus -Operations $Operations -ToolDir $ToolDir
        if (-not $fresh.ok) { $fresh = [pscustomobject]@{ ok=$false; state='unknown'; errorCategory='service-status-unavailable' } }
        return [pscustomobject]@{ ok=$false; action=$Action; errorCategory=$Category; service=$fresh }
    }
    $status = Get-CodexBridgeServiceStatus -Operations $Operations -ToolDir $ToolDir
    if (-not $status.ok) { return [pscustomobject]@{ ok=$false; action=$Action; errorCategory=$status.errorCategory } }
    try {
        $startupPath = Join-Path ([System.IO.Path]::GetFullPath($ToolDir)) 'start-discord-bridge.ps1'
        switch ($Action) {
            'start-temporary' {
                if (-not $status.running) {
                    if ($status.autoStartEnabled) { & $Operations.StartTask }
                    else { & $Operations.StartDetached $startupPath 'temporary' }
                }
            }
            'stop-temporary' {
                if ($status.runtime -and $status.runtime.mode -eq 'scheduled') { if($Operations.ContainsKey('OpenBridgeJob')){$stopped=Stop-CodexBridgeRuntime -Runtime $status.runtime -Operations $Operations -ToolDir $ToolDir -BeforeTerminate { & $Operations.StopTask } -TimeoutMilliseconds ($PollAttempts*[Math]::Max(1,$PollMilliseconds));if(-not $stopped.ok){return New-ServiceActionFailure $stopped.errorCategory}}else{& $Operations.StopTask} }
                elseif ($status.running) {
                    if (Test-CodexBridgeJobOperations $Operations) { $stopped = Stop-CodexBridgeRuntime -Runtime $status.runtime -Operations $Operations -ToolDir $ToolDir -TimeoutMilliseconds ($PollAttempts * [Math]::Max(1,$PollMilliseconds)); if (-not $stopped.ok) { return New-ServiceActionFailure $stopped.errorCategory } }
                    else { & $Operations.StopRuntime $status.runtime }
                }
                elseif ($status.taskRunning) { & $Operations.StopTask }
            }
            'enable-long-term' {
                $taskDefinitionNeedsUpgrade = $status.taskInstalled -and -not $status.taskDefinitionCurrent
                if ($taskDefinitionNeedsUpgrade -and $status.runtime -and $status.runtime.mode -eq 'scheduled') {
                    if (Test-CodexBridgeJobOperations $Operations) {
                        $stopped = Stop-CodexBridgeRuntime -Runtime $status.runtime -Operations $Operations -ToolDir $ToolDir -BeforeTerminate { & $Operations.StopTask } -TimeoutMilliseconds ($PollAttempts * [Math]::Max(1,$PollMilliseconds))
                        if (-not $stopped.ok) { return New-ServiceActionFailure $stopped.errorCategory }
                    }
                    else {
                        & $Operations.StopTask
                    }
                }
                elseif ($taskDefinitionNeedsUpgrade -and $status.taskRunning) {
                    & $Operations.StopTask
                }
                if (-not $status.taskInstalled -or $taskDefinitionNeedsUpgrade) {
                    & $Operations.InstallTask
                    $status = Get-CodexBridgeServiceStatus -Operations $Operations -ToolDir $ToolDir
                    if (-not $status.ok) { return New-ServiceActionFailure 'service-status-failed' }
                }
                if (-not $status.autoStartEnabled) { & $Operations.EnableTask }
                if ($null -ne $status.runtime -and $status.runtime.mode -eq 'temporary') {
                    if (Test-CodexBridgeJobOperations $Operations) { $stopped = Stop-CodexBridgeRuntime -Runtime $status.runtime -Operations $Operations -ToolDir $ToolDir -TimeoutMilliseconds ($PollAttempts * [Math]::Max(1,$PollMilliseconds)); if (-not $stopped.ok) { return New-ServiceActionFailure $stopped.errorCategory } }
                    else { & $Operations.StopRuntime $status.runtime }
                }
                if (-not $status.running -or $null -eq $status.runtime -or $status.runtime.mode -ne 'scheduled') { & $Operations.StartTask }
            }
            'disable-long-term' {
                if ($status.taskInstalled) { & $Operations.DisableTask }
                if ($status.runtime -and $status.runtime.mode -eq 'scheduled') { if($Operations.ContainsKey('OpenBridgeJob')){$stopped=Stop-CodexBridgeRuntime -Runtime $status.runtime -Operations $Operations -ToolDir $ToolDir -BeforeTerminate { & $Operations.StopTask } -TimeoutMilliseconds ($PollAttempts*[Math]::Max(1,$PollMilliseconds));if(-not $stopped.ok){return New-ServiceActionFailure $stopped.errorCategory}}else{& $Operations.StopTask} }
                elseif ($status.running) {
                    if (Test-CodexBridgeJobOperations $Operations) { $stopped = Stop-CodexBridgeRuntime -Runtime $status.runtime -Operations $Operations -ToolDir $ToolDir -TimeoutMilliseconds ($PollAttempts * [Math]::Max(1,$PollMilliseconds)); if (-not $stopped.ok) { return New-ServiceActionFailure $stopped.errorCategory } }
                    else { & $Operations.StopRuntime $status.runtime }
                }
                elseif ($status.taskRunning) { & $Operations.StopTask }
            }
        }
        $finalStatus = $null
        for ($attempt = 0; $attempt -lt $PollAttempts; $attempt++) {
            $finalStatus = Get-CodexBridgeServiceStatus -Operations $Operations -ToolDir $ToolDir
            $complete = $finalStatus.ok -and $(switch ($Action) {
                'start-temporary' { $finalStatus.running -and $finalStatus.autoStartEnabled -eq $status.autoStartEnabled }
                'stop-temporary' { -not $finalStatus.running -and -not $finalStatus.taskRunning -and $finalStatus.autoStartEnabled -eq $status.autoStartEnabled }
                'enable-long-term' { $finalStatus.taskDefinitionCurrent -and $finalStatus.autoStartEnabled -and $finalStatus.running -and $finalStatus.runtime.mode -eq 'scheduled' }
                'disable-long-term' { -not $finalStatus.autoStartEnabled -and -not $finalStatus.running -and -not $finalStatus.taskRunning }
            })
            if ($complete) { return [pscustomobject][ordered]@{ ok=$true; action=$Action; service=$finalStatus } }
            if ($attempt -lt ($PollAttempts - 1) -and $Operations.ContainsKey('Sleep') -and $Operations.Sleep -is [scriptblock]) { & $Operations.Sleep $PollMilliseconds }
        }
        if ($null -eq $finalStatus -or -not $finalStatus.ok) { $finalStatus = [pscustomobject]@{ ok=$false; state='unknown'; errorCategory='service-status-unavailable' } }
        return [pscustomobject][ordered]@{ ok=$false; action=$Action; errorCategory='service-action-incomplete'; service=$finalStatus }
    }
    catch { return New-ServiceActionFailure 'service-action-failed' }
}

function Test-CodexBoundProcessIdentity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$BoundProcess,
        [Parameter(Mandatory)][int]$ProcessId,
        [Parameter(Mandatory)][object]$CreationDate
    )

    $boundProcessId = Get-ControlProcessProperty -Process $BoundProcess -Name 'ProcessId'
    $boundCreationDate = Get-ControlProcessProperty -Process $BoundProcess -Name 'CreationDate'
    if ($null -eq $boundProcessId -or [int]$boundProcessId -ne $ProcessId) {
        return $false
    }
    if ($null -ne $boundCreationDate) {
        return ([string]$boundCreationDate -ceq $CreationDate)
    }

    $startTimeUtc = Get-ControlProcessProperty -Process $BoundProcess -Name 'StartTimeUtc'
    $expectedTimeUtc = ConvertTo-ControlCreationTime -Value $CreationDate
    if ($null -eq $startTimeUtc -or $null -eq $expectedTimeUtc) {
        return $false
    }
    try {
        $actualTimeUtc = ([DateTimeOffset]$startTimeUtc).ToUniversalTime()
        $actualCimTicks = $actualTimeUtc.Ticks - ($actualTimeUtc.Ticks % 10)
        $expectedCimTicks = $expectedTimeUtc.Ticks - ($expectedTimeUtc.Ticks % 10)
        return $actualCimTicks -eq $expectedCimTicks
    }
    catch {
        return $false
    }
}

function Stop-CodexDesktop {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Operations,
        [ValidateRange(0,10000)][int]$GraceMilliseconds = 3000
    )

    foreach ($requiredOperation in @('GetProcesses', 'OpenProcess', 'RequestClose', 'StopProcess', 'Sleep')) {
        if (-not $Operations.ContainsKey($requiredOperation) -or $Operations[$requiredOperation] -isnot [scriptblock]) {
            return [pscustomobject]@{ ok=$false; errorCategory='invalid-control-operations' }
        }
    }

    try {
        $before = @(& $Operations.GetProcesses)
        $beforePlan = Get-CodexDesktopProcessPlan -Processes $before
        if (-not $beforePlan.IsValid) {
            return [pscustomobject]@{ ok=$false; errorCategory=$beforePlan.ErrorCategory; stoppedProcessCount=0 }
        }
        if (@($beforePlan.Roots).Count -eq 0) {
            return [pscustomobject]@{ ok=$true; alreadyStopped=$true; stoppedProcessCount=0 }
        }
        foreach ($root in @($beforePlan.Roots)) {
            $boundRoot = & $Operations.OpenProcess $root.ProcessId
            if (-not (Test-CodexBoundProcessIdentity -BoundProcess $boundRoot -ProcessId $root.ProcessId -CreationDate $beforePlan.CreationTimes[[int]$root.ProcessId])) {
                return [pscustomobject]@{ ok=$false; errorCategory='process-revalidation-failed'; stoppedProcessCount=0 }
            }
            [void](& $Operations.RequestClose $boundRoot)
        }
        [void](& $Operations.Sleep $GraceMilliseconds)

        $after = @(& $Operations.GetProcesses)
        $afterPlan = Get-CodexDesktopProcessPlan -Processes $after
        if (-not $afterPlan.IsValid) {
            return [pscustomobject]@{ ok=$false; errorCategory=$afterPlan.ErrorCategory; stoppedProcessCount=0 }
        }
        $beforeRootCreationTimes = @{}
        foreach ($root in @($beforePlan.Roots)) {
            $beforeRootCreationTimes[[string]$root.ProcessId] = $beforePlan.CreationTimes[[int]$root.ProcessId]
        }
        foreach ($root in @($afterPlan.Roots)) {
            $key = [string]$root.ProcessId
            if ($beforeRootCreationTimes.ContainsKey($key) -and $afterPlan.CreationTimes[[int]$root.ProcessId] -cne $beforeRootCreationTimes[$key]) {
                return [pscustomobject]@{ ok=$false; errorCategory='process-revalidation-failed'; stoppedProcessCount=0 }
            }
        }

        $survivingRootIds = @($afterPlan.Roots | Where-Object {
            $key = [string]$_.ProcessId
            $beforeRootCreationTimes.ContainsKey($key) -and $afterPlan.CreationTimes[[int]$_.ProcessId] -ceq $beforeRootCreationTimes[$key]
        } | ForEach-Object { [int]$_.ProcessId })
        if ($survivingRootIds.Count -eq 0) {
            return [pscustomobject]@{ ok=$true; alreadyStopped=$true; stoppedProcessCount=0 }
        }

        $stoppedCount = 0
        foreach ($processId in @($afterPlan.StopProcessIds)) {
            if ($survivingRootIds -notcontains [int]$afterPlan.RootByProcessId[[string]$processId]) {
                continue
            }
            $boundProcess = & $Operations.OpenProcess $processId
            if (-not (Test-CodexBoundProcessIdentity -BoundProcess $boundProcess -ProcessId $processId -CreationDate $afterPlan.CreationTimes[[int]$processId])) {
                return [pscustomobject]@{ ok=$false; errorCategory='process-revalidation-failed'; stoppedProcessCount=$stoppedCount }
            }
            [void](& $Operations.StopProcess $boundProcess)
            $stoppedCount++
        }
        return [pscustomobject]@{ ok=$true; alreadyStopped=$false; stoppedProcessCount=$stoppedCount }
    }
    catch {
        return [pscustomobject]@{ ok=$false; errorCategory='process-control-failed' }
    }
}

function Test-ControlHealthPropertySet {
    param([Parameter(Mandatory)][object]$Value, [Parameter(Mandatory)][string[]]$Names)
    if ($null -eq $Value) { return $false }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $expected = @($Names | Sort-Object)
    return (($actual -join '|') -ceq ($expected -join '|'))
}

function Test-ControlHealthState {
    param([object]$Value)
    return @('idle','connecting','ready','reconnecting','stopped','ok','offline','failed','unknown') -ccontains [string]$Value
}

function Test-ControlHealthCategory {
    param([object]$Value)
    return @('bridge-health-write-failed','startup-failed','gateway-timeout','gateway-frame-invalid','gateway-hello-invalid','gateway-reconnect-requested','gateway-disconnected','gateway-connect-failed','interaction-handler-failed','queue-retry-failed','channel-poll-failed','index-refresh-failed','rollout-poll-failed','rollout-state-save-failed','turn-completion-connection-lost','continuation-started','continuation-queued','message-ignored','unknown') -ccontains [string]$Value
}

function Read-SanitizedBridgeHealth {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ToolDir, [datetimeoffset]$Now = [datetimeoffset]::UtcNow)

    try {
        $root = [System.IO.Path]::GetFullPath($ToolDir)
        $path = Join-Path $root 'discord-bridge-health.json'
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
        $item = Get-Item -LiteralPath $path -ErrorAction Stop
        if ($item.Length -gt 65536) { return $null }
        $value = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -DateKind String -ErrorAction Stop
        if (-not (Test-ControlHealthPropertySet -Value $value -Names @('version','observedAt','gateway','discordRest','queueCount','startedAt','lastActivityAt','latestEventCategory'))) { return $null }
        if ([int]$value.version -ne 1 -or -not (Test-ControlHealthPropertySet -Value $value.gateway -Names @('state')) -or -not (Test-ControlHealthPropertySet -Value $value.discordRest -Names @('state'))) { return $null }
        if (-not (Test-ControlHealthState $value.gateway.state) -or -not (Test-ControlHealthState $value.discordRest.state) -or -not (Test-ControlHealthCategory $value.latestEventCategory)) { return $null }
        if ($value.queueCount -isnot [int] -and $value.queueCount -isnot [long]) { return $null }
        if ($value.queueCount -lt 0 -or $value.queueCount -gt 1000000) { return $null }
        $observed = [datetimeoffset]::Parse([string]$value.observedAt).ToUniversalTime()
        if (($Now.ToUniversalTime() - $observed).TotalSeconds -gt 30 -or ($observed - $Now.ToUniversalTime()).TotalSeconds -gt 5) { return $null }
        foreach ($timestamp in @($value.startedAt, $value.lastActivityAt)) { if ($null -ne $timestamp) { [void][datetimeoffset]::Parse([string]$timestamp) } }
        return [pscustomobject][ordered]@{ gatewayState=[string]$value.gateway.state; discordRestState=[string]$value.discordRest.state; queueCount=[int]$value.queueCount; lastActivityAt=$value.lastActivityAt; latestEventCategory=[string]$value.latestEventCategory }
    }
    catch { return $null }
}

function Read-BridgeQueueState {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ToolDir)

    try {
        $root = [System.IO.Path]::GetFullPath($ToolDir)
        $path = Join-Path $root 'discord-inbox-state.json'
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return [pscustomobject]@{ state='unknown'; count=0 } }
        $item = Get-Item -LiteralPath $path -ErrorAction Stop
        if ($item.Length -gt 1048576) { return [pscustomobject]@{ state='unknown'; count=0 } }
        $value = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        if ($null -eq $value -or [int]$value.version -ne 2 -or $null -eq $value.pendingContinuations) { return [pscustomobject]@{ state='unknown'; count=0 } }
        $items = @($value.pendingContinuations.PSObject.Properties.Value)
        if (@($items | Where-Object { $null -eq $_ -or $_.PSObject.Properties.Name -notcontains 'status' }).Count -gt 0) { return [pscustomobject]@{ state='unknown'; count=0 } }
        return [pscustomobject]@{ state='ready'; count=@($items | Where-Object { [string]$_.status -ceq 'queued' }).Count }
    }
    catch { return [pscustomobject]@{ state='unknown'; count=0 } }
}

function Get-CodexControlStatus {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Operations,
        [Parameter(Mandatory)][string]$ToolDir
    )

    if (-not $Operations.ContainsKey('GetProcesses') -or $Operations.GetProcesses -isnot [scriptblock]) {
        return [pscustomobject]@{ ok=$false; errorCategory='invalid-control-operations' }
    }
    try {
        $plan = Get-CodexDesktopProcessPlan -Processes @(& $Operations.GetProcesses)
        if (-not $plan.IsValid) {
            return [pscustomobject]@{ ok=$false; errorCategory=$plan.ErrorCategory }
        }
        $service = [pscustomobject]@{ ok=$false; running=$false; autoStartEnabled=$false; runtime=$null }
        if ($Operations.ContainsKey('GetTask') -and $Operations.GetTask -is [scriptblock]) {
            $service = Get-CodexBridgeServiceStatus -Operations $Operations -ToolDir $ToolDir
        }
        $now = [datetimeoffset]::UtcNow
        if ($Operations.ContainsKey('Now') -and $Operations.Now -is [scriptblock]) { $now = [datetimeoffset](& $Operations.Now) }
        $health = Read-SanitizedBridgeHealth -ToolDir $ToolDir -Now $now
        if (-not ($service.ok -and $service.running)) { $health = $null }
        $queue = Read-BridgeQueueState -ToolDir $ToolDir
        $queueCount = if ($queue.state -eq 'ready') { [int]$queue.count } elseif ($null -ne $health) { [int]$health.queueCount } else { 0 }
        return [pscustomobject][ordered]@{
            ok = $true
            service = [pscustomobject][ordered]@{
                running = [bool]($service.ok -and $service.running)
                autoStartEnabled = [bool]($service.ok -and $service.autoStartEnabled)
                mode = $(if ($service.ok -and $null -ne $service.runtime -and $null -ne $service.runtime.mode) { [string]$service.runtime.mode } else { 'unknown' })
            }
            discord = [pscustomobject][ordered]@{
                state = $(if ($null -ne $health) { $health.gatewayState } else { 'unknown' })
                restState = $(if ($null -ne $health) { $health.discordRestState } else { 'unknown' })
                lastActivityAt = $(if ($null -ne $health) { $health.lastActivityAt } else { $null })
                healthState = $(if ($null -ne $health) { 'ready' } else { 'unknown' })
                queueState = $queue.state
            }
            desktop = [pscustomobject][ordered]@{
                running = (@($plan.Roots).Count -gt 0)
                processCount = @($plan.ProcessIds).Count
            }
            codexDesktop = [pscustomobject][ordered]@{
                running = (@($plan.Roots).Count -gt 0)
                processCount = @($plan.ProcessIds).Count
            }
            queueCount = $queueCount
        }
    }
    catch {
        return [pscustomobject]@{ ok=$false; errorCategory='control-status-failed' }
    }
}

function Invoke-CodexControlAction {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Action,
        [Parameter(Mandatory)][string]$ToolDir
    )

    $operations = New-CodexControlOperations
    switch ($Action) {
        'status' { return Get-CodexControlStatus -Operations $operations -ToolDir $ToolDir }
        'stop-codex' { return Stop-CodexDesktop -Operations $operations }
        'start-temporary' { return Invoke-CodexBridgeServiceAction -Action $Action -ToolDir $ToolDir -Operations $operations }
        'stop-temporary' { return Invoke-CodexBridgeServiceAction -Action $Action -ToolDir $ToolDir -Operations $operations }
        'enable-long-term' { return Invoke-CodexBridgeServiceAction -Action $Action -ToolDir $ToolDir -Operations $operations }
        'disable-long-term' { return Invoke-CodexBridgeServiceAction -Action $Action -ToolDir $ToolDir -Operations $operations }
        default { return [pscustomobject]@{ ok=$false; errorCategory='invalid-action' } }
    }
}
