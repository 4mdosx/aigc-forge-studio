"""风格向量。输入图片路径，返回 7 维 styleVec；给参考图时附带距离。"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from critic.preprocess import style_array

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

_embed_fn = None
_embed_device = None


def loaded() -> bool:
    return _embed_fn is not None


def device() -> str | None:
    return _embed_device


def embed(
    path: str | Path,
    *,
    ref: str | Path | None = None,
    device: str | None = None,
    dtype: str | None = None,
) -> dict:
    image = _image(path, "path")
    embed_fn, used = _predictor(device, dtype)
    result = {"image": str(image), "device": used, "styleVec": embed_fn(image)}
    if ref:
        reference = _image(ref, "ref")
        ref_vec = embed_fn(reference)
        result["ref"] = {
            "image": str(reference),
            "styleVec": ref_vec,
            **compare(result["styleVec"], ref_vec),
        }
    return result


def close(a: str | Path, b: str | Path, *, device: str | None = None) -> dict:
    left = _image(a, "a")
    right = _image(b, "b")
    embed_fn, used = _predictor(device, None)
    return {
        "a": str(left),
        "b": str(right),
        "device": used,
        **compare(embed_fn(left), embed_fn(right)),
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


def _predictor(device: str | None, dtype: str | None):
    global _embed_fn, _embed_device
    if _embed_fn is None:
        _embed_fn, _embed_device = _load(device, dtype)
    return _embed_fn, _embed_device


def _load(device: str | None, dtype: str | None):
    missing = [
        str(path)
        for path in (DINO_DIR / "config.json", DINO_DIR / "model.safetensors", HEAD_FILE)
        if not path.exists()
    ]
    if missing:
        raise FileNotFoundError(
            "缺少模型文件：\n  " + "\n  ".join(missing) + "\n先运行 tools/fetch_style_model.sh"
        )

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

    def embed_fn(path: Path):
        pixels = torch.from_numpy(style_array(path, mean, std)).to(device=dev, dtype=dt)
        with torch.inference_mode():
            cls = dino(pixel_values=pixels).last_hidden_state[:, 0, :]
            vec = head(cls).float().cpu().numpy().reshape(-1)
        if vec.shape[0] != DIM or not all(math.isfinite(float(x)) for x in vec):
            raise RuntimeError(f"风格向量异常：{vec!r}")
        return [round(float(x), 5) for x in vec]

    return embed_fn, str(dev)
