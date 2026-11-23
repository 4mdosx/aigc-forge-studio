#!/usr/bin/env python3
"""对候选池做 tag 层面的二次过滤，输出 keep/reject 两份明细。

为什么需要这一层：danbooru 的 `1girl` 会误标在纯机甲图上（实测约 28%），
而 tag 里只要出现 hair / skirt / blush 这类人体标签，基本可以确认画的是人。
这条规则比「看图」便宜得多，先把明显废的剔掉，人眼只处理剩下的。

用法：
  .venv/bin/python scripts_and_tools/filter_candidates.py \
      --in data/capture/mecha-1123/candidates-danbooru.json \
      --out data/capture/mecha-1123/kept.json \
      --reject data/capture/mecha-1123/rejected.json \
      --min-body 3

写入 out 的 items 会带上 flags.bodyScore 与 flags.keepReason。
"""

import argparse
import json
from collections import Counter
from pathlib import Path

# 人体信号：画了人就会有这些标签；纯机甲/场景不会有
BODY_SIGNALS = {
    "breasts", "large_breasts", "small_breasts", "flat_chest", "cleavage",
    "thighhighs", "skirt", "dress", "shirt", "bodysuit", "leotard", "pantyhose",
    "boots", "gloves", "hair_ornament", "hairband", "ponytail", "twintails",
    "bangs", "long_hair", "short_hair", "blush", "looking_at_viewer", "smile",
    "open_mouth", "closed_mouth", "bare_shoulders", "navel", "midriff",
    "collarbone", "blue_eyes", "red_eyes", "green_eyes", "yellow_eyes",
    "purple_eyes", "ahoge", "hair_between_eyes", "bare_legs", "barefoot",
}

# 有这些说明是「整张图里塞了很多东西」，不是单张立绘
SCENE_SIGNALS = {
    "scenery", "no_humans", "cityscape", "indoors", "outdoors", "sky",
    "cloud", "building", "window", "vehicle", "tank_(medium)",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--reject", required=True)
    ap.add_argument("--min-body", type=int, default=3)
    args = ap.parse_args()

    data = json.loads(Path(args.src).read_text())
    kept, rejected = [], []
    reasons = Counter()

    for it in data["items"]:
        gen = set(it["tags"]["general"]) | set(it["tags"]["meta"])
        body = len(BODY_SIGNALS & gen)
        scene = len(SCENE_SIGNALS & gen)
        it["flags"]["bodyScore"] = body
        it["flags"]["sceneScore"] = scene

        if body < args.min_body:
            reasons["pure-mecha-or-scene"] += 1
            rejected.append(it)
        elif scene >= 4 and body < 6:
            # 场景词压过人体词 → 大概率是「场景里站了个人」，不适合当立绘
            reasons["scene-dominant"] += 1
            rejected.append(it)
        else:
            it["flags"]["keepReason"] = f"body{body}"
            kept.append(it)

    kept.sort(key=lambda x: -x["score"])
    for name, items in (("kept", kept), ("rejected", rejected)):
        payload = {
            **{k: v for k, v in data.items() if k != "items"},
            "filter": {"rule": f"body>={args.min_body}, scene<4", "kept": len(kept),
                       "rejected": len(rejected), "reasons": dict(reasons)},
            "items": items,
        }
        Path(args.out if name == "kept" else args.reject).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2)
        )

    wb = sum(1 for i in kept if i["flags"]["whiteBg"])
    fb = sum(1 for i in kept if i["flags"].get("crop") == "full_body")
    hi = sum(1 for i in kept if i["flags"]["handInFrame"])
    orig = sum(1 for i in kept if i["tags"]["copyright"][:1] == ["original"])
    print(f"保留 {len(kept)} / 剔除 {len(rejected)}   {dict(reasons)}")
    print(f"白底 {wb} / 全身 {fb} / 手入画 {hi} / original {orig}")
    chars = Counter(i["tags"]["character"][0] if i["tags"]["character"] else "(unnamed)" for i in kept)
    print("角色 Top12:", "  ".join(f"{k}:{v}" for k, v in chars.most_common(12)))
    cps = Counter(i["tags"]["copyright"][0] if i["tags"]["copyright"] else "(unknown)" for i in kept)
    print("版权 Top12:", "  ".join(f"{k}:{v}" for k, v in cps.most_common(12)))


if __name__ == "__main__":
    main()
