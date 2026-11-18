# critic

本地 HTTP 服务：WD14 打标 + 风格向量。`preprocess`、`tag`、`embed` 是本目录的模块，HTTP 和 `tools/critic.py` 都直接调用，共用仓库根目录 `.venv`。

## 安装

需要 Python 3.12。在仓库根目录执行：

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -U pip
.venv/bin/python -m pip install -r critic/requirements.txt
```

`.venv` 已在 `.gitignore` 里，不会进版本库。

## 启动

在仓库根目录执行。地址读 `config.json` 的 `critic.host` 和 `critic.port`，默认 `127.0.0.1:8791`。

```bash
.venv/bin/python critic/server.py --host 127.0.0.1 --port 8791
```

也可以 `node cli.js`，先选 dev 或 deploy，再勾选 critic，回车确认后启动。

不走 HTTP、直接拿本地路径时：

```bash
.venv/bin/python tools/critic.py tag data/character/takao/ref/AL_kv_full__高雄立绘.jpg
.venv/bin/python tools/critic.py embed data/character/takao/ref/AL_kv_full__高雄立绘.jpg --json
```

`tag` 返回 tags 和 rating，`embed` 返回 7 维 `styleVec`。`--ref` 再附上 L2 和 cosine。`--json` 打印模块返回的数据。

## 接口

- `GET /health` — 服务与模型加载状态
- `POST /tag` — 图片打 WD14 tag
  - `path`（必填）本地图片路径；相对路径按仓库根解析
  - `model`、`general_threshold`、`character_threshold`、`exclude`、`with_scores` 可选
- `POST /embed` — 图片转 7 维风格向量
  - `path`（必填）；`ref` 可选参考图（返回 L2 / cosine）；`device` 可选
- `POST /close` — 两图风格距离（L2 / cosine）
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
