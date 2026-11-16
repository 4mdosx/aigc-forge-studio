# sd-scripts (kohya) 训练栈部署。可重复执行，每步已装则跳过。
#   infra\train_bootstrap.ps1
#   infra\train_bootstrap.ps1 -TorchIndex cu124   # 默认 cu124，RTX 30 系直接用
#
# 部署内容：
#   C:\AIGC\runtime\sd-scripts      kohya-ss/sd-scripts v0.12.3（钉 tag，别追 main）
#   ...\sd-scripts\venv             独立 venv（不复用 ComfyUI 的 3.12 venv，torch 版本各自为政）
#   torch 2.6.0 + cu124             sd-scripts v0.12 官方档位（CI 测 2.6/2.8）；3080 sm_86 支持
#
# 与 trainer 的接口约定（trainer/config.json → trainer.train.sdScriptsRoot）：
#   <root>\runtime\sd-scripts\venv\Scripts\python.exe -m accelerate.commands.launch ... train_network.py
# mixed_precision 等 accelerate 参数由 trainer spawn 时显式给足，本机无需 accelerate config。

param(
    [string]$Root = "C:\AIGC",
    [string]$SdTag = "v0.12.3",
    [string]$TorchIndex = "cu124"
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
$env:GIT_TERMINAL_PROMPT = "0"
$env:PIP_DISABLE_PIP_VERSION_CHECK = "1"
$env:GIT_CONFIG_COUNT = "1"
$env:GIT_CONFIG_KEY_0 = "safe.directory"
$env:GIT_CONFIG_VALUE_0 = "*"

$Python = "C:\Python312\python.exe"
$SdScripts = Join-Path $Root "runtime\sd-scripts"
$VenvPython = Join-Path $SdScripts "venv\Scripts\python.exe"

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { $output = & $Executable @Arguments 2>&1; $code = $LASTEXITCODE }
    finally { $ErrorActionPreference = $previous }
    foreach ($line in @($output)) {
        if ($null -ne $line -and "$line" -ne "") { Write-Host "$line" }
    }
    if ($code -ne 0) { throw "Command failed: $Executable $($Arguments -join ' ')" }
}

function Write-Skip {
    param([string]$Name)
    Write-Host "Already installed, skipping: $Name" -ForegroundColor Green
}

# 探测类调用：只要 exit code，stderr 吞掉。
# PS5.1 坑：EAP=Stop 时 stderr 重定向（2>&1/2>$null）会把 stderr 行变成
# terminating error——「ModuleNotFoundError」的 traceback 就能炸停脚本。
# 所以探测前必须临时放宽 EAP（实测坑，勿删）。
function Invoke-Probe {
    param([string]$Executable, [string[]]$Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        [void] (& $Executable @Arguments 2>&1)
        return ($LASTEXITCODE -eq 0)
    } finally { $ErrorActionPreference = $previous }
}

# 取输出类调用：返回合并后的 stdout+stderr（trim 过），忽略 exit code。
function Get-NativeOutput {
    param([string]$Executable, [string[]]$Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { return ((& $Executable @Arguments 2>&1 | Out-String).Trim()) }
    finally { $ErrorActionPreference = $previous }
}

if (-not (Test-Path -LiteralPath $Python)) {
    throw "Python 3.12 not found at $Python (ComfyUI bootstrap installs it)"
}

# --- 1. sd-scripts 仓库（钉 tag） ---
$TrainScript = Join-Path $SdScripts "train_network.py"
if (Test-Path -LiteralPath $TrainScript) {
    $head = Get-NativeOutput "git" @("-C", $SdScripts, "describe", "--tags", "--exact-match", "HEAD")
    if ("$head" -eq $SdTag) {
        Write-Skip "sd-scripts $SdTag"
    } else {
        Write-Host "sd-scripts present but not on $SdTag, checking out..."
        Invoke-Checked "git" @("-C", $SdScripts, "fetch", "--depth", "1", "origin", "tag", $SdTag, "--force")
        Invoke-Checked "git" @("-C", $SdScripts, "checkout", $SdTag)
    }
} else {
    Write-Host "Cloning sd-scripts $SdTag..."
    New-Item -ItemType Directory -Force -Path (Join-Path $Root "runtime") | Out-Null
    Invoke-Checked "git" @("clone", "--depth", "1", "--branch", $SdTag,
        "https://github.com/kohya-ss/sd-scripts.git", $SdScripts)
}

# --- 2. 独立 venv ---
if (Test-Path -LiteralPath $VenvPython) {
    Write-Skip "venv"
} else {
    Write-Host "Creating venv..."
    Invoke-Checked $Python @("-m", "venv", (Join-Path $SdScripts "venv"))
}

# --- 3. torch cu124（版本对上就跳过，~2.5GB 下载只在首次发生） ---
if (Invoke-Probe $VenvPython @("-c", "import torch; exit(0 if torch.__version__.startswith('2.6.0') else 1)")) {
    Write-Skip "torch 2.6.0+$TorchIndex"
} else {
    Write-Host "Installing torch 2.6.0 + torchvision (cu124)..."
    Invoke-Checked $VenvPython @("-m", "pip", "install", "torch==2.6.0", "torchvision==0.21.0",
        "--index-url", "https://download.pytorch.org/whl/$TorchIndex")
}

# --- 4. requirements（幂等；已装包 pip 直接秒过） ---
Write-Host "Syncing requirements.txt..."
Invoke-Checked $VenvPython @("-m", "pip", "install", "--upgrade", "-r", (Join-Path $SdScripts "requirements.txt"))

# --- 5. 冒烟：CUDA 可用 + 关键依赖可导入 ---
Write-Host "Smoke test..."
Invoke-Checked $VenvPython @("-c",
    "import torch, accelerate, diffusers, transformers, bitsandbytes; print('torch', torch.__version__, 'cuda', torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'NO GPU')")
if ($LASTEXITCODE -ne 0) { throw "Smoke test failed" }

Write-Host ""
Write-Host "sd-scripts ready at $SdScripts" -ForegroundColor Green
Write-Host "Trainer spawns: $VenvPython -m accelerate.commands.launch ... train_network.py (cwd = $SdScripts)"
Write-Host "Restart trainer service after deploy: infra\service.ps1 restart (or your trainer start script)"
