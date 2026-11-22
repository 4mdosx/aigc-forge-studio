#!/usr/bin/env python3
"""measure_clone.py — 批量量测生成图与参考图的 DINOv3-H CLS 余弦相似度。

用途：验证 LoRA 克隆效果时，给出「每张图离参考图多远」的客观数字，
避免只靠肉眼判断「像不像」。

用法（仓库根目录）：
    .venv/bin/python scripts_and_tools/measure_clone.py <目录或图片...> \
        --ref output/porcelain-style-lora/reference.png [--json] [--sort]

输出：按文件名排序的表格，最后一列 cosine（1.0 = 完全相同）。
另外按「文件名里的 w<数字>」分组给出均值，便于看强度曲线。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from critic.embed import close  # noqa: E402

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


def strength_of(name: str) -> str | None:
    # 文件名形如 native-s1001-w1.png / native-s1001-w0.7.png
    m = re.search(r"-w(\d+(?:\.\d+)?)\.\w+$", name)
    return m.group(1) if m else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("targets", nargs="+")
    ap.add_argument("--ref", required=True)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--sort", action="store_true", help="按 cosine 降序")
    args = ap.parse_args()

    ref = Path(args.ref).expanduser()
    if not ref.is_file():
        print(f"参考图不存在: {ref}", file=sys.stderr)
        return 1
    files = collect(args.targets)
    if not files:
        print("没有匹配的图片", file=sys.stderr)
        return 1

    rows = []
    for f in files:
        r = close(str(f), str(ref))
        rows.append({"image": f.name, "cosine": r["cosine"], "l2": r["l2"], "strength": strength_of(f.name)})
    if args.sort:
        rows.sort(key=lambda r: -r["cosine"])

    if args.json:
        print(json.dumps({"ref": str(ref), "rows": rows}, ensure_ascii=False, indent=2))
        return 0

    print(f"ref: {ref}")
    print(f"{'image':<44} {'cosine':>8} {'l2':>9}")
    for r in rows:
        print(f"{r['image']:<44} {r['cosine']:>8.4f} {r['l2']:>9.4f}")

    groups: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        if r["strength"] is not None:
            groups[r["strength"]].append(r["cosine"])
    if groups:
        print("\n按 LoRA 强度均值：")
        for k in sorted(groups, key=float):
            v = groups[k]
            print(f"  w={k}: n={len(v)} mean={sum(v)/len(v):.4f} min={min(v):.4f} max={max(v):.4f}")

    best = max(rows, key=lambda r: r["cosine"])
    print(f"\n最接近参考图: {best['image']} cosine={best['cosine']:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
