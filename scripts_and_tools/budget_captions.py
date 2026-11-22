#!/usr/bin/env python3
"""budget_captions.py — 按 CLIP 75 token 预算重排训练 caption。

背景（2026-11-23 实测）：ohou19 的 19 张 caption 全部超出 CLIP-L 的 75 token 上限，
平均 168 token，只有 45% 的 tag 真正进模型。被静默丢掉的是 `@style-v1`、
`full_body`、`multicolored_hair`、`dutch_angle`（3/19）—— 恰好是「画风标识 + 构图」
这两组最该被学到的东西。根因不是 caption 写错了内容，是**顺序按 WD14 置信度排，
把风格段的 30 个 token 全花在了开头**，元信息（构图/场景）挤到 40 名开外。

本脚本做三件事：
  1. 按语义桶重排：trigger → style → composition → scene → subject → outfit → prop。
     构图段从第 40 位提到第 25 位以内。
  2. 压缩风格段：`semi-realistic digital painting` → `semi-realistic`，
     `glossy latex outfit` → `glossy latex`，`strong rim light` → `rim light`，
     删 `shallow depth of field`（5 token，对画风贡献最小）。
  3. 桶内按显式优先级排序 + 按桶上限裁剪 + 精确 token 校验，保证每张 ≤ --limit。

被刻意删掉的 tag：
  - `@style-v1`：写在最后从未被学到，实测是安慰剂；已有 `ohou` 作唯一触发器。
  - `artist_name`：画师签名水印，不该被学。
  - 纯解剖/性行为词（`cameltoe` / `groin` / `spread_legs` / `dripping` /
    `ass_visible_through_thighs` / `panties` / `no_panties`）：对画风无贡献；
    服装状态词（`bare_shoulders` / `sideboob` / `strapless` / `off_shoulder`）保留，它们决定轮廓。

用法：
    .venv/bin/python scripts_and_tools/budget_captions.py \
        --dir data/training-export/ohou19/img \
        --out data/training-export/ohou19cap/img --dry

    # 只审计不写盘
    .venv/bin/python scripts_and_tools/budget_captions.py --dir <目录> --dry
"""

from __future__ import annotations

import argparse
import glob
import os
import shutil
import statistics
import sys

from transformers import CLIPTokenizer

LIMIT = 75  # CLIP-L 内容 token 上限（不含 BOS/EOS）

TRIGGER = {"ohou"}

# 风格段：白名单 + 改写。值为 None 表示删除；两个原 tag 可映射到同一目标（自动去重）。
# 设计取舍（2026-11-23）：首版保留 7 段风格吃掉 19 token，把服装段挤到只剩 2 段 ——
# 而上一轮结论是「LoRA 学的是服装包」。所以风格必须压到 4 段，把预算让给服装：
#   `semi-realistic` 与 `no lineart` 重叠（都是「非平涂」），删前者；
#   `glossy skin` 与 `glossy latex` 重叠（都是亮面材质先验），删前者；
#   `rim light` + `crimson and black` 合成 `crimson rim light`（黑色调由 black_* 服装词承担）；
#   `shallow depth of field` 删（5 token，对画风贡献最小）。
STYLE_MAP: dict[str, str | None] = {
    "semi-realistic digital painting": None,
    "no lineart": "no lineart",
    "glossy skin": None,
    "glossy latex outfit": "glossy latex",
    "strong rim light": "crimson rim light",
    "crimson and black": "crimson rim light",
    "shallow depth of field": None,
}

COMPOSITION = {
    "dutch_angle", "from_below", "from_above", "from_side", "from_behind",
    "full_body", "upper_body", "cowboy_shot", "close-up", "portrait",
    "standing", "sitting", "lying", "on_back", "on_stomach", "knee_up",
    "feet_out_of_frame", "head_out_of_frame", "spread_legs",
}

SCENE = {
    "bar_(place)", "indoors", "outdoors", "casino", "pink_background",
    "white_background", "simple_background", "night", "architecture",
    "east_asian_architecture", "onsen", "shrine", "bedroom", "city",
    "cherry_blossoms", "petals", "paper_lantern", "lantern",
}

SUBJECT = {
    "1girl", "1boy", "solo", "multiple_girls", "fox_girl", "kitsune",
    "black_hair", "long_hair", "very_long_hair", "multicolored_hair",
    "two-tone_hair", "colored_inner_hair", "blunt_bangs", "bangs",
    "yellow_eyes", "red_eyes", "brown_eyes", "blue_eyes",
    "tail", "fox_tail", "rabbit_tail", "multiple_tails", "fake_tail",
    "animal_ear_fluff", "eyes", "eyes_closed",
}

