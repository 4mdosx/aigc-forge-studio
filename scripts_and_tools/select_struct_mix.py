"""按机械形态配额从候选池里挑选 struct 训练集。

为什么需要它：struct LoRA 上一版（37 张）长出「军装白外套 + 机械义肢腿」，
根因不是 IP 太少，而是形态与服装过度集中 —— mechanical_arms 占 51%、
mechanical_legs 35%、power_armor 只有 1 张、exoskeleton 0 张。模型的默认
输出就是训练集的众数，所以配比必须当成一等公民来管理。

  python3 scripts_and_tools/select_struct_mix.py \
      --candidates data/capture/mecha-tagscan/candidates-danbooru.json \
                   data/capture/mecha-formscan/candidates-danbooru.json \
      --total 70 --out /tmp/struct_v3.json

筛选口径：
  硬条件   full_body + 单人 + 白/简单/透明底 + rating g（keep() 已保证 1girl）
  形态桶   arms / legs / armor / wings / tail / eyes / joints / other
  配额     按 --quota 的权重分配，桶内按 score 降序
  去重     同画师最多 --max-per-artist 张；同 (画师, 角色) 只留 score 最高的

输出 JSON：选中的 danbooru post id + 每条命中的形态桶 + 配比报告，供
ingest_candidates.py --posts 或数据集接口使用。
"""
import argparse
import collections
import json
import sys
from pathlib import Path

# 形态桶。一个 tag 可以进多个桶（比如 robot_joints 既算 joints 也算 armor 的结构证据），
# 但每条图最终只归到「最强」的那个桶，避免配额被重复计数。
FORM_BUCKETS = {
    'legs': ['prosthetic_leg', 'mechanical_legs', 'artificial_leg', 'mechanical_feet'],
    'arms': ['prosthetic_arm', 'mechanical_arms', 'mechanical_hands', 'single_mechanical_arm',
             'extra_arms', 'multiple_arms'],
    'armor': ['power_armor', 'exoskeleton', 'armor', 'shoulder_armor', 'armored_boots',
              'armored_dress', 'gauntlets', 'greaves', 'pauldrons', 'helmet', 'battle_armor'],
    'wings': ['mechanical_wings', 'wings'],
    'tail': ['mechanical_tail'],
    'eyes': ['mechanical_eyes', 'cybernetic_eyes', 'robot_eyes', 'single_mechanical_eye'],
    'joints': ['robot_joints', 'joints', 'panel_lines', 'cyborg', 'mecha_musume',
               'science_fiction', 'mechanical_horns', 'prosthesis'],
}

# 强度：命中这些词的图算「机械密度高」，优先于只有 science_fiction 的
STRONG = {'prosthetic_leg', 'mechanical_legs', 'prosthetic_arm', 'mechanical_arms',
          'single_mechanical_arm', 'power_armor', 'exoskeleton', 'mechanical_wings',
          'mechanical_tail', 'mechanical_eyes', 'robot_joints', 'cyborg', 'prosthesis'}

# 服装过度集中的信号。上一版三分之二是这批，模型学会了「白外套 = 机娘默认装」
OVERUSED_OUTFIT = {'white_coat', 'military_uniform', 'coat_on_shoulders', 'epaulettes'}

BG_OK = {'white_background', 'simple_background', 'transparent_background', 'grey_background'}

# 形态导向采样（power_armor / exoskeleton）会把欧美游戏与萝卜 IP 拉进来：
# 这些不是「日系机娘立绘」，是另一个物种，混进 struct 会把画风往 3D/卡通拽。
BAD_COPYRIGHT = {
    'my_life_as_a_teenage_robot', 'elden_ring', 'mega_man_(series)', 'marvel_vs._capcom',
    'metroid', 'warhammer_40k', 'gundam', 'transformers', 'overwatch', 'star_wars',
    'cyberpunk_2077', 'dark_souls_(series)', 'bloodborne', 'destiny_(game)',
    'horizon_(series)', 'halo_(series)', 'starcraft', 'diablo',
}
BAD_CHARACTER = {
    'jenny_wakeman', 'malenia_blade_of_miquella', 'hyper_roll_(marvel_vs._capcom)',
}


def load_items(paths):
    items = {}
    for p in paths:
        d = json.loads(Path(p).read_text())
        for it in d.get('items', []):
            items[str(it['id'])] = it
    return items


