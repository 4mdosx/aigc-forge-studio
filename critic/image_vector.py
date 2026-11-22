"""图片向量：进程内 upsert 缓存 + 暴力 cosine 查询 + 分组。

设计要点：
- 缓存是 upsert，不是整表替换。查询时用 ids 显式限定候选集，所以两个请求
  各自的筛选范围互不影响（旧实现 load 即覆盖，并发会把别人的池子冲掉）。
- 维度与 modelVersion 都记在缓存上，不一致直接报错，不静默混用。
- 查询走 numpy 矩阵乘：几千张 × 几维是亚毫秒级，不需要索引。
- 分组是纯函数，向量由调用方传入；不读缓存，也就没有并发问题。
"""

from __future__ import annotations

import math
import threading
import uuid

import numpy as np

_MISSING_SCIPY = "缺少 scipy。先执行: .venv/bin/python -m pip install -r critic/requirements.txt"

BALANCES = ("cluster", "even")

_lock = threading.RLock()
_ids: list[str] = []
_pos: dict[str, int] = {}
_matrix: np.ndarray | None = None
_count = 0
_version = ""
_generation = uuid.uuid4().hex


def state() -> dict:
    with _lock:
        dim = int(_matrix.shape[1]) if _matrix is not None and _count else 0
        return {
            "count": _count,
            "dim": dim,
            "modelVersion": _version,
            "generation": _generation,
        }


def cached() -> dict:
    """旧名字，/health 仍在用。"""
    return state()


def reset() -> dict:
    with _lock:
        global _ids, _pos, _matrix, _count, _version, _generation
        _ids = []
        _pos = {}
        _matrix = None
        _count = 0
        _version = ""
        _generation = uuid.uuid4().hex
        return state()


def sync(vectors: dict, model_version: str = "") -> dict:
    """把这份 id → 向量并进缓存。已有的 id 覆盖，新 id 追加。

    维度和 modelVersion 必须和缓存一致；不一致时报错而不是悄悄混进去。
    """
    if model_version is not None and not isinstance(model_version, str):
        raise ValueError("modelVersion 必须是字符串")
    version = model_version or ""
    ids, matrix = _table(vectors)
    dim = int(matrix.shape[1])
    with _lock:
        global _version
        if _matrix is not None and _count:
            if dim != int(_matrix.shape[1]):
                raise ValueError(
                    f"向量维度不一致：缓存是 {int(_matrix.shape[1])} 维，请求是 {dim} 维；"
                    "换模型后先 POST /image-vector/reset"
                )
            if _version and version and version != _version:
                raise ValueError(
                    f"向量模型不一致：缓存是 {_version}，请求是 {version}；"
                    "先 POST /image-vector/reset 再灌新向量"
                )
        else:
            _grow(dim, len(ids))
        added = 0
        updated = 0
        for offset, image_id in enumerate(ids):
            row = matrix[offset]
            index = _pos.get(image_id)
            if index is None:
                _grow(dim, _count + 1)
                assert _matrix is not None
                _matrix[_count] = row
                _pos[image_id] = _count
                _ids.append(image_id)
                added += 1
                _bump()
            else:
                assert _matrix is not None
                if not np.array_equal(_matrix[index], row):
                    _matrix[index] = row
                    updated += 1
        if not _version and version:
            _version = version
        return {
            "count": _count,
            "dim": dim,
            "modelVersion": _version,
            "added": added,
            "updated": updated,
        }


