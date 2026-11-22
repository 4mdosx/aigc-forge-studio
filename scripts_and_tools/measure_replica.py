#!/usr/bin/env python3
"""measure_replica.py — 量测「生成图离源图有多近」，同时给语义与像素两个数。

为什么需要两个数：DINOv3 余弦量的是语义（同角色同服装就能到 0.9），
PSNR 量的是像素排布。T2I 可以在余弦 0.91 的同时 PSNR 只有 6.7dB——
意思是「画的是同一个人，但完全不是同一张构图」。只看余弦会误判。

用法（仓库根目录）：
    .venv/bin/python scripts_and_tools/measure_replica.py \
        --src data/training-export/ohou19/img/20261122-001117-1b38.png \
        --dir experiments/runs/REPLICA-20261123/ladder

按文件名前缀分组给均值（`t2i-user-s1101` -> `t2i-user`）。
"""

from __future__ import annotations

import argparse
import math
import statistics
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from critic.embed import embed  # noqa: E402

EXTS = {".png", ".jpg", ".jpeg", ".webp"}


def unit(vec) -> np.ndarray:
    a = np.asarray(vec, dtype=np.float32)
    return a / (np.linalg.norm(a) + 1e-9)


def condition_of(name: str) -> str:
    # t2i-user-s1101 / i2i-d020-s1102 -> t2i-user / i2i-d020
    # shot-d020-lora -> d020-lora（fidelity 实验的命名）
    base = name.rsplit("-s", 1)[0] if "-s" in name else name
    if base.count("-") >= 2 and base.split("-")[-1] in {"lora", "nolora"}:
        return "-".join(base.split("-")[-2:])
    return base


def ssim(a: np.ndarray, b: np.ndarray, sigma: float = 1.5, L: float = 255.0) -> float:
    """标准 SSIM（Wang 2004，高斯窗）。skimage 没装，手写一份省得加依赖。

    a/b 是 HxWx3 的 uint8 值域 float 数组，先按 NTSC 权重转灰度。
    """
    from scipy.ndimage import gaussian_filter

    w = np.array([0.299, 0.587, 0.114], dtype=np.float64)
    ga = a.astype(np.float64) @ w
    gb = b.astype(np.float64) @ w
    k1, k2 = 0.01, 0.03
    c1, c2 = (k1 * L) ** 2, (k2 * L) ** 2
    mu_a, mu_b = gaussian_filter(ga, sigma), gaussian_filter(gb, sigma)
    va = gaussian_filter(ga * ga, sigma) - mu_a**2
    vb = gaussian_filter(gb * gb, sigma) - mu_b**2
    cov = gaussian_filter(ga * gb, sigma) - mu_a * mu_b
    num = (2 * mu_a * mu_b + c1) * (2 * cov + c2)
    den = (mu_a**2 + mu_b**2 + c1) * (va + vb + c2)
    return float(np.mean(num / den))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="源图（还原目标）")
    ap.add_argument("--dir", required=True, help="待测图目录")
    ap.add_argument("--filter", default="", help="只测文件名含该子串的图，如 shot-")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    src = Path(args.src)
    files = sorted(p for p in Path(args.dir).iterdir() if p.suffix.lower() in EXTS)
    if args.filter:
        files = [p for p in files if args.filter in p.name]
    if not files:
        print(f"{args.dir} 下没有图", file=sys.stderr)
        return 1

    with Image.open(src) as im:
        w, h = im.size
        base = np.asarray(im.convert("RGB"), dtype=np.float32)
    src_vec = unit(embed(str(src))["styleVec"])

    rows = []
    for p in files:
        cos = float(np.dot(src_vec, unit(embed(str(p))["styleVec"])))
        with Image.open(p) as im:
            pix = np.asarray(im.convert("RGB").resize((w, h), Image.LANCZOS), dtype=np.float32)
        mse = float(np.mean((pix - base) ** 2))
        psnr = 10 * math.log10(255.0**2 / max(mse, 1e-9))
        rows.append({"file": p.name, "condition": condition_of(p.stem), "cosine": cos, "psnr": psnr, "ssim": ssim(pix, base)})

    rows.sort(key=lambda r: r["psnr"])
    print(f"{'文件':38s} {'DINOv3 cos':>11s} {'PSNR dB':>9s} {'SSIM':>7s}")
    print("-" * 70)
    for r in rows:
        print(f"{r['file']:38s} {r['cosine']:11.3f} {r['psnr']:9.2f} {r['ssim']:7.4f}")

    groups: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        groups[r["condition"]].append(r)
    print("\n按条件均值：")
    for cond in sorted(groups, key=lambda c: -statistics.mean(x["psnr"] for x in groups[c])):
        g = groups[cond]
        print(f"  {cond:14s} cos {statistics.mean(x['cosine'] for x in g):.3f}   psnr {statistics.mean(x['psnr'] for x in g):6.2f}   ssim {statistics.mean(x['ssim'] for x in g):.4f}   n={len(g)}")

    if args.json:
        import json

        print(json.dumps({"src": str(src), "rows": rows}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
