#!/usr/bin/env python3
"""critic — 本地 HTTP 服务：WD14 打标 + 风格向量。

接口：
    GET  /health
    POST /prepare {"path": "...", "out": "..."}  # 预处理 PNG
    POST /tag     {"path": "...", "model": "...", "general_threshold": 0.35,
                   "character_threshold": 0.85, "exclude": [], "with_scores": false}
    POST /embed   {"path": "...", "ref": "...", "device": "auto"}
    POST /close   {"a": "...", "b": "..."}   # 两图风格距离（L2 + cosine）

运行（仓库根目录的 .venv）：
    .venv/bin/python critic/server.py --port 8791

仅处理本地路径图片。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from flask import Flask, jsonify, request

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from critic import embed as embedder
from critic import models
from critic import tag as tagger

app = Flask(__name__)


def _resolve(path: str, field: str = "path") -> Path:
    if not isinstance(path, str) or not path.strip():
        raise ValueError(f"{field} 必须是非空字符串")
    image = Path(path).expanduser()
    if not image.is_absolute():
        image = (ROOT / image).resolve()
    if not image.is_file():
        raise FileNotFoundError(f"图片不存在: {image}")
    return image


def _body() -> dict:
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


@app.get("/health")
def health():
    gaps = [str(path.relative_to(ROOT)) for path in models.missing()]
    return jsonify(
        {
            "ok": True,
            "models_ready": not gaps,
            "models_missing": gaps,
            "taggers_loaded": tagger.loaded_models(),
            "embedder_loaded": embedder.loaded(),
            "embed_device": embedder.device(),
            "wd14_models": list(tagger.MODELS),
        }
    )


@app.post("/prepare")
def prepare_image():
    """按 profile 预处理并写成 PNG。供 runner 在打标 / embedding 之前落盘。"""
    try:
        data = _body()
        image = _resolve(data["path"])
        out_raw = data.get("out")
        if not isinstance(out_raw, str) or not out_raw.strip():
            raise ValueError("out 必须是非空路径")
        out = Path(out_raw).expanduser()
        if not out.is_absolute():
            out = (ROOT / out).resolve()
        else:
            out = out.resolve()
        if ROOT != out and ROOT not in out.parents:
            raise ValueError("out 必须在仓库内")
        from critic.preprocess import prepare

        prepared = prepare(image)
        out.parent.mkdir(parents=True, exist_ok=True)
        prepared.save(out, format="PNG")
        width, height = prepared.size
        return jsonify({"ok": True, "path": str(out), "width": width, "height": height})
    except KeyError:
        return jsonify({"ok": False, "error": "缺少 path"}), 400
    except (ValueError, FileNotFoundError) as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), 500


@app.post("/tag")
def tag():
    try:
        data = _body()
        image = _resolve(data["path"])
        result = tagger.tag(
            image,
            model=data.get("model", tagger.DEFAULT_MODEL),
            general_threshold=float(data.get("general_threshold", 0.35)),
            character_threshold=float(data.get("character_threshold", 0.85)),
            exclude=data.get("exclude", []),
            with_scores=bool(data.get("with_scores", False)),
        )
        return jsonify({"ok": True, **result})
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
        ref = _resolve(data["ref"], "ref") if data.get("ref") else None
        result = embedder.embed(image, ref=ref, device=data.get("device"))
        return jsonify({"ok": True, **result})
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
        result = embedder.close(
            _resolve(data["a"], "a"),
            _resolve(data["b"], "b"),
            device=data.get("device"),
        )
        return jsonify({"ok": True, **result})
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
    if models.report_missing() != 0:
        return 1
    app.run(host=args.host, port=args.port, threaded=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
