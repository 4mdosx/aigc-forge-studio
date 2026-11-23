#!/usr/bin/env python3
"""overfit_curve.py — 曝光次数饱和曲线：过拟合到底能换到多少保真度（2026-11-23）

背景：T2I 复现训练图时，30 曝光/图的余弦天花板是 0.891（max 0.929）。
问题：这个数字是「数据集信息上限」还是「欠拟合」？把曝光次数推到 150 看曲线形状。

判据（四个一起看，缺一个都会误判）：
  1. max 余弦      —— 天花板本身能不能破 0.95
  2. mean 余弦曲线 —— 在哪一档拐弯（饱和点）
  3. PSNR          —— 像素对应。余弦饱和后 PSNR 还在涨 = 过拟合只在拉近构图，不在提高语义
  4. cos 标准差    —— 多样性坍缩。32 seed 越像彼此，说明 LoRA 在背图而不是学概念

用法（仓库根目录，先跑完 replica_seedsearch.mjs 的各档）：
    .venv/bin/python scripts_and_tools/overfit_curve.py --root experiments/runs --prefix OVERFIT-E
    .venv/bin/python scripts_and_tools/overfit_curve.py --root experiments/runs --out curve.png
"""

from __future__ import annotations

import argparse
import json
import math
import re
import statistics
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from critic.embed import embed  # noqa: E402
from scripts_and_tools.measure_replica import ssim, unit  # noqa: E402

EXTS = {".png", ".jpg", ".jpeg", ".webp"}
CACHE = ROOT / "experiments" / "runs" / "_metrics.json"


def exposure_of(name: str) -> int | None:
    m = re.search(r"E(\d+)$", name)
    return int(m.group(1)) if m else None


def measure_dir(src: Path, dirpath: Path, base: np.ndarray, src_vec: np.ndarray) -> dict[str, list[dict]]:
    """按 prompt 条件分组测一档。"""
    w, h = base.shape[1], base.shape[0]
    groups: dict[str, list[dict]] = defaultdict(list)
    for p in sorted(dirpath.iterdir()):
        if p.suffix.lower() not in EXTS:
            continue
        cond = p.stem.rsplit("-s", 1)[0] if "-s" in p.stem else p.stem
        cos = float(np.dot(src_vec, unit(embed(str(p))["styleVec"])))
        with Image.open(p) as im:
            pix = np.asarray(im.convert("RGB").resize((w, h), Image.LANCZOS), dtype=np.float32)
        mse = float(np.mean((pix - base) ** 2))
        groups[cond].append(
            {
                "file": p.name,
                "cosine": cos,
                "psnr": 10 * math.log10(255.0**2 / max(mse, 1e-9)),
                "ssim": ssim(pix, base),
            }
        )
    return groups


def summarize(rows: list[dict]) -> dict:
    cos = [r["cosine"] for r in rows]
    return {
        "n": len(rows),
        "cos_mean": statistics.mean(cos),
        "cos_median": statistics.median(cos),
        "cos_max": max(cos),
        "cos_std": statistics.pstdev(cos),
        "psnr_mean": statistics.mean(r["psnr"] for r in rows),
        "ssim_mean": statistics.mean(r["ssim"] for r in rows),
    }


