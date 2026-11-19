#!/usr/bin/env python3
"""下载 critic 需要的模型到 data/models。已存在的文件跳过。

    .venv/bin/python critic/install.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from critic.models import install


if __name__ == "__main__":
    sys.exit(install())
