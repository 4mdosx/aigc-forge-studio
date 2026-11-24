#!/usr/bin/env python3
"""把 pose 库的姿态重排成「留白版」构图。

问题背景：现有 depth 图人物占满 100% 画布高度、底边贴地，部分还带一条横贯
画面的地面灰带；而同一姿态的骨架图底部有 8~10% 留白。两张控制图对构图的
说法不一致，生成时模型倾向于把脚顶出画面。

做法：以 depth 剪影的外接框为基准算一个仿射变换，把「剪影 + 骨架」按同样
变换重排到更大留白的画布上 —— 人物占画布高度的 height-ratio，底部留
bottom-margin。depth 与 bone 共用同一变换，对齐关系原样保留。

用法：
  .venv/bin/python scripts_and_tools/depth_letterbox.py \
      --src data/pose/standing --out data/pose/fullbody \
      --canvas 768x1152 --height-ratio 0.80 --bottom-margin 0.06
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage


def strip_ground(a: np.ndarray, thresh: int = 20, fill_ratio: float = 0.90) -> np.ndarray:
    """切掉底部的「地面带」：从底往上，连续整行几乎全亮的行视为地面。

    只切边界上的连续段落，人物腿部中间透出的空隙不会被误伤。
    """
    h = a.shape[0]
    mask = a > thresh
    row_fill = mask.mean(axis=1)
    cut = h
    for y in range(h - 1, -1, -1):
        if row_fill[y] >= fill_ratio:
            cut = y
        else:
            break
    if cut < h:
        a = a.copy()
        a[cut:] = 0
    return a


def silhouette_bbox(a: np.ndarray, thresh: int = 20) -> tuple[int, int, int, int] | None:
    """取最大连通体的外接框 (l, t, r, b)，右下开区间。"""
    mask = a > thresh
    if mask.sum() < 200:
        return None
    lab, n = ndimage.label(mask)
    if n == 0:
        return None
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    big = int(np.argmax(sizes)) + 1
    ys, xs = np.where(lab == big)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def reframe(img: Image.Image, bbox, canvas, target_h, bottom_margin):
    """按 bbox 把整张图缩放平移到新画布：bbox 顶对齐 target_h 高，底部落在 margin 处。"""
    l, t, r, b = bbox
    bh = b - t
    if bh <= 0:
        return None
    s = target_h / bh
    W, H = canvas
    # 缩放后 bbox 中心 x 落到画布中心，bbox 底边落到 H*(1-margin)
    cx_src = (l + r) / 2.0
    bottom_dst = H * (1.0 - bottom_margin)
    # 新画布上原图坐标 (x, y) 映射为 (x - cx_src)*s + W/2, (y - b)*s + bottom_dst
    new_w = max(1, round(img.width * s))
    new_h = max(1, round(img.height * s))
    scaled = img.resize((new_w, new_h), Image.LANCZOS)
    ox = round(W / 2 - cx_src * s)
    oy = round(bottom_dst - b * s)
    out = Image.new('L', (W, H), 0)
    out.paste(scaled, (ox, oy))
    return out, dict(scale=round(s, 5), offset=[ox, oy], bbox=[l, t, r, b])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default='data/pose/standing')
    ap.add_argument('--out', default='data/pose/fullbody')
    ap.add_argument('--canvas', default='768x1152')
    ap.add_argument('--height-ratio', type=float, default=0.80,
                    help='人物占画布高度比例。留白靠它，不是靠 prompt')
    ap.add_argument('--bottom-margin', type=float, default=0.06,
                    help='脚底距画布底边比例')
    ap.add_argument('--limit', type=int, default=0)
    args = ap.parse_args()

    W, H = (int(x) for x in args.canvas.lower().split('x'))
    target_h = H * args.height_ratio
    src, out = Path(args.src), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    made, skipped = [], []
    dirs = sorted(d for d in src.iterdir() if d.is_dir())
    if args.limit:
        dirs = dirs[: args.limit]

    for d in dirs:
        dp, bp = d / 'depth.png', d / 'bone.png'
        if not (dp.exists() and bp.exists()):
            skipped.append((d.name, 'missing'))
            continue
        depth = np.asarray(Image.open(dp).convert('L'))
        bone = np.asarray(Image.open(bp).convert('L'))
        d_clean = strip_ground(depth)
        bbox = silhouette_bbox(d_clean)
        if bbox is None:
            skipped.append((d.name, 'no-silhouette'))
            continue
        # 骨架在自己的黑底上也可能有杂点，同样清一遍
        b_clean = bone
        res_d = reframe(Image.fromarray(d_clean), bbox, (W, H), target_h, args.bottom_margin)
        if res_d is None:
            skipped.append((d.name, 'degenerate'))
            continue
        img_d, meta_d = res_d
        img_b, _ = reframe(Image.fromarray(b_clean), bbox, (W, H), target_h, args.bottom_margin)

        od = out / d.name
        od.mkdir(parents=True, exist_ok=True)
        img_d.save(od / 'depth.png')
        img_b.save(od / 'bone.png')

        # 记录重排后的实际占位，方便回查留白是否生效
        a = np.asarray(img_d)
        ys, xs = np.where(a > 20)
        meta = dict(
            source=d.name,
            canvas=[W, H],
            heightRatio=args.height_ratio,
            bottomMargin=args.bottom_margin,
            placed=dict(
                top=round(float(ys.min()) / H, 4),
                bottom=round(1 - float(ys.max() + 1) / H, 4),
                height=round(float(ys.max() - ys.min() + 1) / H, 4),
                width=round(float(xs.max() - xs.min() + 1) / W, 4),
            ),
            **meta_d,
        )
        (od / 'meta.json').write_text(json.dumps(meta, ensure_ascii=False, indent=1))
        made.append(meta)

    print(f'生成 {len(made)} 组 -> {out}')
    print(f'跳过 {len(skipped)} 组' + (f'：{skipped[:5]}' if skipped else ''))
    if made:
        tops = [m['placed']['top'] for m in made]
        bots = [m['placed']['bottom'] for m in made]
        hs = [m['placed']['height'] for m in made]
        print(f'人物顶部留白 {min(tops):.3f}~{max(tops):.3f}  '
              f'底部留白 {min(bots):.3f}~{max(bots):.3f}  '
              f'占高 {min(hs):.3f}~{max(hs):.3f}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
