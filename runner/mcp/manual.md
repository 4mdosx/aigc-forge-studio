# aigc-runner 使用手册

这是 aigc-forge-studio 的 runner（Hono + SQLite，默认 127.0.0.1:8787）通过 MCP 暴露出来的
工具集。它管的是**机娘 / 二次元立绘**这条生成链路：ComfyUI 在 192.168.8.136:8188，
训练机在 :8788，所有参数、版本、姿态素材都在 runner 的库里。

## 1. 三条生成路径，先选一条

| 路径 | 工具 | 什么时候用 | 构图控制 |
|---|---|---|---|
| 快速出图·有姿态 | quick_generate(kind="cn") | 要指定姿势、要全身入画、要稳定 | 骨架 1.0 + 深度 0.7 双 ControlNet |
| 快速出图·无姿态 | quick_generate(kind="base") | 只想看「机设想得对不对」，构图随便 | 无 CN，纯文生图，构图看运气 |
| 定案工作流 | run_work(work="mecha") | 要高质量成品、要能逐槽调参 | 同 cn，另加 hires 二次采样 |

三条都跑同一套底子：`animagine-xl-4.0-zero` + gloss LoRA 1.0（画法）+ struct_pool_v3 0.8（机设语言），
832×1216，30 步，cfg 5。区别只在构图控制和后处理。

## 2. 五分钟上手

1. `runner_status` —— 确认服务在、GPU 空、队列没堵。
2. `list_works` —— 看有哪些 work；机娘是 `mecha`，角色直出是 `character`。
3. `describe_work("mecha")` —— **关键一步**。返回每个 workflow 的入参槽位表：
   每个 key 对应哪个节点、当前值多少。你交的 payload 只能用这里的 key，多一个都会
   报 `unknown input`。
4. `run_work({ work:"mecha", pose:"synth-stand-a", payload:{ positive:"..." } })`
   —— 只交要改的槽位，其余自动取工作流现值。
5. `wait_tasks({ ids:["<taskId>"] })` —— 等它在 GPU 上跑完，返回产物路径与下载 URL。

## 3. payload 语义

- `positive` / `negative`：整段提示词直通对应 CLIPTextEncode 节点。**工作流里已经写死的
  质量词和负面词会被你这一句覆盖**，所以要么写全，要么不传。
- `seed`：整数，或 `"random"`（默认）。同一 seed + 同一 payload = 可复现。
- `batch`：一次出几张（1–16）。注意 base 路走 `batch_size`、cn 路走 `RepeatLatentBatch.amount`，
  语义都是「几张」。
- 强度类：`skeleton_strength` / `depth_strength` / `gloss_strength` / `struct_strength`。
  经验值：骨架 1.0、深度 0.7、gloss 1.0、struct 0.8。**denoise 才是质感的总阀门**，
  但 `run_work` 这条路 denoise 给 1.0 直出，别降。
- `pose`：姿态 id（来自 `list_poses`），服务端会把骨架图和深度图传到 ComfyUI 并覆盖
  width/height。工作流没有骨架/深度槽位时直接报 400——不会静默忽略。
- 其余槽位按 `describe_work` 的清单来。

## 4. 版本模型（别乱传 version）

workflow 有版本（8 位 id）和分支，**默认永远跑 main head**。`version` 只在做「同一张图
换个版本对比」时传，而且该版本必须绑定了 adapter（`describe_work` 里 adapterStatus 是 ready）。

节点标题是协议不是注释：adapter 按 `class_type + 节点标题` 找节点，改标题等于让任务提交失败。
要改工作流，走 runner 的 /workflows/:name/commit，别绕过它直接写 DB 或直连 ComfyUI。

## 5. 产物怎么拿

任务终态（completed / failed / cancelled / timeout）后：

