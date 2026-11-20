# 一次性修复脚本和调试工具

## critic 打标 / 风格向量

不经 HTTP，直接调用仓库里的 critic 模块。需要仓库根目录 `.venv`。

```
.venv/bin/python scripts_and_tools/critic.py tag <图片路径> [--json]
.venv/bin/python scripts_and_tools/critic.py embed <图片路径> [--ref <参考图>] [--json]
```

## image_assets 导出 / 导入

只处理已通过的条目（`image_assets.status = approved`）和 `data/capture/assets/<hash>/` 里的图片。

```
node scripts_and_tools/export_image_assets.mjs [--out data/exports/image-assets.tar.gz] [--dry-run]
node scripts_and_tools/import_image_assets.mjs <image-assets.tar.gz> [--dry-run]
```

导入只补当前没有的数据库行和图片。已有 id、已被其他条目占用的 hash、已经存在的文件都保持不动。

## 数据集 → 训练集 → 训练（Animagine XL 4.0 Zero）

```
node scripts_and_tools/export_dataset.mjs --dataset style-fullbody --trigger zzstyle --strip-characters
node scripts_and_tools/train_animagine.mjs --list-profiles
node scripts_and_tools/train_animagine.mjs --dataset style-fullbody --profile seed --trigger zzstyle --dry-run
node scripts_and_tools/train_animagine.mjs --dataset style-fullbody --profile seed --trigger zzstyle
```

`export_dataset.mjs` 走 runner `/datasets` → assetIds → `/capture/assets/:id`，取 processed 图和 WD14 tags：
- `--dataset`：数据集名，支持精确 / 去尾 s / 包含模糊匹配。
- `--trigger`：触发词，写在 caption 首位；可省略。
- `--strip-characters`：可选，按 WD14 `selected_tags.csv` 的 category=4 剥掉角色名（风格 LoRA 需要；角色 LoRA 别加）。

默认跳过 questionable/explicit，落到 `data/training-export/<name>/img/<id>.png + <id>.txt`。`--dry-run` 可预览。

`train_animagine.mjs` 把上述目录推到训练机 `C:\AIGC\training\<name>\img`，再以 `checkpoints/animagine-xl-4.0-zero.safetensors` 为底模建训练 job。**最后一条命令默认跑完整流程**：建 job → 轮询到 completed → 从 `training/<job>/output/` 拉各 epoch checkpoint 到 `data/lora/<job>/`（含 `manifest.json`）→ 推 `models/loras/` → 核对 ComfyUI 可见 → 调 `verify_ax4z_lora.mjs` 出 16 张验证矩阵 + 每场景一张 `grid.png`。不用再手工回流。用 `--profile` 选训练参数组，配置在 `scripts_and_tools/train_profiles.json`：

| profile | 图数 | repeats × epochs | 曝光/图 | 用途 |
|---|---|---|---|---|
| `seed` | 50（40–60） | 10 × 2 | 20 | v1 种子池 |
| `refine-r1` | 65 | 8 × 2 | 16 | 回流第一轮 |
| `refine-r2` | 75 | 6 × 2 | 12 | 回流第二轮 |
| `scene` | 50 | 10 × 2 | 20 | 场景专属 LoRA |
| `smoke` | 任意 | 2 × 1 | 2 | 链路冒烟，不交付 |

profile 只写与 runner STABLE_PRESET 的差异项，其余继承。`--set key=value` 覆盖任意训练字段（可重复，如 `--set unetLr=0.0002`）；传 `--trigger` 强制 `keepTokens=1`，且验证矩阵正向词首位会锁同一个触发词。`--dry-run` 打印最终参数与 step 估算就退出，不上传、不建 job；图数偏离 profile 预期会警告。参数白名单对应 `trainer/src/train/toml.ts` 字段，拼错立刻报错。`cacheTextEncoderOutputs` 与 `shuffleCaption` 互斥——要开 shuffle 得同时 `--set cacheTextEncoderOutputs=false`。

收尾阶段可选项：`--train-only` 只建 job（旧行为，打印 `--attach` 提示）；`--no-verify` 回流但不跑矩阵；`--attach <jobId>` 接管已在跑/已完成的 job 只做后半段（不重训，例：`node scripts_and_tools/train_animagine.mjs --attach ff237eb0-... --dataset mech_man --trigger zxmechman`）；`--poll-seconds 20` / `--timeout-hours 6` 调轮询节奏。产物目录 `experiments/runs/<job名>-VERIFY-YYYYMMDD/`，历史 job 已存在的图会跳过，可断点续跑。

实验计划见 `/Users/token/workspace/AIGC/research/style-lora-multiscene-experiment.md`。曝光次数（`repeats × epochs`）才是过拟合旋钮，安全区 15–20；别靠堆 step 拉强度。

**建 job 必须走 runner `/train/jobs`（127.0.0.1:8787，自动套 STABLE_PRESET），不要直连 trainer :8788**。trainer 原始默认档 = `cacheTextEncoderOutputs=false` + `shuffleCaption=true` + `maxTrainEpochs=10`，实测 14.4 s/it；runner 快档 = TE cache 开 / shuffle 关 / 3 epochs，实测 1.99 s/it（330 step，11 分钟），7 倍差。启动前会检查底模下载状态；没下完会警告。

底模下载用 trainer 的 `/downloads` 异步端点。训练机侧 Civitai 直链只有 ~170 KB/s，改走 ModelScope `https://www.modelscope.cn/models/cagliostrolab/animagine-xl-4.0-zero/resolve/master/animagine-xl-4.0-zero.safetensors`（6.94 GB，SHA256 `f15812e65c2ea7f4e19ce37fb2a8445eb65c64da450a508dd9c8f237c73f6bb8`）。

## LoRA 验证矩阵（Animagine Zero + test-boot）

```
node scripts_and_tools/verify_ax4z_lora.mjs --dry-run
node scripts_and_tools/verify_ax4z_lora.mjs [--only l600] [--seed 3001]
```

前置：ComfyUI :8188 在线；checkpoint 已在 `C:\AIGC\models\loras\`。走 runner `baseline` work → `baseline_ax4z_lora_v1@<roll_config.version>`（无 ControlNet），正负向取 `config/roll_config` 的 Animagine 官方词。4 列（裸模 / 110 / 220 / 330 step）× 2 场景（无装备词 / 明确 boots 词）× 2 seed = 16 张，落到 `experiments/runs/AX4Z-LORA-VERIFY-20261120/`。已有图跳过，可断点续跑。ComfyUI 的 LoraLoader 没有 `None` 空槽，`base` 列用首只 LoRA + strength 0 等效裸模。

泛化调用（通常由 `train_animagine.mjs` 自动触发，也可单独重跑）：

```
node scripts_and_tools/verify_ax4z_lora.mjs --job <job名> \
  --loras <f1,f2,final> --labels <epoch 1,epoch 2,final> \
  --steps-per-epoch 550 --trigger zxmechman \
  --out <experiments/runs/<目录>>
```

`--job` / `--loras` 决定列数（裸模 + 每只 LoRA），`--trigger` 锁正向词首位，`--no-grid` 只出原图不拼图。拼图调用 `tools/compare_grid.py`，每场景一张 `grid.png`：行 = seed，列 = 各 checkpoint。