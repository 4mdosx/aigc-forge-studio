#!/usr/bin/env python3
"""从骨架合成配套 depth —— 给 ControlNet 补上「尺度」这一个信息维度。

为什么需要这一步：
  openpose 只约束关节的**相对**位置，完全不约束人物在画布里占多大。实测
  骨架踝点在 82% 处，出图鞋尖却顶到 100% —— 模型把人物放大了 1.2 倍。
  而外部那批 depth 是 3D 写实人体渲染，尺度是对的，但八头身、敦实、带地面
  灰带的先验会把画风往写实拽。
  所以自己合成：坐标变换与骨架**同一套参数**，只额外提供骨架没有的两件事 ——
  人物外轮廓占多大、地面在哪个高度。

depth 惯例：近处亮、远处暗。背景 0。

  .venv/bin/python scripts_and_tools/pose_depth_synth.py --canvas 832x1216 \
      --height-ratio 0.84 --bottom-margin 0.115 --sheet
"""
import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pose_synth import VARIANTS, _variant  # noqa: E402

# 亮度分级：躯干最近，四肢渐远，脚最远
LV = {
    'head': 196, 'neck': 188, 'torso': 200,
    'uarm': 176, 'farm': 166, 'hand': 158,
    'thigh': 180, 'shin': 168, 'foot': 150,
}
GROUND_NEAR, GROUND_FAR = 92, 26


