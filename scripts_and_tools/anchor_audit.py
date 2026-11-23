#!/usr/bin/env python3
"""anchor_audit.py — 审一个数据集到底有多少张真的能用。

为什么需要：池子是「按 tag 筛出来的」，tag 会骗人。上一批 61 张「白底机娘」里
混着纯机体、3D 概念图、带背景的场景图；如果直接拿去训，风格会互相拉扯
（已经踩过一次：饱和度双峰 → LoRA 只会学成去饱和）。

三把尺子：
  1. 人体信号   body score ≥3（tag 层面，规则同 filter_candidates.py）
  2. 画风同质度 组内两两余弦的中位数。越低说明这批图本身不是一个画风，
                单 LoRA 学不动，得拆源或重采。
  3. 与目标簇的距离  每张到本数据集质心的余弦，低于 p10 的直接列出来人眼复核。

用法：
  .venv/bin/python scripts_and_tools/anchor_audit.py --dataset mecha_core_anchor
  .venv/bin/python scripts_and_tools/anchor_audit.py --dataset mecha_core_anchor --json-out /tmp/a.json
"""

import argparse
import json
import sqlite3
import statistics as st
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
DB = REPO / 'data' / 'runner.sqlite'
CRITIC = 'http://127.0.0.1:8791'
NORM_H = 1024

BODY_SIGNALS = {
    'breasts', 'large_breasts', 'small_breasts', 'flat_chest', 'cleavage',
    'thighhighs', 'skirt', 'dress', 'shirt', 'bodysuit', 'leotard', 'pantyhose',
    'boots', 'gloves', 'hair_ornament', 'hairband', 'ponytail', 'twintails',
    'bangs', 'long_hair', 'short_hair', 'blush', 'looking_at_viewer', 'smile',
    'open_mouth', 'closed_mouth', 'bare_shoulders', 'navel', 'midriff',
    'collarbone', 'blue_eyes', 'red_eyes', 'green_eyes', 'yellow_eyes',
    'purple_eyes', 'ahoge', 'hair_between_eyes', 'bare_legs', 'barefoot',
}
SCENE_SIGNALS = {
    'scenery', 'no_humans', 'cityscape', 'indoors', 'outdoors', 'sky',
    'cloud', 'building', 'window', 'vehicle', 'tank_(medium)',
}


def tone(path: Path) -> dict:
    im = Image.open(path).convert('RGB')
    if im.height != NORM_H:
        im = im.resize((round(im.width * NORM_H / im.height), NORM_H), Image.LANCZOS)
    a = np.asarray(im, dtype=np.float32)
    gray = a @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    lap = (
        np.abs(4 * gray[1:-1, 1:-1] - gray[:-2, 1:-1] - gray[2:, 1:-1] - gray[1:-1, :-2] - gray[1:-1, 2:])
        ** 2
    ).mean()
    mx, mn = a.max(axis=2), a.min(axis=2)
    s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    # 定义对齐 style-anchor/profile.json：只统计 S>0.06 的像素，否则白底会把均值稀释掉
    sat = float(s[s > 0.06].mean()) if (s > 0.06).any() else 0.0
    corners = np.concatenate([mx[:40, :40].ravel(), mx[:40, -40:].ravel(), mx[-40:, :40].ravel(), mx[-40:, -40:].ravel()])
    return {
        'lap_var': float(lap),
        'sat': sat,
        'aspect': im.width / im.height,
        'corner_white': float((corners >= 250).mean()),
    }


