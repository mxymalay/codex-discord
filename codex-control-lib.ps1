Set-StrictMode -Version Latest

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

function ConvertTo-CodexDesktopProcessRecord {
    [CmdletBinding()]
    param([Parameter(Mandatory)][object]$Process)

    $rawProcessId = Get-ControlProcessProperty -Process $Process -Name 'ProcessId'
    $rawParentProcessId = Get-ControlProcessProperty -Process $Process -Name 'ParentProcessId'
    $rawCreationDate = Get-ControlProcessProperty -Process $Process -Name 'CreationDate'
    $processId = 0
    $parentProcessId = 0
    if ($null -eq $rawProcessId -or -not [int]::TryParse(([string]$rawProcessId), [ref]$processId) -or $processId -le 0) {
        return $null
    }
    if ($null -ne $rawParentProcessId -and -not [int]::TryParse(([string]$rawParentProcessId), [ref]$parentProcessId)) {
        return $null
    }
    if ($null -eq $rawCreationDate -or [string]::IsNullOrWhiteSpace([string]$rawCreationDate)) {
        return $null
    }

    return [pscustomobject]@{
        Process = $Process
        ProcessId = $processId
        ParentProcessId = $parentProcessId
        Name = [string](Get-ControlProcessProperty -Process $Process -Name 'Name')
        ExecutablePath = [string](Get-ControlProcessProperty -Process $Process -Name 'ExecutablePath')
        CreationDate = [string]$rawCreationDate
        PackageRoot = Get-CodexDesktopPackageRoot -Path ([string](Get-ControlProcessProperty -Process $Process -Name 'ExecutablePath'))
    }
}

function New-EmptyCodexDesktopProcessPlan {
    return [pscustomobject][ordered]@{
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
        $key = [string]$record.ProcessId
        if ($byProcessId.ContainsKey($key)) {
            return New-EmptyCodexDesktopProcessPlan
        }
        $byProcessId[$key] = $record
    }

    $roots = @($records | Where-Object {
        $_.Name -ieq 'ChatGPT.exe' -and
        (Test-CodexDesktopRootPath -Path $_.ExecutablePath) -and
        (-not $byProcessId.ContainsKey([string]$_.ParentProcessId) -or
            $null -eq $byProcessId[[string]$_.ParentProcessId].PackageRoot -or
            -not $byProcessId[[string]$_.ParentProcessId].PackageRoot.Equals($_.PackageRoot, [System.StringComparison]::OrdinalIgnoreCase))
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
        RequestClose = {
            param([int]$ProcessId, [string]$CreationDate)
            $current = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $ProcessId) -ErrorAction SilentlyContinue
            if ($null -eq $current -or [string]$current.CreationDate -cne $CreationDate) {
                return $false
            }
            try {
                return [bool]((Get-Process -Id $ProcessId -ErrorAction Stop).CloseMainWindow())
            }
            catch {
                return $false
            }
        }
        StopProcess = {
            param([int]$ProcessId, [string]$CreationDate)
            $current = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $ProcessId) -ErrorAction SilentlyContinue
            if ($null -eq $current -or [string]$current.CreationDate -cne $CreationDate) {
                throw 'process-revalidation-failed'
            }
            Stop-Process -Id $ProcessId -Force -ErrorAction Stop
        }
        Sleep = {
            param([int]$Milliseconds)
            Start-Sleep -Milliseconds $Milliseconds
        }
    }
}

function Stop-CodexDesktop {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Operations,
        [ValidateRange(0,10000)][int]$GraceMilliseconds = 3000
    )

    foreach ($requiredOperation in @('GetProcesses', 'RequestClose', 'StopProcess', 'Sleep')) {
        if (-not $Operations.ContainsKey($requiredOperation) -or $Operations[$requiredOperation] -isnot [scriptblock]) {
            return [pscustomobject]@{ ok=$false; errorCategory='invalid-control-operations' }
        }
    }

    try {
        $before = @(& $Operations.GetProcesses)
        $beforePlan = Get-CodexDesktopProcessPlan -Processes $before
        if (@($beforePlan.Roots).Count -eq 0) {
            return [pscustomobject]@{ ok=$true; alreadyStopped=$true; stoppedProcessCount=0 }
        }
        foreach ($root in @($beforePlan.Roots)) {
            [void](& $Operations.RequestClose $root.ProcessId $beforePlan.CreationTimes[[int]$root.ProcessId])
        }
        [void](& $Operations.Sleep $GraceMilliseconds)

        $after = @(& $Operations.GetProcesses)
        $afterPlan = Get-CodexDesktopProcessPlan -Processes $after
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
            [void](& $Operations.StopProcess $processId $afterPlan.CreationTimes[[int]$processId])
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
        'start-temporary' { return [pscustomobject]@{ ok=$false; action=$Action; errorCategory='service-control-unavailable' } }
        'stop-temporary' { return [pscustomobject]@{ ok=$false; action=$Action; errorCategory='service-control-unavailable' } }
        'enable-long-term' { return [pscustomobject]@{ ok=$false; action=$Action; errorCategory='service-control-unavailable' } }
        'disable-long-term' { return [pscustomobject]@{ ok=$false; action=$Action; errorCategory='service-control-unavailable' } }
        default { return [pscustomobject]@{ ok=$false; errorCategory='invalid-action' } }
    }
}