def render_depth(points, W, H, hr, bottom, blur=5):
    top = 1.0 - hr - bottom
    ph = H * hr

    def px(p):
        return (W / 2 + (p[0] - 0.5) * ph, H * top + p[1] * ph)

    P = {k: px(v) for k, v in points.items()}
    img = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(img)

    # --- 脚：骨架只到踝，脚底再往下 0.035 身高。这一段是骨架缺的，depth 补上 ---
    sole_y = max(P['lank'][1], P['rank'][1]) + 0.035 * ph
    for side in ('l', 'r'):
        a = P[f'{side}ank']
        shoe_w = 0.030 * ph
        d.line([(a[0], a[1]), (a[0], sole_y)], fill=LV['foot'], width=int(shoe_w * 1.6))
        d.ellipse([a[0] - shoe_w, sole_y - shoe_w * 0.8, a[0] + shoe_w, sole_y + shoe_w * 0.5],
                  fill=LV['foot'])

    # --- 腿 ---
    for side in ('l', 'r'):
        hip, knee, ank = P[f'{side}hip'], P[f'{side}knee'], P[f'{side}ank']
        d.line([hip, knee], fill=LV['thigh'], width=int(0.062 * ph))
        d.line([knee, ank], fill=LV['shin'], width=int(0.048 * ph))
        # 高光带，做圆柱体积感
        d.line([hip, knee], fill=LV['thigh'] + 16, width=int(0.030 * ph))
        d.line([knee, ank], fill=LV['shin'] + 14, width=int(0.024 * ph))

    # --- 躯干：肩 → 胯 → 腰，多边形 ---
    sh_l, sh_r = P['lsho'], P['rsho']
    hp_l, hp_r = P['lhip'], P['rhip']
    mid_sh_y = (sh_l[1] + sh_r[1]) / 2
    mid_hp_x = (hp_l[0] + hp_r[0]) / 2
    mid_hp_y = (hp_l[1] + hp_r[1]) / 2
    waist_y = mid_sh_y + (mid_hp_y - mid_sh_y) * 0.62
    waist_w = 0.034 * ph
    hip_w = 0.058 * ph
    torso = [
        sh_l, sh_r,
        (mid_hp_x + hip_w, mid_hp_y), (mid_hp_x + waist_w, waist_y),
        (mid_hp_x - waist_w, waist_y), (mid_hp_x - hip_w, mid_hp_y),
    ]
    d.polygon(torso, fill=LV['torso'])
    # 胸腹再亮一档，让深度有前后
    d.ellipse([mid_hp_x - 0.072 * ph, mid_sh_y + 0.015 * ph,
               mid_hp_x + 0.072 * ph, waist_y + 0.02 * ph],
              fill=min(255, LV['torso'] + 10))

    # --- 手臂 ---
    for side in ('l', 'r'):
        sho, elb, wri = P[f'{side}sho'], P[f'{side}elb'], P[f'{side}wri']
        d.line([sho, elb], fill=LV['uarm'], width=int(0.046 * ph))
        d.line([elb, wri], fill=LV['farm'], width=int(0.038 * ph))
        d.ellipse([wri[0] - 0.022 * ph, wri[1] - 0.022 * ph,
                   wri[0] + 0.022 * ph, wri[1] + 0.022 * ph], fill=LV['hand'])

    # --- 头与颈 ---
    neck = P['neck']
    d.line([(neck[0], neck[1] - 0.01 * ph), ((sh_l[0] + sh_r[0]) / 2, sh_l[1])],
           fill=LV['neck'], width=int(0.038 * ph))
    head_c = ((P['lear'][0] + P['rear'][0]) / 2, (P['lear'][1] + P['rear'][1]) / 2 - 0.005 * ph)
    hr_x, hr_y = 0.052 * ph, 0.062 * ph
    d.ellipse([head_c[0] - hr_x, head_c[1] - hr_y, head_c[0] + hr_x, head_c[1] + hr_y],
              fill=LV['head'])

    # --- 地面：只在脚底画一小段亮晕，往下快速衰减到黑。
    # 画满整条底边会把地面变成「墙」，模型反而不知道该站多高。---
    gh = max(2, int(0.045 * H))
    if sole_y < H:
        g = Image.new('L', (1, gh))
        gd = ImageDraw.Draw(g)
        for i in range(gh):
            v = GROUND_NEAR * (1 - i / max(1, gh - 1)) ** 1.6
            gd.line([(0, i), (0, i)], fill=int(v))
        img.paste(g.resize((W, gh), Image.BILINEAR), (0, int(sole_y)))

    if blur:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    return img, sole_y / H


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='data/pose/synthetic')
    ap.add_argument('--canvas', default='832x1216')
    ap.add_argument('--height-ratio', type=float, default=0.84)
    ap.add_argument('--bottom-margin', type=float, default=0.115)
    ap.add_argument('--blur', type=float, default=5)
    ap.add_argument('--only', default='')
    ap.add_argument('--sheet', action='store_true')
    args = ap.parse_args()

    W, H = (int(v) for v in args.canvas.lower().split('x'))
    names = [n for n in (args.only.split(',') if args.only else VARIANTS) if n]
    out = Path(args.out)

    made = []
    for n in names:
        pts = _variant(n)
        img, sole = render_depth(pts, W, H, args.height_ratio, args.bottom_margin, args.blur)
        d = out / n
        d.mkdir(parents=True, exist_ok=True)
        img.save(d / 'depth.png')
        meta_p = d / 'meta.json'
        meta = json.loads(meta_p.read_text()) if meta_p.exists() else {'name': n}
        meta['depth'] = {
            'file': 'depth.png', 'soleY': round(sole, 4),
            'note': '从骨架合成，坐标与 bone.png 同源；提供人物轮廓占比与地面高度',
        }
        meta_p.write_text(json.dumps(meta, ensure_ascii=False, indent=1))
        made.append((n, img))
        print(f'  {n:14s} -> {d}/depth.png  脚底 y={sole:.3f}')

    if args.sheet and made:
        TW, TH = 260, 380
        sheet = Image.new('L', (TW * len(made), TH), 0)
        for i, (_, im) in enumerate(made):
            t = im.copy()
            t.thumbnail((TW, TH))
            sheet.paste(t, (i * TW + (TW - t.width) // 2, (TH - t.height) // 2))
        sheet.save(out.parent / 'synthetic_depth_sheet.png')
        print(f'  总览 -> {out.parent}/synthetic_depth_sheet.png')
    print(f'共 {len(made)} 组')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
