"""检索质量评测：不依赖人工标注，用两套代理真值。

- 内容：WD14 tag 的 Jaccard。同角色、同场景 → 高。
- 风格：source_url 相同（同一 pixiv 作品）→ 视为同风格。

用法：
    .venv/bin/python scripts_and_tools/eval_retrieval.py
    .venv/bin/python scripts_and_tools/eval_retrieval.py --versions dinov3-cls-224-v1
    .venv/bin/python scripts_and_tools/eval_retrieval.py --k 5,10,20 --groups 6,10

指标都是「top-k 邻居与真值的平均重合 ÷ 随机基线」，1.0 等于随机。
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import numpy as np


def parse_csv(raw: str) -> list[int]:
    out = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        value = int(part)
        if value < 1:
            raise argparse.ArgumentTypeError("必须正整数")
        out.append(value)
    if not out:
        raise argparse.ArgumentTypeError("至少要一个值")
    return out


def load(db_path: Path) -> dict:
    db = sqlite3.connect(db_path)
    rows = db.execute(
        "select id, tags_json, source_url from image_assets order by created_at"
    ).fetchall()
    ids = [row[0] for row in rows]
    tags = [set(__import__("json").loads(row[1] or "[]")) for row in rows]
    urls = [row[2] for row in rows]
    vectors: dict[str, dict[str, np.ndarray]] = defaultdict(dict)
    for asset_id, version, vec in db.execute(
        "select asset_id, model_version, vec from image_vectors"
    ):
        vectors[version][asset_id] = np.frombuffer(vec, dtype=np.float32)
    return {"ids": ids, "tags": tags, "urls": urls, "vectors": dict(vectors)}


def tag_matrix(tags: list[set[str]]) -> np.ndarray:
    vocab = sorted({tag for row in tags for tag in row})
    column = {tag: index for index, tag in enumerate(vocab)}
    table = np.zeros((len(tags), len(vocab)), dtype=np.float32)
    for index, row in enumerate(tags):
        for tag in row:
            table[index, column[tag]] = 1
    counts = table.sum(axis=1)
    inter = table @ table.T
    union = counts[:, None] + counts[None, :] - inter
    return np.divide(inter, union, out=np.zeros_like(inter), where=union > 0)


def same_matrix(urls: list[str]) -> np.ndarray:
    groups: dict[str, list[int]] = defaultdict(list)
    for index, url in enumerate(urls):
        if url:
            groups[url].append(index)
    same = np.zeros((len(urls), len(urls)), dtype=bool)
    for members in groups.values():
        for left in members:
            for right in members:
                if left != right:
                    same[left, right] = True
    return same


def unit(matrix: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(matrix, axis=1, keepdims=True)
    norm[norm == 0] = 1.0
    return matrix / norm


def evaluate(
    name: str,
    vectors: dict[str, np.ndarray],
    ids: list[str],
    jac: np.ndarray,
    same: np.ndarray,
    base_jac: float,
    base_same: float,
    ks: list[int],
    group_counts: list[int],
    samples: int,
) -> None:
    index = [i for i, image_id in enumerate(ids) if image_id in vectors]
    if len(index) < max(ks) + 1:
        print(f"{name}: 只有 {len(index)} 张有向量，跳过")
        return
    matrix = np.stack([vectors[ids[i]] for i in index])
    dim = matrix.shape[1]
    z = unit(matrix.astype(np.float64))
    sim = z @ z.T
    np.fill_diagonal(sim, -np.inf)
    rng = np.random.default_rng(0)
    picks = rng.choice(len(index), size=min(samples, len(index)), replace=False)
    orig = np.asarray(index)
    parts = [f"{name:24s} dim={dim:5d}"]
    for k in ks:
        top = np.argpartition(-sim[picks], k, axis=1)[:, :k]
        rows = orig[picks]
        cols = orig[top]
        tag_hit = float(jac[rows[:, None], cols].mean())
        same_hit = float(same[rows[:, None], cols].mean())
        parts.append(
            f"tagJ@{k}={tag_hit:.3f}({tag_hit / base_jac:.2f}x) "
            f"同源@{k}={same_hit:.3f}({same_hit / base_same:.1f}x)"
        )
    if group_counts:
        from critic.image_vector import _cluster_chunks

        pairs = np.argwhere(np.triu(same, 1))
        local = {int(value): position for position, value in enumerate(index)}
        pairs = np.asarray(
            [(local[int(a)], local[int(b)]) for a, b in pairs if int(a) in local and int(b) in local]
        )
        for groups in group_counts:
            chunks = _cluster_chunks(z, groups)
            label = np.zeros(len(index), dtype=int)
            for group_index, members in enumerate(chunks):
                for member in members:
                    label[member] = group_index
            recall = (
                float((label[pairs[:, 0]] == label[pairs[:, 1]]).mean())
                if len(pairs)
                else 0.0
            )
            sizes = sorted((len(chunk) for chunk in chunks), reverse=True)
            parts.append(f"k={groups} 同源召回={recall:.3f} {sizes[:4]}")
    print(" ".join(parts), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="检索质量评测")
    parser.add_argument("--db", default=str(ROOT / "data" / "runner.sqlite"))
    parser.add_argument("--versions", default="", help="要评的 model_version，逗号分隔；默认全部")
    parser.add_argument("--k", default="10,20", type=parse_csv)
    parser.add_argument("--groups", default="6,10", type=parse_csv)
    parser.add_argument("--samples", type=int, default=400, help="抽多少张做查询")
    args = parser.parse_args()

    data = load(Path(args.db))
    ids = data["ids"]
    jac = tag_matrix(data["tags"])
    same = same_matrix(data["urls"])
    off = ~np.eye(len(ids), dtype=bool)
    base_jac = float(jac[off].mean())
    base_same = float(same[off].mean())
    print(f"图片 {len(ids)} 张 · tag 基线 {base_jac:.4f} · 同源基线 {base_same:.4f}")

    wanted = [v.strip() for v in args.versions.split(",") if v.strip()]
    versions = wanted or sorted(
        data["vectors"], key=lambda v: len(data["vectors"][v]), reverse=True
    )
    for version in versions:
        vectors = data["vectors"].get(version)
        if not vectors:
            print(f"{version}: 没有向量")
            continue
        evaluate(
            version,
            vectors,
            ids,
            jac,
            same,
            base_jac,
            base_same,
            args.k,
            args.groups,
            args.samples,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