def embed(path: Path) -> np.ndarray:
    body = json.dumps({'path': str(path)}).encode()
    req = urllib.request.Request(
        f'{CRITIC}/embed', data=body, headers={'content-type': 'application/json'}, method='POST'
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.loads(r.read())
    if not d.get('ok'):
        raise RuntimeError(f'embed 失败 {path}: {d}')
    v = np.asarray(d['styleVec'], dtype=np.float64)
    return v / (np.linalg.norm(v) or 1.0)


def dataset_rows(name: str) -> list[dict]:
    with urllib.request.urlopen('http://127.0.0.1:8787/datasets', timeout=30) as r:
        d = json.loads(r.read())
    hit = next((x for x in d['datasets'] if x['name'] == name), None)
    if not hit:
        raise SystemExit(f'找不到数据集 {name}')
    db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    out = []
    for i in hit['assetIds']:
        r = db.execute(
            'select id, processed_path p, original_path o, tags_json, processed_width w, processed_height h from image_assets where id=?',
            (i,),
        ).fetchone()
        if not r:
            continue
        p = REPO / 'data' / (r['p'] or r['o'] or '')
        if not r['p'] and not r['o']:
            continue
        if not p.exists():
            out.append({'id': r['id'], 'path': str(p), 'missing': True})
            continue
        try:
            tags = json.loads(r['tags_json']) if r['tags_json'] else {}
        except Exception:
            tags = {}
        names = set()
        if isinstance(tags, list):
            names = {str(x) for x in tags}
        elif isinstance(tags, dict):
            # 两种历史结构：{tag: score} 或 {general:[...], character:[...]}
            if any(isinstance(v, list) for v in tags.values()):
                for v in tags.values():
                    if isinstance(v, list):
                        names |= {str(x) for x in v}
            else:
                names = set(tags.keys())
        names = {n.lower().replace(' ', '_') for n in names}
        t = tone(p)
        out.append({'id': r['id'], 'path': str(p), 'tags': sorted(names), **t})
    db.close()
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--dataset', required=True)
    ap.add_argument('--min-body', type=int, default=3)
    ap.add_argument('--json-out', default='')
    args = ap.parse_args()

    rows = [r for r in dataset_rows(args.dataset) if not r.get('missing')]
    print(f'{args.dataset}: {len(rows)} 张（{len(dataset_rows(args.dataset)) - len(rows)} 张文件缺失已跳过）')

    vecs = []
    for r in rows:
        r['body'] = len(set(r['tags']) & BODY_SIGNALS)
        r['scene'] = sorted(set(r['tags']) & SCENE_SIGNALS)
        vecs.append(embed(Path(r['path'])))
        print(f"  {r['id']}  body={r['body']:2d}  scene={','.join(r['scene']) or '-':24s} lap={r['lap_var']:6.0f} sat={r['sat']:.3f}")

    M = np.stack(vecs)
    S = M @ M.T
    off = S[~np.eye(len(rows), dtype=bool)]
    c = np.mean(M, axis=0)
    c /= np.linalg.norm(c) or 1
    dist = M @ c
    for r, d in zip(rows, dist):
        r['cos_centroid'] = round(float(d), 4)

    body_pass = [r for r in rows if r['body'] >= args.min_body]
    clean = [r for r in rows if r['body'] >= args.min_body and not r['scene']]
    p10 = np.percentile(dist, 10)
    low = sorted(rows, key=lambda r: r['cos_centroid'])[: max(1, len(rows) // 10)]

    rep = [f'# anchor 池体检：{args.dataset}\n',
           f'共 {len(rows)} 张\n',
           f'- 人体信号 ≥{args.min_body}：{len(body_pass)} 张（{len(body_pass)/len(rows):.0%}）',
           f'- 再加「无场景标签」：{len(clean)} 张（{len(clean)/len(rows):.0%}）',
           f'- 组内两两余弦：中位 {st.median(off):.3f}／p10 {np.percentile(off,10):.3f}／p90 {np.percentile(off,90):.3f}',
           f'- 到质心余弦：中位 {st.median(dist):.3f}／最低 {dist.min():.3f}（p10={p10:.3f}）',
           '',
           '## 离质心最远的 10%（人眼复核用）', '']
    for r in low:
        rep.append(f"- `{r['id']}` cos={r['cos_centroid']:.3f} body={r['body']} lap={r['lap_var']:.0f} sat={r['sat']:.3f}")
    rep.append('')
    rep.append('## 无人体信号（tag 层面就是纯机甲）')
    rep.append('')
    rep += [f"- `{r['id']}` body={r['body']}" for r in rows if r['body'] < args.min_body] or ['- 无']
    text = '\n'.join(rep)
    print('\n' + text)
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(rows, ensure_ascii=False, indent=1))
        print(f'\n-> {args.json_out}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