def best_of_n(rows: list[dict]) -> dict[int, float]:
    """best-of-N 期望：从 32 个样本里随机取 N 个，其最大余弦的期望。"""
    cos = sorted((r["cosine"] for r in rows), reverse=True)
    out = {}
    for n in (1, 2, 4, 8, 16, 32):
        # 取前 n 的均值作为上限近似（顺序无关的单调代理）
        out[n] = statistics.mean(cos[:n])
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(ROOT / "experiments" / "runs"))
    ap.add_argument("--prefix", default="OVERFIT-E")
    ap.add_argument("--src", default=str(ROOT / "data/training-export/ohou19cap2/img/20261122-001117-1b38.png"))
    ap.add_argument("--out", default="")
    ap.add_argument("--json-out", default="")
    args = ap.parse_args()

    root = Path(args.root)
    src = Path(args.src)
    with Image.open(src) as im:
        base = np.asarray(im.convert("RGB"), dtype=np.float32)
    src_vec = unit(embed(str(src))["styleVec"])

    table: dict[int, dict[str, dict]] = {}
    for run in sorted(root.glob(f"{args.prefix}*")):
        exp = exposure_of(run.name)
        sub = run / "seedsearch"
        if exp is None or not sub.is_dir():
            continue
        groups = measure_dir(src, sub, base, src_vec)
        table[exp] = {cond: summarize(rows) for cond, rows in groups.items()}
        table[exp]["_bestof"] = {cond: best_of_n(rows) for cond, rows in groups.items()}
        print(f"  测完 {run.name}（{sum(len(v) for v in groups.values())} 张）", file=sys.stderr)

    if not table:
        print(f"{root} 下没有匹配 {args.prefix}*/seedsearch 的目录", file=sys.stderr)
        return 1

    conds = sorted({c for e in table.values() for c in e if not c.startswith("_")})
    exps = sorted(table)

    # ---- Markdown 表 ----
    print("\n## 曝光饱和曲线\n")
    head = "| 曝光 | " + " | ".join(f"{c} cos 均值 | {c} cos 最大 | {c} PSNR | {c} SSIM | {c} cos σ" for c in conds) + " |"
    print(head)
    print("|" + "---|" * (1 + 5 * len(conds)))
    for e in exps:
        cells = [str(e)]
        for c in conds:
            s = table[e].get(c)
            if not s:
                cells += ["-"] * 5
                continue
            cells += [
                f"{s['cos_mean']:.3f}",
                f"{s['cos_max']:.3f}",
                f"{s['psnr_mean']:.2f}",
                f"{s['ssim_mean']:.4f}",
                f"{s['cos_std']:.3f}",
            ]
        print("| " + " | ".join(cells) + " |")

    # ---- best-of-N ----
    print("\n## best-of-N（同一档内取前 N 个的平均余弦）\n")
    ns = [1, 2, 4, 8, 16, 32]
    print("| 曝光 | " + " | ".join(f"{c} N={n}" for c in conds for n in ns) + " |")
    print("|" + "---|" * (1 + len(conds) * len(ns)))
    for e in exps:
        cells = [str(e)]
        for c in conds:
            bo = table[e].get("_bestof", {}).get(c, {})
            cells += [f"{bo.get(n, float('nan')):.3f}" for n in ns]
        print("| " + " | ".join(cells) + " |")

    payload = {"src": str(src), "exposures": {str(k): v for k, v in table.items()}}
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(payload, ensure_ascii=False, indent=2))
        print(f"\nJSON → {args.json_out}")

    # ---- 曲线图 ----
    if args.out:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        fig, axes = plt.subplots(1, 3, figsize=(15, 4.4))
        colors = {"full": "#c0392b", "user": "#2c6fa8"}

        ax = axes[0]
        for c in conds:
            ys = [table[e][c]["cos_mean"] for e in exps if c in table[e]]
            std = [table[e][c]["cos_std"] for e in exps if c in table[e]]
            xs = [e for e in exps if c in table[e]]
            ax.plot(xs, ys, "o-", color=colors.get(c), label=f"{c} mean")
            ax.fill_between(xs, [a - b for a, b in zip(ys, std)], [a + b for a, b in zip(ys, std)],
                            color=colors.get(c), alpha=0.12)
            ax.plot(xs, [table[e][c]["cos_max"] for e in xs], "o--", color=colors.get(c),
                    alpha=0.55, lw=1.2, label=f"{c} max")
        ax.axhline(0.95, color="#888", ls=":", lw=1)
        ax.text(exps[0], 0.952, "0.95", color="#888", fontsize=8)
        ax.set_xlabel("exposures per image")
        ax.set_ylabel("DINOv3 cosine")
        ax.set_title("Semantic similarity")
        ax.legend(fontsize=7, loc="lower right")
        ax.grid(alpha=0.25)

        ax = axes[1]
        for c in conds:
            xs = [e for e in exps if c in table[e]]
            ax.plot(xs, [table[e][c]["psnr_mean"] for e in xs], "o-", color=colors.get(c), label=c)
        ax.set_xlabel("exposures per image")
        ax.set_ylabel("PSNR (dB)")
        ax.set_title("Pixel correspondence")
        ax.legend(fontsize=8)
        ax.grid(alpha=0.25)

        ax = axes[2]
        for c in conds:
            xs = [e for e in exps if c in table[e]]
            ax.plot(xs, [table[e][c]["cos_std"] for e in xs], "o-", color=colors.get(c), label=c)
        ax.set_xlabel("exposures per image")
        ax.set_ylabel("std of cosine across 32 seeds")
        ax.set_title("Diversity collapse")
        ax.legend(fontsize=8)
        ax.grid(alpha=0.25)

        fig.suptitle("Overfitting saturation: ohou19cap2, 19 images, 1216x688, 32 seeds x 2 prompts",
                     fontsize=10)
        fig.tight_layout()
        fig.savefig(args.out, dpi=150)
        print(f"图 → {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
