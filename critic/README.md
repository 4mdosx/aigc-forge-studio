# critic

本地 HTTP 服务：WD14 打标 + 风格向量。与工具共用 `tools/.venv`，无独立环境。

## 启动

```bash
cd aigc-forge-studio
tools/.venv/bin/python critic/server.py --port 8791
```

## 接口

- `GET /health` — 服务与模型加载状态
- `POST /tag` — 图片打 WD14 tag
  - `path`（必填）本地图片路径；相对路径按仓库根解析
  - `model`、`general_threshold`、`character_threshold`、`exclude`、`with_scores` 可选
- `POST /embed` — 图片转 7 维风格向量
  - `path`（必填）；`ref` 可选参考图（返回 L2 / cosine / verdict）；`device` 可选
- `POST /close` — 两图风格接近判定
  - `a`、`b`（必填）图片路径；`device` 可选

## 调用示例

```bash
curl -s http://127.0.0.1:8791/tag \
  -H 'Content-Type: application/json' \
  -d '{"path":"data/character/takao/ref/AL_kv_full__高雄立绘.jpg"}'

curl -s http://127.0.0.1:8791/embed \
  -H 'Content-Type: application/json' \
  -d '{"path":"data/character/takao/ref/AL_kv_full__高雄立绘.jpg"}'
```

## 依赖

模型权重沿用 `data/models/wd14/` 与 `data/models/style-embedder/`；风格向量权重缺失时见
上层 tools 仓库的 `../tools/fetch_style_model.sh`。WD14 模型沿用 runner 的缓存，未内置下载。
仅处理 SFW 素材。
