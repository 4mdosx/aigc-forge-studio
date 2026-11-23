#!/usr/bin/env python3
"""repaint_probe.py — 两段式第二阶段（gloss repaint）denoise 扫描的量化。

要回答的问题只有一个：**换质感的 denoise 区间存在吗**。
「质感刷上去了」和「结构保住了」是两个方向相反的指标，必须同时看：

  结构保真  cos_src     = 出图与源图在 DINOv3-H(CLS) 空间里的余弦。低 = 已经不是原来那张画了。
  质感迁移  d_gloss     = cos(out, gloss 质心) - cos(out, struct 质心)。正 = 往韩系半厚涂那边挪了。
  细节密度  lap_var     = 灰度拉普拉斯方差（高度归一 1024）。gloss 池中位 538 / struct 池中位 919。
  配色      sat         = 非背景区平均饱和度。

消融：同一 denoise 下 gloss 变体与 ctrl 变体的 d_gloss 之差，才是「韩系质感词本身」的效应；
否则量到的是「denoise 高本来就重绘」这种无信息量的事实。

用法：
  .venv/bin/python scripts_and_tools/repaint_probe.py --run REPAINT-DN-20261123

产物：experiments/runs/<run>/probe.json / probe.csv / probe.md
"""

import argparse
import csv
import json
import math
import sqlite3
import statistics as st
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import laplace

REPO = Path(__file__).resolve().parent.parent
DB = REPO / 'data' / 'runner.sqlite'
CRITIC = 'http://127.0.0.1:8791'
NORM_H = 1024
LAP_KERNEL = np.array([[0, 1, 0], [1, -4, 1], [0, 1, 0]], dtype=np.float32)


# ── 图像统计 ────────────────────────────────────────────────────────────────
def tone(path: Path) -> dict:
    im = Image.open(path).convert('RGB')
    if im.height != NORM_H:
        w = round(im.width * NORM_H / im.height)
        im = im.resize((w, NORM_H), Image.LANCZOS)
    a = np.asarray(im, dtype=np.float32)
    gray = a @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    lap = laplace(gray)
    mx = a.max(axis=2)
    mn = a.min(axis=2)
    s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    # 定义对齐 style-anchor/profile.json：只统计 S>0.06 的像素
    return {
        'lap_var': float(lap.var()),
        'sat': float(s[s > 0.06].mean()) if (s > 0.06).any() else 0.0,
        'lum': float(gray.mean()),
    }


# ── 向量 ────────────────────────────────────────────────────────────────────
def embed(path: Path) -> np.ndarray:
    body = json.dumps({'path': str(path)}).encode()
    req = urllib.request.Request(
        f'{CRITIC}/embed', data=body, headers={'content-type': 'application/json'}, method='POST'
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.loads(r.read())
    if not d.get('ok'):
        raise RuntimeError(f'embed 失败 {path}: {d}')
    v = np.asarray(d['styleVec'], dtype=np.float64)
    return v / (np.linalg.norm(v) or 1.0)


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b))


def centroid(vecs):
    m = np.mean(np.stack(vecs), axis=0)
    return m / (np.linalg.norm(m) or 1.0)


# ── 数据来源 ────────────────────────────────────────────────────────────────
def dataset_paths(name: str) -> list[Path]:
    """按数据集名取 processed 图路径（顺序与界面一致）。"""
    ids = _dataset_asset_ids(name)
    db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    out = []
    for i in ids:
        r = db.execute('select processed_path p from image_assets where id=?', (i,)).fetchone()
        if r and r['p']:
            p = REPO / 'data' / r['p']
            if p.exists():
                out.append(p)
    db.close()
    return out


def _dataset_asset_ids(name: str) -> list[str]:
    with urllib.request.urlopen('http://127.0.0.1:8787/datasets', timeout=30) as r:
        d = json.loads(r.read())
    for x in d['datasets']:
        if x['name'] == name:
            return x['assetIds']
    raise SystemExit(f'找不到数据集 {name}')


def src_tag(path: Path) -> str:
    """必须与 distill_img2img.mjs 的 srcTagOf 完全一致。"""
    b = path.stem
    if b in ('processed', 'original', 'image'):
        d = path.parent.name
        if d and not d[:8].isdigit():
            return d[-6:]
    tail = b.replace('-', '_').split('_')[-1] or b
    return tail[-6:]


