#!/usr/bin/env python3
"""probe_concept.py — 量「风格词是否被学成了可拆的独立概念」。

背景（2026-11-23）：ohou 的 19 张训练 caption 里，`strong rim light` 与
`crimson and black` 是两个独立 tag。第一版 caption 重排时为了省 4 token 把它们
合成 `crimson rim light`——问题是这个合并词在 CLIP 词表里不是独立概念，模型只能
把它当整体硬背。于是拆回两段（ohou19cap2）重训。

验证方法：固定同一份 caption，只抽掉其中一个风格词，看生成图的色彩分布是否
跟着各自变化。如果拆词生效，会出现：

  onlyrim  （抽掉 crimson and black）→ 红色成分明显下降，但亮部/边缘高光仍在
  onlycrim （抽掉 rim light）       → 红色仍在，但对比/硬边下降
  noboth   （两个都抽掉）           → 红色最低

若 LoRA 学的是合并词，则抽掉任一个都会让两个效果一起塌，三组数字挤在一起。

指标（HSV）：
  red_ratio  红色相像素占比（hue 340-360/0-20，S>0.25，V>0.2）—— `crimson`
  hi_ratio   高亮像素占比（V>0.75）—— `rim light` 的直接产物
  mean_sat   平均饱和度

用法：
  .venv/bin/python scripts_and_tools/probe_concept.py --dir experiments/runs/PROBE-xxx/probe
  .venv/bin/python scripts_and_tools/probe_concept.py --dir ... --json
"""

from __future__ import annotations

import argparse
import json
import statistics
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image

EXTS = {".png", ".jpg", ".jpeg", ".webp"}


def hsv_stats(path: Path) -> dict[str, float]:
    with Image.open(path) as im:
        hsv = np.asarray(im.convert("HSV"), dtype=np.float32) / 255.0
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    # PIL 的 H 通道是 0..255 的整数映射，红色跨 0 点：0..10 与 241..255（约 ±20°）
    red_hue = (h <= 0.039) | (h >= 0.944)
    red = red_hue & (s > 0.25) & (v > 0.2)
    return {
        "red_ratio": float(red.mean()),
        "hi_ratio": float((v > 0.75).mean()),
        "mean_sat": float(s.mean()),
        "mean_v": float(v.mean()),
    }


def group_of(stem: str, known: list[str]) -> str:
    for k in sorted(known, key=len, reverse=True):
        if stem.startswith(k + "-"):
            return k
    return stem.rsplit("-", 1)[0]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--groups", default="", help="逗号分隔的组名前缀，缺省自动推断")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    files = sorted(p for p in Path(args.dir).iterdir() if p.suffix.lower() in EXTS)
    if not files:
        print(f"{args.dir} 下没有图", flush=True)
        return 1

    known = [g.strip() for g in args.groups.split(",") if g.strip()]
    buckets: dict[str, list[dict]] = defaultdict(list)
    for p in files:
        g = group_of(p.stem, known)
        row = {"file": p.name, **hsv_stats(p)}
        buckets[g].append(row)

    if args.json:
        print(json.dumps({g: v for g, v in buckets.items()}, ensure_ascii=False, indent=1))
        return 0

    print(f"{'组':14s} {'n':>3s} {'red%':>7s} {'hi%':>7s} {'sat':>6s} {'val':>6s}")
    print("-" * 50)
    for g in sorted(buckets, key=lambda x: -statistics.mean(r["mean_sat"] for r in buckets[x])):
        rs = buckets[g]
        print(
            f"{g:14s} {len(rs):3d} "
            f"{statistics.mean(r['red_ratio'] for r in rs) * 100:6.2f}% "
            f"{statistics.mean(r['hi_ratio'] for r in rs) * 100:6.2f}% "
            f"{statistics.mean(r['mean_sat'] for r in rs):6.3f} "
            f"{statistics.mean(r['mean_v'] for r in rs):6.3f}"
        )

    # 若按 LoRA 分组（loraX-mode），再给一张「同一 LoRA 内三个变体的极差」
    multi = [g for g in buckets if "-" in g]
    if multi:
        by_lora: dict[str, dict[str, list]] = defaultdict(dict)
        for g in buckets:
            parts = g.split("-", 1)
            if len(parts) == 2:
                by_lora[parts[0]][parts[1]] = buckets[g]
        print("\n同一 LoRA 内的拆分效应（red% 极差越大＝两个词越可拆）：")
        for lora, modes in sorted(by_lora.items()):
            if len(modes) < 2:
                continue
            means = {m: statistics.mean(r["red_ratio"] for r in v) * 100 for m, v in modes.items()}
            spread = max(means.values()) - min(means.values())
            detail = "  ".join(f"{m}={v:.2f}%" for m, v in sorted(means.items()))
            print(f"  {lora:22s} 极差 {spread:5.2f}pp   {detail}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
