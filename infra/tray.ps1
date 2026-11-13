# System tray control for ComfyUI. Launch through tray.vbs so no console appears.
if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne "STA") {
    $vbs = Join-Path $PSScriptRoot "tray.vbs"
    Start-Process -FilePath (Join-Path $env:SystemRoot "System32\wscript.exe") -ArgumentList "`"$vbs`""
    exit 0
}

$mutex = New-Object System.Threading.Mutex($false, "Local\AIGC.ComfyUI.Tray")
$ownsMutex = $false
try {
    $ownsMutex = $mutex.WaitOne(0)
}
catch [System.Threading.AbandonedMutexException] {
    $ownsMutex = $true
}
if (-not $ownsMutex) {
    exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
namespace AigcTray {
    public static class Native {
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool DestroyIcon(IntPtr handle);

        public static Task<string> ReadAll(StreamReader reader) {
            return Task.Run(() => reader.ReadToEnd());
        }
    }
}
"@

$ErrorActionPreference = "Stop"

function Write-TrayLog {
    param([string]$Message)
    try {
        $dir = Join-Path (Split-Path $PSScriptRoot -Parent) "logs"
        if (-not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
        }
        Add-Content -LiteralPath (Join-Path $dir "tray.log") -Encoding utf8 -Value ("{0} {1}" -f (Get-Date -Format "s"), $Message)
    }
    catch {
    }
}

try {
    . (Join-Path $PSScriptRoot "install-shortcuts.ps1")
    . (Join-Path $PSScriptRoot "service.ps1")
}
catch {
    Write-TrayLog $_.Exception.Message
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "ComfyUI") | Out-Null
    $mutex.ReleaseMutex() | Out-Null
    exit 1
}

$script:StartupLink = Join-Path ([Environment]::GetFolderPath("Startup")) "ComfyUI.lnk"
$script:DesktopLink = Join-Path ([Environment]::GetFolderPath("Desktop")) "ComfyUI.lnk"
$script:ActionProcess = $null
$script:ActionName = ""
$script:OutTask = $null
$script:ErrTask = $null
$script:IconHandles = @()

function New-DotIcon {
    param([System.Drawing.Color]$Color)

    $bitmap = New-Object System.Drawing.Bitmap 32, 32
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.SolidBrush $Color
    $graphics.FillEllipse($brush, 2, 2, 28, 28)
    $graphics.Dispose()
    $brush.Dispose()

    $handle = $bitmap.GetHicon()
    $bitmap.Dispose()
    $script:IconHandles += $handle
    return [System.Drawing.Icon]::FromHandle($handle)
}

$script:Icons = @{
    running = New-DotIcon ([System.Drawing.Color]::FromArgb(34, 160, 80))
    stopped = New-DotIcon ([System.Drawing.Color]::FromArgb(150, 150, 150))
    starting = New-DotIcon ([System.Drawing.Color]::FromArgb(230, 170, 40))
    foreign = New-DotIcon ([System.Drawing.Color]::FromArgb(200, 70, 60))
}

function Get-TrayState {
    $owners = Get-PortOwners
    if ($owners.Ours.Count -gt 0) {
        return "running"
    }

    $filePid = Read-PidFile
    if ($filePid -and (Test-OurPython -ProcessId $filePid)) {
        return "starting"
    }

    if ($owners.Foreign.Count -gt 0) {
        return "foreign"
    }

    return "stopped"
}

function Test-ActionRunning {
    return ($script:ActionProcess -and -not $script:ActionProcess.HasExited)
}

function Update-Tray {
    $state = Get-TrayState
    $busy = Test-ActionRunning
    $iconKey = $state
    $text = "ComfyUI 已停止"

    if ($busy) {
        $iconKey = "starting"
        if ($script:ActionName -eq "stop") {
            $text = "ComfyUI 正在停止"
        }
        else {
            $text = "ComfyUI 正在启动"
        }
    }
    elseif ($state -eq "running") {
        $text = "ComfyUI 运行中"
    }
    elseif ($state -eq "starting") {
        $text = "ComfyUI 正在启动"
    }
    elseif ($state -eq "foreign") {
        $text = "端口 $Port 已被占用"
    }

    $notify.Icon = $script:Icons[$iconKey]
    if ($text.Length -gt 63) {
        $text = $text.Substring(0, 63)
    }
    $notify.Text = $text
}

function Show-Tip {
    param(
        [string]$Message,
        [System.Windows.Forms.ToolTipIcon]$Kind = "Info"
    )
    $notify.ShowBalloonTip(3000, "ComfyUI", $Message, $Kind)
}

function Start-ComfyAction {
    param([string]$Action)

    if (Test-ActionRunning) {
        return
    }

    if (-not (Test-Path -LiteralPath $LogDir)) {
        New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    }

    $service = Join-Path $PSScriptRoot "service.ps1"
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$service`" -Action $Action -Root `"$Root`""
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    try {
        $proc.Start() | Out-Null
        $script:OutTask = [AigcTray.Native]::ReadAll($proc.StandardOutput)
        $script:ErrTask = [AigcTray.Native]::ReadAll($proc.StandardError)
    }
    catch {
        Write-TrayLog $_.Exception.Message
        Show-Tip $_.Exception.Message "Error"
        return
    }

    $script:ActionProcess = $proc
    $script:ActionName = $Action
    Update-Tray
}

function Complete-ComfyAction {
    if (-not $script:ActionProcess -or -not $script:ActionProcess.HasExited) {
        return
    }

    $proc = $script:ActionProcess
    $name = $script:ActionName
    $code = $proc.ExitCode
    $script:ActionProcess = $null
    $script:ActionName = ""

    $detail = ""
    if ($script:ErrTask -and $script:ErrTask.Wait(2000)) {
        $detail = ([string]$script:ErrTask.Result).Trim()
    }
    if (-not $detail -and $script:OutTask -and $script:OutTask.Wait(2000)) {
        $detail = ([string]$script:OutTask.Result).Trim()
    }
    $script:ErrTask = $null
    $script:OutTask = $null

    if ($code -ne 0) {
        if (-not $detail) {
            $detail = "操作失败，退出码 $code"
        }
        if ($detail.Length -gt 180) {
            $detail = $detail.Substring($detail.Length - 180)
        }
        Show-Tip $detail "Error"
    }
    elseif ($name -eq "stop") {
        Show-Tip "ComfyUI 已停止"
    }
    elseif ((Get-TrayState) -eq "running") {
        Show-Tip "ComfyUI 已启动"
    }
    else {
        Show-Tip "命令已结束，服务还没有打开端口" "Warning"
    }

    Update-Tray
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemStart = New-Object System.Windows.Forms.ToolStripMenuItem "启动"
$itemStop = New-Object System.Windows.Forms.ToolStripMenuItem "停止"
$itemRestart = New-Object System.Windows.Forms.ToolStripMenuItem "重启"
$itemOpen = New-Object System.Windows.Forms.ToolStripMenuItem "打开页面"
$itemLog = New-Object System.Windows.Forms.ToolStripMenuItem "打开日志"
$itemDesktop = New-Object System.Windows.Forms.ToolStripMenuItem "放到桌面"
$itemStartup = New-Object System.Windows.Forms.ToolStripMenuItem "登录时启动"
$itemExit = New-Object System.Windows.Forms.ToolStripMenuItem "退出托盘"

$itemStart.Add_Click({ Start-ComfyAction "start" })
$itemStop.Add_Click({ Start-ComfyAction "stop" })
$itemRestart.Add_Click({ Start-ComfyAction "restart" })
$itemOpen.Add_Click({
    if ((Get-TrayState) -eq "running") {
        Start-Process $BaseUrl
    }
})
$itemLog.Add_Click({
    $log = $OutLog
    if (-not (Test-Path -LiteralPath $log)) {
        $log = $ErrLog
    }
    if (Test-Path -LiteralPath $log) {
        Start-Process -FilePath "notepad.exe" -ArgumentList "`"$log`""
    }
    else {
        Show-Tip "还没有日志"
    }
})
$itemDesktop.Add_Click({
    New-ComfyShortcut -Path $script:DesktopLink
    Show-Tip "已放到桌面"
})
$itemStartup.Add_Click({
    if (Test-Path -LiteralPath $script:StartupLink) {
        Remove-Item -LiteralPath $script:StartupLink -Force
        $itemStartup.Checked = $false
        Show-Tip "已取消登录时启动"
    }
    else {
        New-ComfyShortcut -Path $script:StartupLink
        $itemStartup.Checked = $true
        Show-Tip "登录后会打开托盘"
    }
})

