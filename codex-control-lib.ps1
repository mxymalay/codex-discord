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
            if ($null -eq $task) { return [pscustomobject]@{ installed=$false; enabled=$false; running=$false } }
            $enabled = $true
            if ($null -ne $task.Settings -and $null -ne $task.Settings.PSObject.Properties['Enabled']) {
                $enabled = [bool]$task.Settings.Enabled
            }
            return [pscustomobject]@{ installed=$true; enabled=$enabled; running=($task.State -eq 'Running') }
        }
        InstallTask = {
            $installScript = Join-Path $PSScriptRoot 'install-discord-bridge-task.ps1'
            & $installScript | Out-Null
        }
        EnableTask = { Enable-ScheduledTask -TaskName 'Codex Discord Bridge' -ErrorAction Stop | Out-Null }
        DisableTask = { Disable-ScheduledTask -TaskName 'Codex Discord Bridge' -ErrorAction Stop | Out-Null }
        StartTask = { Start-ScheduledTask -TaskName 'Codex Discord Bridge' -ErrorAction Stop }
        StopTask = { Stop-ScheduledTask -TaskName 'Codex Discord Bridge' -ErrorAction Stop }
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
        StopRuntime = {
            param([Parameter(Mandatory)][object]$Runtime)
            $process = Get-Process -Id ([int]$Runtime.processId) -ErrorAction Stop
            $expectedTime = ConvertTo-BridgeRuntimeTimeUtc -Value $Runtime.creationTimeUtc
            $actualTime = ConvertTo-BridgeRuntimeTimeUtc -Value $process.StartTime
            if ($null -eq $expectedTime -or $null -eq $actualTime -or $expectedTime.UtcDateTime.Ticks -ne $actualTime.UtcDateTime.Ticks) {
                throw 'Bridge supervisor identity revalidation failed'
            }
            $process.Kill()
        }
        GetBridgeProcesses = {
            @(Get-Process -ErrorAction Stop | ForEach-Object {
                [pscustomobject]@{ ProcessId=$_.Id; CreationTimeUtc=$_.StartTime.ToUniversalTime() }
            })
        }
    }
}

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
            $task = [pscustomobject]@{ installed=$false; enabled=$false; running=$false }
        }
        $runtime = $null
        if ($Operations.ContainsKey('GetRuntime') -and $Operations.GetRuntime -is [scriptblock]) {
            $runtime = & $Operations.GetRuntime
        }
        else {
            $processes = @()
            if ($Operations.ContainsKey('GetBridgeProcesses') -and $Operations.GetBridgeProcesses -is [scriptblock]) {
                $processes = @(& $Operations.GetBridgeProcesses)
            }
            elseif ($Operations.ContainsKey('GetProcesses') -and $Operations.GetProcesses -is [scriptblock]) {
                $processes = @(& $Operations.GetProcesses)
            }
            $runtime = Read-ValidatedBridgeRuntimeIdentity -Path (Join-Path $ToolDir 'discord-bridge-runtime.json') -Processes $processes -ToolDir $ToolDir
        }
        return [pscustomobject][ordered]@{
            ok = $true
            taskInstalled = [bool]$task.installed
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
        [Parameter(Mandatory)][hashtable]$Operations
    )

    $requiredByAction = @{
        'start-temporary' = @('GetTask', 'StartTask', 'StartDetached')
        'stop-temporary' = @('GetTask', 'StopTask', 'StopRuntime')
        'enable-long-term' = @('GetTask', 'InstallTask', 'EnableTask', 'StartTask', 'StopRuntime')
        'disable-long-term' = @('GetTask', 'DisableTask', 'StopTask', 'StopRuntime')
    }
    foreach ($operationName in $requiredByAction[$Action]) {
        if (-not $Operations.ContainsKey($operationName) -or $Operations[$operationName] -isnot [scriptblock]) {
            return [pscustomobject]@{ ok=$false; action=$Action; errorCategory='invalid-service-operations' }
        }
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
                if ($status.running) { & $Operations.StopRuntime $status.runtime }
                elseif ($status.taskRunning) { & $Operations.StopTask }
            }
            'enable-long-term' {
                if (-not $status.taskInstalled) { & $Operations.InstallTask }
                & $Operations.EnableTask
                if ($null -ne $status.runtime -and $status.runtime.mode -eq 'temporary') { & $Operations.StopRuntime $status.runtime }
                & $Operations.StartTask
            }
            'disable-long-term' {
                if ($status.taskInstalled) { & $Operations.DisableTask }
                if ($status.running) { & $Operations.StopRuntime $status.runtime }
                elseif ($status.taskRunning) { & $Operations.StopTask }
            }
        }
        $finalStatus = Get-CodexBridgeServiceStatus -Operations $Operations -ToolDir $ToolDir
        return [pscustomobject][ordered]@{ ok=$finalStatus.ok; action=$Action; service=$finalStatus }
    }
    catch {
        return [pscustomobject]@{ ok=$false; action=$Action; errorCategory='service-action-failed' }
    }
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
        return [pscustomobject][ordered]@{
            ok = $true
            codexDesktop = [pscustomobject][ordered]@{
                running = (@($plan.Roots).Count -gt 0)
                processCount = @($plan.ProcessIds).Count
            }
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