def nearest(
    image_id: str,
    k: int = 10,
    *,
    order: str = "near",
    only=None,
) -> dict:
    """返回缓存里与这张图 cosine 最近或最远的其它图片。

    only 给定时只在这些 id 里找，候选集在查询这一侧过滤。
    """
    if not isinstance(image_id, str) or image_id == "":
        raise ValueError("id 必须是非空字符串")
    if isinstance(k, bool) or not isinstance(k, int) or k < 1:
        raise ValueError("k 必须是正整数")
    if order not in ("near", "far"):
        raise ValueError("order 必须是 near 或 far")
    scope = _scope(only)
    with _lock:
        if _matrix is None or image_id not in _pos:
            raise ValueError(f"图片不在缓存中: {image_id}")
        origin = _pos[image_id]
        ids = _ids
        rows = _matrix
        count = _count
        if scope is None:
            candidates = np.arange(count, dtype=np.int64)
        else:
            candidates = np.array(
                sorted({_pos[item] for item in scope if item in _pos}),
                dtype=np.int64,
            )
    candidates = candidates[candidates != origin]
    if candidates.size == 0:
        return {"id": image_id, "neighbors": []}
    query = rows[origin]
    norm = float(np.linalg.norm(query))
    if norm == 0:
        raise ValueError(f"图片向量是零向量: {image_id}")
    block = rows[candidates]
    norms = np.linalg.norm(block, axis=1)
    norms[norms == 0] = 1.0
    sims = (block @ query) / (norms * norm)
    take = min(k, int(candidates.size))
    if order == "far":
        picked = np.argpartition(sims, take - 1)[:take]
    else:
        picked = np.argpartition(-sims, take - 1)[:take]
    neighbors = []
    for offset in picked:
        index = int(candidates[int(offset)])
        neighbors.append(
            {
                "id": ids[index],
                "cosine": round(float(sims[int(offset)]), 5),
                "l2": round(float(np.linalg.norm(query - rows[index])), 5),
            }
        )
    if order == "far":
        neighbors.sort(key=lambda item: (item["cosine"], -item["l2"], item["id"]))
    else:
        neighbors.sort(key=lambda item: (-item["cosine"], item["l2"], item["id"]))
    return {"id": image_id, "neighbors": neighbors[:k]}


def split(
    ids: list,
    groups: int,
    *,
    vectors: dict | None = None,
    balance: str = "cluster",
) -> dict:
    """把这些图片分成 groups 组。

    balance="cluster"（默认）跑 ward 层次聚类，组大小均衡且语义正确；
    balance="even" 沿叶子顺序等分，组大小整齐，但边界会切进密集区。
    每组附一个 centerId（组内到其它成员平均相似度最高的那张）。
    """
    selected = _id_list(ids)
    if isinstance(groups, bool) or not isinstance(groups, int):
        raise ValueError("groups 必须是正整数")
    if groups < 1 or groups > len(selected):
        raise ValueError(f"groups 必须在 1 到 {len(selected)} 之间")
    if balance not in BALANCES:
        raise ValueError(f"balance 必须是 {' 或 '.join(BALANCES)}")
    table = vectors if vectors is not None else _snapshot(selected)
    rows, ordered = _rows_for(table, selected)
    if balance == "even":
        chunks = _even_chunks(rows, groups)
    else:
        chunks = _cluster_chunks(rows, groups)
    packed = []
    for chunk in chunks:
        packed.append(
            {
                "ids": [ordered[index] for index in chunk],
                "centerId": _medoid(rows, chunk, ordered),
            }
        )
    if len(packed) != groups:
        raise RuntimeError(f"分组结果是 {len(packed)} 组，期望 {groups} 组")
    return {"groups": packed, "balance": balance}


def _scope(only) -> list[str] | None:
    if only is None:
        return None
    if not isinstance(only, list):
        raise ValueError("ids 必须是图片 id 数组")
    scope: list[str] = []
    for item in only:
        if not isinstance(item, str) or item == "":
            raise ValueError("ids 里的图片 id 必须是非空字符串")
        scope.append(item)
    return scope


def _snapshot(ids: list[str]) -> dict:
    with _lock:
        if _matrix is None:
            raise ValueError("缓存是空的")
        missing = [item for item in ids if item not in _pos]
        if missing:
            raise ValueError(_missing(missing))
        return {item: _matrix[_pos[item]].tolist() for item in ids}


def _rows_for(table: dict, ids: list[str]) -> tuple[np.ndarray, list[str]]:
    if not isinstance(table, dict):
        raise ValueError("vectors 必须是 {图片 id: 向量}")
    ordered: list[str] = []
    rows: list[list[float]] = []
    dim: int | None = None
    for image_id in ids:
        if image_id not in table:
            raise ValueError(_missing([image_id]))
        values = _vector(table[image_id], image_id)
        if dim is None:
            dim = len(values)
        elif len(values) != dim:
            raise ValueError(f"向量维度不一致: {image_id} 是 {len(values)} 维，其余是 {dim} 维")
        ordered.append(image_id)
        rows.append(values)
    matrix = np.asarray(rows, dtype=np.float64)
    zero_at = np.flatnonzero(np.linalg.norm(matrix, axis=1) == 0)
    if zero_at.size:
        raise ValueError(f"向量不能是零向量: {ordered[int(zero_at[0])]}")
    return matrix, ordered


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


