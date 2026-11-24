#!/usr/bin/env python3
"""把任意来源的 openpose 骨架重排进统一画布，并合成配套 depth。

为什么需要：ControlNet 直接吃参考图尺寸的骨架，人物占画布比例会沿用原图构图
——有的顶天立地、有的只占一半，出图尺度就不一致。这里统一到「头顶在 10.5%、
脚踝在 92.5% 身高」的口径，与自绘骨架（pose_synth.py）完全一致。

depth 不靠关节点，而是从骨架像素的行包络推外轮廓再模糊：手伸到哪里体积就到
哪里，且不含任何 3D 写实人体先验。

  .venv/bin/python scripts_and_tools/pose_from_ref.py --src /tmp/refpose --out data/pose/weapon
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

# 与 pose_synth.py 同一套口径
TOP_MARGIN = 0.105
HEIGHT_RATIO = 0.788
ANKLE_AT = 0.925          # 脚踝在「身高」里的位置（脚再往下 7.5%）


def content_bbox(im: Image.Image) -> tuple[int, int, int, int]:
    a = np.asarray(im.convert("RGB"), dtype=np.uint8)
    mask = a.max(axis=2) > 24          # 黑底，非黑即骨架
    ys, xs = np.where(mask)
    if len(xs) == 0:
        raise ValueError("骨架图是空的")
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def normalize(im: Image.Image, W: int, H: int) -> Image.Image:
    x0, y0, x1, y1 = content_bbox(im)
    crop = im.crop((x0, y0, x1, y1))
    cw, ch = crop.size
    # 骨架高度（头顶→脚踝）占画布的比例
    target_h = HEIGHT_RATIO * ANKLE_AT * H
    scale = target_h / ch
    tw, th = max(1, round(cw * scale)), max(1, round(ch * scale))
    crop = crop.resize((tw, th), Image.LANCZOS)
    canvas = Image.new("RGB", (W, H), (0, 0, 0))
    canvas.paste(crop, ((W - tw) // 2, round(H * TOP_MARGIN)))
    return canvas


def _dilate(mask: np.ndarray, r: int) -> np.ndarray:
    m = mask.copy()
    for _ in range(max(1, r)):
        m = m | np.roll(m, 1, 0) | np.roll(m, -1, 0) | np.roll(m, 1, 1) | np.roll(m, -1, 1)
    return m


def depth_from_bone(bone: Image.Image, W: int, H: int) -> Image.Image:
    """躯干走行包络（有体积），四肢走膨胀（保持分开）。

    早期版本对每一列做上下填满，结果是整块白矩形——分开的双腿会被整条填掉。
    躯干的行包络只作用到髋线以上，髋以下靠膨胀保住两条腿的间隙。
    """
    a = np.asarray(bone.convert("L"), dtype=np.float32) / 255.0
    mask = a > 0.10
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return Image.new("RGB", (W, H), (0, 0, 0))
    top, bot = int(ys.min()), int(ys.max())
    hip = top + int((bot - top) * 0.55)

    body = np.zeros_like(mask)
    for y in range(top, min(hip + 1, H)):
        row = np.where(mask[y])[0]
        if len(row) == 0:
            continue
        body[y, row.min():row.max() + 1] = True

    pad = max(6, int(W * 0.014))
    body = _dilate(body, pad)
    legs = _dilate(mask[hip:], pad)
    body[hip:] = body[hip:] | legs

    ys_n = np.arange(H, dtype=np.float32)[:, None] / H
    d = body.astype(np.float32) * (1.0 - 0.40 * np.abs(ys_n - 0.52) * 2)
    img = Image.fromarray((np.clip(d, 0, 1) * 255).astype(np.uint8), mode="L")
    img = img.filter(ImageFilter.GaussianBlur(radius=max(3, H // 150)))
    return img.convert("RGB")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="SDPose 输出的骨架图目录")
    ap.add_argument("--out", default="data/pose/weapon")
    ap.add_argument("--canvas", default="832x1216")
    args = ap.parse_args()
    W, H = (int(v) for v in args.canvas.lower().split("x"))
    orig = Path(args.src)
    out = Path(args.out)
    made = 0
    for p in sorted(orig.glob("*.png")):
        im = Image.open(p)
        bone = normalize(im, W, H)
        d = out / p.stem
        d.mkdir(parents=True, exist_ok=True)
        bone.save(d / "bone.png")
        depth_from_bone(bone, W, H).save(d / "depth.png")
        print(f"  {p.stem} -> {d}/bone.png + depth.png")
        made += 1
    print(f"共 {made} 组")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
