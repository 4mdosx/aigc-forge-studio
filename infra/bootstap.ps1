# Re-runnable. Each step prints "Already installed, skipping" when that
# part already matches infra\data\environment.json.

param(
    [string]$Root = "C:\AIGC"
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$env:GIT_TERMINAL_PROMPT = "0"
$env:PIP_DISABLE_PIP_VERSION_CHECK = "1"
# Copied trees keep another user's owner, so Git refuses to read them.
# This applies only to this process and does not change git config.
$env:GIT_CONFIG_COUNT = "1"
$env:GIT_CONFIG_KEY_0 = "safe.directory"
$env:GIT_CONFIG_VALUE_0 = "*"

$Infra = Join-Path $Root "infra"
$Runtime = Join-Path $Root "runtime\comfyui-prod"
$EnvironmentFile = Join-Path $Infra "data\environment.json"

$BasePython = "C:\Python312\python.exe"
$Python = Join-Path $Runtime ".venv\Scripts\python.exe"
$CustomNodes = Join-Path $Runtime "custom_nodes"

if (-not (Test-Path -LiteralPath $EnvironmentFile)) {
    throw "Missing environment.json. Run snapshot first: $EnvironmentFile"
}

$Config = Get-Content -LiteralPath $EnvironmentFile -Raw | ConvertFrom-Json

function Invoke-Checked {
    param(
        [string]$Executable,
        [string[]]$Arguments
    )

    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & $Executable @Arguments 2>&1
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }

    foreach ($line in @($output)) {
        if ($null -ne $line -and "$line" -ne "") {
            Write-Host "$line"
        }
    }

    if ($code -ne 0) {
        throw "Command failed: $Executable $($Arguments -join ' ')"
    }
}

function Write-Skip {
    param([string]$Name)
    Write-Host "Already installed, skipping: $Name" -ForegroundColor Green
}

function Format-Commit {
    param([string]$Commit)
    if ($Commit.Length -ge 12) {
        return $Commit.Substring(0, 12)
    }
    return $Commit
}

function Get-GitHead {
    param([string]$Path)

    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $actual = & git -C $Path rev-parse HEAD 2>&1
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }

    if ($code -ne 0) {
        return $null
    }

    $hash = @($actual | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join ""
    return $hash.Trim()
}

function Get-TorchIndex {
    param(
        [string]$TorchVersion,
        [string]$Cuda
    )

    if ($TorchVersion -match '\+(cu\d+|rocm\d+|cpu)$') {
        return "https://download.pytorch.org/whl/$($Matches[1])"
    }

    if ($Cuda -match '^(\d+)\.(\d+)') {
        return "https://download.pytorch.org/whl/cu$($Matches[1])$($Matches[2])"
    }

    return "https://download.pytorch.org/whl/cu128"
}

function Normalize-Text {
    param([string]$Text)
    if (-not $Text) {
        return ""
    }
    return (($Text -replace "`r`n", "`n" -replace "`r", "`n").Trim())
}

function Ensure-GitRepository {
    param(
        [string]$Path,
        [string]$Repository,
        [string]$Commit,
        [string]$Label
    )

    if (-not $Repository -or -not $Commit) {
        throw "Missing repository or commit for: $Label"
    }

    $gitPath = Join-Path $Path ".git"
    if (Test-Path -LiteralPath $gitPath) {
        $actual = Get-GitHead $Path
        if (-not $actual) {
            Write-Host "Completing checkout: $Label"
            Invoke-Checked "git" @("-C", $Path, "checkout", "--detach", $Commit)
            $actual = Get-GitHead $Path
        }

        if ($actual -ne $Commit) {
            throw @"
Git commit mismatch:
Path: $Path
Expected: $Commit
Actual: $actual

Existing repository was left unchanged.
"@
        }

        return "skipped"
    }

    if (Test-Path -LiteralPath $Path) {
        $existing = @(Get-ChildItem -LiteralPath $Path -Force)
        if ($existing.Count -gt 0) {
            throw "Directory exists but is not a Git repo: $Path"
        }
    }

    $parent = Split-Path $Path -Parent
    New-Item -ItemType Directory -Force -Path $parent | Out-Null

    Write-Host "Cloning: $Repository"
    Invoke-Checked "git" @(
        "clone",
        "--no-checkout",
        $Repository,
        $Path
    )
    Invoke-Checked "git" @(
        "-C", $Path,
        "checkout",
        "--detach",
        $Commit
    )

    $actual = Get-GitHead $Path
    if ($actual -ne $Commit) {
        throw "Checkout finished at $actual, expected $Commit ($Path)"
    }

    return "installed"
}

