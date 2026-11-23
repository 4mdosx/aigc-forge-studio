#!/usr/bin/env python3
"""把候选池渲染成带编号的分页缩略图，供人眼过图。

为什么要这个工具：05 规范的判据是「并排目检」，但候选池动辄几百张，
逐张点开看不现实。contact sheet 把 100 张铺成一页，编号与 candidates.json
的下标一一对应，看到问题直接报编号就能定位。

用法：
  .venv/bin/python scripts_and_tools/contact_sheet.py \
      --candidates data/capture/mecha-1123/candidates-danbooru.json \
      --out-dir data/capture/mecha-1123/sheets --per-sheet 98 --cols 10

输出：sheets/sheet-01.png ... 每张图左上角标编号（与 candidates.json items 下标一致）
缓存目录默认 /tmp/danbooru-thumbs，可按 --cache 覆盖。
"""

import argparse
import concurrent.futures as cf
import json
import re
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
REFERER = "https://danbooru.donmai.us/"


def fetch(url: str, dest: Path) -> bool:
    if dest.exists() and dest.stat().st_size > 20000:
        try:
            Image.open(dest).verify()
            return True
        except Exception:
            pass
    subprocess.run(
        [
            "curl", "-s", "--max-time", "30",
            "-A", UA, "-H", f"Referer: {REFERER}",
            "-o", str(dest), url,
        ],
        check=False,
    )
    if not (dest.exists() and dest.stat().st_size > 20000):
        return False
    try:
        Image.open(dest).verify()
        return True
    except Exception:
        return False


def label(im: Image.Image, text: str) -> Image.Image:
    draw = ImageDraw.Draw(im)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 20)
    except Exception:
        font = ImageFont.load_default()
    box = draw.textbbox((0, 0), text, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    draw.rectangle([0, 0, w + 10, h + 8], fill=(0, 0, 0))
    draw.text((5, 2), text, fill=(255, 255, 255), font=font)
    return im


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--per-sheet", type=int, default=98)
    ap.add_argument("--cols", type=int, default=10)
    ap.add_argument("--cell-h", type=int, default=230)
    ap.add_argument("--cache", default="/tmp/danbooru-thumbs")
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--end", type=int, default=0, help="0 表示到末尾")
    args = ap.parse_args()

    data = json.loads(Path(args.candidates).read_text())
    items = data["items"]
    end = args.end or len(items)
    items = list(enumerate(items))[args.start:end]

    cache = Path(args.cache)
    if not cache.is_dir():
        cache.mkdir(parents=True)
    out_dir = Path(args.out_dir)
    if not out_dir.is_dir():
        out_dir.mkdir(parents=True)

    def key_of(idx_item):
        idx, it = idx_item
        src = it.get("sampleUrl") or it.get("fileUrl") or it.get("imgUrl") or ""
        ext = re.search(r"\.(jpe?g|png|webp)(?:$|\?)", src.lower())
        ext = ext.group(1) if ext else "jpg"
        return idx, src, cache / f"{idx:04d}.{ext}"

    jobs = [key_of(x) for x in items]
    with cf.ThreadPoolExecutor(8) as ex:
        oks = list(ex.map(lambda j: fetch(j[1], j[2]), jobs))
    ok_map = {j[0]: (j[2], ok) for j, ok in zip(jobs, oks)}
    print(f"缩略图就绪 {sum(oks)}/{len(jobs)}")

    cells = []
    for idx, it in items:
        path, ok = ok_map[idx]
        if not ok:
            continue
        try:
            im = Image.open(path).convert("RGB")
        except Exception:
            continue
        w, h = im.size
        cell = im.resize((max(1, int(w * args.cell_h / h)), args.cell_h), Image.LANCZOS)
        cells.append((idx, label(cell, f"{idx:03d}")))

    n = 0
    for start in range(0, len(cells), args.per_sheet):
        chunk = cells[start:start + args.per_sheet]
        rows = (len(chunk) + args.cols - 1) // args.cols
        width = max(
            sum(c.width for _, c in chunk[r * args.cols:(r + 1) * args.cols])
            for r in range(rows)
        )
        canvas = Image.new("RGB", (width, rows * args.cell_h), "#e8e8e8")
        for r in range(rows):
            x = 0
            for _, c in chunk[r * args.cols:(r + 1) * args.cols]:
                canvas.paste(c, (x, r * args.cell_h))
                x += c.width
        n += 1
        dst = out_dir / f"sheet-{n:02d}.png"
        canvas.save(dst)
        print(f"{dst}  {canvas.size}  #{chunk[0][0]:03d}-#{chunk[-1][0]:03d}")


if __name__ == "__main__":
    main()
