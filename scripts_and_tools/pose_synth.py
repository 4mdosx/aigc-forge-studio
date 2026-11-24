#!/usr/bin/env python3
"""自绘 openpose 骨架：解决「pose 库里没有正面全身站姿」。

为什么不用现成的 pose 库：`data/pose/standing` 165 个姿态里，剪影高宽比 >=1.85
的只有 15 个（其余 150 个是胸像/半身），这 15 个的左右镜像对称度最高到 0.706，
没有一个正面直立。而且它的 depth 是 3D 写实人体渲染，不是二次元深度图——拿它
当 ControlNet 输入会把画风往写实方向拽。

所以骨架自己画。好处有两个：构图留白完全可控（脚不会被顶出画面），且不引入
任何写实人体先验。

坐标用「身高归一化」：y 0=头顶 1=脚底，x 0.5=中线、单位为身高。渲染时按
height-ratio 映射到画布，上下留白由 top/bottom margin 决定，与 prompt 无关。

用法：
  .venv/bin/python scripts_and_tools/pose_synth.py --out data/pose/synthetic
  .venv/bin/python scripts_and_tools/pose_synth.py --canvas 832x1216 --height-ratio 0.80 --sheet
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw

# COCO-18（openpose 默认顺序）
KEYS = ['nose', 'neck', 'rsho', 'relb', 'rwri', 'lsho', 'lelb', 'lwri',
        'rhip', 'rknee', 'rank', 'lhip', 'lknee', 'lank', 'reye', 'leye', 'rear', 'lear']

# 1-based 配对，openpose 官方 limbSeq（1=nose … 18=lear）。
# 注意：这里是 **1-based**，取值时要 -1。此前写成 0-based 的值却照样 -1，
# 整条拓扑错位一格 —— 画出来是「鼻子→肩、脖子→肘」，ControlNet 见到的是畸形骨架，
# 姿态自然被 prompt 压过去。修正是 2026-11-24 出图全变正面直立时查到的。
LIMBS = [(2, 3), (2, 6), (3, 4), (4, 5), (6, 7), (7, 8), (2, 9), (9, 10), (10, 11),
         (2, 12), (12, 13), (13, 14), (2, 1), (1, 15), (15, 17), (1, 16), (16, 18)]

# openpose 官方 18 色
COLORS = [(255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0), (170, 255, 0), (85, 255, 0),
          (0, 255, 0), (0, 255, 85), (0, 255, 170), (0, 255, 255), (0, 170, 255), (0, 85, 255),
          (0, 0, 255), (85, 0, 255), (170, 0, 255), (255, 0, 255), (255, 0, 170), (255, 0, 85)]


def _base() -> dict[str, tuple[float, float]]:
    """正面直立、双臂自然下垂微张。x<0.5 是角色右侧（画面左）。"""
    return {
        'nose': (0.500, 0.075),
        'reye': (0.484, 0.062), 'leye': (0.516, 0.062),
        'rear': (0.464, 0.078), 'lear': (0.536, 0.078),
        'neck': (0.500, 0.140),
        'rsho': (0.415, 0.160), 'lsho': (0.585, 0.160),
        'relb': (0.392, 0.330), 'lelb': (0.608, 0.330),
        'rwri': (0.380, 0.480), 'lwri': (0.620, 0.480),
        'rhip': (0.436, 0.470), 'lhip': (0.564, 0.470),
        'rknee': (0.430, 0.710), 'lknee': (0.570, 0.710),
        'rank': (0.425, 0.925), 'lank': (0.575, 0.925),
    }


def _variant(name: str) -> dict[str, tuple[float, float]]:
    p = _base()
    if name == 'stand-a':
        pass
    elif name == 'stand-hands':
        # 双手在身前小腹处交叠：肘内收、腕靠近中线
        p['relb'] = (0.402, 0.320)
        p['lelb'] = (0.598, 0.320)
        p['rwri'] = (0.472, 0.452)
        p['lwri'] = (0.528, 0.452)
    elif name == 'stand-hip':
        # 左手叉腰、右手自然下垂
        p['lelb'] = (0.632, 0.318)
        p['lwri'] = (0.548, 0.472)
    elif name == 'stand-open':
        # 双臂更外张，露出手臂与腰线之间的空隙，便于装甲上色
        p['relb'] = (0.378, 0.325)
        p['lelb'] = (0.622, 0.325)
        p['rwri'] = (0.352, 0.472)
        p['lwri'] = (0.648, 0.472)
    elif name == 'stand-3q':
        # 3/4 侧身：右侧前移（x 更靠中线），左侧后退
        for k in ('rsho', 'relb', 'rwri', 'rhip', 'rknee', 'rank', 'rear', 'reye'):
            x, y = p[k]
            p[k] = (x + 0.022, y)
        for k in ('lsho', 'lelb', 'lwri', 'lhip', 'lknee', 'lank', 'lear', 'leye'):
            x, y = p[k]
            p[k] = (x - 0.012, y)
        p['nose'] = (0.512, 0.075)
        p['neck'] = (0.507, 0.140)
    else:
        raise ValueError(f'未知姿态 {name}')
    return p


VARIANTS = ['stand-a', 'stand-hands', 'stand-hip', 'stand-open', 'stand-3q']


def render(points, W: int, H: int, hr: float, bottom: float) -> Image.Image:
    """按身高比例映射到画布。hr=人物占高，bottom=脚底距底边。"""
    top = 1.0 - hr - bottom
    ph = H * hr                       # 身高对应的像素
    xy = {}
    for k, (x, y) in points.items():
        xy[k] = (W / 2 + (x - 0.5) * ph, H * top + y * ph)

    img = Image.new('RGB', (W, H), (0, 0, 0))
    d = ImageDraw.Draw(img)
    lw = max(3, round(H / 190))
    lr = max(3, round(H / 220))
    for i, (a, b) in enumerate(LIMBS):
        pa, pb = xy[KEYS[a - 1]], xy[KEYS[b - 1]]
        d.line([pa, pb], fill=COLORS[i % len(COLORS)], width=lw)
    for k, (x, y) in xy.items():
        # 点也按 limb 配色循环取色，保证与相邻连线同族
        idx = next((i for i, (a, b) in enumerate(LIMBS) if KEYS[a - 1] == k or KEYS[b - 1] == k), 0)
        d.ellipse([x - lr, y - lr, x + lr, y + lr], fill=COLORS[idx % len(COLORS)])
    return img


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='data/pose/synthetic')
    ap.add_argument('--canvas', default='832x1216')
    ap.add_argument('--height-ratio', type=float, default=0.90,
                    help='人物占画布高度。这一项决定脚会不会被顶出画面')
    ap.add_argument('--bottom-margin', type=float, default=0.08)
    ap.add_argument('--only', default='')
    ap.add_argument('--sheet', action='store_true', help='额外输出一张总览')
    args = ap.parse_args()

    W, H = (int(v) for v in args.canvas.lower().split('x'))
    names = [n for n in (args.only.split(',') if args.only else VARIANTS) if n]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    made = []
    for n in names:
        pts = _variant(n)
        img = render(pts, W, H, args.height_ratio, args.bottom_margin)
        d = out / n
        d.mkdir(parents=True, exist_ok=True)
        img.save(d / 'bone.png')
        (d / 'meta.json').write_text(json.dumps({
            'name': n, 'canvas': [W, H],
            'heightRatio': args.height_ratio, 'bottomMargin': args.bottom_margin,
            'note': '自绘 COCO-18 骨架；无 depth 配套，depth 由 3D 写实人体引入的先验不可用',
            'points': {k: list(v) for k, v in pts.items()},
        }, ensure_ascii=False, indent=1))
        made.append((n, img))
        print(f'  {n:14s} -> {d}/bone.png')

    if args.sheet and made:
        TW = 260
        sheet = Image.new('RGB', (TW * len(made), TW), 'white')
        for i, (_, im) in enumerate(made):
            t = im.copy(); t.thumbnail((TW, TW))
            sheet.paste(t, (i * TW + (TW - t.width) // 2, (TW - t.height) // 2))
        sheet.save(out / '_sheet.png')
        print(f'  总览 -> {out}/_sheet.png')
    print(f'共 {len(made)} 组')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
