#!/usr/bin/env python3
"""budget_captions_generic.py — 通用 caption 预算重排，不绑定某一批数据。

与 budget_captions.py 的分工：那个是 ohou 兔女郎酒吧那一批专用的（风格段是手写白名单、
DROP 表针对 explicit 词条），改它会把旧实验的口径一起改掉。这个脚本只依赖一条原则，
换任何数据集都能用：

  **caption 里留下的 tag 可以由 prompt 控制；被挤掉（截断）的 tag 会被 LoRA 当成默认。**

所以排序不该按置信度，也不该按语义桶，而该按**信息量**：一张图独有的 tag（罕见词）
说明的是这张图的个性，值得花 token 解释掉；在 40 张里出现 40 次的 tag（`1girl`、
`white_background`）没有区分度，留在尾部让它被截掉，正好沉进 LoRA 的先验里 ——
我们要的质感就是这样被「剩下的残差」学到的。

排序：按语料内文档频率升序（越罕见越靠前），同频按原始顺序。这与 budget_captions.py
的语义桶排序不同，那套是为「想让构图进权重」设计的，与本脚本目标相反。

丢弃：画师名 / 水印 / 站点 / 画质 / 元信息。这些既不是内容也不是风格，留着只会烧 token。

用法：
  .venv/bin/python scripts_and_tools/budget_captions_generic.py \
      --dir data/training-export/gloss_train/img \
      --out data/training-export/gloss_train_b/img --limit 75

  # 只审计不写盘
  .venv/bin/python scripts_and_tools/budget_captions_generic.py --dir <目录> --dry
"""

from __future__ import annotations

import argparse
import shutil
import statistics as st
from collections import Counter
from pathlib import Path

from transformers import CLIPTokenizer

DROP = {
    # 画师 / 水印 / 站点
    'artist_name', 'watermark', 'signature', 'username', 'text', 'web_address',
    'english_commentary', 'commentary', 'commentary_request', 'translated',
    'artist_logo', 'logo', 'dated', 'twitter_username', 'patreon_username',
    'pixiv_username', 'character_name', 'copyright_name', 'bad_id',
    'bad_pixiv_id', 'bad_twitter_id', 'bad_deviantart_id',
    # 画质 / 元信息：LoRA 会把它们学成默认值，没必要写在 caption 里占位置
    'lowres', 'highres', 'absurdres', 'worst_quality', 'low_quality',
    'blurry', 'jpeg_artifacts', 'error', 'official_art', 'game_cg',
    'variant_set', 'multiple_views', 'reference_sheet', 'character_sheet',
    'back-to-back', 'split_screen', 'collage',
    # 站点/评级
    'general', 'sensitive', 'questionable', 'explicit',
}

# 风格描述词必须删。写进 caption 等于告诉模型「这层光泽是这句话造成的」，
# 模型就不必把它编进权重 —— 而质感 LoRA 要的正是把它编进去。
# 留下的是「内容」，被解释掉的越干净，LoRA 学到的残差就越纯粹是画法。
STYLE_DROP = {
    'shiny_clothes', 'shiny_skin', 'shiny_legwear', 'glossy', 'wet', 'sweat',
    'realistic', 'semi-realistic', 'photorealistic', 'blurry_background',
    'blurry', 'shadow', 'depth_of_field', 'bloom', 'lens_flare',
    'chromatic_aberration', 'motion_blur',
}

# 上位概念：同一条 caption 里已有更具体的词时删掉它，省 token
GENERIC_PARENTS = (
    'thighhighs', 'pantyhose', 'gloves', 'boots', 'heels', 'dress', 'skirt',
    'shirt', 'coat', 'jacket', 'leotard', 'bodysuit', 'bikini', 'bra',
    'panties', 'earrings', 'necklace', 'choker', 'collar', 'ribbon', 'bow',
    'hair_ornament', 'weapon', 'sword', 'tail', 'ears',
)