OUTFIT = {
    "playboy_bunny", "bunny_girl", "rabbit_ears", "fake_animal_ears",
    "black_leotard", "red_leotard", "highleg_leotard", "strapless_leotard",
    "leotard", "bodysuit", "bodystocking",
    "black_gloves", "half_gloves", "elbow_gloves",
    "black_pantyhose", "black_thighhighs", "pantyhose", "thighband_pantyhose",
    "fishnets", "garter_straps", "black_garter_straps", "thigh_strap",
    "black_footwear", "high_heels", "boots", "heels",
    "detached_collar", "collar", "choker", "wrist_cuffs", "armlet",
    "hair_ornament", "hair_flower", "bow", "red_bow", "bowtie",
    "black_bowtie", "red_bowtie", "traditional_bowtie",
    "coat", "black_coat", "fur-trimmed_coat", "fur-trimmed_kimono",
    "fur_trim", "jacket", "cloak", "hood", "hood_up",
    "japanese_clothes", "black_kimono", "short_kimono", "black_dress",
    "wide_sleeves", "long_sleeves", "sash", "obi", "pelvic_curtain",
    "side_slit", "floral_print", "see-through", "see-through_cleavage",
    "strapless", "off_shoulder", "bare_shoulders", "sideboob",
    "between_breasts", "clothing_cutout", "covered_navel", "alternate_costume",
    "umbrella", "oil-paper_umbrella", "smoking_pipe",
}
OUTFIT_KEYS = ("kimono", "leotard", "pantyhose", "thighhigh", "dress", "coat",
               "sleeve", "glove", "heel", "boot", "bow", "collar", "strap",
               "cuff", "ear", "tail")

PROP = {
    "drinking_glass", "wine_glass", "cocktail_glass", "cup", "bottle",
    "wine_bottle", "alcohol", "wine", "bar_stool", "stool", "counter",
    "tray", "poker_chip", "sakazuki", "holding", "holding_cup",
    "holding_tray", "holding_smoking_pipe", "holding_umbrella",
    "pouring_onto_self",
}
PROP_KEYS = ("glass", "bottle", "holding", "alcohol", "stool", "tray", "chip")

# 明确丢弃：性行为/纯解剖/水印，对画风无贡献且烧 token。
DROP = {
    "@style-v1", "artist_name", "cameltoe", "groin", "spread_legs",
    "ass_visible_through_thighs", "panties", "no_panties", "underwear",
    "black_panties", "highleg_panties", "blush", "red_lips", "eyeliner",
    "eyeshadow", "wide_hips", "curvy", "armpits", "dripping",
}

# 桶内优先级：数字小的排前面，同权保持原顺序。没列的默认 50。
PRIORITY: dict[str, int] = {
    # 构图：入画范围最优先，其次机位偏差，再次姿态
    "full_body": 0, "dutch_angle": 1, "from_below": 2, "from_side": 3,
    "from_above": 4, "cowboy_shot": 5, "upper_body": 5, "standing": 6,
    "sitting": 7, "lying": 8, "on_back": 9, "knee_up": 10,
    "feet_out_of_frame": 11,
    # 场景
    "bar_(place)": 0, "indoors": 1, "casino": 2, "pink_background": 2,
    "architecture": 3, "east_asian_architecture": 3, "cherry_blossoms": 3,
    "paper_lantern": 4, "lantern": 4,
    # 主体
    "1girl": 0, "solo": 20, "fox_girl": 2, "kitsune": 2, "black_hair": 3,
    "multicolored_hair": 3, "very_long_hair": 4, "long_hair": 4,
    "two-tone_hair": 5, "red_eyes": 5, "yellow_eyes": 5, "brown_eyes": 5,
    "blunt_bangs": 6, "colored_inner_hair": 6, "tail": 6, "fox_tail": 6,
    "multiple_tails": 7, "rabbit_tail": 7, "animal_ear_fluff": 7,
    # 服装：主体装束 > 配饰 > 细节
    "playboy_bunny": 0, "bunny_girl": 0, "rabbit_ears": 1, "fox_ears": 1,
    "black_leotard": 2, "red_leotard": 2, "highleg_leotard": 3, "leotard": 5,
    "strapless_leotard": 4,
    "black_kimono": 2, "black_dress": 2, "japanese_clothes": 2,
    "black_gloves": 3, "half_gloves": 3,
    "black_pantyhose": 4, "black_thighhighs": 5, "pantyhose": 6,
    "high_heels": 5, "black_footwear": 6,
    "fur-trimmed_coat": 6, "fur-trimmed_kimono": 6, "black_coat": 7, "coat": 8,
    "detached_collar": 7, "collar": 7,
    "thigh_strap": 8, "garter_straps": 8, "black_garter_straps": 8,
    "wide_sleeves": 9, "long_sleeves": 9, "sash": 9, "obi": 9,
    "hair_ornament": 10, "choker": 10, "wrist_cuffs": 10, "armlet": 10,
    # 道具
    "drinking_glass": 0, "wine_bottle": 0, "bottle": 0, "alcohol": 1,
    "cup": 2, "wine_glass": 2, "cocktail_glass": 2, "bar_stool": 3,
    "tray": 4, "poker_chip": 4, "holding": 5,
}