function Get-TorchPackages {
    $packages = @("torch==$($Config.pytorch)")
    if ($Config.torchvision) {
        $packages += "torchvision==$($Config.torchvision)"
    }
    if ($Config.torchaudio) {
        $packages += "torchaudio==$($Config.torchaudio)"
    }
    return $packages
}

function Get-RequirementFiles {
    $comfyRequirements = Join-Path $Runtime "requirements.txt"
    if (-not (Test-Path -LiteralPath $comfyRequirements)) {
        throw "Missing requirements.txt: $comfyRequirements"
    }

    $files = @($comfyRequirements)
    foreach ($plugin in @($Config.plugins)) {
        if ($null -eq $plugin -or -not $plugin.name) {
            continue
        }

        $requirements = Join-Path $CustomNodes "$($plugin.name)\requirements.txt"
        if (Test-Path -LiteralPath $requirements) {
            $files += $requirements
        }
    }

    return $files
}

function Get-DependencyProblems {
    param([string[]]$RequirementFiles)

    $env:AIGC_EXPECT_TORCH = [string]$Config.pytorch
    $env:AIGC_EXPECT_TORCHVISION = [string]$Config.torchvision
    $env:AIGC_EXPECT_TORCHAUDIO = [string]$Config.torchaudio
    $env:AIGC_EXPECT_FRONTEND = [string]$Config.frontend
    $env:AIGC_REQUIRE_MANAGER = "1"
    $checker = Join-Path $Infra "check_deps.py"
    if (-not (Test-Path -LiteralPath $checker)) {
        throw "Missing dependency checker: $checker"
    }

    try {
        $previous = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            $output = & $Python $checker @RequirementFiles 2>&1
            $code = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $previous
        }

        $lines = @(
            $output |
                Where-Object { $null -ne $_ -and "$_" -ne "" } |
                ForEach-Object { "$_" }
        )
        if ($code -ne 0) {
            if ($lines.Count -eq 0) {
                return @("dependency check failed")
            }
            return $lines
        }
        return @()
    }
    finally {
        Remove-Item Env:AIGC_EXPECT_TORCH -ErrorAction SilentlyContinue
        Remove-Item Env:AIGC_EXPECT_TORCHVISION -ErrorAction SilentlyContinue
        Remove-Item Env:AIGC_EXPECT_TORCHAUDIO -ErrorAction SilentlyContinue
        Remove-Item Env:AIGC_EXPECT_FRONTEND -ErrorAction SilentlyContinue
        Remove-Item Env:AIGC_REQUIRE_MANAGER -ErrorAction SilentlyContinue
    }
}

function Install-PythonDependencies {
    param(
        [string]$CudaIndex,
        [string[]]$RequirementFiles
    )

    $torchPackages = @(Get-TorchPackages)
    $torchArgs = @(
        "-m", "pip", "install",
        "--disable-pip-version-check"
    ) + $torchPackages + @("--index-url", $CudaIndex)

    Write-Host "Installing $($torchPackages -join ', ')"
    Invoke-Checked $Python $torchArgs

    foreach ($requirements in $RequirementFiles) {
        Write-Host "Installing requirements: $requirements"
        Invoke-Checked $Python @(
            "-m", "pip", "install",
            "--disable-pip-version-check",
            "-r", $requirements
        )
    }

    Write-Host "Installing comfyui-manager"
    Invoke-Checked $Python @(
        "-m", "pip", "install",
        "--disable-pip-version-check",
        "-U", "--pre",
        "comfyui-manager"
    )

    Write-Host "Pinning $($torchPackages -join ', ')"
    Invoke-Checked $Python $torchArgs

    if ($Config.frontend) {
        Write-Host "Pinning comfyui-frontend-package==$($Config.frontend)"
        Invoke-Checked $Python @(
            "-m", "pip", "install",
            "--disable-pip-version-check",
            "comfyui-frontend-package==$($Config.frontend)"
        )
    }

    Invoke-Checked $Python @("-m", "pip", "check")
}