# 分桶：先保证「能被 prompt 控制」的组别拿到 token，再往里填细节。
# 桶序不是审美选择——入画范围/姿态/身份/服装这四组若被截断，就会被 LoRA 当成默认，
# 应用在题材不同的图上时会出现「换不掉」的构图和发色。
COMPOSITION = {
    'full_body', 'upper_body', 'cowboy_shot', 'close-up', 'portrait', 'standing',
    'sitting', 'lying', 'kneeling', 'on_back', 'on_stomach', 'on_side',
    'crossed_legs', 'legs_up', 'knee_up', 'feet_out_of_frame', 'head_out_of_frame',
    'from_above', 'from_below', 'from_side', 'from_behind', 'dutch_angle',
    'looking_at_viewer', 'looking_back', 'looking_away', 'eye_contact',
    'spread_legs', 'arms_up', 'hand_up', 'tiptoes', 'invisible_chair',
    'wariza', 'all_fours', 'crouching', 'squatting', 'seiza', 'split',
}
SCENE = {
    'white_background', 'simple_background', 'grey_background', 'black_background',
    'gradient_background', 'colored_background', 'indoors', 'outdoors', 'night',
    'bedroom', 'pool', 'poolside', 'onsen', 'bar_(place)', 'casino', 'city',
    'beach', 'sky', 'cloud', 'water', 'curtain', 'window', 'bed', 'chair',
    'couch', 'sofa', 'pillow', 'shadow',
}
PROP = {
    'holding', 'food', 'drink', 'cup', 'glass', 'bottle', 'towel', 'umbrella',
    'phone', 'book', 'fruit', 'bread', 'cake', 'ice_cream',
}
APPEARANCE_KEYS = (
    'hair', 'eyes', 'eye', 'bangs', 'sidelocks', 'ahoge', 'twintails', 'braid',
    'ponytail', 'bun', 'hime_cut', 'skin', 'ears', 'tail', 'horn', 'fang',
    'mole', 'freckles', 'makeup', 'lips', 'eyebrows', 'eyelashes',
    '1girl', '1boy', 'solo', 'multiple_girls', '2girls', 'elf', 'monster_girl',
    'pointy_ears', 'animal_ears', 'cat_ears', 'fox_ears', 'rabbit_ears',
)
# 体型词排在服装之后：这批图尺度差异大，体型若被截断会沉进先验 —— 对本项目
# 目标（用韩系人体把尺度顶上去）反而是可接受的，牺牲优先级最低。
BODY_KEYS = (
    'breasts', 'cleavage', 'navel', 'midriff', 'collarbone', 'thighs', 'hips',
    'waist', 'curvy', 'wide_hips', 'skinny', 'muscular', 'stomach',
)
OUTFIT_KEYS = (
    'dress', 'skirt', 'shirt', 'sweater', 'hoodie', 'coat', 'jacket', 'cloak',
    'kimono', 'leotard', 'bodysuit', 'bodystocking', 'bikini', 'bra', 'panties',
    'underwear', 'shorts', 'pants', 'jeans', 'socks', 'stockings', 'thighhigh',
    'pantyhose', 'garter', 'boots', 'heels', 'shoes', 'sandals', 'gloves',
    'sleeves', 'collar', 'choker', 'necklace', 'earrings', 'bracelet', 'ring',
    'hair_ornament', 'hairband', 'ribbon', 'bow', 'belt', 'strap', 'harness',
    'armor', 'uniform', 'suit', 'swimsuit', 'apron', 'scarf', 'hat', 'cap',
    'crop_top', 'top', 'outfit', 'clothes', 'clothing', 'corset', 'train',
    'veil', 'frills', 'trim', 'print', 'pattern', 'lace', 'zipper', 'pocket',
)


def bucket_of(tag: str) -> int:
    if tag in COMPOSITION:
        return 0
    if any(k in tag for k in APPEARANCE_KEYS):
        return 1
    if any(tag == k or tag.endswith('_' + k) or tag.startswith(k + '_') for k in OUTFIT_KEYS):
        return 2
    if any(k in tag for k in BODY_KEYS):
        return 3
    if tag in PROP or any(k in tag for k in ('holding_', 'food', 'drink')):
        return 4
    if tag in SCENE:
        return 5
    return 6