def form_of(tags):
    """返回 (bucket, strong)。bucket 为 None 表示没有可归类的机械形态。"""
    hits = {b: [t for t in tags if t in FORM_BUCKETS[b]] for b in FORM_BUCKETS}
    hits = {b: v for b, v in hits.items() if v}
    if not hits:
        return None, False
    # 形态特异性优先：有义肢/翅膀/尾巴就说这个，不要被万能的 armor 吞掉
    for b in ('legs', 'wings', 'tail', 'eyes', 'arms', 'armor', 'joints'):
        if b in hits:
            return b, any(t in STRONG for t in hits[b])
    return None, False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--candidates', nargs='+', required=True)
    ap.add_argument('--total', type=int, default=70)
    ap.add_argument('--max-per-artist', type=int, default=4)
    ap.add_argument('--min-score', type=float, default=0, help='按 score 过滤；0 表示不过滤')
    ap.add_argument('--require-bg', action='store_true', default=True)
    ap.add_argument('--allow-overused-outfit', type=int, default=0,
                    help='允许保留多少张命中 OVERUSED_OUTFIT 的图（默认 0，把军装外套剔干净）')
    ap.add_argument('--quota', default='legs=0.20,arms=0.16,armor=0.26,wings=0.10,'
                                       'tail=0.06,eyes=0.06,joints=0.16')
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    quota = {}
    for part in args.quota.split(','):
        k, v = part.split('=')
        quota[k] = float(v)

    items = load_items(args.candidates)
    print(f'候选池 {len(items)} 条')

    # ---- 硬条件 ----
    kept, drop = [], collections.Counter()
    for it in items.values():
        tags = set((it.get('tags') or {}).get('general') or [])
        if 'full_body' not in tags:
            drop['no-full-body'] += 1
            continue
        if not (tags & BG_OK):
            drop['no-clean-bg'] += 1
            continue
        if tags & {'multiple_girls', '2girls', '6+girls'}:
            drop['multi'] += 1
            continue
        if (it.get('score') or 0) < args.min_score:
            drop['low-score'] += 1
            continue
        bucket, strong = form_of(tags)
        if bucket is None:
            drop['no-form'] += 1
            continue
        artist = ((it.get('tags') or {}).get('artist') or ['?'])[0]
        char = ((it.get('tags') or {}).get('character') or ['(unnamed)'])[0]
        cpv = ((it.get('tags') or {}).get('copyright') or ['(original)'])[0]
        if cpv in BAD_COPYRIGHT:
            drop['bad-copyright'] += 1
            continue
        if char in BAD_CHARACTER:
            drop['bad-character'] += 1
            continue
        kept.append({
            'post': str(it['id']),
            'score': it.get('score') or 0,
            'aspect': it.get('aspect'),
            'bucket': bucket,
            'strong': strong,
            'artist': artist,
            'character': char,
            'copyright': ((it.get('tags') or {}).get('copyright') or ['(original)'])[0],
            'overused': len(tags & OVERUSED_OUTFIT),
            'sampleUrl': it.get('sampleUrl'),
            'fileUrl': it.get('fileUrl'),
        })
    print(f'过筛 {len(kept)} 条  淘汰 {dict(drop)}')

    # ---- 同 (画师, 角色) 只留 score 最高 ----
    best = {}
    for r in kept:
        k = (r['artist'], r['character'])
        if k not in best or r['score'] > best[k]['score']:
            best[k] = r
    kept = list(best.values())
    print(f'同(画师,角色)去重后 {len(kept)} 条')

    # ---- 按配额贪心：每轮给「还差得最多」的桶补 1 张 ----
    by_bucket = collections.defaultdict(list)
    for r in kept:
        by_bucket[r['bucket']].append(r)
    for b in by_bucket:
        by_bucket[b].sort(key=lambda r: (-int(r['strong']), -r['score']))

    target = {b: max(1, round(args.total * w)) for b, w in quota.items()}
    picked = []
    per_artist = collections.Counter()
    used = set()
    overused_left = args.allow_overused_outfit

    def take(b):
        nonlocal overused_left
        for r in by_bucket.get(b, []):
            if r['post'] in used:
                continue
            if r['overused'] and overused_left <= 0:
                continue
            if per_artist[r['artist']] >= args.max_per_artist:
                continue
            used.add(r['post'])
            per_artist[r['artist']] += 1
            if r['overused']:
                overused_left -= 1
            picked.append(r)
            return True
        return False

    for _ in range(args.total * 3):
        if len(picked) >= args.total:
            break
        deficits = {b: target[b] - sum(1 for r in picked if r['bucket'] == b) for b in target}
        deficits = {b: d for b, d in deficits.items() if d > 0}
        if not deficits:
            break
        # 缺口比例最大的先补，避免大桶吃光名额
        b = max(deficits, key=lambda k: deficits[k] / target[k])
        if not take(b):
            target[b] = 0   # 该桶枯竭，让位给别的桶
    # 补齐：配额桶都枯竭但还没到 total，就从剩余里按 score 补
    if len(picked) < args.total:
        rest = sorted(kept, key=lambda r: -r['score'])
        for r in rest:
            if len(picked) >= args.total:
                break
            if r['post'] in used:
                continue
            if r['overused'] and overused_left <= 0:
                continue
            if per_artist[r['artist']] >= args.max_per_artist:
                continue
            used.add(r['post'])
            per_artist[r['artist']] += 1
            picked.append(r)

    # ---- 报告 ----
    n = len(picked)
    print(f'\n选中 {n} 张（目标 {args.total}）')
    print(f"\n{'桶':8} {'实际':>4} {'目标':>4} {'占比':>6}")
    for b in quota:
        c = sum(1 for r in picked if r['bucket'] == b)
        print(f'{b:8} {c:4d} {target.get(b, 0):4d} {c/max(1,n)*100:5.0f}%')
    print(f"\n画师 {len(per_artist)} 位，最集中 {per_artist.most_common(3)}")
    cp = collections.Counter(r['copyright'] for r in picked)
    print(f"原创占比 {cp['(original)']/max(1,n)*100:.0f}%，版权 Top5 {cp.most_common(5)}")
    print(f"军装外套命中 {sum(1 for r in picked if r['overused'])} 张")

    Path(args.out).write_text(json.dumps({
        'total': n,
        'posts': [r['post'] for r in picked],
        'records': picked,
        'quota': quota,
        'buckets': {b: sum(1 for r in picked if r['bucket'] == b) for b in quota},
    }, ensure_ascii=False, indent=1))
    print(f'\n-> {args.out}')


if __name__ == '__main__':
    sys.exit(main())