function Install-OrSkipDependencies {
    param([string]$CudaIndex)

    $requirementFiles = @(Get-RequirementFiles)
    $problems = @(Get-DependencyProblems -RequirementFiles $requirementFiles | Where-Object { $_ })
    if ($problems.Count -eq 0) {
        Write-Skip "[6/7] Python dependencies"
        return
    }

    $managerOnly = ($problems.Count -eq 1) -and ($problems[0] -eq "comfyui-manager is not installed")
    if ($managerOnly) {
        Write-Host "[6/7] Installing comfyui-manager"
        Invoke-Checked $Python @(
            "-m", "pip", "install",
            "--disable-pip-version-check",
            "-U", "--pre",
            "comfyui-manager"
        )
        $torchArgs = @(
            "-m", "pip", "install",
            "--disable-pip-version-check"
        ) + @(Get-TorchPackages) + @("--index-url", $CudaIndex)
        Invoke-Checked $Python $torchArgs

        $remaining = @(Get-DependencyProblems -RequirementFiles $requirementFiles | Where-Object { $_ })
        if ($remaining.Count -gt 0) {
            throw "Dependencies are still missing after installation:`n$($remaining -join "`n")"
        }
        return
    }

    Write-Host "[6/7] Installing Python dependencies..."
    if ($problems.Count -gt 8) {
        Write-Host "$($problems.Count) packages are missing or mismatched."
    }
    else {
        foreach ($problem in $problems) {
            Write-Host "  $problem"
        }
    }

    Install-PythonDependencies -CudaIndex $CudaIndex -RequirementFiles $requirementFiles

    $remaining = @(Get-DependencyProblems -RequirementFiles $requirementFiles | Where-Object { $_ })
    if ($remaining.Count -gt 0) {
        throw "Dependencies are still missing after installation:`n$($remaining -join "`n")"
    }
}

Write-Host "=== ComfyUI Production Bootstrap ==="

# -------------------------------------------------
# 1. Python
# -------------------------------------------------

if (-not (Test-Path -LiteralPath $BasePython)) {
    throw "Python not found: $BasePython"
}

$actualPython = (& $BasePython --version).Trim()
$expectedPython = "Python $($Config.python)"
if ($actualPython -ne $expectedPython) {
    throw "Expected $expectedPython, got $actualPython"
}

Write-Skip "[1/7] Python $($Config.python)"

# -------------------------------------------------
# 2. Directories
# -------------------------------------------------

$Directories = @(
    "runtime",
    "models\checkpoints",
    "models\loras",
    "models\vae",
    "models\controlnet",
    "models\diffusion_models",
    "models\text_encoders",
    "models\upscale_models",
    "outputs",
    "input",
    "user",
    "datasets",
    "data"
)

$created = @()
foreach ($relative in $Directories) {
    $path = Join-Path $Root $relative
    if (Test-Path -LiteralPath $path) {
        continue
    }

    New-Item -ItemType Directory -Force -Path $path | Out-Null
    $created += $relative
}

if ($created.Count -eq 0) {
    Write-Skip "[2/7] directories"
}
else {
    Write-Host "[2/7] Created: $($created -join ', ')"
}

# -------------------------------------------------
# 3. ComfyUI Git repository
# -------------------------------------------------

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "git is not installed or not on PATH."
}

$comfyResult = Ensure-GitRepository `
    -Path $Runtime `
    -Repository $Config.comfyui.repository `
    -Commit $Config.comfyui.commit `
    -Label "ComfyUI"

$comfyCommit = Format-Commit $Config.comfyui.commit
if ($comfyResult -eq "skipped") {
    Write-Skip "[3/7] ComfyUI ($comfyCommit)"
}
else {
    Write-Host "[3/7] Installed: ComfyUI ($comfyCommit)"
}

# -------------------------------------------------
# 4. Python virtual environment
# -------------------------------------------------

