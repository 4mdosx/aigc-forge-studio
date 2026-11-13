# ComfyUI process control.
#   infra\start.ps1
#   infra\start.ps1 -Foreground
#   infra\stop.ps1
#   infra\service.ps1 status
#   infra\service.ps1 restart

param(
    [Parameter(Position = 0)]
    [ValidateSet("start", "stop", "status", "restart")]
    [string]$Action = "status",

    [string]$Root = "C:\AIGC",

    [switch]$Foreground
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

$Runtime = Join-Path $Root "runtime\comfyui-prod"
$Python = Join-Path $Runtime ".venv\Scripts\python.exe"
$Infra = Join-Path $Root "infra"
$LogDir = Join-Path $Root "logs"
$PidFile = Join-Path $LogDir "comfyui.pid"
$OutLog = Join-Path $LogDir "comfyui.log"
$ErrLog = Join-Path $LogDir "comfyui.err.log"

$AppConfigPath = Join-Path $Infra "config.json"
if (-not (Test-Path -LiteralPath $AppConfigPath)) {
    throw "Missing config.json: $AppConfigPath"
}

$AppConfig = Get-Content -LiteralPath $AppConfigPath -Raw | ConvertFrom-Json
$Listen = if ($AppConfig.listen) { [string]$AppConfig.listen } else { "0.0.0.0" }
$Port = if ($AppConfig.port) { [int]$AppConfig.port } else { 8188 }
$BaseUrl = if ($AppConfig.baseURL) { ([string]$AppConfig.baseURL).TrimEnd("/") } else { "http://127.0.0.1:$Port" }

$ArgumentList = @(
    (Join-Path $Runtime "main.py"),
    "--listen", $Listen,
    "--port", "$Port",
    "--output-directory", (Join-Path $Root "outputs"),
    "--input-directory", (Join-Path $Root "input"),
    "--user-directory", (Join-Path $Root "user"),
    "--enable-manager"
)

function Show-Endpoint {
    Write-Host "URL: $BaseUrl"
    Write-Host "Listen: ${Listen}:$Port"
}

function Read-PidFile {
    if (-not (Test-Path -LiteralPath $PidFile)) {
        return $null
    }

    $text = (Get-Content -LiteralPath $PidFile -Raw).Trim()
    if ($text -match '^\d+$') {
        return [int]$text
    }
    return $null
}

function Get-ProcessCommandLine {
    param([int]$ProcessId)

    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($proc) {
        return [string]$proc.CommandLine
    }
    return ""
}

function Test-ComfyCommand {
    param([string]$Command)

    if (-not $Command) {
        return $false
    }

    $normalized = $Command.ToLower()
    if (-not $normalized.Contains("main.py")) {
        return $false
    }

    $markers = @(
        $Runtime,
        (Join-Path $Root "outputs"),
        (Join-Path $Root "user"),
        (Join-Path $Root "input")
    )
    foreach ($marker in $markers) {
        if ($normalized.Contains($marker.ToLower())) {
            return $true
        }
    }
    return $false
}

function Test-OurPython {
    param([int]$ProcessId)

    $current = $ProcessId
    for ($depth = 0; $depth -lt 6; $depth++) {
        $proc = Get-Process -Id $current -ErrorAction SilentlyContinue
        if (-not $proc) {
            return $false
        }

        if ($proc.Path -and ($proc.Path -ieq $Python)) {
            return $true
        }

        if (Test-ComfyCommand (Get-ProcessCommandLine $current)) {
            return $true
        }

        $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $current" -ErrorAction SilentlyContinue
        if (-not $parent -or -not $parent.ParentProcessId -or [int]$parent.ParentProcessId -eq $current) {
            return $false
        }
        $current = [int]$parent.ParentProcessId
    }

    return $false
}

function Get-ListeningProcessIds {
    param([int]$Port)

    $ids = New-Object 'System.Collections.Generic.List[int]'
    $checked = $false

    try {
        $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
        $checked = $true
        foreach ($conn in $connections) {
            $ids.Add([int]$conn.OwningProcess)
        }
    }
    catch {
        $checked = $false
    }

    if (-not $checked) {
        foreach ($line in @(netstat.exe -ano)) {
            if ($line -notmatch ":$Port\s") {
                continue
            }
            if ($line -match "LISTENING\s+(\d+)\s*$") {
                $ids.Add([int]$Matches[1])
            }
        }
    }

    if ($ids.Count -eq 0) {
        return @()
    }
    return @($ids | Select-Object -Unique)
}

function Get-PortOwners {
    $ours = @()
    $foreign = @()
    foreach ($processId in @(Get-ListeningProcessIds -Port $Port)) {
        if (Test-OurPython -ProcessId $processId) {
            $ours += $processId
        }
        else {
            $foreign += $processId
        }
    }

    return [pscustomobject]@{
        Ours = @($ours | Select-Object -Unique)
        Foreign = @($foreign | Select-Object -Unique)
    }
}

function Stop-ProcessTree {
    param([int]$ProcessId)

    & taskkill.exe /PID $ProcessId /T /F | Out-Null
    if ((Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) -and $LASTEXITCODE -ne 0) {
        throw "Failed to stop PID $ProcessId"
    }
}

function Get-LogTail {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return ""
    }
    return ((Get-Content -LiteralPath $Path -Tail 30) -join "`n")
}

function Ensure-RuntimeDirectories {
    foreach ($relative in @("outputs", "input", "user", "logs")) {
        New-Item -ItemType Directory -Force -Path (Join-Path $Root $relative) | Out-Null
    }
}

function Assert-Installed {
    if (-not (Test-Path -LiteralPath (Join-Path $Runtime "main.py"))) {
        throw "ComfyUI is not installed: $Runtime. Run infra\bootstap.ps1 first."
    }
    if (-not (Test-Path -LiteralPath $Python)) {
        throw "Python environment not found: $Python. Run infra\bootstap.ps1 first."
    }
}

