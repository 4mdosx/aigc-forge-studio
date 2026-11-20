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
node scripts_and_tools/export_dataset.mjs --dataset test-boot --trigger ohwx --strip-characters
node scripts_and_tools/train_animagine.mjs --dataset test-boot --trigger ohwx
```

`export_dataset.mjs` 走 runner `/datasets` → assetIds → `/capture/assets/:id`，取 processed 图和 WD14 tags：
- `--dataset`：数据集名，支持精确 / 去尾 s / 包含模糊匹配。
- `--trigger`：触发词，写在 caption 首位；可省略。
- `--strip-characters`：可选，按 WD14 `selected_tags.csv` 的 category=4 剥掉角色名（风格 LoRA 需要；角色 LoRA 别加）。

默认跳过 questionable/explicit，落到 `data/training-export/<name>/img/<id>.png + <id>.txt`。`--dry-run` 可预览。

`train_animagine.mjs` 把上述目录推到训练机 `C:\AIGC\training\<name>\img`，再以 `checkpoints/animagine-xl-4.0-zero.safetensors` 为底模建训练 job。传了 `--trigger` 就设 `keepTokens: 1` 防止触发词被 shuffle。

**建 job 必须走 runner `/train/jobs`（127.0.0.1:8787，自动套 STABLE_PRESET），不要直连 trainer :8788**。trainer 原始默认档 = `cacheTextEncoderOutputs=false` + `shuffleCaption=true` + `maxTrainEpochs=10`，实测 14.4 s/it；runner 快档 = TE cache 开 / shuffle 关 / 3 epochs，实测 1.99 s/it（330 step，11 分钟），7 倍差。启动前会检查底模下载状态；没下完会警告。

底模下载用 trainer 的 `/downloads` 异步端点。训练机侧 Civitai 直链只有 ~170 KB/s，改走 ModelScope `https://www.modelscope.cn/models/cagliostrolab/animagine-xl-4.0-zero/resolve/master/animagine-xl-4.0-zero.safetensors`（6.94 GB，SHA256 `f15812e65c2ea7f4e19ce37fb2a8445eb65c64da450a508dd9c8f237c73f6bb8`）。

## LoRA 验证矩阵（Animagine Zero + test-boot）

```
node scripts_and_tools/verify_ax4z_lora.mjs --dry-run
node scripts_and_tools/verify_ax4z_lora.mjs [--only l600] [--seed 3001]
```

前置：ComfyUI :8188 在线；checkpoint 已在 `C:\AIGC\models\loras\`。走 runner `baseline` work → `baseline_ax4z_lora_v1@y4jl7y4f`（无 ControlNet），正负向取 `config/roll_config` 的 Animagine 官方词。4 列（裸模 / 110 / 220 / 330 step）× 2 场景（无装备词 / 明确 boots 词）× 2 seed = 16 张，落到 `experiments/runs/AX4Z-LORA-VERIFY-20261120/`。已有图跳过，可断点续跑。`base` 列用 ComfyUI 内建 `None` 空槽 + strength 0；无 `None` 时降级为首只 LoRA + strength 0。