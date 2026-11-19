# 一次性修复脚本和调试工具

## image_assets 导出 / 导入

只处理已通过的条目（`image_assets.status = approved`）和 `data/capture/assets/<hash>/` 里的图片。

```
node scripts_and_tools/export_image_assets.mjs [--out data/exports/image-assets.tar.gz] [--dry-run]
node scripts_and_tools/import_image_assets.mjs <image-assets.tar.gz> [--dry-run]
```

导入只补当前没有的数据库行和图片。已有 id、已被其他条目占用的 hash、已经存在的文件都保持不动。