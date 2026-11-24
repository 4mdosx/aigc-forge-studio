# AIGC

Windows GPU 上的 ComfyUI，加上一个从外部提交工作流的 Runner。

`infra` 在 Windows 上安装并启停 ComfyUI。Runner 是 Hono 服务，用 SQLite 保存 Workflow 版本和任务队列。出图实例来自 `runner.comfyUiBaseURLs`；没有这个列表时用 `runner.comfyUiBaseURL`，它也没有值时用 `comfyui.baseURL`。一台实例同时只跑一条出图任务。

默认根目录是 `C:\AIGC`。仓库放在别的路径时，给下面的脚本加上 `-Root D:\AIGC`。

## 目录

| 路径 | 作用 |
| --- | --- |
| `cli.js` | 交互启动。先选 dev 或 deploy，再多选服务，确认后启动 |
| `config.json` | ComfyUI 和 Runner 的地址、超时、数据库路径 |
| `env.example.ts` | 提示词网关的模板。复制成 `env.ts` 后填写，`env.ts` 不进版本库 |
| `infra/data/environment.json` | ComfyUI、插件、Python、PyTorch 的版本钉扎 |
| `runtime/comfyui-prod` | ComfyUI 本体和虚拟环境，不进版本库 |
| `models/` | 共享权重，不进版本库 |
| `runner/src/` | HTTP 服务。`http` 是接口，`workflow` 是版本，`task` 是出图队列，`chat` 是提示词对话，`comfy` 是 ComfyUI 客户端 |
| `web/` | Next.js 界面，通过 Runner 的 HTTP 接口操作 |
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
    "out": "outputs/runner",
    "db": "data/runner.sqlite"
  }
}
```

`comfyui.listen` 和 `comfyui.port` 是 Windows 进程的绑定地址。`comfyui.baseURL` 是浏览器访问用的地址。Runner 的出图实例优先用 `runner.comfyUiBaseURLs`。没有这个数组时用 `runner.comfyUiBaseURL`，这个字段没有值时用 `comfyui.baseURL`。`runner.timeout` 是出图任务进入执行后的超时秒数，默认 600。`runner.db` 默认是 `data/runner.sqlite`。日志写到 `data/logs/runner.log`。

提示词对话读仓库根目录的 `env.ts`，这个文件不进版本库。把 `env.example.ts` 复制成 `env.ts` 再填写。`AI_GATEWAY_MODEL` 是模型名列表。请求里的 `model` 必须是其中一项，不传就用第一项。没有 `env.ts`，或 key、url 还空着时，出图照常运行，对话接口返回 503。

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

在能访问 ComfyUI 的机器上执行。需要 Node.js 22.18 或更新版本。`runner/` 和 `web/` 都安装过依赖后，在仓库根目录执行：

```bash
npm install
node cli.js
```

先选 `dev` 或 `deploy`，再勾选服务。方向键移动，空格勾选，回车启动。可以同时选 `runner+web` 和 `critic`，Ctrl+C 一起停。`dev` 用 `npm run dev`，源码变化会重启。`deploy` 用 `npm start`，选了 `runner+web` 时 Web 会先执行 `npm run build`。Runner 听 `http://127.0.0.1:8787`，界面听 `http://127.0.0.1:3000`。`critic` 用仓库根目录的 `.venv` 启动，地址读 `config.json` 的 `critic.host` 和 `critic.port`。

只启动 Runner 时：

```bash
cd runner
npm install
npm start
```

服务听在 `config.json` 的 `runner.host` 和 `runner.port`，默认是 `http://127.0.0.1:8787`。`--host`、`--port`、`--timeout` 只覆盖这一次启动。`npm run dev` 会在源码变化时重启进程。数据库在 `runner.db`，默认 `data/runner.sqlite`。日志在 `data/logs/runner.log`。

SQLite 里 `works` 是逻辑能力，例如生成一张 SDXL 图。语义字段写在 `semantic_json`。`workflows` 对应 ComfyUI userdata 里的一个文件，不再属于某一个 Work。`workflow_revisions` 保存界面图和执行图。`version` 是这个 Workflow 内部唯一的八位字母数字 id，覆盖不改它，Commit 才新生成一个。`workflow_revision_parents` 记录父节点，分支上的顺序看父节点。`workflow_branches` 是可移动的分支头。`work_workflows` 以 `work_id`、`workflow_id` 唯一。`adapter_json` 是版本号到 Adapter 的映射。同一个 Workflow 挂到不同 Work 时各有一份映射。某一版没有 Adapter 时，出图沿用创建时间最近、而且已经有 Adapter 的那一版，并在页面上标明来源。`tasks` 在创建时把当时实际用的 Adapter 抄进 `adapter_json`，之后只读这份快照。`chats` 和 `chat_messages` 保存提示词对话，不进入任务队列。

从 ComfyUI 拉列表，再由调用方选择入库或更新。列表只比较，不写入：

