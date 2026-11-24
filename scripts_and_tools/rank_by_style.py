"""按「已确认合格的图」的画风质心给候选排序，把 3D 渲染/欧美卡通/机甲图排掉。

为什么不能靠 tag：上一次目检 69 张，判掉 31 张，其中一半是 tag 判不出来的 ——
`armor` 同时标在「白底机娘立绘」和「欧美 3D 概念渲染」上；`white_background`
也会标在带淡渐变场景的图上。tag 描述的是内容，不是画法。

DINOv3 CLS 向量能分开这两者（详见项目记忆里「tag 判不出二次元立绘 vs 3D 概念渲染，
只有余弦能」）。所以用一批人工确认合格的图算质心，候选按余弦排序，目检只看排在前面的。

  python3 scripts_and_tools/rank_by_style.py \
      --refs /tmp/v3_manual.json:keep --target-assets /tmp/cand_ids.json \
      --out /tmp/ranked.json

refs 支持三种来源：
  --refs <json>:keep            audit/manual 结果里的 keep 数组
  --refs dataset:<id>           runner 数据集
  --refs assets:a,b,c           assetId 列表
"""
import argparse
import json
import sys
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
RUNNER = 'http://127.0.0.1:8787'
CRITIC = 'http://127.0.0.1:8791'
CACHE = Path('/tmp/style_vec_cache.json')


def post(path, body=None, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f'{CRITIC}{path}', data=data,
                                 headers={'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=timeout))


def asset_of(aid):
    return json.load(urllib.request.urlopen(f'{RUNNER}/capture/assets/{aid}', timeout=20))


def image_path(aid):
    d = asset_of(aid)
    h = (d.get('original') or {}).get('hash') or ''
    base = ROOT / 'data' / 'capture' / 'raw' / h
    for name in ('processed.png', 'original.jpg', 'original.png', 'original.webp'):
        if (base / name).exists():
            return base / name
    c = sorted(base.glob('original.*')) if base.is_dir() else []
    return c[0] if c else None


def vec_of(aid, cache):
    if aid in cache:
        return np.array(cache[aid], dtype=np.float32)
    p = image_path(aid)
    if p is None:
        return None
    r = post('/embed', {'path': str(p)})
    v = r.get('styleVec')
    if not v:
        return None
    v = np.array(v, dtype=np.float32)
    v /= (np.linalg.norm(v) + 1e-9)
    cache[aid] = v.tolist()
    return v


def load_refs(spec):
    if spec.startswith('dataset:'):
        return json.load(urllib.request.urlopen(
            f'{RUNNER}/datasets/{spec.split(":", 1)[1]}', timeout=20))['assetIds']
    if spec.startswith('assets:'):
        return [x for x in spec.split(':', 1)[1].split(',') if x]
    path, _, key = spec.partition(':')
    d = json.loads(Path(path).read_text())
    if key and key in d:
        d = d[key]
    if isinstance(d, list) and d and isinstance(d[0], dict):
        return [x['assetId'] for x in d]
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--refs', required=True, help='合格参照集')
    ap.add_argument('--targets', nargs='+', default=[], help='audit json 路径，取其中的 assetId')
    ap.add_argument('--out', required=True)
    ap.add_argument('--top', type=int, default=0, help='只输出前 N 个')
    args = ap.parse_args()

    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    refs = load_refs(args.refs)
    print(f'参照集 {len(refs)} 张')

    # 归一化后取质心，再归一化 —— 否则长尾图会把质心拉偏
    rv = []
    for i, a in enumerate(refs):
        v = vec_of(a, cache)
        if v is not None:
            rv.append(v)
        if (i + 1) % 10 == 0:
            print(f'  ref {i+1}/{len(refs)}', flush=True)
    if not rv:
        print('参照集一张也算不出来，放弃')
        return 1
    M = np.stack(rv)
    centroid = M.mean(axis=0)
    centroid /= np.linalg.norm(centroid) + 1e-9
    # 参照集内部一致度：太低说明「合格」这批本身不同质，排序意义会打折
    inner = (M @ centroid)
    print(f'参照集与质心的余弦：中位 {np.median(inner):.3f}  最低 {inner.min():.3f}')

    targets = []
    for p in args.targets:
        d = json.loads(Path(p).read_text())
        for r in d:
            if r.get('assetId') and not r.get('error'):
                targets.append(r['assetId'])
    targets = [t for t in targets if t not in set(refs)]
    print(f'待排序 {len(targets)} 张')

    rows = []
    for i, a in enumerate(targets):
        v = vec_of(a, cache)
        if v is None:
            continue
        rows.append({'assetId': a, 'cos': float(v @ centroid)})
        if (i + 1) % 25 == 0:
            print(f'  target {i+1}/{len(targets)}', flush=True)

    rows.sort(key=lambda r: -r['cos'])
    CACHE.write_text(json.dumps(cache))
    if args.top:
        rows = rows[:args.top]
    Path(args.out).write_text(json.dumps(rows, ensure_ascii=False, indent=1))

    cs = [r['cos'] for r in rows]
    print(f'\n余弦分布：最高 {cs[0]:.3f}  中位 {np.median(cs):.3f}  最低 {cs[-1]:.3f}')
    for q in (0.9, 0.75, 0.5, 0.25):
        print(f'  {int(q*100):>3}% 分位 {np.quantile(cs, q):.3f}')
    print(f'-> {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
