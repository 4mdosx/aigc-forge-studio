"""WD14 打标。输入图片路径，返回 tags 和 Danbooru 四档 rating。"""

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

# Danbooru 四档，从低到高。最终档位取标签下限和模型 rating 里更高的一档。
LEVELS = ("general", "sensitive", "questionable", "explicit")
RANK = {name: index for index, name in enumerate(LEVELS)}

# 等级越高，标签要越确信才把整张图抬上去。
TAG_MIN_SCORE = {1: 0.40, 2: 0.45, 3: 0.50}
# rating head 是四路独立 sigmoid。最高分低于这个值时不计入。
MODEL_MIN_SCORE = 0.35

# 只收「出现就几乎必然不低于该档」的标签。
# 身体特征（large_breasts、thighs）和普通泳装不进表，避免正常图被抬级。
_SENSITIVE = (
    "cleavage", "sideboob", "underboob", "panties", "bra", "underwear", "lingerie",
    "covered_nipples", "panty_peek", "bra_peek", "skirt_lift", "shirt_lift", "dress_lift",
    "clothes_lift", "upskirt", "downblouse", "bra_lift", "underwear_only",
    "ass_visible_through_thighs", "micro_bikini", "slingshot_swimsuit", "thong",
    "g-string", "string_panties", "side-tie_panties", "no_bra",
    "garter_belt", "garter_straps", "fishnets", "see-through", "torn_clothes", "open_clothes",
    "playboy_bunny", "bondage", "shibari",
)
_QUESTIONABLE = (
    "nipples", "areolae", "nude", "completely_nude", "topless", "bottomless", "cameltoe",
    "pubic_hair", "no_panties", "nipple_slip", "areola_slip", "breasts_out", "one_breast_out",
    "naked_apron", "naked_shirt", "naked_towel", "public_nudity", "public_indecency",
    "exhibitionism", "ahegao", "sex_toy", "dildo", "vibrator", "condom",
    "covering_breasts", "covering_crotch", "nude_cover",
    "convenient_censoring", "bar_censor", "mosaic_censoring", "heart_censor",
    "steam_censor", "soap_censor", "hair_censor", "censored",
    "bdsm", "ball_gag", "femdom", "spanked", "netorare", "grabbing_another's_breast",
)
_EXPLICIT = (
    "penis", "pussy", "vagina", "vaginal", "anus", "testicles", "sex", "cum", "ejaculation",
    "fellatio", "cunnilingus", "paizuri", "cooperative_paizuri", "handjob", "footjob",
    "after_sex", "cum_in_pussy", "cum_on_body", "cum_on_breasts", "cum_in_mouth",
    "facial", "oral", "anal", "pussy_juice", "erection", "missionary", "doggystyle",
    "girl_on_top", "spread_pussy", "spread_anus", "fingering", "masturbation", "bukkake",
    "gangbang", "group_sex", "threesome", "double_penetration", "anal_object_insertion",
    "vaginal_object_insertion", "object_insertion", "irrumatio", "deepthroat",
    "breast_sucking", "nipple_tweak", "rape", "uncensored", "penetration",
    "sex_from_behind", "standing_sex",
)


def _norm(name: str) -> str:
    return " ".join(name.lower().replace("_", " ").split())


def _floor_table() -> dict[str, int]:
    table: dict[str, int] = {}
    for rank, names in ((1, _SENSITIVE), (2, _QUESTIONABLE), (3, _EXPLICIT)):
        for name in names:
            table[_norm(name)] = rank
    return table


TAG_FLOOR = _floor_table()

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


def rating_level(name: str) -> str | None:
    """rating head 的标签名归一成四档。general / rating_explicit 都能认。"""
    norm = _norm(name).removeprefix("rating ").strip()
    if norm in RANK:
        return norm
    return None


def grade(content: list[tuple[str, float]], rating_scores: dict[str, float]) -> dict:
    """按标签敏感度和模型 rating 给图片定 Danbooru 档。

    标签下限：敏感词表里，分数达到该档门槛的标签中的最高档。
    模型 rating：四档分数的最高档，最高分达到 MODEL_MIN_SCORE 才计入。
    最终档位是两者中更高的一档。
    """
    tag_rank = 0
    hits: list[tuple[str, float]] = []
    for name, score in content:
        rank = TAG_FLOOR.get(_norm(name))
        if rank is None or score < TAG_MIN_SCORE[rank]:
            continue
        if rank > tag_rank:
            tag_rank = rank
            hits = [(name, score)]
        elif rank == tag_rank:
            hits.append((name, score))
    hits.sort(key=lambda pair: pair[1], reverse=True)

    model_name = ""
    model_score = 0.0
    model_rank = 0
    if rating_scores:
        model_name = max(rating_scores, key=rating_scores.__getitem__)
        model_score = float(rating_scores[model_name])
        if model_score >= MODEL_MIN_SCORE:
            model_rank = RANK[model_name]
        else:
            model_name = ""

    final = max(tag_rank, model_rank)
    return {
        "rating": LEVELS[final],
        "rating_model": model_name,
        "rating_model_score": round(model_score, 5),
        "rating_tags": LEVELS[tag_rank],
        "rating_hits": [name for name, _ in hits],
    }


def _select_tags(
    scores,
    entries: list[tuple[str, int]],
    general_threshold: float = 0.35,
    character_threshold: float = 0.85,
    exclude_tags: list[str] | None = None,
) -> dict:
    if len(scores) != len(entries):
        raise ValueError(f"输出 {len(scores)} 维 != 标签表 {len(entries)} 行")
    exclude = {_norm(item) for item in (exclude_tags or [])}
    rating_scores: dict[str, float] = {}
    content: list[tuple[str, float]] = []
    picked: list[tuple[str, float]] = []
    for (name, category), score in zip(entries, scores):
        score = float(score)
        if category == CAT_RATING:
            level = rating_level(name)
            if level is not None and score > rating_scores.get(level, -1.0):
                rating_scores[level] = score
            continue
        norm = _norm(name)
        if norm in exclude:
            continue
        if category == CAT_CHARACTER:
            if score >= character_threshold:
                picked.append((name, score))
            continue
        if category != CAT_GENERAL:
            # artist / copyright 不进 caption（画师名污染风格数据集）
            continue
        content.append((name, score))
        if score >= general_threshold:
            picked.append((name, score))
    picked.sort(key=lambda pair: pair[1], reverse=True)
    return {"tags": [name for name, _ in picked], **grade(content, rating_scores)}


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
            raise FileNotFoundError(
                f"模型文件缺失: {model_dir}\n先运行 .venv/bin/python critic/install.py"
            )
        self._session = ort.InferenceSession(str(model_file), providers=["CPUExecutionProvider"])
        self._input_name = self._session.get_inputs()[0].name
        self._entries = _parse_tags_csv(tags_file)