- `get_task(id)` 返回 `outputPath`（ComfyUI 侧的 output/... 路径）和 `files`（同目录全部文件）。
- 下载 URL 形如 `{{RUNNER}}/tasks/<id>/files/output/2026-11-24/<task>/xxx_00001_.png`。
- `list_outputs` 是「最近出过什么图」的画廊视图，`trace_output(path)` 能从一张图反查
  是哪个任务、什么 payload 产出的（做重绘时拿素材段用）。

## 6. 已知坑与对应报错

| 报错 | 原因 | 怎么办 |
|---|---|---|
| `unknown input xxx` | payload 里有 adapter 不认识的 key | 先 `describe_work`，按槽位名交 |
| `missing input xxx` | 该槽位既没交、工作流里也没有现值 | 显式给值 |
| `no KSampler named ...` / `matched N nodes` | 节点被改名或增删了 | 工作流改坏了，回滚版本 |
| `pose xxx not in manifest` | 姿态没登记 | `list_poses` 里挑一个 |
| `workflow xxx has no pose_image slot` | 这个工作流不吃 ControlNet | 换 work 或用 cn 快速出图 |
| HTTP 404 `work xxx has no workflow` | work 名写错或没挂工作流 | `list_works` |

## 7. 资源现状

- 底模：`animagine-xl-4.0-zero`（灰底是它的先验，且 hires 也改不掉；要去背景就后期抠）。
- LoRA：gloss（画法，40 张跨题材）、struct_pool_v3（机设语言，39 张机娘）。两者不需要触发词。
- 姿态库：`data/pose/manifest.json` 约 480 条。`source=synthetic` 那批是自绘骨架（5 站姿 +
  6 持械，分组 `mecha`，前端叫「机娘站姿」）——**机娘立绘只该用这批**，外部 3D 写实 depth
  会把八头身和地面灰带带进画面，还会跟骨架打架裁脚。
- 十二种机设配方在仓库 `data/mech/designs.json`（形态词 × 配色），是纯文件不是接口；
  要用就照里面的 tag 组装 positive。

## 8. 不要做的事

- 不要直连 ComfyUI 8188 提交任务：绕过了 runner 的队列、超时、产物落盘和版本记录。
- 不要写 runner 的 SQLite：沙箱进程写 data/ 会 disk I/O error，且绕过版本模型。
- 不要拿 prompt 去拧质感：实测 prompt 对质感没有权限，能拧的只有数据、训练目标、
  生成阶段挂什么（denoise / LoRA 权重）。

## 9. 原来用脚本做的事，现在用工具

| 老脚本 | 现在 | 差别 |
|---|---|---|
| `run_work_workflow.mjs` | `run_work` | 不用自己把 UI 图转成 API 图，产物照常进库 |
| `mech_design.mjs` | `sweep` + `run_work` | 形态词走 payload，配方仍看 `data/mech/designs.json` |
| `cn_gloss_probe.mjs` / `hires_face_probe.mjs` | `quick_generate(kind="cn")` / `run_work("mecha")` | 参数变成槽位，不再写死在脚本里 |
| `verify_ax4z_lora.mjs` / `verify_mecha_clone.mjs` | `sweep` | 因子笛卡尔积，一次请求拿一组对照 |
| `probe_version_matrix.mjs` | `sweep` + `version` | 版本对比直接传 8 位 id |

度量类（`measure_replica.py`、`probe_concept.py`、`sharp_stats.py`、`eval_retrieval.py`）**还没有**对应的工具：
它们跑在本地 Python 环境里读图算余弦 / HSV / lapvar，MCP 目前只负责把图生成出来。要做定量判读，
先 `wait_tasks` 拿到产物路径，再回本地跑脚本。

## 10. 资源

除了工具，还能按 URI 直接读实时数据（适合一次性拉全量）：

- `runner://manual` —— 本手册
- `runner://works` —— works 全量（含 semantic 与挂载的工作流）
- `runner://workflows` —— 工作流全量（含版本）
- `runner://poses` —— enabled 姿态（前 200 条）