def cap_family(tags: list[str], max_per_head: int = 2) -> list[str]:
    """同一件衣服常被 WD14 拆成 4-6 个 tag（white_sweater / ribbed_sweater /
    turtleneck_sweater / sweater_dress / sweater / turtleneck）。同族超过上限时
    只留修饰词最多的几个 —— 这是最不痛的一刀：删掉的是同一件衣服的别名，
    而不是某个信息维度。"""
    fam: dict[str, list[str]] = {}
    for t in tags:
        fam.setdefault(t.split('_')[-1], []).append(t)
    drop: set[str] = set()
    for head, items in fam.items():
        if head not in OUTFIT_KEYS or len(items) <= max_per_head:
            continue
        ranked = sorted(items, key=lambda t: (-len(t.split('_')), t))
        drop |= set(ranked[max_per_head:])
    return [t for t in tags if t not in drop]


def load_pairs(root: Path) -> list[tuple[Path, list[str]]]:
    pairs = []
    for txt in sorted(root.glob('*.txt')):
        raw = txt.read_text(encoding='utf-8').strip().rstrip(',')
        tags = [t.strip() for t in raw.split(',') if t.strip()]
        pairs.append((txt, tags))
    return pairs


def collapse(tags: list[str]) -> list[str]:
    """有 black_thighhighs 就删 thighhighs，避免上位概念白占 token。"""
    kept = []
    for t in tags:
        if t in GENERIC_PARENTS and any(o != t and o.endswith('_' + t) for o in tags):
            continue
        kept.append(t)
    return kept


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', required=True)
    ap.add_argument('--out', default='')
    ap.add_argument('--limit', type=int, default=75)
    ap.add_argument('--dry', action='store_true')
    args = ap.parse_args()

    root = Path(args.dir)
    pairs = load_pairs(root)
    if not pairs:
        raise SystemExit(f'{root} 下没有 .txt')

    tok = CLIPTokenizer.from_pretrained('openai/clip-vit-large-patch14')

    def ntok(s: str) -> int:
        return len(tok(s, truncation=False)['input_ids']) - 2

    cleaned = []
    for path, tags in pairs:
        tags = [t for t in tags if t not in DROP and t not in STYLE_DROP]
        tags = collapse(tags)
        tags = cap_family(tags)
        cleaned.append((path, tags))

    df = Counter()
    for _, tags in cleaned:
        df.update(set(tags))
    n = len(cleaned)

    out = []
    for path, tags in cleaned:
        # 桶序优先，桶内按文档频率升序（具体词先于上位词），同频保持原顺序
        order = sorted(range(len(tags)), key=lambda i: (bucket_of(tags[i]), df[tags[i]], i))
        ordered = [tags[i] for i in order]
        kept, dropped = [], []
        for t in ordered:
            trial = kept + [t]
            if ntok(', '.join(trial)) <= args.limit:
                kept.append(t)
            else:
                dropped.append(t)
        out.append((path, kept, dropped, ntok(', '.join(kept))))

    lens = [x[3] for x in out]
    print(f'{n} 张 | token 中位 {st.median(lens):.0f} 最大 {max(lens)} 最小 {min(lens)}')
    print(f'被挤掉的 tag 平均 {st.mean(len(x[2]) for x in out):.1f} 个/张')
    const = sorted([t for t, c in df.items() if c == n])
    print(f'全语料恒定 tag（会被沉进 LoRA 先验）：{", ".join(const) or "无"}')

    if args.dry:
        for path, kept, dropped, ln in out[:3]:
            print(f'\n{path.stem}  {ln} tok')
            print('  keep:', ', '.join(kept))
            print('  drop:', ', '.join(dropped))
        return 0

    dest = Path(args.out) if args.out else root.parent / (root.parent.name + '_b') / 'img'
    dest.mkdir(parents=True, exist_ok=True)
    for path, kept, dropped, ln in out:
        img = path.with_suffix('.png')
        if img.exists():
            shutil.copy2(img, dest / img.name)
        (dest / (path.stem + '.txt')).write_text(', '.join(kept) + ',', encoding='utf-8')
    print(f'-> {dest}（{len(out)} 组）')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
