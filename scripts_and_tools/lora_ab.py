#!/usr/bin/env python3
"""LoRA A/B：把两次 repaint 扫描（同一 prompt、同一 seed、同一 denoise 档）并排放。

用法（先各自跑 repaint_probe.py 生成 probe.csv）：
    python3 scripts_and_tools/lora_ab.py --a LORA-GLOSS-20261124 --b LORA-CTRL-20261124 \
        --label-a "gloss LoRA @0.9" --label-b "无 LoRA"

A 与 B 必须共用同一批源图与 denoise 档，否则只报交集。
输出 run_a/lora_ab.md，并在终端打印。
"""

from __future__ import annotations

import argparse
import csv
import json
import statistics as st
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
RUNS = REPO / 'experiments' / 'runs'


def load(run: str) -> list[dict]:
    p = RUNS / run / 'probe.csv'
    if not p.exists():
        raise SystemExit(f'{p} 不存在，先跑 repaint_probe.py --run {run}')
    rows = list(csv.DictReader(p.open()))
    for r in rows:
        for k in ('denoise', 'cos_src', 'dd_gloss', 'd_gloss', 'lap_ratio_vs_src', 'sat', 'lap_var'):
            r[k] = float(r[k])
    return rows


def mean(xs, k):
    return st.mean(x[k] for x in xs) if xs else float('nan')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--a', required=True)
    ap.add_argument('--b', required=True)
    ap.add_argument('--label-a', default='A')
    ap.add_argument('--label-b', default='B')
    args = ap.parse_args()

    ra, rb = load(args.a), load(args.b)
    tags = sorted({r['srcTag'] for r in ra} & {r['srcTag'] for r in rb})
    dens = sorted({r['denoise'] for r in ra} & {r['denoise'] for r in rb})
    if not tags or not dens:
        raise SystemExit('两次扫描没有共同源图或共同 denoise 档')

    def pick(rows, tag, d):
        hit = [r for r in rows if r['srcTag'] == tag and r['denoise'] == d]
        return hit[0] if hit else None

    L = [f'# LoRA A/B · {args.label_a} vs {args.label_b}\n']
    L.append(f'源图 {len(tags)} 张（{", ".join(f"`{t}`" for t in tags)}），denoise 档 {len(dens)} 个。')
    L.append('两边的 prompt / seed / 尺寸 / 底模完全一致，唯一变量是 LoRA。\n')
    L.append('`dd_gloss` = 相对自己那张源图朝 gloss 簇走的位移；`cos_src` < 0.90 表示已不是原来那张画。')
    L.append('**Δdd = A 的 dd_gloss − B 的 dd_gloss**，这一列才是权重本身的效应（prompt 已被控住）。\n')

    L.append('| denoise | cos_src A | cos_src B | dd_gloss A | dd_gloss B | Δdd | lap/源 A | lap/源 B | sat A | sat B | 源胜出 |')
    L.append('|---|---|---|---|---|---|---|---|---|---|---|')
    for d in dens:
        a = [r for r in ra if r['denoise'] == d and r['srcTag'] in tags]
        b = [r for r in rb if r['denoise'] == d and r['srcTag'] in tags]
        win = sum(
            1
            for t in tags
            if (x := pick(ra, t, d)) and (y := pick(rb, t, d)) and x['dd_gloss'] > y['dd_gloss']
        )
        L.append(
            f"| {d:.2f} | {mean(a,'cos_src'):.3f} | {mean(b,'cos_src'):.3f} | "
            f"{mean(a,'dd_gloss'):+.3f} | {mean(b,'dd_gloss'):+.3f} | "
            f"**{mean(a,'dd_gloss') - mean(b,'dd_gloss'):+.3f}** | "
            f"{mean(a,'lap_ratio_vs_src'):.2f} | {mean(b,'lap_ratio_vs_src'):.2f} | "
            f"{mean(a,'sat'):.3f} | {mean(b,'sat'):.3f} | {win}/{len(tags)} |"
        )

    L.append('\n## 逐源 dd_gloss\n')
    L.append('| 源图 | ' + ' | '.join(f'{d:.2f}' for d in dens) + ' |')
    L.append('|---|' + '---|' * len(dens))
    for t in tags:
        cells = []
        for d in dens:
            x, y = pick(ra, t, d), pick(rb, t, d)
            cells.append(f"{x['dd_gloss']:+.3f} / {y['dd_gloss']:+.3f}" if x and y else '-')
        L.append(f'| `{t}` | ' + ' | '.join(cells) + ' |')

    out = RUNS / args.a / 'lora_ab.md'
    out.write_text('\n'.join(L) + '\n')
    print('\n'.join(L))
    print(f'\n-> {out}')
    print(json.dumps({'a': args.a, 'b': args.b, 'tags': tags, 'dens': dens}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
