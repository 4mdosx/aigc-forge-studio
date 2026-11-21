# Trainer (Node :8788) process control. ComfyUI 的 service.ps1 只管 ComfyUI，
# trainer 单独一个脚本——训练时它要活、ComfyUI 要停，两者互不掺和。
#   infra\trainer_service.ps1 status
#   infra\trainer_service.ps1 restart        # 只重启 trainer，正在跑的 sd-scripts 保留
#   infra\trainer_service.ps1 stop           # 同上：只停 trainer
#   infra\trainer_service.ps1 stop -KillChildren   # 连训练进程一起杀
#   infra\trainer_service.ps1 start [-Foreground]
#
# 训练进程是 trainer spawn 的，但 pid 已落库（train_jobs.pid）、日志由子进程直写文件，
# 所以 trainer 重启/升级不再中断训练：新进程起来后 re-attach，等进程消失再按日志收尾。
#
# !! 本文件必须保存为 UTF-8 with BOM。PS 5.1 读无 BOM 的 .ps1 会按 cp936 解码，
#    双引号里的中文（如全角句号 U+3002 = E3 80 82）会被拆成两个 GBK 字节，
#    尾字节 0x82 把结尾的 " 当成第二个字节吃掉 → 报「字符串缺少终止符」。
#    编辑后请确认文件头是 EF BB BF：xxd -l 3 infra/trainer_service.ps1

param(
    [Parameter(Position = 0)]
    [ValidateSet("start", "stop", "status", "restart")]
    [string]$Action = "status",

    [string]$Root = "C:\AIGC",

    [switch]$Foreground,

    # 只在显式 stop -KillChildren 时连训练子进程一起杀
    [switch]$KillChildren
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

$TrainerDir = Join-Path $Root "trainer"
$Entry = Join-Path $TrainerDir "src\main.ts"
$LogDir = Join-Path $Root "logs"
$PidFile = Join-Path $LogDir "trainer.pid"
$OutLog = Join-Path $LogDir "trainer.out.log"
$ErrLog = Join-Path $LogDir "trainer.err.log"

# 端口取自仓库根 config.json 的 trainer.port（与 trainer 本体同一份真相源）
$AppConfigPath = Join-Path $Root "config.json"
if (-not (Test-Path -LiteralPath $AppConfigPath)) {
    throw "Missing config.json: $AppConfigPath"
}
$AppConfig = Get-Content -LiteralPath $AppConfigPath -Raw | ConvertFrom-Json
if (-not $AppConfig.trainer) {
    throw "trainer section missing in $AppConfigPath"
}
$Port = if ($AppConfig.trainer.port) { [int]$AppConfig.trainer.port } else { 8788 }

function Get-NodeCommand {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { throw "node.exe not found in PATH (trainer needs Node >= 22.18)" }
    return $node.Source
}

function Get-ListeningProcessIds {
    param([int]$PortNumber)
    try {
        return @((Get-NetTCPConnection -LocalPort $PortNumber -State Listen -ErrorAction Stop) |
            ForEach-Object { [int]$_.OwningProcess } | Select-Object -Unique)
    } catch {
        $ids = New-Object 'System.Collections.Generic.List[int]'
        foreach ($line in @(netstat.exe -ano)) {
            if ($line -match ":$PortNumber\s" -and $line -match "LISTENING\s+(\d+)\s*$") {
                $ids.Add([int]$Matches[1])
            }
        }
        return @($ids | Select-Object -Unique)
    }
}

function Wait-ProcessGone {
    param([int]$ProcessId, [int]$TimeoutSeconds = 10)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $true }
        Start-Sleep -Milliseconds 200
    }
    return (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue))
}

function Get-ProcessSnapshot {
    param([int]$ProcessId)
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $proc) { return $null }
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue).CommandLine
    return [pscustomobject]@{ Id = $ProcessId; Name = $proc.ProcessName; CommandLine = $cmd }
}

