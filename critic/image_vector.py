"""图片向量缓存。

runner 一次传入全部图片的 id → 向量，记在本进程里。
之后可按 cosine 查最近邻，或把指定的图片分成 m 组。
"""

from __future__ import annotations

import math
import threading

import numpy as np

from critic.embed import compare

_SKLEARN = "缺少 scikit-learn。先执行: .venv/bin/python -m pip install -r critic/requirements.txt"

_lock = threading.Lock()
_ids: list[str] = []
_matrix: np.ndarray | None = None
_pos: dict[str, int] = {}
_fitted = None


def cached() -> dict:
    with _lock:
        count = len(_ids)
        dim = int(_matrix.shape[1]) if _matrix is not None and count else 0
    return {"count": count, "dim": dim}


def load(vectors: dict) -> dict:
    """用这份 id → 向量整表替换缓存。"""
    ids, matrix = _table(vectors)
    fitted = _fit(matrix)
    with _lock:
        global _ids, _matrix, _pos, _fitted
        _ids = ids
        _matrix = matrix
        _pos = {image_id: index for index, image_id in enumerate(ids)}
        _fitted = fitted
    return cached()


def nearest(image_id: str, k: int = 10, *, order: str = "near") -> dict:
    """返回缓存里与这张图 cosine 最近或最远的其它图片，默认最近 10 条。"""
    if not isinstance(image_id, str) or image_id == "":
        raise ValueError("id 必须是非空字符串")
    if isinstance(k, bool) or not isinstance(k, int) or k < 1:
        raise ValueError("k 必须是正整数")
    if order not in ("near", "far"):
        raise ValueError("order 必须是 near 或 far")
    with _lock:
        if image_id not in _pos or _matrix is None or _fitted is None:
            raise ValueError(f"图片不在缓存中: {image_id}")
        ids = _ids
        matrix = _matrix
        fitted = _fitted
        origin = _pos[image_id]
    others = len(ids) - 1
    if others <= 0:
        return {"id": image_id, "neighbors": []}
    # 最远要看完全部，最近只取前 k 个再丢掉自己。
    ask = others + 1 if order == "far" else min(k, others) + 1
    _, indices = fitted.kneighbors(matrix[origin : origin + 1], n_neighbors=ask)
    query = matrix[origin].tolist()
    neighbors = []
    for index in indices[0]:
        index = int(index)
        if index == origin:
            continue
        neighbors.append({"id": ids[index], **compare(query, matrix[index].tolist())})
    if order == "far":
        neighbors.sort(key=lambda item: (item["cosine"], -item["l2"], item["id"]))
    else:
        neighbors.sort(key=lambda item: (-item["cosine"], item["l2"], item["id"]))
    return {"id": image_id, "neighbors": neighbors[:k]}


def split(ids: list, groups: int) -> dict:
    """把指定的图片按 cosine 分成恰好 groups 组。"""
    selected = _id_list(ids)
    if isinstance(groups, bool) or not isinstance(groups, int):
        raise ValueError("groups 必须是正整数")
    if groups < 1 or groups > len(selected):
        raise ValueError(f"groups 必须在 1 到 {len(selected)} 之间")
    with _lock:
        missing = [image_id for image_id in selected if image_id not in _pos]
        if missing or _matrix is None:
            raise ValueError(_missing(missing or selected))
        rows = _matrix[[_pos[image_id] for image_id in selected]]
    labels = _labels(rows, groups)
    packed = _pack(selected, labels)
    if len(packed) != groups:
        raise RuntimeError(f"分组结果是 {len(packed)} 组，期望 {groups} 组")
    return {"groups": packed}


def _table(vectors: dict) -> tuple[list[str], np.ndarray]:
    if not isinstance(vectors, dict) or not vectors:
        raise ValueError("vectors 必须是非空的 {图片 id: 向量}")
    ids: list[str] = []
    rows: list[list[float]] = []
    dim: int | None = None
    for image_id, raw in vectors.items():
        if not isinstance(image_id, str) or image_id == "":
            raise ValueError("图片 id 必须是非空字符串")
        values = _vector(raw, image_id)
        if dim is None:
            dim = len(values)
        elif len(values) != dim:
            raise ValueError(f"向量维度不一致: {image_id} 是 {len(values)} 维，其余是 {dim} 维")
        ids.append(image_id)
        rows.append(values)
    matrix = np.asarray(rows, dtype=np.float64)
    zero_at = np.flatnonzero(np.linalg.norm(matrix, axis=1) == 0)
    if zero_at.size:
        raise ValueError(f"向量不能是零向量: {ids[int(zero_at[0])]}")
    return ids, matrix


def _vector(raw, image_id: str) -> list[float]:
    if not isinstance(raw, list) or not raw:
        raise ValueError(f"向量必须是非空数值数组: {image_id}")
    values: list[float] = []
    for item in raw:
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            raise ValueError(f"向量必须是数值数组: {image_id}")
        value = float(item)
        if not math.isfinite(value):
            raise ValueError(f"向量含非有限数值: {image_id}")
        values.append(value)
    return values


def _id_list(ids: list) -> list[str]:
    if not isinstance(ids, list) or not ids:
        raise ValueError("ids 必须是非空的图片 id 数组")
    selected: list[str] = []
    seen: set[str] = set()
    for image_id in ids:
        if not isinstance(image_id, str) or image_id == "":
            raise ValueError("ids 里的图片 id 必须是非空字符串")
        if image_id in seen:
            raise ValueError(f"ids 有重复: {image_id}")
        seen.add(image_id)
        selected.append(image_id)
    return selected


def _missing(ids: list[str]) -> str:
    shown = ", ".join(ids[:8])
    if len(ids) > 8:
        shown += f" 等 {len(ids)} 个"
    return f"图片不在缓存中: {shown}"


def _fit(matrix: np.ndarray):
    model = _symbol("sklearn.neighbors", "NearestNeighbors")
    fitted = model(metric="cosine", algorithm="brute")
    fitted.fit(matrix)
    return fitted


def _labels(rows: np.ndarray, groups: int) -> np.ndarray:
    count = int(rows.shape[0])
    if groups == 1:
        return np.zeros(count, dtype=int)
    if groups == count:
        return np.arange(count, dtype=int)
    model = _symbol("sklearn.cluster", "AgglomerativeClustering")
    return model(n_clusters=groups, metric="cosine", linkage="average").fit_predict(rows)


def _pack(ids: list[str], labels: np.ndarray) -> list[dict]:
    order: list[int] = []
    buckets: dict[int, list[str]] = {}
    for image_id, label in zip(ids, labels.tolist()):
        label = int(label)
        if label not in buckets:
            buckets[label] = []
            order.append(label)
        buckets[label].append(image_id)
    return [{"ids": buckets[label]} for label in order]


def _symbol(module: str, name: str):
    try:
        imported = __import__(module, fromlist=[name])
    except ImportError as exc:
        raise RuntimeError(_SKLEARN) from exc
    return getattr(imported, name)
