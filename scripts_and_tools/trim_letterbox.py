#!/usr/bin/env python3
"""trim_letterbox.py — 裁掉采集管道填出来的白边（letterbox）。

背景（2026-11-22）：capture 管道把 16:9 原图等比缩到 1216 宽后，居中贴进
1216x832 的画布，上下各留 74px 纯白。这类白边如果直接进训练集，模型会学到
"主体居中、上下各留一条白条"这种与内容无关的构图先验，出图永远带白边。

判据：从四条边向内扫描，第一行/列出现 < --thr 像素的位置即内容边界。
幂等：检测到四边白边都 < 2px 时跳过，可反复跑。

用法：
    .venv/bin/python scripts_and_tools/trim_letterbox.py <目录|图片...> [--thr 245] [--dry-run]
    .venv/bin/python scripts_and_tools/trim_letterbox.py data/training-export/ohou/img --dry-run
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

EXTS = {".png", ".jpg", ".jpeg", ".webp"}


def collect(targets: list[str]) -> list[Path]:
    out: list[Path] = []
    for t in targets:
        p = Path(t).expanduser()
        if p.is_dir():
            out.extend(sorted(x for x in p.iterdir() if x.suffix.lower() in EXTS))
        elif p.is_file():
            out.append(p)
        else:
            raise FileNotFoundError(f"不存在: {p}")
    return out


def edge(arr: np.ndarray, thr: int) -> int:
    """从数组起点向内扫描，返回第一个存在非白像素的行/列索引。"""
    for k in range(len(arr)):
        if arr[k].min() < thr:
            return k
    return len(arr)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("targets", nargs="+")
    ap.add_argument("--thr", type=int, default=245, help="白边判定阈值（默认 245）")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    files = collect(args.targets)
    changed = skipped = 0
    rows = []
    for p in files:
        im = Image.open(p).convert("RGB")
        a = np.asarray(im.convert("L"))
        h, w = a.shape
        top = edge(a, args.thr)
        bot = edge(a[::-1], args.thr)
        left = edge(a.T, args.thr)
        right = edge(a.T[::-1], args.thr)
        box = (left, top, w - right, h - bot)
        nw, nh = box[2] - box[0], box[3] - box[1]
        if left < 2 and right < 2 and top < 2 and bot < 2:
            skipped += 1
            continue
        rows.append((p.name, f"{w}x{h}", f"{left}/{right}/{top}/{bot}", f"{nw}x{nh}"))
        if not args.dry_run:
            im.crop(box).save(p)
        changed += 1

    print(f"{'file':<46}{'原尺寸':>11}{'边L/R/T/B':>16}{'裁后':>11}")
    for r in rows:
        print(f"{r[0][:44]:<46}{r[1]:>11}{r[2]:>16}{r[3]:>11}")
    print(f"\n{'将裁' if args.dry_run else '已裁'} {changed} 张，跳过 {skipped} 张（无白边）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
