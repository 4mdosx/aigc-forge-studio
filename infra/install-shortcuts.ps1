param(
    [switch]$Startup
)

$ComfyInfraDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ComfyInfraDir) {
    $ComfyInfraDir = $PSScriptRoot
}

function New-ComfyShortcut {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $vbs = Join-Path $ComfyInfraDir "tray.vbs"
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($Path)
    $link.TargetPath = Join-Path $env:SystemRoot "System32\wscript.exe"
    $link.Arguments = "`"$vbs`""
    $link.WorkingDirectory = $ComfyInfraDir
    $link.WindowStyle = 7
    $link.Description = "ComfyUI"
    $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    if (Test-Path -LiteralPath $powershell) {
        $link.IconLocation = "$powershell,0"
    }
    $link.Save()
}

if ($MyInvocation.InvocationName -ne '.') {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $desktopLink = Join-Path $desktop "ComfyUI.lnk"
    New-ComfyShortcut -Path $desktopLink
    Write-Host "Desktop shortcut: $desktopLink"

    if ($Startup) {
        $startup = [Environment]::GetFolderPath("Startup")
        $startupLink = Join-Path $startup "ComfyUI.lnk"
        New-ComfyShortcut -Path $startupLink
        Write-Host "Startup shortcut: $startupLink"
    }
}
