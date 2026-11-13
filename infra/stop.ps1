param(
    [string]$Root = "C:\AIGC"
)

& (Join-Path $PSScriptRoot "service.ps1") -Action stop -Root $Root
