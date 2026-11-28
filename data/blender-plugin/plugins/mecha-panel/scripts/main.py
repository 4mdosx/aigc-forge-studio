"""机甲面板生成器 — 通过 Runner 注入的 VARS 参数化运行。

约定：
- VARS: dict，工作台表单注入的变量（键名与 manifest.json 的 variables 对应）
- CTX: dict，运行时上下文（runId、pluginId、scene、repoRoot、outputDir）
- 脚本可用 bpy；执行体由 Runner 包装后在 Blender 主线程运行。
- 返回值用 print 输出即可，Runner 会收进运行日志。
"""

import bpy
import math
import random
import os

vars_in = globals().get("VARS", {})
ctx = globals().get("CTX", {})

count = int(vars_in.get("count", 6))
width = float(vars_in.get("width", 0.8))
seed = int(vars_in.get("seed", 1))
prefix = str(vars_in.get("prefix", "Panel"))
clear_existing = bool(vars_in.get("clearExisting", True))

rng = random.Random(seed)

if clear_existing:
    for obj in list(bpy.data.objects):
        if obj.name.startswith(prefix):
            bpy.data.objects.remove(obj, do_unlink=True)

created = []
for index in range(count):
    angle = (index / max(count, 1)) * math.tau
    depth = 0.6 + rng.random() * 0.9
    bpy.ops.mesh.primitive_cube_add(
        size=1.0,
        location=(math.cos(angle) * 1.8, math.sin(angle) * 1.8, depth),
    )
    obj = bpy.context.object
    obj.name = f"{prefix}_{index:02d}"
    obj.dimensions = (width, width * 0.35, 0.12 + rng.random() * 0.18)
    obj.rotation_euler.z = angle
    created.append(obj.name)

output_dir = ctx.get("outputDir")
if output_dir:
    os.makedirs(output_dir, exist_ok=True)
    report = os.path.join(output_dir, "report.txt")
    with open(report, "w", encoding="utf-8") as handle:
        handle.write("\n".join(created) + "\n")

print(f"created {len(created)} panels in scene {ctx.get('scene', '<active>')}")
