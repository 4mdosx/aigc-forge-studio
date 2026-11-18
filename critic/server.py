#!/usr/bin/env python3
"""critic — 本地 HTTP 服务：WD14 打标 + 风格向量。

接口：
    GET  /health
    POST /tag     {"path": "...", "model": "...", "general_threshold": 0.35,
                   "character_threshold": 0.85, "exclude": [], "with_scores": false}
    POST /embed   {"path": "...", "ref": "...", "device": "auto"}
    POST /close   {"a": "...", "b": "..."}   # 两图风格接近判定（L2 + cosine）

运行（仓库根目录的 .venv）：
    .venv/bin/python critic/server.py --port 8791

仅处理本地路径图片；SFW only。
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

from flask import Flask, jsonify, request

import style_score
import wd14_tag

ROOT = Path(__file__).resolve().parent.parent


app = Flask(__name__)

# 进程内单例，首次请求时加载（模型加载慢，不让启动卡住）
_taggers: dict[str, wd14_tag.Wd14Tagger] = {}
_embed_fn = None
_embed_device = None


def _resolve(path: str, field: str = "path") -> Path:
    if not isinstance(path, str) or not path.strip():
        raise ValueError(f"{field} 必须是非空字符串")
    p = Path(path).expanduser()
    if not p.is_absolute():
        p = (ROOT / p).resolve()
    if not p.is_file():
        raise FileNotFoundError(f"图片不存在: {p}")
    return p


def _tagger(model: str) -> wd14_tag.Wd14Tagger:
    if model not in _taggers:
        _taggers[model] = wd14_tag.Wd14Tagger(model)
    return _taggers[model]


def _embedder(device: str | None):
    global _embed_fn, _embed_device
    if _embed_fn is None:
        _embed_fn, _embed_device = style_score.load_predictor(device)
    return _embed_fn, _embed_device


def _compare(a: list[float], b: list[float]) -> dict:
    diff = [x - y for x, y in zip(a, b)]
    l2 = math.sqrt(sum(x * x for x in diff))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(x * x for x in b)) or 1.0
    cos = sum(x * y for x, y in zip(a, b)) / (na * nb)
    return {
        "l2": round(l2, 5),
        "cosine": round(cos, 5),
        "verdict": style_score._verdict(l2, cos),
    }


def _body() -> dict:
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


@app.get("/health")
def health():
    return jsonify(
        {
            "ok": True,
            "taggers_loaded": list(_taggers),
            "embedder_loaded": _embed_fn is not None,
            "embed_device": _embed_device,
            "wd14_models": list(wd14_tag.MODELS),
        }
    )


@app.post("/tag")
def tag():
    try:
        data = _body()
        image = _resolve(data["path"])
        model = data.get("model", wd14_tag.DEFAULT_MODEL)
        result = _tagger(model).tag(
            image,
            general_threshold=float(data.get("general_threshold", 0.35)),
            character_threshold=float(data.get("character_threshold", 0.85)),
            exclude_tags=data.get("exclude", []),
            with_scores=bool(data.get("with_scores", False)),
        )
        return jsonify({"ok": True, "image": str(image), **result})
    except KeyError:
        return jsonify({"ok": False, "error": "缺少 path"}), 400
    except (ValueError, FileNotFoundError) as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001 — HTTP 边界统一返回错误
        return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), 500


@app.post("/embed")
def embed():
    try:
        data = _body()
        image = _resolve(data["path"])
        embed_fn, device = _embedder(data.get("device"))
        result = {
            "ok": True,
            "image": str(image),
            "device": device,
            "styleVec": embed_fn(image),
        }
        if "ref" in data and data["ref"]:
            ref = _resolve(data["ref"], "ref")
            ref_vec = embed_fn(ref)
            result["ref"] = {
                "image": str(ref),
                "styleVec": ref_vec,
                **_compare(result["styleVec"], ref_vec),
            }
        return jsonify(result)
    except KeyError:
        return jsonify({"ok": False, "error": "缺少 path"}), 400
    except (ValueError, FileNotFoundError) as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), 500


@app.post("/close")
def close():
    try:
        data = _body()
        a = _resolve(data["a"], "a")
        b = _resolve(data["b"], "b")
        embed_fn, device = _embedder(data.get("device"))
        return jsonify(
            {
                "ok": True,
                "a": str(a),
                "b": str(b),
                "device": device,
                **_compare(embed_fn(a), embed_fn(b)),
            }
        )
    except KeyError as exc:
        return jsonify({"ok": False, "error": f"缺少 {exc.args[0]}"}), 400
    except (ValueError, FileNotFoundError) as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), 500


def main() -> int:
    parser = argparse.ArgumentParser(description="critic 本地 HTTP 服务")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8791)
    args = parser.parse_args()
    app.run(host=args.host, port=args.port, threaded=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
