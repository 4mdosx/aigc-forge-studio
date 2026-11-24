#!/usr/bin/env python3
"""量出图里人物在画布里占了多大、有没有被裁。

两个坑都踩过了：
  1. 背景是垂直渐变 + 地面投影时，单一「四角背景色」会把整幅下半判成主体。
     改用「每行左右两端中位色」+「每列上端中位色」两条背景估计，取较近者。
  2. 地面投影横跨整幅、对比度又和靴子连续，用色差阈值怎么调都分不开。
     关键判据是**行内最大对比度**：人物边缘挨着背景色差 200+，柔和投影撑死 60。
     所以「有主体的行」= 该行存在与背景色差 > DEEP_TOL 的像素。
     被裁的腿在画面边上没有边缘——梯度法在这里天然失效，但色差法照样有效。

输出 top/bottom/left/right（归一化，0 在上/左）、占高、宽高比、裁决。

  python3 scripts_and_tools/frame_fit.py experiments/runs/XXX/out/
  python3 scripts_and_tools/frame_fit.py --json out.json <dir>

裁决口径：
  bbox 触到画布边 EDGE_TOL 以内 -> crop_<边>
  占高 >= 0.72 且四边都没裁 -> whole（完整全身立绘）
  占高 <  0.72 -> partial（半身/胸像）

  阈值从 0.80 降到 0.72：0.80 是凭感觉定的，实测 79.6% 和 80.2% 的人物高度
  根本没有肉眼可辨的差别，却会被判成两类。0.72 以下才真的是半身/胸像。
"""
import sys, json, glob
from pathlib import Path

import numpy as np
from PIL import Image

EDGE_TOL = 0.008      # 距边 0.8% 内算触边（2px @ 1216 级别的贴边留白）
BG_TOL = 26.0         # 与背景色差超过这个值 -> 可能是主体
DEEP_TOL = 100.0      # 行/列内最大色差超过这个值 -> 这一行/列真有主体
WHOLE_H = 0.72
DOWNSCALE = 2


def analyze(path: Path) -> dict:
    im = Image.open(path).convert('RGB')
    im = im.resize((max(1, im.width // DOWNSCALE), max(1, im.height // DOWNSCALE)), Image.LANCZOS)
    a = np.asarray(im).astype(np.float32)
    h, w, _ = a.shape

    k = max(4, min(h, w) // 30)
    row_bg = np.median(np.concatenate([a[:, :k], a[:, -k:]], axis=1), axis=1)  # (h,3)
    col_bg = np.median(a[:k, :], axis=0)                                       # (w,3)
    dist = np.minimum(
        np.linalg.norm(a - row_bg[:, None, :], axis=2),
        np.linalg.norm(a - col_bg[None, :, :], axis=2),
    )

    rowmax = dist.max(axis=1)
    colmax = dist.max(axis=0)
    rows = np.where(rowmax > DEEP_TOL)[0]
    cols = np.where(colmax > DEEP_TOL)[0]
    mode = 'deep'

    if len(rows) == 0 or len(cols) == 0:
        # 白底白裙这种极低对比的图，回退到宽阈值 + 计数
        mode = 'loose'
        min_pr = max(2, int(w * 0.003))
        min_pc = max(2, int(h * 0.003))
        m = dist > BG_TOL
        rows = np.where(m.sum(axis=1) >= min_pr)[0]
        cols = np.where(m.sum(axis=0) >= min_pc)[0]
        if len(rows) == 0 or len(cols) == 0:
            return {'file': path.name, 'error': 'no subject'}

    top, bot = rows[0] / (h - 1), rows[-1] / (h - 1)
    left, right = cols[0] / (w - 1), cols[-1] / (w - 1)
    fill = (bot - top) * 100
    width_fill = (right - left) * 100

    crop_top = top <= EDGE_TOL
    crop_bottom = bot >= 1 - EDGE_TOL
    crop_side = left <= EDGE_TOL or right >= 1 - EDGE_TOL

    if crop_bottom:
        verdict = 'crop_bottom'
    elif crop_top:
        verdict = 'crop_top'
    elif crop_side:
        verdict = 'crop_side'
    elif fill >= WHOLE_H * 100:
        verdict = 'whole'
    else:
        verdict = 'partial'

    return {
        'file': path.name,
        'mode': mode,
        'top': round(top, 4), 'bottom': round(bot, 4),
        'left': round(left, 4), 'right': round(right, 4),
        'fill_pct': round(fill, 1),
        'w_pct': round(width_fill, 1),
        'aspect': round((bot - top) * h / max(1e-6, (right - left) * w), 3),
        'verdict': verdict,
    }


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    as_json = '--json' in sys.argv
    files = []
    for a in args:
        p = Path(a)
        if p.is_dir():
            files += sorted(p.glob('*.png'))
        else:
            files += [Path(x) for x in glob.glob(a)]
    if not files:
        print('没找到图片')
        return 1

    rows = [analyze(f) for f in files]
    if as_json:
        print(json.dumps(rows, ensure_ascii=False, indent=1))
        return 0

    print(f"{'file':40} {'top':>6} {'bot':>6} {'fill%':>6} {'w%':>6} {'asp':>5}  verdict")
    for r in rows:
        if r.get('error'):
            print(f"{r['file']:40} {r['error']}")
            continue
        flag = '' if r['mode'] == 'deep' else ' (loose)'
        print(f"{r['file']:40} {r['top']:6.3f} {r['bottom']:6.3f} {r['fill_pct']:6.1f} "
              f"{r['w_pct']:6.1f} {r['aspect']:5.2f}  {r['verdict']}{flag}")

    from collections import Counter
    c = Counter(r.get('verdict', 'err') for r in rows)
    print('\n汇总：' + '  '.join(f'{k}={v}' for k, v in c.most_common()))
    ok = [r for r in rows if r.get('verdict') in ('whole', 'partial')]
    if ok:
        print(f"未被裁 {len(ok)}/{len(rows)}；其中完整全身 {sum(1 for r in ok if r['verdict']=='whole')}"
              f"，占高中位 {np.median([r['fill_pct'] for r in ok]):.1f}%")
    return 0


if __name__ == '__main__':
    sys.exit(main())
