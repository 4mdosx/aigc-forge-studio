"""按 critic/profile.json 的 default 配置做统一预处理。

颜色收成配置里的色彩空间和通道数。分辨率缩放到宽高比最近的 bucket，
空出的边用白边补齐，不裁切。
"""

from __future__ import annotations

import io
import json
import math
from pathlib import Path

from PIL import Image, ImageCms, ImageOps

ROOT = Path(__file__).resolve().parent
PROFILE_PATH = ROOT / "profile.json"
PAD = (255, 255, 255)


def load_profile(name: str | None = None) -> dict:
    raw = json.loads(PROFILE_PATH.read_text(encoding="utf-8"))
    key = name or raw.get("default")
    if not isinstance(key, str) or key not in raw or not isinstance(raw[key], dict):
        raise ValueError(f"profile.json 缺少可用配置: {key}")
    return raw[key]


def prepare(path: Path, profile: str | None = None) -> Image.Image:
    """打开图片，统一颜色，再缩放补边到最近的 bucket。"""
    config = load_profile(profile)
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source) or source
        image.load()
        image = to_color(image, config)
        image.load()
    bucket = nearest_bucket(image.size, buckets_of(config))
    return fit_bucket(image, bucket)


def wd14_tensor(path: Path, size: int):
    """统一预处理后垫成正方形，再缩到模型边长。BGR NHWC float32，值域 0..255。"""
    import numpy as np

    image = prepare(path)
    width, height = image.size
    side = max(width, height)
    padded = Image.new("RGB", (side, side), PAD)
    padded.paste(image, ((side - width) // 2, (side - height) // 2))
    if side != size:
        padded = padded.resize((size, size), Image.Resampling.LANCZOS)

    rgb = np.asarray(padded, dtype=np.float32)
    return rgb[:, :, ::-1].copy()[None, ...]


def style_array(path: Path, mean, std):
    """统一预处理后的 RGB，按均值方差做成 NCHW float32。"""
    import numpy as np

    image = prepare(path)
    array = np.asarray(image, dtype=np.float32) / 255.0
    array = (array - np.asarray(mean, dtype=np.float32)) / np.asarray(std, dtype=np.float32)
    return np.ascontiguousarray(array.transpose(2, 0, 1)[None, ...])


def to_color(image: Image.Image, profile: dict) -> Image.Image:
    space = str(profile.get("colorSpace", "sRGB"))
    channels = int(profile.get("channels", 3))
    if space.lower() != "srgb" or channels != 3:
        raise ValueError(f"只支持 sRGB 三通道，当前是 {space} / {channels}")
    icc = image.info.get("icc_profile")
    if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
        rgba = image.convert("RGBA")
        canvas = Image.new("RGBA", rgba.size, PAD + (255,))
        image = Image.alpha_composite(canvas, rgba).convert("RGB")
    elif image.mode != "RGB":
        image = image.convert("RGB")
    if not icc:
        return image
    try:
        source = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        target = ImageCms.createProfile("sRGB")
        return ImageCms.profileToProfile(image, source, target, outputMode="RGB")
    except (ImageCms.PyCMSError, OSError, ValueError):
        return image.convert("RGB")


def buckets_of(profile: dict) -> list[tuple[int, int]]:
    raw = profile.get("buckets")
    if not isinstance(raw, list) or not raw:
        raise ValueError("profile.buckets 必须是非空列表")
    buckets: list[tuple[int, int]] = []
    for item in raw:
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            raise ValueError(f"bucket 必须是 [宽, 高]: {item}")
        width, height = int(item[0]), int(item[1])
        if width < 1 or height < 1:
            raise ValueError(f"bucket 边长必须为正: {item}")
        buckets.append((width, height))
    return buckets


def nearest_bucket(size: tuple[int, int], buckets: list[tuple[int, int]]) -> tuple[int, int]:
    width, height = size
    aspect = math.log(width / height)

    def distance(bucket: tuple[int, int]) -> float:
        return abs(aspect - math.log(bucket[0] / bucket[1]))

    return min(buckets, key=distance)


def fit_bucket(image: Image.Image, bucket: tuple[int, int]) -> Image.Image:
    """缩放到能放进 bucket 的最大尺寸，再居中补白边。"""
    bucket_w, bucket_h = bucket
    width, height = image.size
    scale = min(bucket_w / width, bucket_h / height)
    fitted_w = max(1, min(bucket_w, round(width * scale)))
    fitted_h = max(1, min(bucket_h, round(height * scale)))
    if (fitted_w, fitted_h) != (width, height):
        image = image.resize((fitted_w, fitted_h), Image.Resampling.LANCZOS)
    if (fitted_w, fitted_h) == (bucket_w, bucket_h):
        return image
    canvas = Image.new("RGB", (bucket_w, bucket_h), PAD)
    canvas.paste(image, ((bucket_w - fitted_w) // 2, (bucket_h - fitted_h) // 2))
    return canvas
