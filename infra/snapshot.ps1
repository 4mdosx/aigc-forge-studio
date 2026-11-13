
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$env:GIT_CONFIG_COUNT = "1"
$env:GIT_CONFIG_KEY_0 = "safe.directory"
$env:GIT_CONFIG_VALUE_0 = "*"

$Root = "C:\AIGC"
$Runtime = Join-Path $Root "runtime\comfyui-prod"
$Python = Join-Path $Runtime ".venv\Scripts\python.exe"
$Infra = Join-Path $Root "infra"
$DataDir = Join-Path $Infra "data"
$OutputFile = Join-Path $DataDir "environment.json"
$ModelConfig = Join-Path $Runtime "extra_model_paths.yaml"

function Assert-Exists {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Path not found: $Path"
    }
}

function Get-GitInfo {
    param([string]$Path)

    Assert-Exists (Join-Path $Path ".git")

    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $commit = & git -C $Path rev-parse HEAD 2>&1
        $commitCode = $LASTEXITCODE
        $remote = & git -C $Path config --get remote.origin.url 2>&1
        $remoteCode = $LASTEXITCODE
        $tags = @(& git -C $Path tag --points-at HEAD 2>&1)
        $tagCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }

    $commit = @($commit | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join ""
    if ($commitCode -ne 0 -or -not $commit.Trim()) {
        throw "Cannot get Git commit: $Path"
    }

    $remote = @($remote | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join ""
    if ($remoteCode -ne 0 -or -not $remote.Trim()) {
        $remote = $null
    }

    if ($tagCode -ne 0) {
        throw "Cannot read Git tags: $Path"
    }
    $tags = @($tags | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] -and "$_" -ne "" })

    $tag = $null
    if ($tags.Count -gt 0) {
        $tag = $tags[0].Trim()
    }

    return [ordered]@{
        repository = if ($remote) { "$remote".Trim() } else { $null }
        commit = "$commit".Trim()
        tag = $tag
    }
}

function Get-ModelFilenames {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return @()
    }

    $files = @(
        Get-ChildItem -LiteralPath $Path -File |
            Sort-Object Name |
            Select-Object -ExpandProperty Name
    )

    return $files
}

# Required environment
Assert-Exists $Python
Assert-Exists (Join-Path $Runtime ".git")

New-Item -ItemType Directory -Force -Path $DataDir |
    Out-Null

Write-Host "[1/4] Reading ComfyUI version..."

$ComfyUI = Get-GitInfo $Runtime

Write-Host "[2/4] Reading Python / PyTorch / CUDA..."

$versionJson = & $Python -c @'
import json
import sys
import torch
from importlib.metadata import version, PackageNotFoundError

def package_version(name):
    try:
        return version(name)
    except PackageNotFoundError:
        return None

print(json.dumps({
    "python": ".".join(map(str, sys.version_info[:3])),
    "pytorch": torch.__version__,
    "torchvision": package_version("torchvision"),
    "torchaudio": package_version("torchaudio"),
    "cuda": torch.version.cuda,
    "gpu": (
        torch.cuda.get_device_name(0)
        if torch.cuda.is_available()
        else None
    ),
    "frontend": package_version("comfyui-frontend-package")
}))
'@

if ($LASTEXITCODE -ne 0) {
    throw "Failed to read Python / PyTorch information."
}

$Versions = $versionJson | ConvertFrom-Json

Write-Host "[3/4] Reading custom nodes..."

$Plugins = @()

$CustomNodes = Join-Path $Runtime "custom_nodes"

if (Test-Path -LiteralPath $CustomNodes) {
    $directories = @(
        Get-ChildItem -LiteralPath $CustomNodes -Directory |
            Where-Object {
                $_.Name -ne "__pycache__" -and
                $_.Name -ne ".git"
            } |
            Sort-Object Name
    )

    foreach ($directory in $directories) {
        $gitDir = Join-Path $directory.FullName ".git"

        if (Test-Path -LiteralPath $gitDir) {
            $info = Get-GitInfo $directory.FullName

            $Plugins += [ordered]@{
                name = $directory.Name
                repository = $info.repository
                commit = $info.commit
            }
        }
        else {
            # Record local / non-Git plugins for reference.
            $Plugins += [ordered]@{
                name = $directory.Name
                repository = $null
                commit = $null
            }
        }
    }
}

Write-Host "[4/4] Reading model filenames and paths..."

$ModelPathsYaml = $null

if (Test-Path -LiteralPath $ModelConfig) {
    $ModelPathsYaml = [System.IO.File]::ReadAllText(
        $ModelConfig,
        [System.Text.Encoding]::UTF8
    )
}

$Environment = [ordered]@{
    schemaVersion = 1

    comfyui = $ComfyUI

    python = $Versions.python
    pytorch = $Versions.pytorch
    torchvision = $Versions.torchvision
    torchaudio = $Versions.torchaudio
    cuda = $Versions.cuda
    gpu = $Versions.gpu
    frontend = $Versions.frontend

    plugins = @($Plugins)

    models = [ordered]@{
        checkpoints = @(
            Get-ModelFilenames "$Root\models\checkpoints"
        )
        loras = @(
            Get-ModelFilenames "$Root\models\loras"
        )
    }

    modelPathsYaml = $ModelPathsYaml
}

$Json = $Environment | ConvertTo-Json -Depth 10

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(
    $OutputFile,
    $Json,
    $Utf8NoBom
)

Write-Host ""
Write-Host "Snapshot completed." -ForegroundColor Green
Write-Host "File: $OutputFile"
Write-Host "ComfyUI: $($ComfyUI.commit)"
Write-Host "Python: $($Versions.python)"
Write-Host "PyTorch: $($Versions.pytorch)"
Write-Host "Plugins: $($Plugins.Count)"
