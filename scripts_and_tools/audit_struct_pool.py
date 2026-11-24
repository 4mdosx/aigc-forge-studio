"""对 struct 候选池做自动体检，把「被裁 / 背景脏 / 机械密度低」筛出来。

为什么需要：目检缩略图判断不了细节 —— 一张 176px 宽的缩略图看不出背景是
纯白还是带淡淡渐变，也看不出脚是不是切掉了一点点。上一版 struct LoRA 长
出「军装白外套 + 机械义肢」就是因为 68% 的训练图来自同一批，而这次要防的
是另一种失败：形态配额对了，但混进了复杂背景或 3D 渲染。

  python3 scripts_and_tools/audit_struct_pool.py --ingested data/capture/mecha-formscan/ingested-v3.json
  python3 scripts_and_tools/audit_struct_pool.py --dataset <id> --json out.json

判定口径：
  crop      frame_fit 的 verdict（crop_* 直接不合格）
  bg       边框环带的亮度中位 + 标准差。白底要 ≥232 且 std ≤ 11；
           灰底允许 195~232。std 大说明背景有场景/渐变/水印
  mecha    tags 里强机械词的数量（与 select_struct_mix 的 STRONG 一致）
"""
import argparse
import json
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from frame_fit import analyze  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
API = 'http://127.0.0.1:8787'

STRONG = {'prosthetic_leg', 'mechanical_legs', 'prosthetic_arm', 'mechanical_arms',
          'single_mechanical_arm', 'power_armor', 'exoskeleton', 'mechanical_wings',
          'mechanical_tail', 'mechanical_eyes', 'robot_joints', 'cyborg', 'prosthesis'}


def api(path):
    return json.load(urllib.request.urlopen(f'{API}{path}', timeout=20))


def border_stats(path: Path) -> dict:
    """边框环带的亮度统计。背景越脏，std 越大、亮度的下尾越低。"""
    im = Image.open(path).convert('RGB')
    a = np.asarray(im).astype(np.float32)
    h, w, _ = a.shape
    k = max(3, min(h, w) // 25)
    ring = np.concatenate([
        a[:k, :].reshape(-1, 3), a[-k:, :].reshape(-1, 3),
        a[:, :k].reshape(-1, 3), a[:, -k:].reshape(-1, 3),
    ])
    lum = ring.mean(axis=1)
    return {
        'bg_lum': float(np.median(lum)),
        'bg_std': float(lum.std()),
        'bg_p05': float(np.percentile(lum, 5)),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ingested', help='ingest_candidates 产出的 records 文件')
    ap.add_argument('--dataset', help='从 runner 数据集取 assetIds')
    ap.add_argument('--json', help='把明细写成 json')
    ap.add_argument('--only-bad', action='store_true')
    args = ap.parse_args()

    asset_ids, post_of, tags_of = [], {}, {}
    if args.dataset:
        asset_ids = api(f'/datasets/{args.dataset}')['assetIds']
    if args.ingested:
        for r in json.loads(Path(args.ingested).read_text())['records']:
            asset_ids.append(r['assetId'])
            post_of[r['assetId']] = r['post']

    rows = []
    for aid in asset_ids:
        try:
            d = api(f'/capture/assets/{aid}')
        except Exception as e:
            rows.append({'assetId': aid, 'error': f'api {e}'})
            continue
        h = (d.get('original') or {}).get('hash') or ''
        # status=collected 的资产只有 original.*，processed.png 要等流水线。
        # 体检只关心构图和背景，用原图判断不会引入偏差。
        base = ROOT / 'data' / 'capture' / 'raw' / h
        p = base / 'processed.png'
        if not p.exists():
            cands = sorted(base.glob('original.*')) if base.is_dir() else []
            if not cands:
                rows.append({'assetId': aid, 'error': 'no image file'})
                continue
            p = cands[0]
        tags = d.get('tags') or []
        try:
            fit = analyze(p)
            bg = border_stats(p)
        except Exception as e:
            rows.append({'assetId': aid, 'error': str(e)})
            continue

        verdict = fit.get('verdict', 'err')
        mecha = sum(1 for t in tags if t in STRONG)
        bad = []
        if verdict.startswith('crop'):
            bad.append(verdict)
        if bg['bg_std'] > 16:
            bad.append('bg-noisy')
        elif bg['bg_lum'] < 190:
            bad.append('bg-dark')
        if mecha == 0:
            bad.append('no-mecha')
        rows.append({
            'assetId': aid,
            'post': post_of.get(aid, ''),
            'artist': next((t for t in tags if t in d.get('note', '')), ''),
            'note': d.get('note', ''),
            'verdict': verdict,
            'fill_pct': fit.get('fill_pct'),
            'top': fit.get('top'), 'bottom': fit.get('bottom'),
            'bg_lum': round(bg['bg_lum'], 1),
            'bg_std': round(bg['bg_std'], 1),
            'mecha': mecha,
            'bad': ','.join(bad),
        })

    good = [r for r in rows if not r.get('bad') and not r.get('error')]
    bad = [r for r in rows if r.get('bad')]
    err = [r for r in rows if r.get('error')]

    print(f'共 {len(rows)} 张：合格 {len(good)}，有问题 {len(bad)}，读取失败 {len(err)}')
    print(f"\n{'fill%':>6} {'bottom':>6} {'bgL':>5} {'bgS':>5} {'mech':>4}  判定")
    for r in sorted(rows, key=lambda x: (x.get('bad') or 'zz')):
        if args.only_bad and not r.get('bad'):
            continue
        if r.get('error'):
            print(f"{'':6} {'':6} {'':5} {'':5} {'':4}  {r['assetId']} ERR {r['error']}")
            continue
        print(f"{r['fill_pct']:6.1f} {r['bottom']:6.3f} {r['bg_lum']:5.0f} {r['bg_std']:5.1f} "
              f"{r['mecha']:4d}  {r['assetId']:22} {r['bad'] or 'ok'}")

    if args.json:
        Path(args.json).write_text(json.dumps(rows, ensure_ascii=False, indent=1))
        print(f'\n-> {args.json}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
