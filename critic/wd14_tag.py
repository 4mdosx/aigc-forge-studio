#!/usr/bin/env python3
"""WD14 打标（SmilingWolf Danbooru 反推器）—— Python 版，供 critic HTTP 服务调用。

移植自 runner/src/tag/wd14.ts，预处理与筛选逻辑逐条对齐：
  - RGBA 压白底 → 白 pad 成方形 → resize 到模型边长 → RGB 转 BGR
  - 值域铁律：喂 0..255 float32（NHWC）；/255 会退化成恒定先验输出
  - artist / copyright 不进 caption；rating 取 category 9 最高分
  - general >= 0.35、character >= 0.85（可用参数覆盖）

模型缓存：data/models/wd14/<modelId>/（model.onnx + selected_tags.csv）
用法：
    .venv/bin/python critic/wd14_tag.py <图片路径> [--json] [--model <id>]
仅用于 SFW 素材打标。
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "data" / "models" / "wd14"

MODELS = {
    "wd-eva02-large-tagger-v3": 448,
    "wd-v1-4-convnextv2-tagger-v2": 448,
}
DEFAULT_MODEL = "wd-eva02-large-tagger-v3"

CAT_GENERAL, CAT_ARTIST, CAT_COPYRIGHT, CAT_CHARACTER, CAT_RATING = 0, 1, 3, 4, 9


def parse_tags_csv(path: Path) -> list[tuple[str, int]]:
    entries: list[tuple[str, int]] = []
    with path.open(encoding="utf-8", newline="") as fh:
        reader = csv.reader(fh)
        next(reader, None)
        for row in reader:
            if len(row) < 3:
                continue
            name = row[1].strip()
            if name:
                entries.append((name, int(row[2])))
    if not entries:
        raise ValueError(f"selected_tags.csv 无有效行: {path}")
    return entries


def select_tags(
    scores,
    entries: list[tuple[str, int]],
    general_threshold: float = 0.35,
    character_threshold: float = 0.85,
    exclude_tags: list[str] | None = None,
) -> dict:
    if len(scores) != len(entries):
        raise ValueError(f"输出 {len(scores)} 维 != 标签表 {len(entries)} 行")
    exclude = {" ".join(t.lower().replace("_", " ").split()) for t in (exclude_tags or [])}
    rating, rating_score = "", -1.0
    picked: list[tuple[str, float]] = []
    for (name, category), score in zip(entries, scores):
        score = float(score)
        if category == CAT_RATING:
            if score > rating_score:
                rating, rating_score = name, score
            continue
        norm = " ".join(name.lower().replace("_", " ").split())
        if norm in exclude:
            continue
        if category == CAT_CHARACTER:
            if score >= character_threshold:
                picked.append((name, score))
            continue
        if category == CAT_GENERAL and score >= general_threshold:
            picked.append((name, score))
        # artist / copyright 不进 caption（画师名污染风格数据集）
    picked.sort(key=lambda pair: pair[1], reverse=True)
    return {"tags": [name for name, _ in picked], "rating": rating}


class Wd14Tagger:
    """进程内懒加载，每个模型一个 session（onnxruntime CPU）。"""

    def __init__(self, model_id: str = DEFAULT_MODEL):
        if model_id not in MODELS:
            raise ValueError(f"未知模型 {model_id}；可选 {list(MODELS)}")
        self.model_id = model_id
        self.size = MODELS[model_id]
        self._session = None
        self._input_name = None
        self._entries: list[tuple[str, int]] | None = None

    @property
    def model_dir(self) -> Path:
        return MODELS_DIR / self.model_id

    def _ensure(self):
        if self._session is not None:
            return
        import onnxruntime as ort

        model_dir = self.model_dir
        model_file = model_dir / "model.onnx"
        tags_file = model_dir / "selected_tags.csv"
        if not model_file.is_file() or not tags_file.is_file():
            raise FileNotFoundError(f"模型文件缺失: {model_dir}")
        self._session = ort.InferenceSession(
            str(model_file), providers=["CPUExecutionProvider"]
        )
        self._input_name = self._session.get_inputs()[0].name
        self._entries = parse_tags_csv(tags_file)

    def tag(
        self,
        image_path: str | Path,
        general_threshold: float = 0.35,
        character_threshold: float = 0.85,
        exclude_tags: list[str] | None = None,
        with_scores: bool = False,
    ) -> dict:
        self._ensure()
        import numpy as np
        from PIL import Image, ImageOps

        image = Image.open(image_path)
        image = ImageOps.exif_transpose(image)
        if image.mode in ("RGBA", "LA") or (
            image.mode == "P" and "transparency" in image.info
        ):
            rgba = image.convert("RGBA")
            canvas = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            image = Image.alpha_composite(canvas, rgba).convert("RGB")
        else:
            image = image.convert("RGB")

        w, h = image.size
        side = max(w, h)
        padded = Image.new("RGB", (side, side), (255, 255, 255))
        padded.paste(image, ((side - w) // 2, (side - h) // 2))
        if side != self.size:
            padded = padded.resize((self.size, self.size), Image.Resampling.LANCZOS)

        rgb = np.asarray(padded, dtype=np.float32)
        tensor = rgb[:, :, ::-1].copy()[None, ...]  # RGB -> BGR，NHWC，0..255
        outputs = self._session.run(None, {self._input_name: tensor})
        scores = outputs[0].reshape(-1)
        result = select_tags(
            scores,
            self._entries,
            general_threshold,
            character_threshold,
            exclude_tags,
        )
        result["model"] = self.model_id
        if with_scores:
            result["scores"] = [
                {"name": name, "category": cat, "score": round(float(score), 5)}
                for (name, cat), score in zip(self._entries, scores)
            ]
        return result


def main() -> int:
    parser = argparse.ArgumentParser(description="WD14 打标（Python 版）")
    parser.add_argument("image", help="本地图片路径")
    parser.add_argument("--model", default=DEFAULT_MODEL, choices=list(MODELS))
    parser.add_argument("--general-threshold", type=float, default=0.35)
    parser.add_argument("--character-threshold", type=float, default=0.85)
    parser.add_argument("--exclude", nargs="*", default=[])
    parser.add_argument("--with-scores", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    result = Wd14Tagger(args.model).tag(
        args.image,
        args.general_threshold,
        args.character_threshold,
        args.exclude,
        args.with_scores,
    )
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(f"model: {result['model']}  rating: {result['rating']}")
        for tag in result["tags"]:
            print(f"  {tag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
