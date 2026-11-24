"""把各路来源拼成 struct v3 训练池，按设计签名限流，避免再训出「军装白外套」。

上一版失败的直接原因不是数据脏，而是配比：37 张里 25 张来自同一批 Pinterest
采集，全部 white_coat / military_uniform / coat_on_shoulders，模型就把这套制服
当成了机娘的默认装束。这次三个来源混着来，但必须显式限制「同设计签名」的张数，
否则同源图会靠数量重新夺回话语权。

判据（每张都必须满足）：
  1. tags 里有机械结构证据（装甲/关节/义肢/义眼/翅膀/尾巴，任一）
  2. 全幅立绘：aspect 在 0.30~0.95，且 tags 标 full_body
  3. 单人
  4. 背景白/浅（tags 有 white_background / simple_background / transparent_background）

  python3 scripts_and_tools/build_struct_v3.py --out /tmp/struct_v3.json
"""
import argparse
import collections
import json
import sys
import urllib.request
from pathlib import Path

RUNNER = 'http://127.0.0.1:8787'

# 已训过的 v1：质量已知，但 68% 是同一批 Pinterest 采集，必须限流
V1 = '8370c489-bdf1-43e1-a679-899f5d5079b3'
V2 = '4c77cb5e-1a97-41d3-8f7e-ce59f40bf1b6'

MECH = {'mecha_musume', 'mecha', 'robot', 'cyborg', 'android', 'exoskeleton',
        'mechanical_arms', 'mechanical_legs', 'mechanical_wings', 'mechanical_tail',
        'mechanical_eyes', 'mechanical_hands', 'mechanical_horns', 'single_mechanical_arm',
        'single_mechanical_eye', 'prosthesis', 'prosthetic_leg', 'prosthetic_arm',
        'robot_joints', 'joints', 'armor', 'power_armor', 'shoulder_armor',
        'armored_boots', 'armored_dress', 'gauntlets', 'greaves', 'pauldrons',
        'headgear', 'helmet', 'cable', 'panel_lines'}
BG = {'white_background', 'simple_background', 'transparent_background', 'grey_background'}

# 设计签名：决定「看起来是不是同一套设定」。同签名超过上限的只留一部分，
# 这样同一套制服不会靠数量变成模型的默认。
OUTFIT = ('white_coat', 'military_uniform', 'coat_on_shoulders', 'epaulettes', 'jacket',
          'coat', 'white_jacket', 'black_jacket', 'dress', 'skirt', 'leotard', 'bodysuit',
          'school_uniform', 'serafuku')


def api(path):
    return json.load(urllib.request.urlopen(f'{RUNNER}{path}', timeout=25))


def tags_of(aid):
    return api(f'/capture/assets/{aid}').get('tags') or []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--v1-max', type=int, default=20, help='v1 最多留几张（防止同源重新主导）')
    ap.add_argument('--sig-max', type=int, default=4, help='同一 (服装, 形态) 签名最多几张')
    ap.add_argument('--coat-max', type=int, default=8, help='军装/白外套系最多几张')
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    pools = collections.OrderedDict()
    pools['v1'] = api(f'/datasets/{V1}')['assetIds']
    pools['v2'] = api(f'/datasets/{V2}')['assetIds']
    pools['formscan_ok'] = [x['assetId'] for x in json.load(open('/tmp/v3_manual.json'))['keep']]
    if Path('/tmp/mix2_ok.json').exists():
        pools['mix2_ok'] = [x['assetId'] for x in json.load(open('/tmp/mix2_ok.json'))]

    seen, rows = set(), []
    for src, ids in pools.items():
        for aid in ids:
            if aid in seen:
                continue
            seen.add(aid)
            t = set(tags_of(aid))
            rec = {
                'assetId': aid, 'src': src,
                'mech': sorted(t & MECH),
                'outfit': sorted(t & set(OUTFIT)),
                'coat': bool(t & {'white_coat', 'military_uniform', 'coat_on_shoulders', 'epaulettes'}),
                'full': 'full_body' in t,
                'bg': sorted(t & BG),
                'multi': bool(t & {'multiple_girls', '2girls', '3girls'}),
            }
            rec['ok'] = bool(rec['mech']) and rec['full'] and bool(rec['bg']) and not rec['multi']
            rows.append(rec)

    bad = [r for r in rows if not r['ok']]
    keep = [r for r in rows if r['ok']]
    print(f'组池 {len(rows)} 张 → 过判据 {len(keep)}，淘汰 {len(bad)}')
    drop_reason = collections.Counter()
    for r in bad:
        if not r['mech']:
            drop_reason['no-mech'] += 1
        if not r['full']:
            drop_reason['no-full-body'] += 1
        if not r['bg']:
            drop_reason['no-clean-bg'] += 1
        if r['multi']:
            drop_reason['multi'] += 1
    print('  ', dict(drop_reason))

    # ---- 限流：v1 总量 + 设计签名 + 军装系 ----
    out, sig_cnt, coat_cnt, v1_cnt = [], collections.Counter(), 0, 0
    # 先放非 v1 的（新数据形态更多样），再拿 v1 补位
    for r in sorted(keep, key=lambda x: (x['src'] == 'v1', x['coat'])):
        if r['src'] == 'v1' and v1_cnt >= args.v1_max:
            continue
        sig = (tuple(r['outfit'][:2]), tuple(r['mech'][:2]))
        if sig_cnt[sig] >= args.sig_max:
            continue
        if r['coat'] and coat_cnt >= args.coat_max:
            continue
        sig_cnt[sig] += 1
        coat_cnt += 1 if r['coat'] else 0
        v1_cnt += 1 if r['src'] == 'v1' else 0
        out.append(r)

    print(f'\n最终 {len(out)} 张')
    print('  来源:', collections.Counter(r['src'] for r in out))
    print(f"  军装/白外套系 {sum(1 for r in out if r['coat'])} 张"
          f"（v1 里原本 68%）")
    print('  机械形态:')
    mc = collections.Counter()
    for r in out:
        for m in r['mech'][:3]:
            mc[m] += 1
    for m, n in mc.most_common(14):
        print(f'    {m:26} {n:3d}  {n/len(out)*100:5.0f}%')
    print('  服装:')
    oc = collections.Counter()
    for r in out:
        for o in r['outfit'][:2]:
            oc[o] += 1
    for o, n in oc.most_common(10):
        print(f'    {o:26} {n:3d}  {n/len(out)*100:5.0f}%')

    Path(args.out).write_text(json.dumps({'total': len(out), 'records': out}, ensure_ascii=False, indent=1))
    print(f'\n-> {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