function Wait-ComfyReady {
    param($Process)

    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
        if ($Process.HasExited) {
            $outTail = Get-LogTail $OutLog
            $errTail = Get-LogTail $ErrLog
            throw "ComfyUI exited with code $($Process.ExitCode).`n$outTail`n$errTail"
        }

        foreach ($listener in @(Get-ListeningProcessIds -Port $Port)) {
            if ($listener -le 4) {
                continue
            }
            if ($listener -eq $Process.Id -or (Test-OurPython -ProcessId $listener)) {
                return $true
            }
            throw "Port $Port was taken by PID $listener while ComfyUI was starting."
        }

        Start-Sleep -Seconds 1
    }

    return $false
}

function Invoke-Start {
    Assert-Installed
    Ensure-RuntimeDirectories

    $owners = Get-PortOwners
    if ($owners.Ours.Count -gt 0) {
        Write-Host "Already running, skipping: ComfyUI (PID $($owners.Ours -join ', '))" -ForegroundColor Green
        Show-Endpoint
        return
    }
    if ($owners.Foreign.Count -gt 0) {
        throw "Port $Port is already used by PID $($owners.Foreign -join ', ')."
    }

    $filePid = Read-PidFile
    if ($filePid -and (Test-OurPython -ProcessId $filePid)) {
        Write-Host "Already running, skipping: ComfyUI (PID $filePid)" -ForegroundColor Green
        Show-Endpoint
        return
    }

    if ($Foreground) {
        Write-Host "Starting ComfyUI in this window. Press Ctrl+C to stop."
        Show-Endpoint
        Push-Location $Runtime
        try {
            & $Python @ArgumentList
            if ($LASTEXITCODE -ne 0) {
                throw "ComfyUI exited with code $LASTEXITCODE"
            }
        }
        finally {
            Pop-Location
        }
        return
    }

    $proc = Start-Process `
        -FilePath $Python `
        -ArgumentList $ArgumentList `
        -WorkingDirectory $Runtime `
        -WindowStyle Hidden `
        -RedirectStandardOutput $OutLog `
        -RedirectStandardError $ErrLog `
        -PassThru

    Set-Content -LiteralPath $PidFile -Value $proc.Id -Encoding ascii
    Write-Host "Starting ComfyUI (PID $($proc.Id))..."
    Write-Host "Waiting for port $Port..."

    try {
        $ready = Wait-ComfyReady -Process $proc
    }
    catch {
        if (-not $proc.HasExited) {
            Stop-ProcessTree -ProcessId $proc.Id
        }
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
        throw
    }

    if (-not $ready) {
        Write-Warning "ComfyUI is running, but port $Port is not listening yet."
    }

    Write-Host "ComfyUI started." -ForegroundColor Green
    Show-Endpoint
    Write-Host "Log: $OutLog"
    Write-Host "Errors: $ErrLog"
}

function Invoke-Stop {
    param([switch]$Quiet)

    $owners = Get-PortOwners
    if ($owners.Foreign.Count -gt 0 -and $owners.Ours.Count -eq 0) {
        throw "Port $Port is used by PID $($owners.Foreign -join ', '), which is not this ComfyUI. Not stopping it."
    }

    $targets = New-Object 'System.Collections.Generic.List[int]'
    foreach ($processId in @($owners.Ours)) {
        if ($processId) {
            $targets.Add([int]$processId)
        }
    }

    $filePid = Read-PidFile
    if ($filePid -and (Test-OurPython -ProcessId $filePid) -and -not $targets.Contains($filePid)) {
        $targets.Add($filePid)
    }

    if ($targets.Count -eq 0) {
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
        if (-not $Quiet) {
            Write-Host "Already stopped, skipping." -ForegroundColor Green
        }
        return
    }

    foreach ($processId in $targets) {
        Stop-ProcessTree -ProcessId $processId
    }

    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue

    $deadline = (Get-Date).AddSeconds(10)
    do {
        $remaining = Get-PortOwners
        if ($remaining.Ours.Count -eq 0) {
            break
        }
        Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $deadline)

    $remaining = Get-PortOwners
    if ($remaining.Ours.Count -gt 0) {
        Write-Warning "ComfyUI is still listening on port $Port (PID $($remaining.Ours -join ', '))."
        return
    }

    Write-Host "ComfyUI stopped." -ForegroundColor Green
}

function Invoke-Status {
    $owners = Get-PortOwners
    $filePid = Read-PidFile

    if ($owners.Ours.Count -gt 0) {
        Write-Host "ComfyUI running" -ForegroundColor Green
        Write-Host "PID: $($owners.Ours -join ', ')"
        Show-Endpoint
        if (Test-Path -LiteralPath $OutLog) {
            Write-Host "Log: $OutLog"
        }
        return
    }

    if ($filePid -and (Test-OurPython -ProcessId $filePid)) {
        Write-Host "ComfyUI starting" -ForegroundColor Yellow
        Write-Host "PID: $filePid"
        Show-Endpoint
        return
    }

    if ($owners.Foreign.Count -gt 0) {
        Write-Host "Port $Port is used by another process: PID $($owners.Foreign -join ', ')" -ForegroundColor Yellow
        return
    }

    Write-Host "ComfyUI stopped"
}

# Dot-sourcing loads the functions without starting or stopping anything.
if ($MyInvocation.InvocationName -ne '.') {
    switch ($Action) {
        "start" { Invoke-Start }
        "stop" { Invoke-Stop }
        "status" { Invoke-Status }
        "restart" {
            Invoke-Stop -Quiet
            Start-Sleep -Seconds 1
            Invoke-Start
        }
    }
}