function Invoke-TaskKill {
    # PS 5.1 坑：EAP=Stop 时对原生命令做 2>&1 会把 stderr 变成 ErrorRecord 直接终止脚本，
    # 而 taskkill 失败（进程已退）恰恰就是写 stderr。所以这里临时降级 EAP。
    param([int]$ProcessId, [switch]$Tree)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        if ($Tree) {
            & taskkill.exe /PID $ProcessId /T /F 2>&1 | Out-Null
        } else {
            & taskkill.exe /PID $ProcessId /F 2>&1 | Out-Null
        }
    } catch {
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Stop-ProcessTree {
    param([int]$ProcessId, [switch]$KillChildren)

    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }

    if ($KillChildren) {
        Invoke-TaskKill -ProcessId $ProcessId -Tree
        if (Wait-ProcessGone -ProcessId $ProcessId -TimeoutSeconds 10) { return }
    } else {
        # 软停：只杀 node 自己。训练子进程继续跑，新 trainer 起来会 re-attach。
        # 坑：TerminateProcess 是异步的，Stop-Process 返回后进程还要几十~几百毫秒才从进程表
        # 消失，紧接着 Get-Process 会误判「停不掉」。所以这里必须等，并且把真实异常打出来
        # （原来 SilentlyContinue 把它吞了，只剩一句 Failed to stop PID）。
        try {
            Stop-Process -Id $ProcessId -Force -ErrorAction Stop
        } catch {
            Write-Warning "Stop-Process 报错：$($_.Exception.Message)（改用 taskkill /F 重试）"
        }
        if (Wait-ProcessGone -ProcessId $ProcessId -TimeoutSeconds 5) { return }
        # 不跟 /T：软停语义是「留训练进程」。只对 node 自己补一刀。
        Invoke-TaskKill -ProcessId $ProcessId
        if (Wait-ProcessGone -ProcessId $ProcessId -TimeoutSeconds 10) { return }
    }

    # 到这儿进程还在。两种可能：真杀不动，或者 PID 已经被系统复用给了别的进程。
    if (-not (Test-OurTrainer -ProcessId $ProcessId)) {
        Write-Warning "PID $ProcessId 已不是我们的 trainer（疑似 PID 复用），原进程应已退出"
        return
    }

    $snap = Get-ProcessSnapshot -ProcessId $ProcessId
    $detail = if ($snap) { "$($snap.Name) / $($snap.CommandLine)" } else { "unknown" }
    Write-Host "Failed to stop PID $ProcessId ($detail)" -ForegroundColor Red
    Write-Host "可能需要管理员权限（进程被提权启动）或有别的进程持有句柄。手工排查："
    Write-Host "  Get-Process -Id $ProcessId | Select-Object Id,ProcessName,StartTime,Path"
    Write-Host "  Stop-Process -Id $ProcessId -Force"
    Write-Host "  taskkill.exe /PID $ProcessId /T /F"
    Write-Host "都失败就用管理员 PowerShell 重跑本脚本。"
    throw "Failed to stop PID $ProcessId"
}

function Read-PidFile {
    if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
    $text = (Get-Content -LiteralPath $PidFile -Raw).Trim()
    if ($text -match '^\d+$') { return [int]$text }
    return $null
}

function Test-OurTrainer {
    param([int]$ProcessId)
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $proc) { return $false }
    # 只认命令行含我们 entry 的 node 进程——端口是硬约定，错杀别人要兜底验证
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue).CommandLine
    return ($cmd -and $cmd.ToLower().Contains($Entry.ToLower()))
}