```bash
curl http://127.0.0.1:8787/comfy/workflows
curl --json '{"action":"import","paths":["RM_BG.json"]}' http://127.0.0.1:8787/comfy/workflows
curl --json '{"action":"update","paths":["RM_BG.json"]}' http://127.0.0.1:8787/comfy/workflows
```

`import` 只创建还没有的 Workflow、根 Revision 和 `main`。文件已经在库里且内容一致时返回未变化。内容不一致时拒绝，不会覆盖，也不会产生新版本。`update` 只处理已经入库的文件：和当前头不一致就改写这一版的界面图和执行图，版本号不变；一致则不写。新版本只在 Commit 时创建。

也可以指定名称直接建立，再把某一个版本挂到 Work 并写入 Adapter：

```bash
curl --json '{"name":"character-generator","comfyPath":"character-generator.json"}' http://127.0.0.1:8787/workflows
curl --json '{"workflowName":"character-generator"}' http://127.0.0.1:8787/works/picture/workflows
curl --json '{"workflowName":"character-generator","version":"<version>","adapter":{"inputs":{"text":{"class_type":"CLIPTextEncode","name":"positive","input":"text"}},"outputs":{"images":{"class_type":"SaveImage","name":"result"}}}}' http://127.0.0.1:8787/works/picture/workflows/adapter
```

之后的版本操作由客户端按顺序调用。服务端不自动合并，也不自动切换：

```bash
curl --json '{"name":"lora-a"}' http://127.0.0.1:8787/workflows/character-generator/branches
curl --json '{"branch":"lora-a"}' http://127.0.0.1:8787/workflows/character-generator/switch
curl -X POST http://127.0.0.1:8787/workflows/character-generator/checkout
curl --json '{"message":"try another lora"}' http://127.0.0.1:8787/workflows/character-generator/commit
curl --json '{"revisionId":"<revision>","expectedHead":"<current head>"}' http://127.0.0.1:8787/workflows/character-generator/branches/main
```

切换分支只改 `current_branch`。出图不看当前分支：请求里的 `version` 是八位 id，不传就用 `main` 的头。Workflow 必须已经挂在该 Work 上。Adapter 从 `work_workflows` 里这一版的条目读取；没有时用最近一份，并在创建任务时写入快照。Checkout 是唯一写回 ComfyUI 的操作，把当前头的 `ui_json` 写到第一台实例的 `comfy_path`。出图只按 Runner 里这一版构造 `/prompt`，不会写回。Commit 从同一路径读回并新建版本，父节点是当时的当前头。新版本不会自动挂到 Work。分支头移动时带上原来的头，对不上就返回冲突。把 `main` 指到某次已有 Revision 不新建快照。

Adapter 用 `class_type` 锁定节点。写了 `name` 时再按节点标题筛选，结果必须恰好一个。`id` 只校验锁定到的节点，变了就失败，需要改 Adapter，这次修改不产生新版本。输入键要和所属 Work 的语义字段一致。`seed` 不传或传 `random` 时生成 `0` 到 `2^32-1` 的整数；传入数字则固定这个值。实际写入的整数记在任务的 `input_json`。

队列只跑出图。`POST /works/:name/run` 写入 `pending` 后立即返回。出图按实例列表分配，一台实例同时只能有一条 `running` 任务。实例连不上时任务留在 `pending`；`/prompt` 拒绝时写成 `failed`。客户端查询只读数据库。任务完成后只记录路径，不把文件下载到 Runner。

```bash
curl --json '{"payload":{"text":"a knight","seed":"random"},"task":"text2img"}' http://127.0.0.1:8787/works/picture/run
curl http://127.0.0.1:8787/tasks/<task id>
curl -X POST http://127.0.0.1:8787/tasks/<task id>/cancel
curl http://127.0.0.1:8787/revisions/<revision id>/tasks
```

`/works/:name/run` 的入参只有 `payload`，其余都在服务端解析：`workflow` 缺省取该 Work 挂的第一个，`version` 缺省取 `main` 头，该版本绑定的 Adapter 从 `work_workflows` 取。**payload 里没交的槽位沿用工作流当前值**，所以调用方只交要改的那几个键；交了 Adapter 不认识的键会直接报 `unknown input`。`pose` 是便捷入口：传 manifest 里的姿态 id，服务端把骨架图和深度图上传到 ComfyUI 并覆盖 `width` / `height`；工作流没有这两个槽位时报 400，不静默忽略。

`/generate/cn` 与 `/generate/base` 是两条固定配方的快捷方式（机娘快速出图），参数只有 `prompt`、`repeat`、`loraName`、`poseName`；workflow 名和 Adapter 写在 `runner/src/generate.ts` 里，对调用方不可见。

状态是 `pending`、`running`、`completed`、`failed`、`timeout`、`cancelled`。出图超时从 `started_at` 起算，默认 600 秒，不算排队。超时后写成 `timeout`，不再查看，也不取消 ComfyUI 上的执行。`pending` 的取消只改 Runner 状态；`running` 的任务会调用该实例的 `POST /api/jobs/{prompt_id}/cancel`。

