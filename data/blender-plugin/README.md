# Blender 插件真相源

这个目录是 Blender 工作台的唯一数据源。源码直接在编辑器里维护，工作台只读取、选 Scene、注入变量、运行。插件全部用 TypeScript 写，Runner 通过 MCP 调用 blender-mcp 完成 Blender 侧操作；仓库里没有 `.py` 文件。

```
data/blender-plugin/
├── types.d.ts                  # 插件上下文类型提示，只在编辑时生效
├── plugins/
│   └── <plugin-id>/
│       ├── manifest.json       # 名称、入口、变量 schema、可见源码
│       └── scripts/*.ts        # 编辑器维护的插件源码
├── scenes/                     # 可选 .blend 模板（不进版本库）
└── runs/                       # 运行记录与产物（不进版本库）
```

## manifest.json

- `id`：目录名，全局唯一。
- `entry`：入口 `.ts` 文件相对路径。
- `files`：工作台代码查看器可见的文件列表。
- `variables`：表单 schema。支持 `number`（含 min/max/step）、`string`、`boolean`、`select`（带 `options`）。

## 脚本约定

入口脚本导出 `run(ctx)`（具名或 default 均可）。Runner 用 Node 22 直接剥离类型并加载执行，ctx 提供：

- `ctx.vars`：工作台表单注入的变量，键与 `manifest.json` 的 `variables` 一致。
- `ctx.scene`：选中的 Scene 名或模板名；空值表示当前 Scene。
- `ctx.runId` / `ctx.pluginId` / `ctx.outputDir`：运行标识与产物目录。产物写 `outputDir`，不要写插件源码目录。
- `ctx.log(message)`：写运行日志。
- `ctx.mcp`：Blender 能力面，全部经由 blender-mcp 调用：
  - `mcp.call(name, args)`：调用任意 MCP 工具。
  - `mcp.code(source)`：逃生舱，把一段 bpy 代码交给 `execute_blender_code`。
  - `mcp.scene.open(filepath)` / `mcp.scene.select(name)`：打开模板 / 切换 Scene。
  - `mcp.objects.clear(prefix)` / `mcp.objects.boxes(items)`：清理物体 / 批量生成方块。
  - `mcp.render.to(filepath, options)`：渲染到指定路径。

类型声明在 `types.d.ts`，插件里 `import type { PluginContext } from '../../../types'` 即可。底层 bpy 代码由 Runner 的 `runner/src/blender/mcp-tools.ts` 生成，插件作者不写 Python。

## Scene 来源

工作台的 Scene 列表合并两处：

1. Blender 当前打开的 `.blend` 里的 Scene 名（经 blender-mcp 读取）。
2. `data/blender-plugin/scenes/*.blend` 里的文件名（模板）。

运行时若选的是模板文件，Runner 会先让 Blender 打开它，再执行插件脚本。选的是 Scene 名时只切换当前 Scene。
