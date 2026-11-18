#!/usr/bin/env python3
"""直接调用 critic 的 tag / embed，不经 HTTP。

用法（仓库根目录）：
    .venv/bin/python tools/critic.py tag <图片路径> [--json]
    .venv/bin/python tools/critic.py embed <图片路径> [--ref <参考图>] [--json]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from critic.embed import AXIS_HINTS, embed
from critic.tag import DEFAULT_MODEL, MODELS, tag


def main() -> int:
    parser = argparse.ArgumentParser(description="本地调用 critic 打标和风格向量")
    commands = parser.add_subparsers(dest="command", required=True)

    tag_cmd = commands.add_parser("tag", help="WD14 打标")
    tag_cmd.add_argument("path", help="本地图片路径")
    tag_cmd.add_argument("--model", default=DEFAULT_MODEL, choices=list(MODELS))
    tag_cmd.add_argument("--general-threshold", type=float, default=0.35)
    tag_cmd.add_argument("--character-threshold", type=float, default=0.85)
    tag_cmd.add_argument("--exclude", nargs="*", default=[])
    tag_cmd.add_argument("--with-scores", action="store_true")
    tag_cmd.add_argument("--json", action="store_true")

    embed_cmd = commands.add_parser("embed", help="7 维风格向量")
    embed_cmd.add_argument("path", help="本地图片路径")
    embed_cmd.add_argument("--ref", help="可选参考图，附带 L2 / cosine")
    embed_cmd.add_argument("--device", help="torch device，默认 auto（mps/cuda/cpu）")
    embed_cmd.add_argument("--dtype", default="float32", choices=["float32", "float16", "bfloat16"])
    embed_cmd.add_argument("--json", action="store_true")

    args = parser.parse_args()
    try:
        if args.command == "tag":
            result = tag(
                args.path,
                model=args.model,
                general_threshold=args.general_threshold,
                character_threshold=args.character_threshold,
                exclude=args.exclude,
                with_scores=args.with_scores,
            )
            _print_tag(result, args.json)
        else:
            result = embed(args.path, ref=args.ref, device=args.device, dtype=args.dtype)
            _print_embed(result, args.json)
    except (ValueError, FileNotFoundError, RuntimeError) as exc:
        print(exc, file=sys.stderr)
        return 1
    return 0


def _print_tag(result: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(result, ensure_ascii=False))
        return
    print(f"image: {result['image']}")
    print(f"model: {result['model']}  rating: {result['rating']}")
    for name in result["tags"]:
        print(f"  {name}")


def _print_embed(result: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(result, ensure_ascii=False))
        return
    print(f"image: {result['image']}   device: {result['device']}")
    for index, value in enumerate(result["styleVec"], 1):
        print(f"  dim{index}: {value:+.5f}   ({AXIS_HINTS[index - 1]})")
    if "ref" in result:
        ref = result["ref"]
        print(f"ref: {ref['image']}")
        print(f"  L2: {ref['l2']}   cosine: {ref['cosine']}")


if __name__ == "__main__":
    sys.exit(main())