最终文件在 `outputPath`，同一节点多张图时是 JSON 数组。其余产出在 `process`，每项含 `path`、`name` 和 `id`。对比图片由客户端按两次 Revision 查出任务后自己做。

提示词对话是同步的多轮请求，用官方 `openai` 包发给 `env.ts` 里的 `AI_GATEWAY_URL`。单次等待模型返回，超时 60 秒，失败后再试 1 次。历史只在模型成功返回后写入。助手用用户的语言交谈，定稿时给出一段英文提示词。

```bash
curl --json '{"content":"一个穿红盔甲的骑士","model":"writer"}' http://127.0.0.1:8787/chats
curl --json '{"content":"背景改成雪原"}' http://127.0.0.1:8787/chats/<id>/messages
curl http://127.0.0.1:8787/chats/<id>
```

上传只进入每台实例的 `input`。路径必须是相对路径，拒绝 `..`、绝对路径和反斜杠：

```bash
curl -F file=@face.png -F path=jobs/face.png http://127.0.0.1:8787/files
curl http://127.0.0.1:8787/files/jobs/face.png
curl http://127.0.0.1:8787/tasks/<task id>/files
curl http://127.0.0.1:8787/tasks/<task id>/files/output/a.png
```

按 task 下载只允许这条任务已经记下的路径，并从它记录的那台实例读取。

### 开发

```bash
cd runner
npm install
npm test
npm run check
```

`npm test` 不连 GPU，也不读 `user/default/workflows`。`npm run check` 做类型检查。

## MCP

`runner/mcp/` 是一个 stdio MCP 服务，把上面这些接口收成给 agent 用的工具集。它不重写业务逻辑：版本解析、Adapter 匹配、姿态上传、prompt 组装都在 Runner 里，这里只转发和裁剪。

```bash
cd runner
npm install            # 含 @modelcontextprotocol/sdk
node mcp/server.mjs    # stdio；RUNNER_URL 默认 http://127.0.0.1:8787
node mcp/selftest.mjs  # 不连 GPU 的自检：列工具 + 调只读工具
```

客户端配置（`~/.workbuddy/mcp.json` 之类）：

```json
{
  "mcpServers": {
    "aigc-runner": {
      "command": "node",
      "args": ["/Users/token/workspace/AIGC/aigc-forge-studio/runner/mcp/server.mjs"],
      "env": { "RUNNER_URL": "http://127.0.0.1:8787" }
    }
  }
}
```

16 个工具，分三组：

- **发现**：`runner_manual`（整篇手册）、`runner_status`、`list_works`、`describe_work`（某个 Work 的完整入参槽位表，含每个槽的节点与当前值）、`list_workflows`、`list_poses`、`list_loras`
- **生成**：`run_work`（按 Work 跑一次，主力）、`quick_generate`（两条快速配方）、`sweep`（因子笛卡尔积批量对照）
- **查询**：`get_task`、`list_tasks`、`wait_tasks`、`list_outputs`、`trace_output`、`list_datasets`

自说明的重点在 `runner/mcp/manual.md` 与每个工具的 `description`：什么场景用哪个工具、payload 每个键什么语义、六类常见报错对应什么原因、哪些事别做（别直连 ComfyUI、别写 SQLite）。手册跟服务一起进版本库，改行为就改它。

## Web

界面在 `web/`，请求由 Next.js 转到 Runner，浏览器不直连 `8787`。

```bash
cd web
npm install
npm run dev
```

默认打开 `http://127.0.0.1:3000`。Runner 地址用环境变量 `RUNNER_URL`，默认 `http://127.0.0.1:8787`。

首次打开界面会设置 4 位 PIN。解锁后的会话到当天结束，次日需要再输入。PIN 的散列存在 `data/web-auth.json`，这个文件不进版本库。设置页可以更新 PIN 或退出。忘记 PIN 时，在 `web/` 执行 `npm run clear-pin` 后重新设置。连续输错会指数退避，最长锁定 24 小时；重启 Web 进程会清掉这次锁定。浏览器入口受 PIN 保护，Runner 的 `8787` 仍按原来的地址直接访问。

顶部是 Work 和 Library。Work 是三列：进行中的任务、Work 及其已挂版本、右侧出图。右下角的对话用来多轮写出图提示词，不进入任务队列。新建和编辑 Work 都在弹窗里。Library 管理 ComfyUI 的 input 和 output，上传输入图也在这一页。同一页可以「从 ComfyUI 建立」workflow：一次选一份 JSON，新文件入库，已变化的文件覆盖当前版本，不产生新版本。打开页面不会写入。Work 页把 workflow 挂上来。点名称可以看版本图和节点图。出图时选择版本并维护这一版的 Adapter；这一版还没有时，页面沿用最近一份并标明来源。工作流页顶部可以新建版本，并在版本列表里改说明、把这一版同步到 ComfyUI。任务页轮询状态，并可以取消还没结束的任务。
