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

`train_animagine.mjs` 把上述目录推到训练机 `C:\AIGC\training\<name>\img`，再以 `checkpoints/animagine-xl-4.0-zero.safetensors` 为底模建训练 job。传了 `--trigger` 就设 `keepTokens: 1` 防止触发词被 shuffle。其余超参（SDXL / bf16 / unet-only / dim128 alpha32 / 10 epochs）走 trainer 默认档。启动前会检查底模下载状态；没下完会警告。

底模下载用 trainer 的 `/downloads` 异步端点（模型源 Civitai model 1409042，Zero fp16，6.46 GB，SHA256 `f15812e65c2ea7f4e19ce37fb2a8445eb65c64da450a508dd9c8f237c73f6bb8`）。