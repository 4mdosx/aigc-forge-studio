#!/usr/bin/env python3
"""把多档 LoRA A/B 扫描汇成一张三栏曲线：权重对质感的权限 vs denoise。

读法（y 轴都是跨源均值）：
  左  dd_gloss —— 相对源图朝 gloss 簇的位移。两条线一起涨说明 img2img 本身在漂；
                 两条线分开的距离（阴影）才是 LoRA 的净效应。
  中  细节密度 / 源图 —— gloss 池是「更平滑」的一簇，LoRA 应把这条线压到 1 以下。
  右  平均饱和度 —— gloss profile 中位 0.284，源图 0.28~0.30，基模默认审美往上跑。

用法：
  python3 scripts_and_tools/lora_curve.py --pair LORA-GLOSS-20261124:CTRL-GLOSS \
      --pair LORA-HI-20261124:CTRL-HI-20261124 --out curve.png
"""

from __future__ import annotations

import argparse
import csv
import statistics as st
from pathlib import Path

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager

REPO = Path(__file__).resolve().parents[1]
RUNS = REPO / 'experiments' / 'runs'

for cand in ('/System/Library/Fonts/Hiragino Sans GB.ttc', '/System/Library/Fonts/PingFang.ttc'):
    if Path(cand).exists():
        font_manager.fontManager.addfont(cand)
        plt.rcParams['font.family'] = font_manager.FontProperties(fname=cand).get_name()
        break
plt.rcParams['axes.unicode_minus'] = False


def load(run: str) -> list[dict]:
    rows = list(csv.DictReader((RUNS / run / 'probe.csv').open()))
    for r in rows:
        for k in ('denoise', 'cos_src', 'dd_gloss', 'lap_ratio_vs_src', 'sat'):
            r[k] = float(r[k])
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--pair', action='append', required=True, help='A:B，A 挂 LoRA，B 不挂')
    ap.add_argument('--out', default='lora_curve.png')
    args = ap.parse_args()

    pts = []  # (denoise, lora_dd, ctrl_dd, lora_lap, ctrl_lap, lora_sat, ctrl_sat)
    for spec in args.pair:
        a, b = spec.split(':')
        ra, rb = load(a), load(b)
        for d in sorted({r['denoise'] for r in ra} & {r['denoise'] for r in rb}):
            la = [r for r in ra if r['denoise'] == d]
            lb = [r for r in rb if r['denoise'] == d]
            pts.append(
                (
                    d,
                    st.mean(x['dd_gloss'] for x in la),
                    st.mean(x['dd_gloss'] for x in lb),
                    st.mean(x['lap_ratio_vs_src'] for x in la),
                    st.mean(x['lap_ratio_vs_src'] for x in lb),
                    st.mean(x['sat'] for x in la),
                    st.mean(x['sat'] for x in lb),
                )
            )
    pts.sort()
    xs = [p[0] for p in pts]

    fig, axes = plt.subplots(1, 3, figsize=(15, 4.6), dpi=140)
    ax = axes[0]
    ax.plot(xs, [p[1] for p in pts], 'o-', color='#2f7fd0', label='挂 gloss LoRA')
    ax.plot(xs, [p[2] for p in pts], 's--', color='#c0392b', label='不挂（同 prompt）')
    ax.fill_between(xs, [p[2] for p in pts], [p[1] for p in pts], color='#2f7fd0', alpha=0.12)
    ax.axhline(0, color='#999', lw=0.8)
    ax.set_title('朝 gloss 簇的位移 dd_gloss')
    ax.set_xlabel('denoise')
    ax.legend(fontsize=9)

    ax = axes[1]
    ax.plot(xs, [p[3] for p in pts], 'o-', color='#2f7fd0', label='挂 LoRA')
    ax.plot(xs, [p[4] for p in pts], 's--', color='#c0392b', label='不挂')
    ax.axhline(1.0, color='#999', lw=0.8, ls=':')
    ax.set_title('细节密度 / 源图（<1 更平滑）')
    ax.set_xlabel('denoise')
    ax.legend(fontsize=9)

    ax = axes[2]
    ax.plot(xs, [p[5] for p in pts], 'o-', color='#2f7fd0', label='挂 LoRA')
    ax.plot(xs, [p[6] for p in pts], 's--', color='#c0392b', label='不挂')
    ax.axhline(0.284, color='#27ae60', lw=0.9, ls='-.')
    ax.text(0.22, 0.286, 'gloss 池中位 0.284', fontsize=8, color='#27ae60')
    ax.set_title('平均饱和度（非背景）')
    ax.set_xlabel('denoise')
    ax.legend(fontsize=9)

    fig.suptitle('权重 vs denoise：LoRA 的质感权限随 denoise 单调上升，结构在同一条滑轨上消失', fontsize=11)
    fig.tight_layout()
    out = Path(args.out)
    fig.savefig(out, bbox_inches='tight')
    print(f'-> {out}')
    print(f"{'dn':>5} {'lora_dd':>8} {'ctrl_dd':>8} {'Δdd':>7} {'lap_l':>6} {'lap_c':>6} {'sat_l':>6} {'sat_c':>6}")
    for p in pts:
        print(f'{p[0]:5.2f} {p[1]:+8.3f} {p[2]:+8.3f} {p[1]-p[2]:+7.3f} {p[3]:6.2f} {p[4]:6.2f} {p[5]:6.3f} {p[6]:6.3f}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