function Invoke-Start {
    if (-not (Test-Path -LiteralPath $Entry)) {
        throw "trainer entry not found: $Entry (git pull first?)"
    }
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

    $listeners = @(Get-ListeningProcessIds -Port $Port)
    $ours = @($listeners | Where-Object { Test-OurTrainer -ProcessId $_ })
    if ($ours.Count -gt 0) {
        Write-Host "Already running, skipping: trainer (PID $($ours -join ', '))" -ForegroundColor Green
        Write-Host "URL: http://127.0.0.1:$Port"
        return
    }
    if ($listeners.Count -gt 0) {
        throw "Port $Port is used by PID $($listeners -join ', ') (not our trainer)."
    }

    $node = Get-NodeCommand
    if ($Foreground) {
        Write-Host "Starting trainer in this window. Press Ctrl+C to stop."
        Push-Location $TrainerDir
        try { & $node $Entry } finally { Pop-Location }
        return
    }

    $proc = Start-Process `
        -FilePath $node `
        -ArgumentList @($Entry) `
        -WorkingDirectory $TrainerDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $OutLog `
        -RedirectStandardError $ErrLog `
        -PassThru
    Set-Content -LiteralPath $PidFile -Value $proc.Id -Encoding ascii

    Write-Host "Starting trainer (PID $($proc.Id))..."
    Write-Host "Waiting for port $Port..."
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) {
            $errTail = if (Test-Path $ErrLog) { (Get-Content $ErrLog -Tail 20) -join "`n" } else { "" }
            throw "trainer exited with code $($proc.ExitCode).`n$errTail"
        }
        if (@(Get-ListeningProcessIds -Port $Port).Count -gt 0) {
            Write-Host "Trainer started." -ForegroundColor Green
            Write-Host "URL: http://127.0.0.1:$Port"
            Write-Host "Log: $OutLog"
            return
        }
        Start-Sleep -Seconds 1
    }
    Write-Warning "trainer process alive but port $Port not listening yet (check $ErrLog)"
}

function Invoke-Stop {
    param([switch]$Quiet, [switch]$KillChildren)
    $listeners = @(Get-ListeningProcessIds -Port $Port)
    $ours = @($listeners | Where-Object { Test-OurTrainer -ProcessId $_ })
    $foreign = @($listeners | Where-Object { -not (Test-OurTrainer -ProcessId $_) })

    if ($foreign.Count -gt 0 -and $ours.Count -eq 0) {
        throw "Port $Port is used by PID $($foreign -join ', '), which is not our trainer. Not stopping it."
    }

    # 端口查不到（已挂/半死）时退回 pid 文件；但 pid 文件可能是历史遗留、PID 已被系统复用，
    # 所以先确认那个 pid 确实是我们的 trainer，否则只清文件、不杀进程。
    $filePid = Read-PidFile
    $targets = @($ours)
    if ($targets.Count -eq 0 -and $filePid) {
        if (Test-OurTrainer -ProcessId $filePid) {
            $targets = @($filePid)
        } else {
            Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
            if (-not $Quiet) { Write-Host "Already stopped, skipping." -ForegroundColor Green }
            return
        }
    }

    if ($targets.Count -eq 0) {
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
        if (-not $Quiet) { Write-Host "Already stopped, skipping." -ForegroundColor Green }
        return
    }

    foreach ($pid_ in $targets) { Stop-ProcessTree -ProcessId $pid_ -KillChildren:$KillChildren }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    if ($KillChildren) {
        Write-Host "Trainer stopped (training process tree killed)." -ForegroundColor Green
    } else {
        Write-Host "Trainer stopped. 训练进程若在跑会继续，下次 start 自动 re-attach。" -ForegroundColor Green
    }
}

function Invoke-Status {
    $listeners = @(Get-ListeningProcessIds -Port $Port)
    $ours = @($listeners | Where-Object { Test-OurTrainer -ProcessId $_ })
    if ($ours.Count -gt 0) {
        Write-Host "Trainer running" -ForegroundColor Green
        Write-Host "PID: $($ours -join ', ')"
        Write-Host "URL: http://127.0.0.1:$Port"
        return
    }
    Write-Host "Trainer stopped"
}

if ($MyInvocation.InvocationName -ne '.') {
    switch ($Action) {
        "start" { Invoke-Start }
        "stop" { Invoke-Stop -KillChildren:$KillChildren }
        "status" { Invoke-Status }
        "restart" {
            Invoke-Stop -Quiet -KillChildren:$KillChildren
            Start-Sleep -Seconds 1
            Invoke-Start
        }
    }
}
