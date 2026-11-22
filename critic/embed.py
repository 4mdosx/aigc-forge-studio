"""风格向量。输入图片路径，返回向量；给参考图时附带距离。

两种模式：
- cls（默认）DINOv3-H 的 CLS，1280 维。方形缩放到 224 再进模型。
- head 作者训练的 7 维风格头，DINO 按 profile bucket 预处理后取 CLS 再走 MLP。

7 维头在检索上明显弱于裸 CLS（同源@10 0.160 vs 0.588），仅为对照保留。
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from critic.preprocess import square_array, style_array

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / "data" / "models" / "style-embedder"
DINO_DIR = MODEL_DIR / "dinov3-vith16plus"
HEAD_FILE = MODEL_DIR / "Style_Embedder_v4.safetensors"

MODE_CLS = "cls"
MODE_HEAD = "head"
DEFAULT_MODE = MODE_CLS
INPUT_SIZE = 224
HEAD_DIM = 7
CLS_DIM = 1280

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

_forward = None
_embed_device = None


def loaded() -> bool:
    return _forward is not None


def device() -> str | None:
    return _embed_device


def mode_of(value: object) -> str:
    if value in (None, ""):
        return DEFAULT_MODE
    if value in (MODE_CLS, MODE_HEAD):
        return str(value)
    raise ValueError(f"mode 必须是 {MODE_CLS} 或 {MODE_HEAD}")


def embed(
    path: str | Path,
    *,
    ref: str | Path | None = None,
    device: str | None = None,
    dtype: str | None = None,
    mode: str | None = None,
) -> dict:
    image = _image(path, "path")
    forward, used, mode = _predictor(device, dtype, mode)
    vector = forward(image, mode)
    result = {
        "image": str(image),
        "device": used,
        "mode": mode,
        "dim": len(vector),
        "styleVec": vector,
    }
    if ref:
        reference = _image(ref, "ref")
        ref_vec = forward(reference, mode)
        result["ref"] = {
            "image": str(reference),
            "styleVec": ref_vec,
            **compare(vector, ref_vec),
        }
    return result


def close(a: str | Path, b: str | Path, *, device: str | None = None) -> dict:
    left = _image(a, "a")
    right = _image(b, "b")
    forward, used, mode = _predictor(device, None, None)
    return {
        "a": str(left),
        "b": str(right),
        "device": used,
        "mode": mode,
        "dim": CLS_DIM if mode == MODE_CLS else HEAD_DIM,
        **compare(forward(left, mode), forward(right, mode)),
    }


def compare(a: list[float], b: list[float]) -> dict:
    diff = [x - y for x, y in zip(a, b)]
    l2 = math.sqrt(sum(x * x for x in diff))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(x * x for x in b)) or 1.0
    cosine = sum(x * y for x, y in zip(a, b)) / (na * nb)
    return {
        "l2": round(l2, 5),
        "cosine": round(cosine, 5),
    }


def _image(path: str | Path, field: str) -> Path:
    if not isinstance(path, (str, Path)) or not str(path).strip():
        raise ValueError(f"{field} 必须是非空路径")
    image = Path(path).expanduser()
    if not image.is_file():
        raise FileNotFoundError(f"图片不存在: {image}")
    return image


def _predictor(device: str | None, dtype: str | None, mode: str | None):
    global _forward, _embed_device
    if _forward is None:
        _forward, _embed_device = _load(device, dtype)
    return _forward, _embed_device, mode_of(mode)


def _load(device: str | None, dtype: str | None):
    from critic.models import require

    require()

    import torch
    import torch.nn as nn
    from safetensors.torch import load_file
    from transformers import AutoModel

    class EmbeddingNetwork(nn.Module):
        def __init__(self):
            super().__init__()
            self.fc1 = nn.Linear(CLS_DIM, 256)
            self.fc2 = nn.Linear(256, 128)
            self.fc3 = nn.Linear(128, HEAD_DIM)
            self.act = nn.ReLU(inplace=True)

        def forward(self, x):
            x = self.act(self.fc1(x))
            x = self.act(self.fc2(x))
            return self.fc3(x)

    if device in (None, "", "auto"):
        if torch.backends.mps.is_available():
            dev = torch.device("mps")
        elif torch.cuda.is_available():
            dev = torch.device("cuda")
        else:
            dev = torch.device("cpu")
    else:
        dev = torch.device(device)
    # 作者用 bf16；MPS 上 bf16 支持不稳，默认 fp32 保数值一致。
    dt = getattr(torch, dtype) if dtype else torch.float32
    stats = json.loads((DINO_DIR / "preprocessor_config.json").read_text())
    mean, std = stats["image_mean"], stats["image_std"]

    dino = AutoModel.from_pretrained(str(DINO_DIR), dtype=dt).to(dev).eval()
    head = EmbeddingNetwork().to(device=dev, dtype=dt)
    head.load_state_dict(load_file(str(HEAD_FILE), device=str(dev)))
    head.eval()

    def forward(path: Path, mode: str) -> list[float]:
        if mode == MODE_CLS:
            array = square_array(path, mean, std, INPUT_SIZE)
        else:
            array = style_array(path, mean, std)
        pixels = torch.from_numpy(array).to(device=dev, dtype=dt)
        with torch.inference_mode():
            cls = dino(pixel_values=pixels).last_hidden_state[:, 0, :]
            vec = (head(cls) if mode == MODE_HEAD else cls).float().cpu().numpy().reshape(-1)
        expect = HEAD_DIM if mode == MODE_HEAD else CLS_DIM
        if vec.shape[0] != expect or not all(math.isfinite(float(x)) for x in vec):
            raise RuntimeError(f"风格向量异常：{mode} 期望 {expect} 维，得到 {vec.shape}")
        # 1280 维不做 round(5)：f16 存储只保 3 位有效数字，四舍五入纯属浪费。
        if mode == MODE_HEAD:
            return [round(float(x), 5) for x in vec]
        return [float(x) for x in vec]

    return forward, str(dev)
