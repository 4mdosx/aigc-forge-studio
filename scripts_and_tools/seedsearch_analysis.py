#!/usr/bin/env python3
"""seedsearch_analysis.py — seed 搜索结果分析：分布 + best-of-N 曲线。

回答的问题不是「像不像」，而是「我该扫多少个 seed」。
best-of-N 用滑窗取最大值再平均，给的是「抽 N 张里最好的那张，期望能到多少」，
比只看单张最大值诚实。

用法：
    .venv/bin/python scripts_and_tools/seedsearch_analysis.py \
        --src data/training-export/ohou19/img/20261122-001117-1b38.png \
        --dir experiments/runs/SEEDSEARCH-20261123/seedsearch

文件名需形如 <mode>-s<seed>.png，mode 就是分组。
"""

from __future__ import annotations

import argparse
import glob
import math
import os
import statistics
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from critic.embed import embed  # noqa: E402


def unit(vec):
    a = np.asarray(vec, dtype=np.float32)
    return a / (np.linalg.norm(a) + 1e-9)


def ssim(a: np.ndarray, b: np.ndarray, sigma: float = 1.5, L: float = 255.0) -> float:
    from scipy.ndimage import gaussian_filter

    w = np.array([0.299, 0.587, 0.114], dtype=np.float64)
    ga, gb = a.astype(np.float64) @ w, b.astype(np.float64) @ w
    c1, c2 = (0.01 * L) ** 2, (0.03 * L) ** 2
    ma, mb = gaussian_filter(ga, sigma), gaussian_filter(gb, sigma)
    va = gaussian_filter(ga * ga, sigma) - ma**2
    vb = gaussian_filter(gb * gb, sigma) - mb**2
    cov = gaussian_filter(ga * gb, sigma) - ma * mb
    num = (2 * ma * mb + c1) * (2 * cov + c2)
    den = (ma**2 + mb**2 + c1) * (va + vb + c2)
    return float(np.mean(num / den))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="目标图")
    ap.add_argument("--dir", required=True, help="生成结果目录")
    ap.add_argument("--ns", default="1,2,4,8,16,32", help="best-of-N 的 N 列表")
    args = ap.parse_args()

    src_vec = unit(embed(args.src)["styleVec"])
    with Image.open(args.src) as im:
        w0, h0 = im.size
        base = np.asarray(im.convert("RGB"), dtype=np.float32)

    rows = []
    for p in sorted(glob.glob(os.path.join(args.dir, "*.png"))):
        stem = os.path.splitext(os.path.basename(p))[0]
        mode = stem.rsplit("-s", 1)[0] if "-s" in stem else stem
        cos = float(np.dot(src_vec, unit(embed(p)["styleVec"])))
        with Image.open(p) as im:
            pix = np.asarray(im.convert("RGB").resize((w0, h0), Image.LANCZOS), dtype=np.float32)
        mse = float(np.mean((pix - base) ** 2))
        rows.append(
            {
                "mode": mode,
                "file": os.path.basename(p),
                "cos": cos,
                "psnr": 10 * math.log10(255.0**2 / max(mse, 1e-9)),
                "ssim": ssim(pix, base),
            }
        )

    ns = [int(x) for x in args.ns.split(",") if x.strip()]
    for mode in sorted({r["mode"] for r in rows}):
        g = sorted([r for r in rows if r["mode"] == mode], key=lambda r: -r["cos"])
        print(f"\n=== {mode}（{len(g)} 张）===")
        print(
            f"  cos   min {min(r['cos'] for r in g):.3f} / 中位 {statistics.median(r['cos'] for r in g):.3f} / max {g[0]['cos']:.3f}"
        )
        print(
            f"  psnr  中位 {statistics.median(r['psnr'] for r in g):.2f} dB / max {max(r['psnr'] for r in g):.2f}"
        )
        print(
            f"  ssim  中位 {statistics.median(r['ssim'] for r in g):.3f} / max {max(r['ssim'] for r in g):.3f}"
        )
        print("  best-of-N 期望：", end="")
        for n in ns:
            if n > len(g):
                break
            vals = [max(r["cos"] for r in g[i : i + n]) for i in range(len(g) - n + 1)]
            print(f"  N={n}: {statistics.mean(vals):.3f}", end="")
        print()
        print(
            f"  最优种子 {g[0]['file']}  cos {g[0]['cos']:.3f} / psnr {g[0]['psnr']:.2f} / ssim {g[0]['ssim']:.3f}"
        )

    print("\n参考：同源图互相之间 DINOv3 余弦 中位 0.813 / 最近邻 0.924（ohou19 实测）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
