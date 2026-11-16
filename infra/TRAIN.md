# 训练链路部署与接入（Windows 训练机 + sd-scripts + trainer /train）

> 落成于 2026-11-16。选型结论：kohya-ss/sd-scripts CLI（headless、TOML 配置、anime/Il 系风格
> LoRA 事实标准）。OneTrainer/kohya_ss GUI 不选——自动化最终都走 CLI，GUI 层是负担。

## 架构

```
Mac (runner/web/脚本)                       Windows 训练机 (C:\AIGC)
─────────────────────                       ─────────────────────────
POST /train/jobs ───────────────────────►   trainer (Node :8788)
GET  /train/jobs/:id  /log                    │ 写 config/{dataset,train}.toml
POST /upload (数据集+caption)                  │ spawn venv python -m accelerate.commands.launch
                                              ▼
产物回流：GET /files 或 SMB 拷            sd-scripts v0.12.3 (C:\AIGC\runtime\sd-scripts)
                                            training/<name>/output/*.safetensors
```

- 目录布局：`C:\AIGC\training\<name>\{img, config, output}`；底模在 `C:\AIGC\models\checkpoints`。
- 单实例单 running；重启恢复把 running 标 failed；日志在 trainer 包根 `data/train/<jobId>.log`。

## 部署步骤（Windows 机 PowerShell）

1. 同步仓库代码到 C:\AIGC（含 `infra/train_bootstrap.ps1`、trainer 新代码；trainer 配置在仓库根 `config.json` 的 `trainer` 段，随仓库一起过来）。
2. `powershell -File infra\train_bootstrap.ps1`——装 sd-scripts v0.12.3 + 独立 venv + torch cu124（首次 ~2.5GB 下载），幂等可重跑。
3. 重启 trainer 服务（host 已改 0.0.0.0，:8788）。
4. 验证：`curl http://127.0.0.1:8788/health` 与 `curl http://127.0.0.1:8788/roots`。

## Mac 侧接入

```bash
# 推数据集（capture 打标产物 → 训练机）
node experiments/push_dataset.mjs --folder common --dataset style-v1

# 建训练 job（默认参数即风格 LoRA 档：1024/dim128α32/AdamW8bit/unet 4e-4+te 5e-5/10 epochs/clip skip 2）
curl -X POST http://192.168.8.136:8788/train/jobs -H 'content-type: application/json' -d '{
  "name": "style-v1",
  "datasetRoot": "training",
  "datasetPath": "style-v1/img",
  "baseModel": "checkpoints/<PD底模>.safetensors"
}'
# 轮询：GET /train/jobs/<id>；日志：GET /train/jobs/<id>/log；取消：DELETE /train/jobs/<id>
```

## 端点速查（trainer /train）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /train/jobs | 白名单字段建 job；底模/数据集先验校验；单 running 否则 409 |
| GET | /train/jobs?status= | 列表 |
| GET | /train/jobs/:id | 详情（status/exitCode/outputDir/params） |
| GET | /train/jobs/:id/log | 全量日志 text |
| DELETE | /train/jobs/:id | 取消（taskkill /T /F 整树杀） |

## 训练纪律（3080 10GB）

- **训练时别让 ComfyUI 抢显存**：SDXL LoRA 1024/fp16/AdamW8bit/latent cache ≈ 7-8GB；ComfyUI 有模型驻留就会 OOM。跑训练前 `infra\stop.ps1`（或把常用模型卸了）。
- batch size 1；再大先看显存。加显存余量可开 `--cache_text_encoder_outputs`（代价：TE 不训练）。
- 看板不看 loss：中段 checkpoint（约 40-60% 步数）经常是最佳；save_every_n_epochs=1 留全档。
- caption 已按研究文档纪律：只写内容不写风格、WD14 打底人工剥风格词、全数据集通用 tag 必删（capture 打标台的标签编辑器做这事）。

## 已知边界

- spawn 计划假设 Windows venv 布局 `venv\Scripts\python.exe`；测试用 `spawnOverride` 注入替代命令。
- datasetPath 尊重显式传入；config/output 恒按 `<name>` 布局。
- 采样出图（sample_prompts）走 sd-scripts 内置采样，会占用显存——默认关。