# 同槽位去重：一组 tag 描述的是同一件东西的不同侧面，只保留优先级最高的一个。
# 理由：`black_leotard` + `highleg_leotard` 各占 4 token 却只说了一件衣服，
# 而同图的高跟鞋、毛领大衣被挤出预算 —— 后者才是造型识别的关键。
SLOTS: dict[str, set[str]] = {
    "leotard": {"black_leotard", "red_leotard", "highleg_leotard",
                "strapless_leotard", "leotard", "bodysuit", "bodystocking"},
    "legwear": {"black_pantyhose", "pantyhose", "black_thighhighs",
                "thighband_pantyhose", "fishnets"},
    "outer": {"coat", "black_coat", "fur-trimmed_coat", "fur-trimmed_kimono",
              "jacket", "cloak"},
}

# 每桶最多保留几段（顺序即优先级，超出从尾部丢）
CAPS = {
    "trigger": 1,
    "style": 4,
    "composition": 3,
    "scene": 2,
    "subject": 4,
    "outfit": 8,
    "prop": 1,
}
BUCKET_ORDER = ["trigger", "style", "composition", "scene", "subject", "outfit", "prop"]
# 预算仍超时，按这个顺序从各桶尾部继续丢（style / trigger 永不丢）
SHRINK_ORDER = ["prop", "outfit", "subject", "scene", "composition"]


def classify(tag: str) -> str:
    if tag in TRIGGER:
        return "trigger"
    if tag in STYLE_MAP:
        return "style"
    if tag in DROP:
        return "drop"
    if tag in COMPOSITION:
        return "composition"
    if tag in SCENE:
        return "scene"
    if tag in SUBJECT:
        return "subject"
    if tag in OUTFIT:
        return "outfit"
    if tag in PROP:
        return "prop"
    if any(k in tag for k in PROP_KEYS):
        return "prop"
    if any(k in tag for k in OUTFIT_KEYS):
        return "outfit"
    return "drop"  # 无法归类的零散词（chubby 之类）直接丢，不占预算