# ── 主流程 ──────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--run', required=True)
    ap.add_argument('--gloss-dataset', default='mecha_core_style')
    ap.add_argument('--struct-dataset', default='mecha_core_anchor')
    ap.add_argument('--cache', default='')
    args = ap.parse_args()

    run_dir = REPO / 'experiments' / 'runs' / args.run
    manifest = json.loads((run_dir / 'manifest.json').read_text())
    cache_path = Path(args.cache) if args.cache else run_dir / 'embeddings.json'
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}

    def vec(p: Path) -> np.ndarray:
        k = str(p)
        if k not in cache:
            cache[k] = embed(p).tolist()
            cache_path.write_text(json.dumps(cache))
        v = np.asarray(cache[k], dtype=np.float64)
        return v / (np.linalg.norm(v) or 1.0)

    print(f'[1/4] 参考簇：gloss={args.gloss_dataset} struct={args.struct_dataset}')
    gloss_vecs = [vec(p) for p in dataset_paths(args.gloss_dataset)]
    struct_vecs = [vec(p) for p in dataset_paths(args.struct_dataset)]
    print(f'      gloss {len(gloss_vecs)} 张 / struct {len(struct_vecs)} 张')
    g_c, s_c = centroid(gloss_vecs), centroid(struct_vecs)
    print(f'      两簇质心互相余弦 = {cosine(g_c, s_c):.3f}（越低说明两簇越可分）')

    srcs = {}
    for s in manifest['sources']:
        p = Path(s['path'])
        srcs[src_tag(p)] = p
    print(f'[2/4] 源图 {len(srcs)} 张')

    rows = []
    # 源图自身的 d_gloss 是「起点」。不同源在图库空间里本来位于不同位置
    # （实测 4 张源图 d_gloss 从 -0.33 到 +0.06），只看出图的绝对值会把起点差
    # 当成效果差。所以真正该报的是「相对起点的位移」dd_gloss。
    src_d = {}
    for tag, p in srcs.items():
        v = vec(p)
        src_d[tag] = cosine(v, g_c) - cosine(v, s_c)
        print(f"      源图 {tag} 起点 d_gloss={src_d[tag]:+.3f}")
    for r in manifest['results']:
        if r.get('error') or not r.get('file'):
            continue
        f = run_dir / 'distill' / r['file']
        if not f.exists():
            continue
        p = srcs[r['srcTag']]
        ov, sv = vec(f), vec(p)
        t = tone(f)
        src_t = r.get('_src_tone') or tone(p)
        d_g = cosine(ov, g_c) - cosine(ov, s_c)
        rows.append(
            {
                'srcTag': r['srcTag'],
                'variant': r['variant'],
                'denoise': r['denoise'],
                'seed': r['seed'],
                'file': r['file'],
                'cos_src': round(cosine(ov, sv), 4),
                'cos_gloss': round(cosine(ov, g_c), 4),
                'cos_struct': round(cosine(ov, s_c), 4),
                'd_gloss': round(d_g, 4),
                'd_gloss_src': round(src_d[r['srcTag']], 4),
                'dd_gloss': round(d_g - src_d[r['srcTag']], 4),
                'lap_var': round(t['lap_var'], 1),
                'sat': round(t['sat'], 4),
                'lap_ratio_vs_src': round(t['lap_var'] / (src_t['lap_var'] or 1), 3),
            }
        )
        print(f"      {r['file']}  cos_src={rows[-1]['cos_src']:.3f} dd_gloss={rows[-1]['dd_gloss']:+.3f} lap={rows[-1]['lap_var']:.0f}")

    rows.sort(key=lambda x: (x['srcTag'], x['variant'], x['denoise']))
    (run_dir / 'probe.json').write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    with open(run_dir / 'probe.csv', 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    # ── 汇总表 ─────────────────────────────────────────────────────────────
    dens = sorted({r['denoise'] for r in rows})
    variants = sorted({r['variant'] for r in rows})
    lines = []
    lines.append(f'# repaint denoise 扫描 — {args.run}\n')
    lines.append(f'源图 {len(srcs)} 张 × 变体 {len(variants)} × denoise {len(dens)} 档 = {len(rows)} 张\n')
    lines.append(f'参考簇：gloss=`{args.gloss_dataset}`（{len(gloss_vecs)} 张） struct=`{args.struct_dataset}`（{len(struct_vecs)} 张）；两簇质心余弦 {cosine(g_c, s_c):.3f}\n')
    lines.append('## 结构与质感的交换曲线（跨源均值）\n')
    lines.append('`dd_gloss` = 出图相对**自己那张源图**朝 gloss 簇走的位移，跨源可加。')
    lines.append('`cos_src` 掉到 0.90 以下说明已经不是原来那张画了。\n')
    lines.append('| denoise | 变体 | cos_src ↑ | dd_gloss ↑ | lap_var | lap/源 | sat |')
    lines.append('|---|---|---|---|---|---|---|')
    for v in variants:
        for d in dens:
            sel = [r for r in rows if r['variant'] == v and r['denoise'] == d]
            if not sel:
                continue
            m = lambda k: st.mean(x[k] for x in sel)
            lines.append(
                f"| {d:.2f} | {v} | {m('cos_src'):.3f} | {m('dd_gloss'):+.3f} | "
                f"{m('lap_var'):.0f} | {m('lap_ratio_vs_src'):.2f} | {m('sat'):.3f} |"
            )
    lines.append('\n## 消融：gloss − ctrl（同一 denoise 的差值，这才是质感词本身的效果）\n')
    if {'gloss', 'ctrl'} <= set(variants):
        lines.append('| denoise | Δcos_src | Δdd_gloss | Δlap/源 | gloss 胜出的源数 |')
        lines.append('|---|---|---|---|---|')
        tags = sorted(srcs)
        for d in dens:
            g = [r for r in rows if r['variant'] == 'gloss' and r['denoise'] == d]
            c = [r for r in rows if r['variant'] == 'ctrl' and r['denoise'] == d]
            if not g or not c:
                continue
            gm = lambda k: st.mean(x[k] for x in g)
            cm = lambda k: st.mean(x[k] for x in c)
            by = {(r['srcTag'], r['variant']): r for r in g + c}
            win = sum(
                1
                for t in tags
                if (t, 'gloss') in by and (t, 'ctrl') in by and by[(t, 'gloss')]['dd_gloss'] > by[(t, 'ctrl')]['dd_gloss']
            )
            lines.append(
                f"| {d:.2f} | {gm('cos_src') - cm('cos_src'):+.3f} | "
                f"{gm('dd_gloss') - cm('dd_gloss'):+.3f} | {gm('lap_ratio_vs_src') - cm('lap_ratio_vs_src'):+.2f} | {win}/{len(tags)} |"
            )
    lines.append('\n## 逐源：起点与位移（绝对值会骗人，位移才是效果）\n')
    lines.append('| 源图 | 起点 d_gloss | ' + ' | '.join(f'{v}@{d:.2f}' for v in variants for d in dens) + ' |')
    lines.append('|---|---|' + '---|' * (len(variants) * len(dens)))
    for t in sorted(srcs):
        cells = []
        for v in variants:
            for d in dens:
                hit = next((r for r in rows if r['srcTag'] == t and r['variant'] == v and r['denoise'] == d), None)
                cells.append(f"{hit['dd_gloss']:+.3f}" if hit else '-')
        lines.append(f'| `{t}` | {src_d[t]:+.3f} | ' + ' | '.join(cells) + ' |')
    (run_dir / 'probe.md').write_text('\n'.join(lines) + '\n')
    print('\n'.join(lines))
    grid = make_grid(run_dir, rows, srcs, dens, variants)
    print(f'\n-> {run_dir}/probe.md  probe.csv  probe.json  {grid.name}')
    return 0


def make_grid(run_dir: Path, rows: list[dict], srcs: dict, dens: list[float], variants: list[str]) -> Path:
    """行 = 源图×变体，列 = denoise。每格标 cos_src / d_gloss，人眼不必再对表。"""
    from PIL import ImageDraw

    order = [v for v in ('gloss', 'ctrl') if v in variants] + [v for v in variants if v not in ('gloss', 'ctrl')]
    rowkeys = [(t, v) for t in srcs for v in order]
    TW, GUT, HDR, FD = 320, 210, 34, 18
    W = GUT + TW * len(dens)
    H = HDR + (TW + FD) * len(rowkeys)
    sheet = Image.new('RGB', (W, H), 'white')
    d = ImageDraw.Draw(sheet)
    for i, dn in enumerate(dens):
        d.text((GUT + TW * i + 8, 10), f'denoise {dn:.2f}', fill='black')
    for r, (tag, var) in enumerate(rowkeys):
        y0 = HDR + r * (TW + FD)
        d.text((8, y0 + TW // 2 - 26), tag, fill='black')
        d.text((8, y0 + TW // 2 - 8), var, fill=('darkorange' if var == 'gloss' else 'steelblue'))
        for c, dn in enumerate(dens):
            hit = next((x for x in rows if x['srcTag'] == tag and x['variant'] == var and x['denoise'] == dn), None)
            x0 = GUT + c * TW
            if not hit:
                continue
            p = run_dir / 'distill' / hit['file']
            if not p.exists():
                continue
            im = Image.open(p).convert('RGB')
            im.thumbnail((TW, TW))
            sheet.paste(im, (x0 + (TW - im.width) // 2, y0 + (TW - im.height) // 2))
            d.text(
                (x0 + 4, y0 + TW + 2),
                f"cos {hit['cos_src']:.2f}  dG {hit['d_gloss']:+.3f}  lap {hit['lap_var']:.0f}",
                fill='black',
            )
    out = run_dir / 'grid.png'
    sheet.save(out)
    return out


if __name__ == '__main__':
    raise SystemExit(main())
