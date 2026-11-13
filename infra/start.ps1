param(
    [string]$Root = "C:\AIGC",
    [switch]$Foreground
)

& (Join-Path $PSScriptRoot "service.ps1") -Action start -Root $Root -Foreground:$Foreground
