# critic

本地 HTTP 服务：WD14 打标 + 风格向量 + 图片向量缓存。`preprocess`、`tag`、`embed`、`image_vector` 是本目录的模块，由 HTTP 直接调用；`scripts_and_tools/critic.py` 调用打标和风格向量。共用仓库根目录 `.venv`。

## 安装

需要 Python 3.12。在仓库根目录执行：

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -U pip
.venv/bin/python -m pip install -r critic/requirements.txt
.venv/bin/python critic/install.py
```

`install.py` 把打标和风格向量的权重下载到 `data/models/`。已经在的文件会跳过。国内可加 `HF_ENDPOINT=https://hf-mirror.com`，需要代理时设 `HTTPS_PROXY` 或 `CRITIC_PROXY`。

`.venv` 已在 `.gitignore` 里，不会进版本库。模型在 `data/` 下，同样不进版本库。

## 启动

在仓库根目录执行。地址读 `config.json` 的 `critic.host` 和 `critic.port`，默认 `127.0.0.1:8791`。

```bash
.venv/bin/python critic/server.py --host 127.0.0.1 --port 8791
```

也可以在仓库根目录 `npm install` 后执行 `node cli.js`，先选 dev 或 deploy，再勾选 critic，回车启动。

启动时会检查「依赖」一节列出的模型文件。缺文件就退出，不监听端口。

不走 HTTP、直接拿本地路径时：

```bash
.venv/bin/python scripts_and_tools/critic.py tag data/character/takao/ref/AL_kv_full__高雄立绘.jpg
.venv/bin/python scripts_and_tools/critic.py embed data/character/takao/ref/AL_kv_full__高雄立绘.jpg --json
```

`tag` 返回 tags，以及 Danbooru 四档 rating（`general` / `sensitive` / `questionable` / `explicit`）。档位取标签敏感度下限和模型 rating 里更高的一档。`embed` 默认返回 1280 维 CLS `styleVec`（`--mode head` 走 7 维风格头）。`--ref` 再附上 L2 和 cosine。`--json` 打印模块返回的数据。

## 接口

- `GET /health` — 服务与模型加载状态
- `POST /tag` — 图片打 WD14 tag
  - `path`（必填）本地图片路径；相对路径按仓库根解析
  - `model`、`general_threshold`、`character_threshold`、`exclude`、`with_scores` 可选
- `POST /embed` — 图片转风格向量
  - `path`（必填）；`ref` 可选参考图（返回 L2 / cosine）；`device` 可选
  - `mode` 可选。`cls`（默认）DINOv3-H 的 CLS，1280 维，方形缩放到 224 进模型；
    `head` 是作者训练的 7 维风格头。7 维头的检索效果差一个量级，只为对照保留
  - 返回 `styleVec`、`dim`、`mode`
- `POST /close` — 两图风格距离（L2 / cosine）
  - `a`、`b`（必填）图片路径；`device` 可选
- `POST /image-vector` — 把一批向量并进缓存（upsert）
  - `vectors`（必填）`{图片 id: 数值向量}`。同一批里维度必须一致，不能是零向量
  - `modelVersion` 可选；和缓存里的记录不一致时返回 400，不会混用新旧向量
  - 已有的 id 覆盖、新的 id 追加，缓存不会因为一次请求被清空
- `POST /image-vector/state` — 缓存现状：`count` / `dim` / `modelVersion` / `generation`
  - `generation` 每次进程启动或 reset 都会变；调用方靠它判断要不要重灌
- `POST /image-vector/reset` — 清空缓存并换一代 `generation`
- `POST /image-vector/nearest` — 某张图片在缓存里的最近邻或最远邻，默认最近 10 条
  - `id`（必填）缓存中的图片 id；`k` 可选，默认 10；`order` 可选，`near` 或 `far`，默认 `near`
  - `ids` 可选候选集，只在给出的 id 里找。候选集在查询这一侧过滤，所以并发请求互不影响
  - `near` 按 cosine 从近到远，`far` 从远到近。不含自己。每条含 `l2` 和 `cosine`
- `POST /image-vector/groups` — 把指定的 n 张图片分成 m 组
  - `ids`（必填）；`groups`（必填）组数，范围是 1 到 `ids` 的长度
  - `vectors` 可选，直接传向量；不给就从缓存里取
  - `balance` 可选。`cluster`（默认）跑 ward 层次聚类，组大小均衡且语义正确；
    `even` 沿叶子顺序等分，组大小整齐但边界会切进密集区
  - 每组返回 `{ids, centerId}`，`centerId` 是组内到其它成员平均相似度最高的那张

分组用 ward 而不是 average-linkage：高维 cos 有集中效应，average 在 1280 维下会
退化成一个巨型簇 + 一堆离群点（实测 1824 张里 1816 张挤在一组）。

图片向量这一路用 numpy + scipy + scikit-learn，不需要额外的模型文件。`requirements.txt` 里已经带上。

## 调用示例

```bash
curl -s http://127.0.0.1:8791/tag \
  -H 'Content-Type: application/json' \
  -d '{"path":"data/character/takao/ref/AL_kv_full__高雄立绘.jpg"}'

curl -s http://127.0.0.1:8791/embed \
  -H 'Content-Type: application/json' \
  -d '{"path":"data/character/takao/ref/AL_kv_full__高雄立绘.jpg"}'

curl -s http://127.0.0.1:8791/image-vector \
  -H 'Content-Type: application/json' \
  -d '{"vectors":{"a":[1,0,0],"b":[0.9,0.1,0],"c":[0,1,0]}}'

curl -s http://127.0.0.1:8791/image-vector/nearest \
  -H 'Content-Type: application/json' \
  -d '{"id":"a"}'

curl -s http://127.0.0.1:8791/image-vector/groups \
  -H 'Content-Type: application/json' \
  -d '{"ids":["a","b","c"],"groups":2}'
```

## 依赖

启动时检查这些文件，缺任何一个都会退出：

- `data/models/wd14/wd-eva02-large-tagger-v3/model.onnx`
- `data/models/wd14/wd-eva02-large-tagger-v3/selected_tags.csv`
- `data/models/style-embedder/dinov3-vith16plus/config.json`
- `data/models/style-embedder/dinov3-vith16plus/preprocessor_config.json`
- `data/models/style-embedder/dinov3-vith16plus/model.safetensors`
- `data/models/style-embedder/dinov3-vith16plus/LICENSE.md`
- `data/models/style-embedder/Style_Embedder_v4.safetensors`

WD14 来自 `SmilingWolf/wd-eva02-large-tagger-v3`。风格向量的骨干是未设访问门槛的 DINOv3 镜像 `bschooled/dinov3-vith16plus-pretrain-lvd1689m`，头是 `Fgdfgfthgr/Anime_Images_Style_Embedder` 的 `Style Embedder v4.safetensors`。