def restructure(segs: list[str]) -> list[tuple[str, str]]:
    """返回 [(tag, bucket)]，已按桶顺序 + 桶内优先级排好并裁到 CAPS。"""
    buckets: dict[str, list[str]] = {k: [] for k in BUCKET_ORDER}
    order_in: dict[str, int] = {}

    for raw in segs:
        tag = raw.strip()
        if not tag:
            continue
        b = classify(tag)
        if b == "drop":
            continue
        if b == "style":
            mapped = STYLE_MAP[tag]
            if mapped is None:
                continue  # 显式删除（shallow depth of field）
            tag = mapped
        if tag in buckets[b]:
            continue
        order_in[tag] = len(order_in)
        buckets[b].append(tag)

    for b in BUCKET_ORDER:
        # 稳定排序：优先级数字小在前，同优先级按原始出现顺序
        buckets[b].sort(key=lambda t: (PRIORITY.get(t, 50), order_in[t]))
        # 同槽位去重：一件衣服只留一个说法
        used: set[str] = set()
        dedup: list[str] = []
        for t in buckets[b]:
            slot = next((k for k, members in SLOTS.items() if t in members), None)
            if slot is not None:
                if slot in used:
                    continue
                used.add(slot)
            dedup.append(t)
        buckets[b] = dedup[: CAPS[b]]

    flat: list[tuple[str, str]] = []
    for b in BUCKET_ORDER:
        flat.extend((t, b) for t in buckets[b])
    return flat


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--out", help="输出目录（不填则只审计）")
    ap.add_argument("--limit", type=int, default=75, help="内容 token 硬上限（CLIP-L 为 75）")
    ap.add_argument("--dry", action="store_true", help="不写盘")
    ap.add_argument("--verbose", action="store_true", help="逐张打印新旧 caption")
    args = ap.parse_args()

    tok = CLIPTokenizer.from_pretrained("openai/clip-vit-large-patch14")

    def ntok(s: str) -> int:
        return len(tok(s)["input_ids"]) - 2

    files = sorted(glob.glob(os.path.join(args.dir, "*.txt")))
    if not files:
        print(f"{args.dir} 下没有 .txt", file=sys.stderr)
        return 1

    if args.out and not args.dry:
        os.makedirs(args.out, exist_ok=True)

    rows = []
    for f in files:
        old = open(f, encoding="utf-8").read().strip()
        old_segs = [s.strip() for s in old.split(",") if s.strip()]
        flat = restructure(old_segs)

        # 逐步收缩直到进预算：只从桶尾丢，桶标签随身携带，不做二次分类
        while True:
            text = ", ".join(t for t, _ in flat) + ","
            if ntok(text) <= args.limit:
                break
            shrunk = False
            for b in SHRINK_ORDER:
                for i in range(len(flat) - 1, -1, -1):
                    if flat[i][1] == b:
                        flat.pop(i)
                        shrunk = True
                        break
                if shrunk:
                    break
            if not shrunk:
                print(f"!! {os.path.basename(f)} 压不到 {args.limit} token", file=sys.stderr)
                break

        segs = [t for t, _ in flat]
        text = ", ".join(segs) + ","
        rows.append({
            "name": os.path.basename(f),
            "old_tokens": ntok(old),
            "old_tags": len(old_segs),
            "new_tokens": ntok(text),
            "new_tags": len(segs),
            "text": text,
            "kept": set(segs),
            "old_text": old,
        })

        if args.out and not args.dry:
            open(os.path.join(args.out, os.path.basename(f)), "w", encoding="utf-8").write(text)
            stem = os.path.basename(f)[:-4]
            for ext in (".png", ".jpg", ".webp"):
                s = os.path.join(args.dir, stem + ext)
                d = os.path.join(args.out, stem + ext)
                if os.path.exists(s) and not os.path.exists(d):
                    shutil.copy2(s, d)
                    break

        if args.verbose:
            print(f"\n=== {rows[-1]['name']}  {rows[-1]['old_tokens']} → {rows[-1]['new_tokens']} token"
                  f"  ({rows[-1]['old_tags']} → {rows[-1]['new_tags']} 段)")
            print(f"  新: {text}")

    n = len(rows)
    over = [r for r in rows if r["new_tokens"] > args.limit]
    print(f"{n} 张 caption  平均 {statistics.mean(r['old_tokens'] for r in rows):.0f} → "
          f"{statistics.mean(r['new_tokens'] for r in rows):.0f} token  "
          f"({statistics.mean(r['old_tags'] for r in rows):.0f} → "
          f"{statistics.mean(r['new_tags'] for r in rows):.0f} 段)")
    print(f"超 {args.limit} token：{len(over)} 张"
          f"{'  ' + ', '.join(r['name'] for r in over) if over else ''}")
    print(f"最长 {max(r['new_tokens'] for r in rows)} / 最短 {min(r['new_tokens'] for r in rows)} token")

    watch = ["ohou", "no lineart", "glossy latex", "crimson rim light",
             "full_body", "dutch_angle", "from_below", "standing", "bar_(place)",
             "multicolored_hair", "black_pantyhose", "high_heels", "fur-trimmed_coat"]
    # 旧 caption 的写法 → 新 caption 的写法（合并类 tag 用同义词对账）
    ALIAS = {"crimson rim light": ("rim light", "crimson and black")}
    print(f"\n关注 tag 存活率（旧 → 新，共 {n} 张）：")
    for tag in watch:
        old_keys = ALIAS.get(tag, (tag,))
        old_alive = sum(1 for r in rows if any(k in r["old_text"] for k in old_keys))
        new_alive = sum(1 for r in rows if tag in r["kept"])
        flag = "✓" if new_alive >= old_alive else ("↓" if new_alive else "✗")
        print(f"  {tag:20s} {old_alive:2d}/{n} → {new_alive:2d}/{n}  {flag}")

    if args.out and not args.dry:
        print(f"\n写了 {n} 个 .txt + 图片到 {args.out}")
    elif args.dry:
        print("\n(--dry，未写盘)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
