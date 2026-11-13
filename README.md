# AIGC

Windows GPU 上的 ComfyUI，加上一个从外部提交工作流的 Runner。

`infra` 在 Windows 上安装并启停 ComfyUI。Runner 是 Hono 服务，用 SQLite 保存 Workflow 版本和任务队列。出图实例来自 `runner.comfyUiBaseURLs`；没有这个列表时用 `runner.comfyUiBaseURL`，它也没有值时用 `comfyui.baseURL`。一台实例同时只跑一条出图任务。

默认根目录是 `C:\AIGC`。仓库放在别的路径时，给下面的脚本加上 `-Root D:\AIGC`。

## 目录

| 路径 | 作用 |
| --- | --- |
| `config.json` | ComfyUI 和 Runner 的地址、超时、数据库路径 |
| `infra/data/environment.json` | ComfyUI、插件、Python、PyTorch 的版本钉扎 |
| `runtime/comfyui-prod` | ComfyUI 本体和虚拟环境，不进版本库 |
| `models/` | 共享权重，不进版本库 |
| `runner/src/` | HTTP 服务、SQLite、版本操作和任务队列 |
| `data/` | Runner 的数据库和日志，不进版本库 |
| `datasets/` | 训练数据集。启动 ComfyUI 时作为数据集节点的默认目录 |
| `user/default/workflows/` | ComfyUI 自己的界面图，Runner 只通过 `/userdata` 读写 |
| `outputs/` | ComfyUI 的生成结果，Runner 只记录路径并通过 `/view` 读取 |
| `input/` | ComfyUI 的输入图，Runner 只通过 `/upload/image` 写入 |

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

`comfyui.listen` 和 `comfyui.port` 是 Windows 进程的绑定地址。`comfyui.baseURL` 是浏览器访问用的地址。Runner 的出图实例优先用 `runner.comfyUiBaseURLs`。没有这个数组时用 `runner.comfyUiBaseURL`，这个字段没有值时用 `comfyui.baseURL`。`runner.timeout` 是出图任务进入执行后的超时秒数，默认 600。`runner.db` 默认是 `data/runner.sqlite`。日志写到 `data/logs/runner.log`。

可选的 LLM 配置：

```json
"llm": { "baseURL": "http://127.0.0.1:11434/v1", "model": "writer", "concurrency": 8, "timeout": 60 }
```

`concurrency` 是这个地址上同时进行的 LLM 请求数。没有 `llm` 时，LLM 任务不会被执行。

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

`start.ps1` 在后台启动。端口已经由这次安装的进程占用时，会跳过。`-Foreground` 把进程留在当前窗口，Ctrl+C 停止。启动时把根目录的 `datasets` 设为训练数据集节点的默认目录，`SaveTrainingDataset` 写到这里。

ComfyUI 日志在 `logs\comfyui.log` 和 `logs\comfyui.err.log`。

托盘图标：

```powershell
infra\tray.vbs
infra\install-shortcuts.ps1
infra\install-shortcuts.ps1 -Startup
```

`install-shortcuts.ps1` 在桌面放一个 ComfyUI 快捷方式。`-Startup` 再放到启动文件夹，登录后自动打开托盘。

## Runner

在能访问 ComfyUI 的机器上执行。需要 Node.js 22.18 或更新版本。先安装依赖：

```bash
cd runner
npm install
node src/server.ts
```

服务听在 `config.json` 的 `runner.host` 和 `runner.port`，默认是 `http://127.0.0.1:8787`。`--host`、`--port`、`--timeout` 只覆盖这一次启动。`npm run dev` 会在源码变化时重启进程。

队列在 Runner 里。`POST /tasks` 写入 `pending` 后立即返回。出图消费按实例列表分配，一台实例同时只有一条 `running` 任务。LLM 消费使用 `runner.llm`，和出图分开计数。客户端查询只读数据库，不会触发一次新的检查。任务完成后只记录 ComfyUI 上的文件路径，不把文件下载到 Runner。

第一次提交从 ComfyUI 的 userdata 读出界面图，创建 Workflow、根 Revision 和 `main`：

```bash
curl --json '{"name":"character-generator","comfyPath":"character-generator.json","adapter":{"inputs":{"text":{"class_type":"CLIPTextEncode","name":"positive","input":"text"}},"outputs":{"images":{"class_type":"SaveImage","name":"result"}}}}' http://127.0.0.1:8787/workflows
```

之后的版本操作：

```bash
curl --json '{"name":"lora-a"}' http://127.0.0.1:8787/workflows/character-generator/branches
curl --json '{"branch":"lora-a"}' http://127.0.0.1:8787/workflows/character-generator/switch
curl -X POST http://127.0.0.1:8787/workflows/character-generator/checkout
curl --json '{"message":"try another lora"}' http://127.0.0.1:8787/workflows/character-generator/commit
curl --json '{"revisionId":"<revision>","expectedHead":"<current head>"}' http://127.0.0.1:8787/workflows/character-generator/branches/main
```

Checkout 把当前头的界面图写回第一台实例。Commit 从同一路径读回，父节点是当时的当前头。Adapter 用 `class_type` 和可选的节点标题锁定节点，`id` 只做校验。`seed` 不传或传 `random` 时生成整数；传入数字则固定这个值。

执行任务：

```bash
curl --json '{"executor":"llm","task":"prompt","payload":{"prompt":"describe a knight"}}' http://127.0.0.1:8787/tasks
curl --json '{"executor":"comfyui","task":"text2img","workflowName":"character-generator","payload":{"text":"a knight","seed":"random"},"parentTaskId":"<llm task>"}' http://127.0.0.1:8787/tasks
curl http://127.0.0.1:8787/tasks/<task id>
curl -X POST http://127.0.0.1:8787/tasks/<task id>/cancel
curl http://127.0.0.1:8787/revisions/<revision id>/tasks
```

LLM 任务完成后，文本在 `outputText`。出图任务的最终文件在 `outputPath`，其余产出在 `process`，每项含 `path`、`name` 和 `id`。

上传只进入每台实例的 `input`。路径必须是相对路径：

```bash
curl -F file=@face.png -F path=jobs/face.png http://127.0.0.1:8787/files
curl http://127.0.0.1:8787/files/jobs/face.png
curl http://127.0.0.1:8787/tasks/<task id>/files
curl http://127.0.0.1:8787/tasks/<task id>/files/output/a.png
```

按 task 下载只允许这条任务已经记下的路径，并从它记录的那台实例读取。`..`、绝对路径和反斜杠会被拒绝。

### 开发

```bash
cd runner
npm install
npm test
npm run check
```

`npm test` 不连 GPU，也不读 `user/default/workflows`。`npm run check` 做类型检查。
