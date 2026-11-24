#!/usr/bin/env node
/**
 * aigc-runner MCP —— 把 aigc-forge-studio 的 runner 收成 agent 能直接用的工具集。
 *
 * 三条设计原则：
 *   1. 自说明。每个 tool 的 description 写清「干什么 / 什么时候用 / 有没有副作用 /
 *      返回什么」，参数逐个带 description；接入前调一次 runner_manual 读整篇手册。
 *   2. 薄。判断全在 runner 里（版本解析、adapter 匹配、姿态上传、prompt 组装），
 *      这里只做 HTTP 转发和少量裁剪——重复实现一套业务逻辑迟早和 runner 分叉。
 *   3. 生成类一律「提交即返回」，不阻塞等图。等图由 wait_tasks 显式做。
 *
 * 启动：node runner/mcp/server.mjs（stdio），RUNNER_URL 默认 http://127.0.0.1:8787
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const RUNNER = (process.env.RUNNER_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '')

// ---------------------------------------------------------------- HTTP 转发

async function api(path, { method = 'GET', body, timeout = 30000 } = {}) {
  const url = `${RUNNER}${path}`
  let res
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    })
  } catch (err) {
    throw new Error(
      `runner 不可达（${url}）：${err instanceof Error ? err.message : String(err)}\n` +
        '检查：runner 进程在不在（cd ~/workspace/AIGC/aigc-forge-studio/runner && npm run dev），' +
        `或 RUNNER_URL 是否该改成别的地址（当前 ${RUNNER}）`,
    )
  }
  const text = await res.text()
  let data = null
  if (text !== '') {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? data.error
        : typeof data === 'string'
          ? data
          : JSON.stringify(data)
    throw new Error(`HTTP ${res.status} ${method} ${path} → ${message}`)
  }
  return data
}

const enc = encodeURIComponent
const qs = (params) => {
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') search.set(k, String(v))
  }
  const s = search.toString()
  return s === '' ? '' : `?${s}`
}

// ---------------------------------------------------------------- 手册（自说明正文）

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 手册放在 manual.md：它既是 agent 读的正文，也是给人看的文档，
// 放在模板字符串里迟早被反引号咬（第一版就是）。{{RUNNER}} 在启动时替换成实际地址。
const MANUAL = readFileSync(
  fileURLToPath(new URL('./manual.md', import.meta.url)),
  'utf8',
).replace('{{RUNNER}}', RUNNER)


// ---------------------------------------------------------------- 描述辅助

const NOTES = {
  readOnly: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  submit: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  create: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}

function uiNodeValue(ui, binding) {
  const nodes = (ui?.nodes ?? []).filter(
    (node) =>
      node &&
      typeof node === 'object' &&
      node.type === binding.class_type &&
      (!binding.name || node.title === binding.name),
  )
  if (nodes.length !== 1 || !binding.input) return undefined
  const named = nodes[0].widgets_values_named
  if (named && typeof named === 'object' && binding.input in named) {
    return named[binding.input]
  }
  return undefined
}

async function slotTable(workflowName, version, adapter) {
  let ui = null
  try {
    const revision = await api(`/workflows/${enc(workflowName)}/revisions/${enc(version)}`)
    ui = revision?.workflow ?? null
  } catch {
    // 拿不到 UI 也不该让 describe 整体失败：槽位名和节点仍然有用
  }
  const inputs = {}
  for (const [key, binding] of Object.entries(adapter?.inputs ?? {})) {
    inputs[key] = {
      node: `${binding.class_type}${binding.name ? ` "${binding.name}"` : ''}`,
      field: binding.input ?? null,
      ...(binding.upload ? { upload: true } : {}),
      ...(binding.map ? { map: binding.map } : {}),
      ...(ui ? { current: uiNodeValue(ui, binding) } : {}),
    }
  }
  return { inputs, outputs: adapter?.outputs ?? {}, prompt: adapter?.prompt ?? null }
}

async function describeWork(name) {
  const work = await api(`/works/${enc(name)}`)
  const workflows = []
  for (const wf of work.workflows ?? []) {
    const versions = wf.versions ?? []
    const head = versions.find((v) => v.head) ?? versions[versions.length - 1] ?? null
    workflows.push({
      workflow: wf.name,
      comfyPath: wf.comfyPath,
      versionCount: versions.length,
      head: head
        ? {
            version: head.version,
            message: head.message,
            createdAt: head.createdAt,
            adapterStatus: head.adapterStatus,
          }
        : null,
      slots: head?.adapter
        ? await slotTable(wf.name, head.version, head.adapter)
        : null,
      versions: versions.map((v) => ({
        version: v.version,
        head: v.head,
        main: v.main,
        hasAdapter: v.hasAdapter,
        createdAt: v.createdAt,
        message: v.message,
      })),
    })
  }
  return { work: work.name, semantic: work.semantic, workflows }
}

const LORA_FRAGMENT = /-\d{6}\.safetensors$/i
const LORA_VIDEO = /^(wan2\.2|ltx|hunyuan)/i
const LORA_UTIL = /^(More_brightness|dlss|4x)/i
const LORA_STRUCT = /^struct_pool/i

function groupLoras(names) {
  const style = []
  const struct = []
  const unusable = []
  for (const name of names) {
    if (LORA_FRAGMENT.test(name) || LORA_VIDEO.test(name) || LORA_UTIL.test(name)) {
      unusable.push(name)
    } else if (LORA_STRUCT.test(name)) {
      struct.push(name)
    } else {
      style.push(name)
    }
  }
  return { style, struct, unusable }
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timeout'])

async function taskWithFiles(id) {
  const task = await api(`/tasks/${enc(id)}`)
  let files = []
  if (task.status === 'completed') {
    try {
      const listed = await api(`/tasks/${enc(id)}/files`)
      files = (listed.files ?? []).map((path) => ({
        path,
        url: `${RUNNER}/tasks/${id}/files/${path}`,
      }))
    } catch {
      // 产物文件表在个别旧任务上缺失，不该让查询失败
    }
  }
  return { ...task, files }
}

// ---------------------------------------------------------------- 工具定义

const TOOLS = [
  {
    name: 'runner_manual',
    title: '读手册',
    annotations: NOTES.readOnly,
    description:
      '返回这个服务的使用手册（markdown）：三条生成路径怎么选、payload 每个槽位什么意思、' +
      '版本模型、产物怎么下载、六类常见报错对应什么原因、资源现状、以及四条别做的事。\n' +
      '什么时候用：**第一次接入，或准备写一长串生成调用之前**。读完再动手能省掉大部分 400。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => MANUAL,
  },
  {
    name: 'runner_status',
    title: '服务与 GPU 状态',
    annotations: NOTES.readOnly,
    description:
      '一次看清 runner 是否在跑、队列里有多少待跑/在跑的任务、ComfyUI 显存与训练机 GPU 情况。\n' +
      '返回 { runner, queue:{pending,running}, tasks:[...], gpu, comfy:{...} }。' +
      '提交任务前先看一眼，队列里堆着五六个时别再加。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const [tasks, gpu] = await Promise.all([
        api('/tasks'),
        api('/system/gpu').catch((err) => ({ error: String(err.message ?? err) })),
      ])
      const list = tasks.tasks ?? []
      return {
        runner: { url: RUNNER, ok: true },
        queue: {
          pending: list.filter((t) => t.status === 'pending').length,
          running: list.filter((t) => t.status === 'running').length,
        },
        tasks: list,
        gpu,
      }
    },
  },
  {
    name: 'list_works',
    title: '列出 works',
    annotations: NOTES.readOnly,
    description:
      '列出所有 work（跑图的最小单位）及各自挂的工作流。' +
      '已知：mecha=机娘立绘，character=角色直出，img2pose=图转骨架，inpaint=局部重绘，' +
      'refine=细化/战斗态，makeImage=底图生成，baseline=对照实验。\n' +
      '返回 [{ name, semantic, workflows:[{name, comfyPath}] }]。要参数细节接着 describe_work。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const data = await api('/works')
      return {
        works: (data.works ?? []).map((w) => ({
          name: w.name,
          // semantic 只留槽位名，完整契约在 describe_work
          slots: Object.keys(w.semantic?.inputs ?? {}),
          workflows: (w.workflows ?? []).map((x) => ({ name: x.name, comfyPath: x.comfyPath })),
        })),
      }
    },
  },
  {
    name: 'describe_work',
    title: 'work 的入参契约',
    annotations: NOTES.readOnly,
    description:
      '返回一个 work 下每个 workflow 的**完整入参槽位表**——这是调 run_work 的唯一依据。\n' +
      '每个槽位给出：对应节点（class_type + 标题）、字段名、是否走文件上传、当前值。' +
      '「当前值」就是你 payload 不交该 key 时会沿用的值。\n' +
      '同时返回全部版本（version / 是否 head / 是否绑了 adapter）。' +
      'adapterStatus 不是 ready 的版本不能跑。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'work 名，例如 "mecha"（先用 list_works 查）' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async ({ name }) => describeWork(name),
  },
  {
    name: 'list_workflows',
    title: '列出工作流',
    annotations: NOTES.readOnly,
    description:
      '列出库里所有 workflow：名字、ComfyUI 路径、main head 版本、版本总数。' +
      '不区分 work——同一个 workflow 可能被多个 work 挂。要槽位表用 describe_work。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const data = await api('/workflows')
      return {
        workflows: (data.workflows ?? []).map((w) => ({
          name: w.name,
          comfyPath: w.comfyPath,
          head: w.head,
          versionCount: Array.isArray(w.versions) ? w.versions.length : w.versionCount,
          works: w.works,
        })),
      }
    },
  },
  {
    name: 'list_poses',
    title: '姿态库',
    annotations: NOTES.readOnly,
    description:
      '列出可用姿态（骨架图 + 深度图成对），返回 id / 名字 / 分组 / 来源 / 生成画布尺寸。\n' +
      '**机娘立绘优先用 source="synthetic"**（自绘骨架，分组 mecha，5 站姿 + 6 持械）：' +
      '外部库那批是 3D 写实 depth，会带进八头身和地面灰带，还会跟骨架打架把脚裁掉。\n' +
      '把返回的 id 直接传给 run_work / quick_generate 的 pose 参数。',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: '按来源过滤，常见值 synthetic（自绘）、img2pose（自产）、openpose-lib（公开库）',
        },
        group: { type: 'string', description: '按动作分组过滤，例如 mecha（机娘站姿）、standing' },
        canvas: { type: 'string', description: '按画布比例过滤，例如 2:3、3:2' },
        limit: { type: 'integer', description: '最多返回多少条，默认 40，上限 480', minimum: 1, maximum: 480 },
      },
      additionalProperties: false,
    },
    handler: async ({ source, group, canvas, limit = 40 }) => {
      const data = await api(`/data/poses${qs({ enabled: true, source, canvas })}`)
      const poses = (data.poses ?? []).filter((p) => !group || p.poseName === group)
      return {
        total: poses.length,
        sources: data.sources ?? [],
        poses: poses.slice(0, limit).map((p) => {
          const variant = Object.values(p.variants ?? {}).find((v) => v?.gen)
          return {
            id: p.id,
            name: p.name,
            group: p.poseName,
            source: p.source,
            canvas: variant?.gen ?? null,
          }
        }),
        truncated: poses.length > limit,
      }
    },
  },
  {
    name: 'list_loras',
    title: '可用 LoRA',
    annotations: NOTES.readOnly,
    description:
      '列出 ComfyUI 上的 LoRA 并按可用性分组：style（可换画法）、struct（结构层，已在图里，别手动选）、' +
      'unusable（训练中间存档 / 视频 LoRA / 画质工具，滤掉了）。\n' +
      '默认配置已经挂了 gloss 1.0 + struct 0.8，**多数情况不用选**。' +
      '换画法只在 quick_generate 的 loraName 里给，会顶掉 gloss 槽但保留 struct。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const data = await api('/comfy/loras')
      const names = data.loras ?? []
      const grouped = groupLoras(names)
      return {
        total: names.length,
        default: 'workflow 里已绑 gloss 1.0 + struct 0.8，留空即用这套',
        ...grouped,
        unusableCount: grouped.unusable.length,
      }
    },
  },
  {
    name: 'run_work',
    title: '按 work 跑一次',
    annotations: NOTES.submit,
    description:
      '**主力工具**。用指定 work 的工作流跑一次生成：服务端取 main head 版本、找出该版本绑定的 ' +
      'adapter、把你交的 payload 填进槽位，其余槽位沿用工作流现值，然后进队列。\n' +
      '提交即返回（不阻塞），返回 task 对象；等图用 wait_tasks。\n' +
      'payload 里的 key 必须是 describe_work 列出的槽位名，多一个会报 unknown input。\n' +
      '机娘成品示例：{ work:"mecha", pose:"synth-stand-a", payload:{ positive:"heavy white armor, ' +
      'large pauldrons, black glossy bodysuit, gold mechanical joints, standing, looking at viewer" } }',
    inputSchema: {
      type: 'object',
      properties: {
        work: { type: 'string', description: 'work 名，例如 "mecha"' },
        workflow: {
          type: 'string',
          description: 'work 下的工作流名，缺省取该 work 挂的第一个；必须属于这个 work',
        },
        version: {
          type: 'string',
          description: '8 位版本 id，只在做版本对比时传；缺省跑 main head',
        },
        payload: {
          type: 'object',
          description:
            '槽位名 → 值。常见：positive / negative / seed（整数或 "random"）/ batch / ' +
            'skeleton_strength / depth_strength / gloss_strength / struct_strength',
          additionalProperties: true,
        },
        pose: {
          type: 'string',
          description:
            '姿态 id（list_poses 给）。服务端上传骨架+深度图并覆盖画布尺寸；工作流没有这两个槽位会报 400',
        },
        task: { type: 'string', description: '任务名（产物目录名），缺省自动生成 <work>-<8位>' },
        parentTaskId: { type: 'string', description: '父任务 id，用于把一组对照挂到同一个来源上' },
      },
      required: ['work'],
      additionalProperties: false,
    },
    handler: async ({ work, workflow, version, payload, pose, task, parentTaskId }) => {
      const body = {}
      if (workflow !== undefined) body.workflowName = workflow
      if (version !== undefined) body.version = version
      if (payload !== undefined) body.payload = payload
      if (pose !== undefined) body.pose = pose
      if (task !== undefined) body.task = task
      if (parentTaskId !== undefined) body.parentTaskId = parentTaskId
      const created = await api(`/works/${enc(work)}/run`, { method: 'POST', body })
      return {
        task: created,
        next: `wait_tasks({ ids:["${created.id}"] }) 等它跑完；产物 URL 在返回的 files 里`,
      }
    },
  },
  {
    name: 'quick_generate',
    title: '快速出图',
    annotations: NOTES.submit,
    description:
      '走前端「快速出图」那两条固定配方，不需要知道 work 和槽位：\n' +
      '- kind="cn"：双 ControlNet（骨架 1.0 + 深度 0.7），必须给 pose，全身入画稳定；\n' +
      '- kind="base"：纯文生图，构图自由但容易裁脚、比例飘。\n' +
      '两条都是 zero + gloss 1.0 + struct 0.8 / 832×1216 / 30 步 / cfg 5，**都不带 hires**。' +
      '想逐槽调强度、batch、seed 用 run_work("mecha")；想要 1248×1824 的精度目前只能走 ' +
      'scripts_and_tools/hires_face_probe.mjs（hires 还没冻进工作流）。返回 task 对象。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['cn', 'base'], description: 'cn=带 ControlNet（需 pose），base=纯文生图' },
        prompt: { type: 'string', description: '正面提示词。装备词要写全（heavy white armor / pauldrons / armored boots），只写 armor plates 会出紧身衣' },
        repeat: { type: 'integer', description: '一次出几张，1–16，默认 1', minimum: 1, maximum: 16 },
        loraName: { type: 'string', description: '换画法时才给（list_loras 的 style 组）；缺省沿用工作流里的 gloss' },
        pose: { type: 'string', description: '姿态 id，kind="cn" 时必填' },
      },
      required: ['kind', 'prompt'],
      additionalProperties: false,
    },
    handler: async ({ kind, prompt, repeat = 1, loraName, pose }) => {
      const body = { prompt, repeat }
      if (loraName !== undefined) body.loraName = loraName
      if (pose !== undefined) body.poseName = pose
      const created = await api(`/generate/${kind}`, { method: 'POST', body })
      return { task: created, next: `wait_tasks({ ids:["${created.id}"] })` }
    },
  },
  {
    name: 'sweep',
    title: '批量扫参数',
    annotations: NOTES.submit,
    description:
      '一次提交一组对照：给若干因子（每个因子是一串取值），做笛卡尔积，每个组合跑一次 run_work。\n' +
      '典型用法：扫 denoise 档 `factors:[{key:"denoise",values:[0.35,0.45,0.55]}]`；' +
      '扫 seed `factors:[{key:"seed",values:[101,102,103]}]`；组合 ' +
      '`factors:[{key:"gloss_strength",values:[0.8,1.2]},{key:"seed",values:[1,2,3]}]`。\n' +
      '上限 32 个任务（队列是串行的，每个约 1–2 分钟，别一次开太大）。' +
      '返回每个组合的 task 与 id 列表，适合直接喂给 wait_tasks。',
    inputSchema: {
      type: 'object',
      properties: {
        work: { type: 'string', description: 'work 名' },
        workflow: { type: 'string', description: 'work 下的工作流名，缺省第一个' },
        payload: { type: 'object', description: '所有组合共用的基础 payload', additionalProperties: true },
        factors: {
          type: 'array',
          description: '因子列表，每个 { key:"槽位名", values:[...] }',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: '槽位名，例如 denoise / seed / depth_strength' },
              values: { type: 'array', description: '这一档要扫的取值', items: {} },
            },
            required: ['key', 'values'],
            additionalProperties: false,
          },
        },
        pose: { type: 'string', description: '所有组合共用的姿态 id' },
        taskPrefix: { type: 'string', description: '任务名前缀，缺省 "<work>-sweep"' },
      },
      required: ['work', 'factors'],
      additionalProperties: false,
    },
    handler: async ({ work, workflow, payload = {}, factors, pose, taskPrefix }) => {
      if (!Array.isArray(factors) || factors.length === 0) {
        throw new Error('factors 至少要有一项，形如 [{ key:"denoise", values:[0.45,0.55] }]')
      }
      let combos = [{}]
      for (const factor of factors) {
        if (!factor?.key || !Array.isArray(factor.values) || factor.values.length === 0) {
          throw new Error('每个 factor 需要 key 和非空 values')
        }
        combos = combos.flatMap((combo) =>
          factor.values.map((value) => ({ ...combo, [factor.key]: value })),
        )
      }
      if (combos.length > 32) throw new Error(`组合数 ${combos.length} 超过上限 32，减少档位`)
      const prefix = taskPrefix ?? `${work}-sweep`
      const created = []
      for (const [index, combo] of combos.entries()) {
        const body = {
          payload: { ...payload, ...combo },
          task: `${prefix}-${String(index + 1).padStart(2, '0')}`,
        }
        if (workflow !== undefined) body.workflowName = workflow
        if (pose !== undefined) body.pose = pose
        const task = await api(`/works/${enc(work)}/run`, { method: 'POST', body })
        created.push({
          taskId: task.id,
          task: task.task,
          payload: Object.fromEntries(
            Object.entries(combo).map(([k, v]) => [k, v]),
          ),
        })
      }
      return {
        count: created.length,
        ids: created.map((item) => item.taskId),
        created,
        next: `wait_tasks({ ids:[...], timeoutSec:${created.length * 180} })`,
      }
    },
  },
  {
    name: 'get_task',
    title: '任务详情',
    annotations: NOTES.readOnly,
    description:
      '按 id 查一个任务：状态（pending / running / completed / failed / cancelled）、error、' +
      'outputPath、所用 work / workflow / version、以及完成后的文件清单与下载 URL。\n' +
      'status 仍是 pending 时说明在排队（队列串行，只有一张卡）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '任务 id（run_work / quick_generate 返回的 task.id）' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async ({ id }) => taskWithFiles(id),
  },
  {
    name: 'list_tasks',
    title: '任务列表',
    annotations: NOTES.readOnly,
    description:
      '查任务：scope="active" 只看待跑和在跑的（默认），scope="recent" 翻历史（含失败），' +
      '可按 status 过滤。用来判断队列有没有堵、上一批对照跑完没有。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['active', 'recent'], description: 'active=队列，recent=历史' },
        status: {
          type: 'string',
          description: 'recent 时过滤：all / pending / running / done / failed',
        },
        size: { type: 'integer', description: 'recent 时返回条数，默认 20', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    handler: async ({ scope = 'active', status = 'all', size = 20 }) => {
      if (scope === 'active') {
        const data = await api('/tasks')
        return { scope, tasks: data.tasks ?? [] }
      }
      const page = await api(`/jobs${qs({ kind: 'generate', status, size })}`)
      return {
        scope,
        total: page.total,
        items: (page.items ?? []).map((job) => ({
          id: job.id,
          task: job.label,
          status: job.status,
          workName: job.workName,
          workflowName: job.workflowName,
          outputPath: job.outputPath,
          error: job.error,
          createdAt: job.createdAt,
          elapsedMs: job.elapsedMs,
        })),
      }
    },
  },
  {
    name: 'wait_tasks',
    title: '等任务跑完',
    annotations: NOTES.readOnly,
    description:
      '轮询若干任务直到全部进入终态或超时，返回每个任务的状态、耗时、产物路径与下载 URL。\n' +
      '队列串行，一个 832×1216 / 30 步的任务大约 40–90 秒；超时只代表「还没跑完」，' +
      '任务本身不会因此取消——可以再调一次 wait_tasks 接着等。',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: '任务 id 列表', minItems: 1 },
        timeoutSec: { type: 'integer', description: '最多等多少秒，默认 300，上限 1800', minimum: 5, maximum: 1800 },
        intervalSec: { type: 'integer', description: '轮询间隔秒，默认 5', minimum: 2, maximum: 60 },
      },
      required: ['ids'],
      additionalProperties: false,
    },
    handler: async ({ ids, timeoutSec = 300, intervalSec = 5 }) => {
      const deadline = Date.now() + timeoutSec * 1000
      let snapshot = []
      for (;;) {
        snapshot = await Promise.all(ids.map((id) => taskWithFiles(id).catch((err) => ({ id, error: String(err.message ?? err) }))))
        if (snapshot.every((task) => task.error || TERMINAL.has(task.status))) break
        if (Date.now() + intervalSec * 1000 > deadline) break
        await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000))
      }
      return {
        done: snapshot.every((task) => task.error || TERMINAL.has(task.status)),
        tasks: snapshot.map((task) => ({
          id: task.id,
          task: task.task,
          status: task.status,
          error: task.error ?? null,
          outputPath: task.outputPath ?? null,
          files: task.files ?? [],
          elapsedMs:
            task.completedAt && task.createdAt
              ? new Date(task.completedAt).getTime() - new Date(task.createdAt).getTime()
              : null,
        })),
      }
    },
  },
  {
    name: 'list_outputs',
    title: '产物画廊',
    annotations: NOTES.readOnly,
    description:
      '按时间倒序列出产出图（画廊视图），可按审核状态过滤。每条带 id / 路径 / 状态。\n' +
      '想知道「最近出了哪些图」用它；想从某张图反查参数用 trace_output。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'approved', 'rejected'], description: '审核状态过滤' },
        size: { type: 'integer', description: '返回条数，默认 20', minimum: 1, maximum: 200 },
        offset: { type: 'integer', description: '分页偏移，默认 0', minimum: 0 },
      },
      additionalProperties: false,
    },
    handler: async ({ status, size = 20, offset = 0 }) => api(`/output/assets${qs({ status, size, offset })}`),
  },
  {
    name: 'trace_output',
    title: '从图反查任务',
    annotations: NOTES.readOnly,
    description:
      '给一个产物路径（例如 output/2026-11-24/mecha-01/xxx_00001_.png），返回产出它的任务 id、' +
      'work / workflow、以及当时的完整 payload。做重绘、复现、对照时先查这个拿素材段。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'output/ 开头的产物路径' } },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async ({ path }) => api(`/trace${qs({ path })}`),
  },
  {
    name: 'list_datasets',
    title: '数据集',
    annotations: NOTES.readOnly,
    description:
      '列出训练用数据集（名字、图片数、用途），训练脚本从这些集导出。' +
      '要具体某集的图与 caption 明细就给 id 再查 /datasets/:id（这个工具只列清单）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const data = await api('/datasets')
      const list = data.datasets ?? data.items ?? data
      return {
        datasets: Array.isArray(list)
          ? list.map((d) => ({
              id: d.id,
              name: d.name,
              assetCount: d.assetCount ?? d.count,
              note: d.note ?? d.description,
              createdAt: d.createdAt,
            }))
          : list,
      }
    },
  },
]

const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]))

// ---------------------------------------------------------------- 资源

const RESOURCES = [
  { uri: 'runner://manual', name: '使用手册', mimeType: 'text/markdown', description: '同 runner_manual 工具，markdown 正文' },
  { uri: 'runner://works', name: 'works 清单', mimeType: 'application/json', description: '实时读取 runner /works' },
  { uri: 'runner://workflows', name: '工作流清单', mimeType: 'application/json', description: '实时读取 runner /workflows' },
  { uri: 'runner://poses', name: '姿态库', mimeType: 'application/json', description: 'enabled 姿态（截前 200 条）' },
]

async function readResource(uri) {
  if (uri === 'runner://manual') return MANUAL
  if (uri === 'runner://works') return JSON.stringify(await api('/works'), null, 2)
  if (uri === 'runner://workflows') return JSON.stringify(await api('/workflows'), null, 2)
  if (uri === 'runner://poses') {
    const data = await api('/data/poses?enabled=true')
    const poses = (data.poses ?? []).slice(0, 200).map((p) => ({
      id: p.id,
      name: p.name,
      group: p.poseName,
      source: p.source,
      variants: Object.fromEntries(Object.entries(p.variants ?? {}).map(([k, v]) => [k, v?.gen ?? null])),
    }))
    return JSON.stringify({ total: data.total, poses }, null, 2)
  }
  throw new Error(`未知资源：${uri}`)
}

// ---------------------------------------------------------------- 装配

const server = new Server(
  { name: 'aigc-runner', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  })),
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const tool = TOOL_MAP.get(name)
  if (!tool) {
    return { isError: true, content: [{ type: 'text', text: `没有这个工具：${name}` }] }
  }
  try {
    const result = await tool.handler(args ?? {})
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    return { content: [{ type: 'text', text }] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      isError: true,
      content: [{ type: 'text', text: `${name} 失败：${message}` }],
    }
  }
})

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }))

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri
  const body = await readResource(uri)
  const meta = RESOURCES.find((item) => item.uri === uri)
  return {
    contents: [{ uri, mimeType: meta?.mimeType ?? 'text/plain', text: body }],
  }
})

const PROMPTS = [
  {
    name: 'mecha_standing',
    title: '出一张机娘立绘',
    description: '组装一份「机娘全身立绘」的 run_work 调用（含姿态、装备词、负面词与等图步骤）。',
    arguments: [
      { name: 'design', description: '形态/机设，例如 "heavy knight, large pauldrons, mechanical wings"', required: true },
      { name: 'color', description: '配色，例如 "white armor with gold joints"', required: false },
      { name: 'pose', description: '姿态 id，缺省 synth-stand-a', required: false },
    ],
  },
]

server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }))

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params
  if (name !== 'mecha_standing') throw new Error(`未知 prompt：${name}`)
  const pose = args.pose ?? 'synth-stand-a'
  const color = args.color ?? 'white glossy armor, black glossy bodysuit, gold mechanical joints'
  const positive = `${args.design}, ${color}, standing, looking at viewer, full body`
  const text = [
    '按下面的顺序调工具（不要一次把参数猜全）：',
    '1. `describe_work({ name: "mecha" })` 确认槽位名与当前值。',
    `2. \`run_work({ work: "mecha", pose: "${pose}", payload: { positive: ${JSON.stringify(positive)}, negative: "lowres, bad anatomy, extra limbs, multiple weapons, rust, weathering, segmented armor" } })\``,
    '3. `wait_tasks({ ids: [返回的 task.id], timeoutSec: 240 })`。',
    '4. 看图：全身入画、脚落地、装甲是重甲不是紧身衣；不满意就只改 positive 里的装备词重跑，不要动 denoise。',
    '5. 要二次元画法更浓时，只把 gloss_strength 从 1.0 提到 1.1 再跑一组同 seed 对照。',
  ].join('\n')
  return {
    messages: [{ role: 'user', content: { type: 'text', text } }],
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
console.error(`[aigc-runner] MCP 已启动，转发到 ${RUNNER}`)
