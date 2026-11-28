# Blender 插件真相源

这个目录是 Blender 工作台的唯一数据源。源码直接在编辑器里维护，工作台只读取、选 Scene、注入变量、运行。

```
data/blender-plugin/
├── plugins/
│   └── <plugin-id>/
│       ├── manifest.json       # 名称、入口、变量 schema、可见源码
│       └── scripts/*.py        # 编辑器维护的源码
├── scenes/                     # 可选 .blend 模板（不进版本库）
└── runs/                       # 运行记录与产物（不进版本库）
```

## manifest.json

- `id`：目录名，全局唯一。
- `entry`：入口脚本相对路径。
- `files`：工作台代码查看器可见的文件列表。
- `variables`：表单 schema。支持 `number`（含 min/max/step）、`string`、`boolean`、`select`（带 `options`）。

## 脚本约定

Runner 在 Blender 主线程里 `exec` 入口脚本，并注入两个全局变量：

- `VARS`：工作台表单注入的变量，键与 `manifest.json` 的 `variables` 一致。
- `CTX`：`runId`、`pluginId`、`scene`、`repoRoot`、`outputDir`。

脚本里 `print(...)` 的内容会进运行日志。写文件请落 `CTX["outputDir"]`，不要写到插件源码目录。

## Scene 来源

工作台的 Scene 列表合并两处：

1. Blender 当前打开的 `.blend` 里的 Scene 名（经 blender-mcp 读取）。
2. `data/blender-plugin/scenes/*.blend` 里的文件名（模板）。

运行时若选的是模板文件，Runner 会先让 Blender 打开它，再执行脚本。选的是 Scene 名时只切换当前 Scene。
