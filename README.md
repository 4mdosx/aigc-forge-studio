# AIGC

Windows GPU 上的 ComfyUI，加上一个从外部提交工作流的 Runner。

`infra` 在 Windows 上安装并启停 ComfyUI。Runner 读根目录 `config.json` 里的 `runner.comfyUiBaseURL`，这个字段没有值时用 `comfyui.baseURL`。它按 `runner/adapter` 把业务参数填进界面工作流，等执行结束，把结果下载到本机。

默认根目录是 `C:\AIGC`。仓库放在别的路径时，给下面的脚本加上 `-Root D:\AIGC`。

## 目录

| 路径 | 作用 |
| --- | --- |
| `config.json` | ComfyUI 和 Runner 的地址、超时、结果目录 |
| `infra/data/environment.json` | ComfyUI、插件、Python、PyTorch 的版本钉扎 |
| `runtime/comfyui-prod` | ComfyUI 本体和虚拟环境，不进版本库 |
| `models/` | 共享权重，不进版本库 |
| `runner/task/` | 日常维护的业务入口。`text2img.ts`、`remove-bg.ts`，链式调用在 `cutout.ts` |
| `runner/adapter/` | 日常维护的映射。用 `model` 选中界面工作流，并把入参写到节点 |
| `runner/src/` | 本地 HTTP 服务和执行。应用配置、读 adapter、提交、等待、下载 |
| `user/default/workflows/` | ComfyUI 界面里保存的图，不进版本库 |
| `outputs/` | 生成结果，不进版本库 |
| `input/` | 交给 ComfyUI 的输入图，不进版本库 |

## infra

在装好环境的 Windows 上执行。需要：

- Git 在 `PATH` 里
- `C:\Python312\python.exe`，版本与 `infra/data/environment.json` 里的 `python` 一致（当前是 3.12.10）
- 能跑该文件里钉扎的 PyTorch CUDA 轮子的 NVIDIA 驱动（当前是 `2.11.0+cu128`）

### 配置

根目录 `config.json`：

```json
{
  "comfyui": {
    "baseURL": "http://192.168.8.136:8188",
    "listen": "0.0.0.0",
    "port": 8188
  },
  "runner": {
    "comfyUiBaseURL": "http://127.0.0.1:18188",
    "host": "127.0.0.1",
    "port": 8787,
    "timeout": 600,
    "out": "outputs/runner"
  }
}
```

`comfyui.listen` 和 `comfyui.port` 是 Windows 进程的绑定地址。`comfyui.baseURL` 是浏览器访问用的地址。Runner 访问 ComfyUI 用 `runner.comfyUiBaseURL`，这个字段没有值时用 `comfyui.baseURL`。`runner` 里其余字段是本地 HTTP 服务的监听地址、超时秒数和结果目录。

### 安装

在已经能出图的机器上先采集现场：

```powershell
infra\snapshot.ps1
```

它把 ComfyUI 和插件的仓库与 commit、Python、PyTorch、模型文件名写入 `infra/data/environment.json`。升级 ComfyUI 或插件之后重新跑一次，再把这个文件提交进仓库。

在新机器上按这份钉扎装回去：

```powershell
infra\bootstap.ps1
```

脚本可以重复执行。已经符合钉扎的步骤会打印 `Already installed, skipping`。它会检查 Python、建目录、检出 ComfyUI 和 `ComfyUI-RMBG`、创建虚拟环境、安装依赖，并把模型目录指到 `C:\AIGC\models`。权重本身不会下载。缺少的 checkpoint 或 BiRefNet 权重会以警告打印出来，文件要自己放到：

- `models\checkpoints\animagine-xl-4.0-opt.safetensors`
- `runtime\comfyui-prod\models\RMBG\BiRefNet\BiRefNet-general.safetensors`

### 启停

```powershell
infra\start.ps1
infra\start.ps1 -Foreground
infra\stop.ps1
infra\service.ps1 status
infra\service.ps1 restart
```

`start.ps1` 在后台启动。端口已经由这次安装的进程占用时，会跳过。`-Foreground` 把进程留在当前窗口，Ctrl+C 停止。

日志在 `logs\comfyui.log` 和 `logs\comfyui.err.log`。

托盘图标：

```powershell
infra\tray.vbs
infra\install-shortcuts.ps1
infra\install-shortcuts.ps1 -Startup
```

`install-shortcuts.ps1` 在桌面放一个 ComfyUI 快捷方式。`-Startup` 再放到启动文件夹，登录后自动打开托盘。

## Runner

在能访问 ComfyUI 的机器上执行。需要 Node.js 22.18 或更新版本。直接跑服务，不用先 `npm install`。

```bash
node runner/src/server.ts
```

服务听在 `config.json` 的 `runner.host` 和 `runner.port`，默认是 `http://127.0.0.1:8787`。`--host`、`--port`、`--timeout`、`--out` 只覆盖这一次启动。`timeout` 单位是秒，默认 600。`out` 相对仓库根目录，默认 `outputs/runner`。ComfyUI 地址来自 `runner.comfyUiBaseURL`，没有值时用 `comfyui.baseURL`。这些在进程启动时定一次。Ctrl+C 会取消正在执行的提交。

调用分三层：

1. HTTP 接口只收业务参数。`POST /text2img` 要 `text` 和 `entry`。`POST /remove-bg` 要 `path` 和 `adapter`。`POST /cutout` 要 `text`，`entry` 默认 `sdxl`，`adapter` 默认 `birefnet`。
2. `runner/adapter/<task>/<model>.json` 用 `model` 选中 `user/default/workflows` 里的一张界面图，并把入参写到指定节点。
3. `runner/src` 把这张图转成 ComfyUI API prompt，提交，等待，再把结果下载到结果根目录下面的一个新目录。响应是 `{ "path": "<这个目录>" }`。

文生图。`entry sdxl` 读 `runner/adapter/text2img/sdxl.json`，把 `text` 写到 `text2image_sdxl.json` 的节点 `10`（Positive Prompt）：

```bash
curl --json '{"text":"a standing character, simple background","entry":"sdxl"}' http://127.0.0.1:8787/text2img
```

```json
{"path":"/Volumes/AIGC/outputs/runner/text2img-20261113T003400123"}
```

抠图。`path` 可以是一张图，也可以是上一步返回的目录；目录里会取按文件名排序的第一张图。`adapter birefnet` 读 `runner/adapter/remove-bg/birefnet.json`，把这张图上传后写入 `RM_BG.json` 的节点 `2`（LoadImage）：

```bash
curl --json '{"path":"/Volumes/AIGC/outputs/runner/text2img-20261113T003400123","adapter":"birefnet"}' http://127.0.0.1:8787/remove-bg
```

`POST /cutout` 先跑文生图，再把返回的 `path` 交给抠图。响应里的 `path` 是抠图结果目录。

```bash
curl --json '{"text":"a standing character, simple background"}' http://127.0.0.1:8787/cutout
```

换模型时在 `runner/adapter/text2img/` 或 `runner/adapter/remove-bg/` 加一个 JSON。`model` 用新名字，`workflow` 指向 `user/default/workflows` 里的图，`inputs` 写明每个业务参数落到哪个节点。`upload: true` 表示这个参数是本地图片，先上传再写入节点。

### 开发

```bash
cd runner
npm install
npm test
npm run check
```

`npm test` 不连 GPU。`npm run check` 做类型检查。
