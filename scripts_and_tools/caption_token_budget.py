#!/usr/bin/env python3
"""caption_token_budget.py — 查训练 caption 有多少真正进了 CLIP。

背景：SDXL 的 CLIP-L 上限 77 token（含两个特殊 token，即 75 个内容 token），
超出部分被 tokenizer 静默截断，没有警告。caption 写得越"详尽"，
越可能把真正关键的 tag 写在截断点之后 —— 写了等于没写。

2026-11-23 实测 ohou19 数据集：19 张全部超限，平均 168 token，只有 44% 进模型，
`@style-v1` 存活 0/19、`full_body` 0/19、`dutch_angle` 3/19。

用法：
    .venv/bin/python scripts_and_tools/caption_token_budget.py --dir data/training-export/ohou19/img
    .venv/bin/python scripts_and_tools/caption_token_budget.py --dir <目录> --tag ohou --tag full_body
"""

from __future__ import annotations

import argparse
import glob
import os
import statistics

from transformers import CLIPTokenizer

LIMIT = 75  # 内容 token 上限（不含 start/end 特殊 token）


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="含 *.txt caption 的目录")
    ap.add_argument("--tag", action="append", default=[], help="额外关注哪些 tag 的存活率，可重复")
    ap.add_argument("--model", default="openai/clip-vit-large-patch14", help="用来计数的 tokenizer")
    args = ap.parse_args()

    tok = CLIPTokenizer.from_pretrained(args.model)
    files = sorted(glob.glob(os.path.join(args.dir, "*.txt")))
    if not files:
        print(f"{args.dir} 下没有 .txt")
        return 1

    def ntok(s: str) -> int:
        return len(tok(s)["input_ids"]) - 2

    rows = []
    for f in files:
        text = open(f, encoding="utf-8").read().strip()
        segs = [s.strip() for s in text.split(",") if s.strip()]
        total = ntok(text)
        acc, cut = 0, None
        for i, s in enumerate(segs):
            acc += ntok(s + ",")
            if acc > LIMIT and cut is None:
                cut = i
        rows.append({"name": os.path.basename(f), "total": total, "segs": segs, "cut": cut})

    over = [r for r in rows if r["total"] > LIMIT]
    print(
        f"{len(files)} 张里 {len(over)} 张超 {LIMIT} token；"
        f"平均 {statistics.mean(r['total'] for r in rows):.0f} token / {statistics.mean(len(r['segs']) for r in rows):.0f} 段"
    )
    kept_ratio = statistics.mean(
        (len(r["segs"]) if r["cut"] is None else r["cut"]) / len(r["segs"]) for r in rows
    )
    print(f"平均只有 {kept_ratio:.0%} 的 tag 真正进模型\n")

    print(f"{'文件':30s} {'token':>6s} {'段数':>5s} {'保留':>8s}  截断点之后第一个被丢的 tag")
    print("-" * 96)
    for r in rows:
        if r["cut"] is None:
            print(f"{r['name']:30s} {r['total']:6d} {len(r['segs']):5d} {'全部':>8s}  （未截断）")
        else:
            dropped = r["segs"][r["cut"]] if r["cut"] < len(r["segs"]) else "(尾)"
            print(f"{r['name']:30s} {r['total']:6d} {len(r['segs']):5d} {r['cut']:5d}/{len(r['segs']):<3d} {dropped}")

    watch = args.tag or ["ohou", "@style-v1", "dutch_angle", "full_body"]
    print(f"\n关注 tag 的存活率（{len(watch)} 个 tag，共 {len(rows)} 张）：")
    for tag in watch:
        # 未截断的图也要逐张查 —— 之前写成 `cut is None or ...` 会把「图里没写这个 tag」
        # 也算成存活，导致未截断时一律显示 n/n。
        alive = sum(
            1
            for r in rows
            if tag in (r["segs"] if r["cut"] is None else r["segs"][: r["cut"]])
        )
        print(f"  {tag:22s} {alive}/{len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
