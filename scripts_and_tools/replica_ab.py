#!/usr/bin/env python3
"""replica_ab.py — 多组 T2I 复现结果的并排度量（2×2 因子实验用）。

measure_replica.py 一次只量一个目录；做「LoRA × caption」这类因子实验时
需要把几组放在一张表里比，这个脚本就干这件事。

指标口径与 measure_replica.py 一致：
  - cosine：DINOv3-H CLS 1280 维余弦（语义相似度，量不到构图）
  - PSNR  ：像素级，跨图不可比（画面细节密度影响极大），同图不同组可比
  - SSIM  ：结构相似度，同图不同组可比

用法：
    .venv/bin/python scripts_and_tools/replica_ab.py \
        --src data/training-export/ohou19/img/20261122-001117-1b38.png \
        --group A-旧LoRA_旧cap=experiments/runs/CAP2x2/A-oldL-oldC \
        --group B-新LoRA_新cap=experiments/runs/CAP2x2/B-newL-newC \
        --group C-旧LoRA_新cap=experiments/runs/CAP2x2/C-oldL-newC \
        --group D-新LoRA_旧cap=experiments/runs/CAP2x2/D-newL-oldC
"""

from __future__ import annotations

import argparse
import math
import statistics
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from critic.embed import embed  # noqa: E402

EXTS = {".png", ".jpg", ".jpeg", ".webp"}


def unit(v) -> np.ndarray:
    a = np.asarray(v, dtype=np.float32)
    return a / (np.linalg.norm(a) + 1e-9)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="目标图")
    ap.add_argument("--group", action="append", required=True, help="NAME=DIR，可重复")
    ap.add_argument("--paired", action="append", default=[], help="X=Y，对同一批 seed 做配对 t 检验（Y 减 X），可重复")
    args = ap.parse_args()

    src = Path(args.src)
    with Image.open(src) as im:
        w, h = im.size
        base = np.asarray(im.convert("RGB"), dtype=np.float32)
    src_vec = unit(embed(str(src))["styleVec"])

    groups = []
    for spec in args.group:
        name, _, d = spec.partition("=")
        p = Path(d)
        if not p.is_dir():
            print(f"跳过 {name}：{d} 不存在", file=sys.stderr)
            continue
        files = sorted(f for f in p.iterdir() if f.suffix.lower() in EXTS)
        if not files:
            print(f"跳过 {name}：{d} 无图", file=sys.stderr)
            continue
        rows = []
        for f in files:
            cos = float(np.dot(src_vec, unit(embed(str(f))["styleVec"])))
            with Image.open(f) as im:
                pix = np.asarray(im.convert("RGB").resize((w, h), Image.LANCZOS), dtype=np.float32)
            mse = float(np.mean((pix - base) ** 2))
            psnr = 10 * math.log10(255.0 ** 2 / max(mse, 1e-9))
            rows.append({"file": f.name, "cosine": cos, "psnr": psnr})
        groups.append({"name": name, "rows": rows})

    if not groups:
        print("没有可用分组", file=sys.stderr)
        return 1

    print(f"目标 {src.name}  {w}x{h}  DINOv3-H CLS 余弦 / PSNR")
    print("-" * 92)
    print(f"{'组合':26s} {'n':>3s} {'cos 均值':>9s} {'cos 中位':>9s} {'cos 最大':>9s} {'PSNR 均值':>10s}")
    print("-" * 92)
    for g in groups:
        cs = [r["cosine"] for r in g["rows"]]
        ps = [r["psnr"] for r in g["rows"]]
        best = max(g["rows"], key=lambda r: r["cosine"])
        print(f"{g['name']:26s} {len(cs):3d} {statistics.mean(cs):9.3f} "
              f"{statistics.median(cs):9.3f} {max(cs):9.3f} {statistics.mean(ps):10.2f}")
        print(f"{'':26s} 最高 cos 的 seed: {best['file']}")
    print("-" * 92)

    # 配对检验：同一 seed 的两组结果配对，比独立样本更能压住 seed 噪声
    if args.paired:
        by_name = {g["name"]: {r["file"]: r for r in g["rows"]} for g in groups}
        try:
            from scipy import stats as sps
        except ImportError:
            sps = None
        print("\n配对 t 检验（同 seed 配对，Y 减 X）：")
        for spec in args.paired:
            x_name, _, y_name = spec.partition("=")
            if x_name not in by_name or y_name not in by_name:
                print(f"  跳过 {spec}：组名不存在")
                continue
            common = sorted(set(by_name[x_name]) & set(by_name[y_name]))
            if len(common) < 3:
                print(f"  跳过 {spec}：共同文件不足")
                continue
            for metric in ("cosine", "psnr"):
                diffs = [by_name[y_name][f][metric] - by_name[x_name][f][metric] for f in common]
                mean_d = statistics.mean(diffs)
                sd_d = statistics.stdev(diffs) if len(diffs) > 1 else 0.0
                if sps and sd_d > 0:
                    t, p = sps.ttest_rel(
                        [by_name[y_name][f][metric] for f in common],
                        [by_name[x_name][f][metric] for f in common],
                    )
                    verdict = "显著" if p < 0.05 else "不显著"
                    print(f"  {x_name} → {y_name:22s} {metric:7s} Δ={mean_d:+.4f} "
                          f"sd={sd_d:.4f} t={t:+.2f} p={p:.4f} {verdict}")
                else:
                    print(f"  {x_name} → {y_name:22s} {metric:7s} Δ={mean_d:+.4f} sd={sd_d:.4f} (样本不足)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