$context = New-Object System.Windows.Forms.ApplicationContext
$itemExit.Add_Click({
    $context.ExitThread()
})

[void]$menu.Items.Add($itemStart)
[void]$menu.Items.Add($itemStop)
[void]$menu.Items.Add($itemRestart)
[void]$menu.Items.Add("-")
[void]$menu.Items.Add($itemOpen)
[void]$menu.Items.Add($itemLog)
[void]$menu.Items.Add("-")
[void]$menu.Items.Add($itemDesktop)
[void]$menu.Items.Add($itemStartup)
[void]$menu.Items.Add("-")
[void]$menu.Items.Add($itemExit)
$notify.ContextMenuStrip = $menu

$menu.Add_Opening({
    $state = Get-TrayState
    $busy = Test-ActionRunning
    $itemStart.Enabled = (-not $busy) -and ($state -eq "stopped")
    $itemStop.Enabled = (-not $busy) -and ($state -in @("running", "starting"))
    $itemRestart.Enabled = (-not $busy) -and ($state -eq "running")
    $itemOpen.Enabled = $state -eq "running"
    $itemStartup.Checked = Test-Path -LiteralPath $script:StartupLink
})

$notify.Add_DoubleClick({
    $state = Get-TrayState
    if ($state -eq "running") {
        Start-Process $BaseUrl
    }
    elseif ($state -eq "stopped" -and -not (Test-ActionRunning)) {
        Start-ComfyAction "start"
    }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1500
$timer.Add_Tick({
    try {
        if ($script:ActionProcess) {
            $script:ActionProcess.Refresh()
            if ($script:ActionProcess.HasExited) {
                Complete-ComfyAction
                return
            }
        }
        Update-Tray
    }
    catch {
        Write-TrayLog $_.Exception.Message
    }
})
$timer.Start()
Update-Tray

try {
    [System.Windows.Forms.Application]::Run($context)
}
finally {
    $timer.Stop()
    $notify.Visible = $false
    $notify.Dispose()
    foreach ($handle in $script:IconHandles) {
        [AigcTray.Native]::DestroyIcon($handle) | Out-Null
    }
    if ($mutex) {
        try { $mutex.ReleaseMutex() | Out-Null } catch {}
        $mutex.Dispose()
    }
}