$venvExisted = Test-Path -LiteralPath $Python
if (-not $venvExisted) {
    Write-Host "[4/7] Creating virtual environment..."
    Invoke-Checked $BasePython @(
        "-m", "venv",
        (Join-Path $Runtime ".venv")
    )
}

$venvVersion = (& $Python --version).Trim()
if ($venvVersion -ne $expectedPython) {
    throw "Venv Python mismatch: $venvVersion"
}

if ($venvExisted) {
    Write-Skip "[4/7] virtual environment"
}
else {
    Write-Host "[4/7] Installed: virtual environment"
}

# -------------------------------------------------
# 5. Custom nodes
# -------------------------------------------------

$sawPlugin = $false
foreach ($plugin in @($Config.plugins)) {
    if ($null -eq $plugin -or -not $plugin.name) {
        continue
    }

    $sawPlugin = $true
    $pluginPath = Join-Path $CustomNodes $plugin.name

    if (-not $plugin.repository -or -not $plugin.commit) {
        if (-not (Test-Path -LiteralPath $pluginPath)) {
            throw @"
Cannot restore non-Git plugin: $($plugin.name)
No repository/commit was recorded.
Install it manually, then retry.
"@
        }

        Write-Skip "[5/7] $($plugin.name) (local plugin)"
        continue
    }

    $pluginResult = Ensure-GitRepository `
        -Path $pluginPath `
        -Repository $plugin.repository `
        -Commit $plugin.commit `
        -Label $plugin.name

    $pluginCommit = Format-Commit $plugin.commit
    if ($pluginResult -eq "skipped") {
        Write-Skip "[5/7] $($plugin.name) ($pluginCommit)"
    }
    else {
        Write-Host "[5/7] Installed: $($plugin.name) ($pluginCommit)"
    }
}

if (-not $sawPlugin) {
    Write-Skip "[5/7] custom nodes"
}

# -------------------------------------------------
# 6. Python dependencies
# -------------------------------------------------

$CudaIndex = Get-TorchIndex -TorchVersion ([string]$Config.pytorch) -Cuda ([string]$Config.cuda)
Install-OrSkipDependencies -CudaIndex $CudaIndex

# -------------------------------------------------
# 7. Model path configuration
# -------------------------------------------------

if ($Config.modelPathsYaml) {
    $target = Join-Path $Runtime "extra_model_paths.yaml"
    $expectedYaml = Normalize-Text ([string]$Config.modelPathsYaml)
    $currentYaml = ""
    if (Test-Path -LiteralPath $target) {
        $currentYaml = Normalize-Text ([System.IO.File]::ReadAllText(
            $target,
            [System.Text.Encoding]::UTF8
        ))
    }

    if ($currentYaml -eq $expectedYaml) {
        Write-Skip "[7/7] model paths"
    }
    else {
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($target, ([string]$Config.modelPathsYaml), $utf8NoBom)
        Write-Host "[7/7] Restored: $target"
    }
}
else {
    Write-Warning "No extra_model_paths.yaml was recorded."
}

foreach ($kind in @("checkpoints", "loras")) {
    foreach ($name in @($Config.models.$kind)) {
        if (-not $name) {
            continue
        }

        $modelPath = Join-Path $Root "models\$kind\$name"
        if (Test-Path -LiteralPath $modelPath) {
            Write-Skip "model $kind/$name"
        }
        else {
            Write-Warning "Model missing: $modelPath"
        }
    }
}

$birefnet = Join-Path $Runtime "models\RMBG\BiRefNet\BiRefNet-general.safetensors"
if (Test-Path -LiteralPath $birefnet) {
    Write-Skip "model RMBG/BiRefNet-general.safetensors"
}
else {
    Write-Warning "Model missing: $birefnet"
}

Write-Host ""
Write-Host "Bootstrap completed successfully." -ForegroundColor Green
Write-Host "Start:    $(Join-Path $Infra 'start.ps1')"
Write-Host "Stop:     $(Join-Path $Infra 'stop.ps1')"
Write-Host "Status:   $(Join-Path $Infra 'service.ps1') status"
Write-Host "Tray:     $(Join-Path $Infra 'tray.vbs')"
Write-Host "Shortcut: $(Join-Path $Infra 'install-shortcuts.ps1')"
