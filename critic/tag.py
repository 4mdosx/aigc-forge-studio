"""WD14 打标。输入图片路径，返回 tags / rating。"""

from __future__ import annotations

import csv
from pathlib import Path

from critic.preprocess import wd14_tensor

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "data" / "models" / "wd14"

MODELS = {
    "wd-eva02-large-tagger-v3": 448,
    "wd-v1-4-convnextv2-tagger-v2": 448,
}
DEFAULT_MODEL = "wd-eva02-large-tagger-v3"

CAT_GENERAL, CAT_CHARACTER, CAT_RATING = 0, 4, 9

_taggers: dict[str, "Wd14Tagger"] = {}


def loaded_models() -> list[str]:
    return list(_taggers)


def tag(
    path: str | Path,
    *,
    model: str = DEFAULT_MODEL,
    general_threshold: float = 0.35,
    character_threshold: float = 0.85,
    exclude: list[str] | None = None,
    with_scores: bool = False,
) -> dict:
    image = _image(path)
    result = _tagger(model).run(
        image,
        general_threshold=general_threshold,
        character_threshold=character_threshold,
        exclude_tags=exclude,
        with_scores=with_scores,
    )
    return {"image": str(image), **result}


def _image(path: str | Path) -> Path:
    if not isinstance(path, (str, Path)) or not str(path).strip():
        raise ValueError("path 必须是非空路径")
    image = Path(path).expanduser()
    if not image.is_file():
        raise FileNotFoundError(f"图片不存在: {image}")
    return image


def _tagger(model: str) -> "Wd14Tagger":
    if model not in _taggers:
        _taggers[model] = Wd14Tagger(model)
    return _taggers[model]


def _parse_tags_csv(path: Path) -> list[tuple[str, int]]:
    entries: list[tuple[str, int]] = []
    with path.open(encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle)
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


def _select_tags(
    scores,
    entries: list[tuple[str, int]],
    general_threshold: float = 0.35,
    character_threshold: float = 0.85,
    exclude_tags: list[str] | None = None,
) -> dict:
    if len(scores) != len(entries):
        raise ValueError(f"输出 {len(scores)} 维 != 标签表 {len(entries)} 行")
    exclude = {" ".join(item.lower().replace("_", " ").split()) for item in (exclude_tags or [])}
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
    """进程内懒加载，每个模型一个 onnxruntime session。"""

    def __init__(self, model_id: str = DEFAULT_MODEL):
        if model_id not in MODELS:
            raise ValueError(f"未知模型 {model_id}；可选 {list(MODELS)}")
        self.model_id = model_id
        self.size = MODELS[model_id]
        self._session = None
        self._input_name = None
        self._entries: list[tuple[str, int]] | None = None

    def run(
        self,
        image_path: Path,
        general_threshold: float = 0.35,
        character_threshold: float = 0.85,
        exclude_tags: list[str] | None = None,
        with_scores: bool = False,
    ) -> dict:
        self._ensure()
        tensor = wd14_tensor(image_path, self.size)
        scores = self._session.run(None, {self._input_name: tensor})[0].reshape(-1)
        result = _select_tags(
            scores,
            self._entries,
            general_threshold,
            character_threshold,
            exclude_tags,
        )
        result["model"] = self.model_id
        if with_scores:
            result["scores"] = [
                {"name": name, "category": category, "score": round(float(score), 5)}
                for (name, category), score in zip(self._entries, scores)
            ]
        return result

    def _ensure(self):
        if self._session is not None:
            return
        import onnxruntime as ort

        model_dir = MODELS_DIR / self.model_id
        model_file = model_dir / "model.onnx"
        tags_file = model_dir / "selected_tags.csv"
        if not model_file.is_file() or not tags_file.is_file():
            raise FileNotFoundError(f"模型文件缺失: {model_dir}")
        self._session = ort.InferenceSession(str(model_file), providers=["CPUExecutionProvider"])
        self._input_name = self._session.get_inputs()[0].name
        self._entries = _parse_tags_csv(tags_file)
