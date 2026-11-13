param(
    [string]$BaseUrl = "",
    [switch]$SkipAPI
)

$ErrorActionPreference = "Stop"
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

$Root = "C:\AIGC"
$Infra = Join-Path $Root "infra"
$Runtime = Join-Path $Root "runtime\comfyui-prod"
$Python = Join-Path $Runtime ".venv\Scripts\python.exe"

$EnvironmentFile = Join-Path $Infra "data\environment.json"
$AppConfigFile = Join-Path $Infra "config.json"

if (-not (Test-Path $EnvironmentFile)) {
    throw "Missing environment.json"
}

if (-not (Test-Path $Python)) {
    throw "Missing Python environment"
}

$Config = Get-Content $EnvironmentFile -Raw |
    ConvertFrom-Json

$AppConfig = Get-Content $AppConfigFile -Raw |
    ConvertFrom-Json

if (-not $BaseUrl) {
    $BaseUrl = $AppConfig.baseURL
}

$BaseUrl = $BaseUrl.TrimEnd("/")

function Assert-Equal {
    param(
        $Actual,
        $Expected,
        [string]$Description
    )

if ($Actual -ne $Expected) {
throw "FAILED: $DescriptionnExpected: $ExpectednActual: $Actual"
}

Write-Host "OK: $Description" -ForegroundColor Green
}

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Description
    )

if (-not $Condition) {
        throw "FAILED: $Description"
    }

Write-Host "OK: $Description" -ForegroundColor Green
}

Write-Host ""
Write-Host "Validating ComfyUI Production"
Write-Host "=============================="