def _grow(dim: int, need: int) -> None:
    global _matrix
    if _matrix is not None and _matrix.shape[0] >= need and _matrix.shape[1] == dim:
        return
    if _matrix is not None and _matrix.shape[1] != dim:
        raise ValueError("向量维度不一致")
    capacity = max(16, _matrix.shape[0] if _matrix is not None else 0)
    while capacity < need:
        capacity *= 2
    fresh = np.empty((capacity, dim), dtype=np.float64)
    if _matrix is not None and _count:
        fresh[:_count] = _matrix[:_count]
    _matrix = fresh


def _bump() -> None:
    global _count
    _count += 1


def _medoid(rows: np.ndarray, members: list[int], ordered: list[str]) -> str:
    block = _unit(rows[members])
    mean = (block @ block.T).mean(axis=1)
    return ordered[members[int(np.argmax(mean))]]


def _cluster_chunks(rows: np.ndarray, groups: int) -> list[list[int]]:
    """ward 层次聚类：最小化簇内方差。

    为什么不是 average-linkage：高维 cos 有集中效应，average 找不到有意义的
    切点，实测 1824 张 1280 维会退化成一个 1816 张的巨簇 + 一堆 1~3 张的
    离群点。ward 在 L2 归一化后的欧氏空间里工作，组大小均衡，
    同一 pixiv 作品的图被封到一起的比例从 0.572 涨到 0.878（k=6）。
    """
    count = int(rows.shape[0])
    if groups == 1:
        return [list(range(count))]
    if groups == count:
        return [[index] for index in range(count)]
    unit = _unit(rows)
    labels = _ward_labels(unit, groups)
    buckets: dict[int, list[int]] = {}
    for index, label in enumerate(labels.tolist()):
        buckets.setdefault(int(label), []).append(index)
    if len(buckets) != groups:
        raise RuntimeError(f"ward 分出 {len(buckets)} 组，期望 {groups} 组")
    chunks = [_row_order(unit, chunk) for chunk in buckets.values()]
    chunks.sort(key=lambda chunk: (-len(chunk), chunk[0]))
    return chunks


def _ward_labels(unit: np.ndarray, groups: int) -> np.ndarray:
    try:
        from sklearn.cluster import AgglomerativeClustering
    except ImportError as exc:
        raise RuntimeError(
            "缺少 scikit-learn。先执行: .venv/bin/python -m pip install -r critic/requirements.txt"
        ) from exc
    model = AgglomerativeClustering(n_clusters=groups, linkage="ward")
    return model.fit_predict(unit)


def _row_order(unit: np.ndarray, members: list[int]) -> list[int]:
    """组内按第一主成分排，视觉上相邻即相似。"""
    if len(members) < 3:
        return members[:]
    block = unit[members]
    centered = block - block.mean(axis=0)
    try:
        _, _, basis = np.linalg.svd(centered, full_matrices=False)
    except np.linalg.LinAlgError:
        return members[:]
    projection = centered @ basis[0]
    return [members[int(index)] for index in np.argsort(projection, kind="stable")]


def _unit(rows: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(rows, axis=1)
    norms[norms == 0] = 1.0
    return rows / norms[:, None]


def _even_chunks(rows: np.ndarray, groups: int) -> list[list[int]]:
    count = int(rows.shape[0])
    if groups == 1:
        return [list(range(count))]
    if groups == count:
        return [[index] for index in range(count)]
    order = _leaf_order(rows)
    base, extra = divmod(count, groups)
    chunks: list[list[int]] = []
    start = 0
    for group in range(groups):
        size = base + (1 if group < extra else 0)
        chunks.append(order[start : start + size])
        start += size
    return chunks


def _leaf_order(rows: np.ndarray) -> list[int]:
    """按平均 cosine 距离排出叶子顺序，风格接近的下标挨在一起。"""
    try:
        from scipy.cluster.hierarchy import leaves_list, linkage
    except ImportError as exc:
        raise RuntimeError(_MISSING_SCIPY) from exc
    linked = linkage(rows, method="average", metric="cosine")
    return [int(index) for index in leaves_list(linked)]
