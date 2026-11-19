"""critic 运行所需的模型文件。server 启动时检查，install.py 负责下载。"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "data" / "models"

# (repo, 远端文件名, 相对 data/models 的落地路径)
FILES: tuple[tuple[str, str, str], ...] = (
    (
        "SmilingWolf/wd-eva02-large-tagger-v3",
        "model.onnx",
        "wd14/wd-eva02-large-tagger-v3/model.onnx",
    ),
    (
        "SmilingWolf/wd-eva02-large-tagger-v3",
        "selected_tags.csv",
        "wd14/wd-eva02-large-tagger-v3/selected_tags.csv",
    ),
    (
        "bschooled/dinov3-vith16plus-pretrain-lvd1689m",
        "config.json",
        "style-embedder/dinov3-vith16plus/config.json",
    ),
    (
        "bschooled/dinov3-vith16plus-pretrain-lvd1689m",
        "preprocessor_config.json",
        "style-embedder/dinov3-vith16plus/preprocessor_config.json",
    ),
    (
        "bschooled/dinov3-vith16plus-pretrain-lvd1689m",
        "model.safetensors",
        "style-embedder/dinov3-vith16plus/model.safetensors",
    ),
    (
        "bschooled/dinov3-vith16plus-pretrain-lvd1689m",
        "LICENSE.md",
        "style-embedder/dinov3-vith16plus/LICENSE.md",
    ),
    (
        "Fgdfgfthgr/Anime_Images_Style_Embedder",
        "Style Embedder v4.safetensors",
        "style-embedder/Style_Embedder_v4.safetensors",
    ),
)

INSTALL_HINT = ".venv/bin/python critic/install.py"


def dest_of(relative: str) -> Path:
    return MODELS / relative


def missing() -> list[Path]:
    return [dest_of(relative) for _, _, relative in FILES if not dest_of(relative).is_file()]


def require() -> None:
    gaps = missing()
    if not gaps:
        return
    listed = "\n  ".join(_display(path) for path in gaps)
    raise FileNotFoundError(f"缺少模型文件：\n  {listed}\n先运行 {INSTALL_HINT}")


def report_missing() -> int:
    gaps = missing()
    if not gaps:
        print("模型已齐全")
        return 0
    print("模型不齐全:", file=sys.stderr)
    for path in gaps:
        print(f"  {_display(path)}", file=sys.stderr)
    print(f"先运行 {INSTALL_HINT}", file=sys.stderr)
    return 1


def install() -> int:
    pending = [
        (repo, filename, dest_of(relative))
        for repo, filename, relative in FILES
        if not dest_of(relative).is_file()
    ]
    if not pending:
        print("模型已齐全")
        return 0
    _prepare_download_env()
    try:
        from huggingface_hub import hf_hub_download
    except ImportError:
        print(
            "缺少 huggingface_hub。先执行: .venv/bin/python -m pip install -r critic/requirements.txt",
            file=sys.stderr,
        )
        return 1
    for repo, filename, dest in pending:
        print(f"下载 {filename} <- {repo}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(dest.name + ".part")
        try:
            cached = Path(hf_hub_download(repo_id=repo, filename=filename))
            shutil.copyfile(cached, part)
            os.replace(part, dest)
        except Exception:
            part.unlink(missing_ok=True)
            raise
        print(f"  {_display(dest)}")
    print("模型已安装")
    return 0


def _display(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def _prepare_download_env() -> None:
    if not os.environ.get("HF_ENDPOINT"):
        for key in ("CRITIC_HF_BASE", "WD14_HF_BASE"):
            value = os.environ.get(key, "").strip().rstrip("/")
            if value:
                os.environ["HF_ENDPOINT"] = value
                break
    if os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy"):
        return
    for key in ("CRITIC_PROXY", "WD14_PROXY", "CAPTURE_PROXY"):
        value = os.environ.get(key, "").strip()
        if value:
            os.environ["HTTPS_PROXY"] = value
            os.environ["HTTP_PROXY"] = value
            return
