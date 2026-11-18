#!/usr/bin/env python3
"""风格轴打分（Anime Style Embedder v4）。

用法：
    tools/.venv/bin/python tools/style_score.py <图片路径> [--ref <参考图>] [--json]

输出 7 维 styleVec（候选 B 的原始风格分数）。给 --ref 时附加 L2 距离、余弦相似度，
以及 close / uncertain / far 三档判断。阈值来自 12 张高雄参考图实测标定，不是通用常数；
正式挑图应优先「池内排名」（见 --styleCenter 设计），绝对阈值只做粗筛。

模型：
  - backbone: DINOv3 ViT-H+/16（镜像 bschooled/...，避开 facebook gated）
  - head: Fgdfgfthgr/Anime_Images_Style_Embedder · Style Embedder v4.safetensors
  - 取 CLS token -> MLP(1280->256->128->7)，与作者 minimal_script.py 一致

权重落地位置：data/models/style-embedder/
仅用于 SFW 素材的风格分组/挑选。
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / "data" / "models" / "style-embedder"
DINO_DIR = MODEL_DIR / "dinov3-vith16plus"
HEAD_FILE = MODEL_DIR / "Style_Embedder_v4.safetensors"
DIM = 7

# 作者博客解释的是旧 6 维模型的方向；v4 是 7 维，仅作弱提示，不是官方标签。
AXIS_HINTS = [
    "sharp contrast",
    "drawing complexity",
    "smooth / oil-ish painting",
    "thick line / blocky color",
    "complex scene / landscape",
    "comics / shading",
    "undocumented in author blog",
]

# 2026-11-18 标定（12 张高雄 ref，SFW）：
#   同画师同风格紧对 L2 0.16-0.52 / cos 0.98-1.00
#   跨画师异风格 L2 0.34-3.69 / cos -0.93..0.99（长尾重叠大）
# 双条件同时满足才判 close；单条件满足落 uncertain，避免跨画师偶发近邻误判。
CLOSE_L2, CLOSE_COS = 0.6, 0.9
FAR_L2, FAR_COS = 2.5, 0.5


def _verdict(l2: float, cos: float) -> str:
    if l2 <= CLOSE_L2 and cos >= CLOSE_COS:
        return "close"
    if l2 >= FAR_L2 or cos <= FAR_COS:
        return "far"
    return "uncertain"


def _require_models() -> None:
    missing = [str(p) for p in (DINO_DIR / "config.json", DINO_DIR / "model.safetensors", HEAD_FILE) if not p.exists()]
    if missing:
        raise SystemExit("缺少模型文件：\n  " + "\n  ".join(missing) + "\n先运行 tools/fetch_style_model.sh")


def _load_modules():
    import torch
    import torch.nn as nn
    from safetensors.torch import load_file
    from transformers import AutoModel

    class EmbeddingNetwork(nn.Module):
        def __init__(self):
            super().__init__()
            self.fc1 = nn.Linear(1280, 256)
            self.fc2 = nn.Linear(256, 128)
            self.fc3 = nn.Linear(128, DIM)
            self.act = nn.ReLU(inplace=True)

        def forward(self, x):
            x = self.act(self.fc1(x))
            x = self.act(self.fc2(x))
            return self.fc3(x)

    return torch, nn, load_file, AutoModel, EmbeddingNetwork


def _pick_device(torch):
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def load_predictor(device=None, dtype=None):
    """返回 (embed_fn, device)；进程内只加载一次模型。"""
    _require_models()
    torch, nn, load_file, AutoModel, EmbeddingNetwork = _load_modules()
    dev = torch.device(device) if device else _pick_device(torch)
    # 作者用 bf16；MPS 上 bf16 支持不稳，统一 fp32 保数值一致。
    dt = getattr(torch, dtype) if dtype else torch.float32

    # 镜像的 Fast processor 依赖 torchvision；这里只用 rescale+normalize+CHW，
    # 且 do_resize=False，手写等价实现，保持零 torchvision 依赖。
    class _Processor:
        def __init__(self):
            import json
            cfg = json.loads((DINO_DIR / "preprocessor_config.json").read_text())
            self.mean = cfg["image_mean"]
            self.std = cfg["image_std"]

        def __call__(self, images, return_tensors=None):
            import numpy as np
            arr = np.asarray(images, dtype=np.float32) / 255.0
            arr = (arr - np.asarray(self.mean, dtype=np.float32)) / np.asarray(self.std, dtype=np.float32)
            arr = np.ascontiguousarray(arr.transpose(2, 0, 1)[None, ...])
            import torch as _torch
            return {"pixel_values": _torch.from_numpy(arr)}

    processor = _Processor()
    dino = AutoModel.from_pretrained(str(DINO_DIR), dtype=dt).to(dev).eval()
    head = EmbeddingNetwork().to(device=dev, dtype=dt)
    head.load_state_dict(load_file(str(HEAD_FILE), device=str(dev)))
    head.eval()

    def embed(path: Path):
        from PIL import Image

        with Image.open(path) as im:
            im = im.convert("RGB")
            # 作者 do_resize=False；这里只做长边上限保护，避免大图 OOM。
            max_side = 1024
            if max(im.size) > max_side:
                scale = max_side / max(im.size)
                im = im.resize((max(16, round(im.width * scale / 16) * 16),
                                max(16, round(im.height * scale / 16) * 16)), Image.LANCZOS)
            inputs = processor(images=im, return_tensors="pt")
        inputs = {k: v.to(device=dev, dtype=dt) for k, v in inputs.items()}
        with torch.inference_mode():
            cls = dino(**inputs).last_hidden_state[:, 0, :]
            vec = head(cls).float().cpu().numpy().reshape(-1)
        if vec.shape[0] != DIM or not all(math.isfinite(float(x)) for x in vec):
            raise RuntimeError(f"风格向量异常：{vec!r}")
        return [round(float(x), 5) for x in vec]

    return embed, str(dev)


def main() -> int:
    ap = argparse.ArgumentParser(description="候选 B 风格轴打分：本地图片 -> 7 维 styleVec")
    ap.add_argument("image", help="本地图片路径")
    ap.add_argument("--ref", help="可选参考图；输出与该图的风格 L2 距离/余弦相似度")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--device", help="torch device，默认 auto (mps/cuda/cpu)")
    ap.add_argument("--dtype", default="float32", choices=["float32", "float16", "bfloat16"])
    args = ap.parse_args()

    image = Path(args.image).expanduser()
    if not image.is_file():
        raise SystemExit(f"图片不存在：{image}")
    ref = Path(args.ref).expanduser() if args.ref else None
    if ref and not ref.is_file():
        raise SystemExit(f"参考图不存在：{ref}")

    embed, dev = load_predictor(args.device, args.dtype)
    vec = embed(image)
    result = {"image": str(image), "device": dev, "styleVec": vec}
    if ref:
        ref_vec = embed(ref)
        diff = [a - b for a, b in zip(vec, ref_vec)]
        l2 = math.sqrt(sum(x * x for x in diff))
        na = math.sqrt(sum(x * x for x in vec)) or 1.0
        nb = math.sqrt(sum(x * x for x in ref_vec)) or 1.0
        cos = sum(a * b for a, b in zip(vec, ref_vec)) / (na * nb)
        result["ref"] = {
            "image": str(ref),
            "styleVec": ref_vec,
            "l2": round(l2, 5),
            "cosine": round(cos, 5),
            "verdict": _verdict(l2, cos),
        }

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(f"image: {image}   device: {dev}")
        for i, v in enumerate(vec, 1):
            print(f"  dim{i}: {v:+.5f}   ({AXIS_HINTS[i - 1]})")
        if ref:
            r = result["ref"]
            print(f"ref: {ref}\n  L2: {r['l2']}   cosine: {r['cosine']}   verdict: {r['verdict']}")
            print(f"  bands: close L2<={CLOSE_L2} & cos>={CLOSE_COS}; far L2>={FAR_L2} or cos<={FAR_COS}; else uncertain")
    return 0


if __name__ == "__main__":
    sys.exit(main())
