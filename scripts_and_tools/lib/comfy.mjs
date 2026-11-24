// ComfyUI 客户端。
//
// 仓库里有 17 个脚本各自实现了「提交 /prompt + 轮询 /history + 回捞图」，
// 12 个还各自实现了轮询重试。POST /tasks 被删（e251b97）那次，5 个脚本一起废，
// 就是因为这段逻辑没有名字。这里给它一个。
//
// 用法：
//   import { createComfy } from './lib/comfy.mjs'
//   const comfy = createComfy()                       // 默认读 COMFY_BASE
//   const info = await comfy.objectInfo()             // 给 lib/graph 用
//   const { promptId } = await comfy.submit(api)
//   const files = await comfy.run(api, { out: dir })   // submit + wait + 下载
//
// 约定：所有方法失败都抛 Error，消息里带 HTTP 状态和响应前 200 字符。
// 不重试——重试策略交给调用方，因为「排队慢」和「节点报错」要区别对待。

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DEFAULT_BASE = process.env.COMFY_BASE || 'http://192.168.8.136:8188'

export function createComfy(baseUrl = DEFAULT_BASE, opts = {}) {
  const base = baseUrl.replace(/\/$/, '')
  const clientId = opts.clientId || `forge-${Math.random().toString(36).slice(2, 10)}`
  const timeoutMs = opts.timeoutMs ?? 600_000
  const intervalMs = opts.intervalMs ?? 1_500

  async function req(path, init) {
    const res = await fetch(`${base}${path}`, init)
    const text = await res.text()
    if (!res.ok) throw new Error(`${init?.method || 'GET'} ${path} -> ${res.status}: ${text.slice(0, 200)}`)
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  const objectInfo = () => req('/object_info')

  // ---------- userdata（ComfyUI 界面里的 workflow 文件） ----------
  // 注意路径要用 %2F 转义，直接传 workflows/xxx.json 会 404。
  const encodePath = (file) => `workflows%2F${encodeURIComponent(file)}`

  async function writeUserdata(file, ui) {
    await req(`/userdata/${encodePath(file)}?overwrite=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ui),
    })
    return file
  }

  async function readUserdata(file) {
    return req(`/userdata/${encodePath(file)}`)
  }

  // ---------- 图/文件 ----------
  // 静默失败的老坑：POST /files 不带 subfolder 时 runner 可能收不到，
  // 直传 /upload/image 是稳的路径。
  async function upload(bytes, name, subfolder = '') {
    const form = new FormData()
    form.append('image', new Blob([bytes], { type: 'image/png' }), name)
    form.append('overwrite', 'true')
    form.append('type', 'input')
    if (subfolder) form.append('subfolder', subfolder)
    const res = await fetch(`${base}/upload/image`, { method: 'POST', body: form })
    if (!res.ok) throw new Error(`upload ${name} -> ${res.status}`)
    const j = await res.json()
    return j.subfolder ? `${j.subfolder}/${j.name}` : j.name
  }

  // ---------- 队列 ----------
  async function submit(api) {
    const body = { prompt: api, client_id: clientId }
    const j = await req('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (j.node_errors && Object.keys(j.node_errors).length) {
      throw new Error(`prompt rejected: ${JSON.stringify(j.node_errors).slice(0, 400)}`)
    }
    return { promptId: j.prompt_id, number: j.number }
  }

  async function history(promptId) {
    const all = await req(`/history/${promptId}`)
    return all?.[promptId]
  }

  async function wait(promptId, waitOpts = {}) {
    const deadline = Date.now() + (waitOpts.timeoutMs ?? timeoutMs)
    const gap = waitOpts.intervalMs ?? intervalMs
    while (Date.now() < deadline) {
      const entry = await history(promptId)
      if (entry) {
        const status = entry.status?.status_str
        if (status === 'error') {
          throw new Error(`prompt ${promptId} failed: ${JSON.stringify(entry.status?.messages ?? []).slice(0, 400)}`)
        }
        if (entry.outputs && Object.keys(entry.outputs).length) return entry
      }
      await new Promise((r) => setTimeout(r, gap))
    }
    throw new Error(`prompt ${promptId} timeout after ${waitOpts.timeoutMs ?? timeoutMs}ms`)
  }

  // 从 history entry 里摊平出所有图片，按节点顺序
  function images(entry) {
    const out = []
    for (const [nodeId, node] of Object.entries(entry.outputs ?? {})) {
      for (const img of node.images ?? []) out.push({ ...img, nodeId })
    }
    return out
  }

  async function download(image, dest) {
    const q = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder ?? '',
      type: image.type ?? 'output',
    })
    const res = await fetch(`${base}/view?${q}`)
    if (!res.ok) throw new Error(`view ${image.filename} -> ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, buf)
    return dest
  }

  // 一条命令跑完：提交 → 等 → 按序下载到 outDir
  async function run(api, runOpts = {}) {
    const { promptId } = await submit(api)
    const entry = await wait(promptId, runOpts)
    const list = images(entry)
    if (!runOpts.out) return { promptId, images: list }
    const saved = []
    for (const [i, img] of list.entries()) {
      const name = runOpts.prefix ? `${runOpts.prefix}_${String(i + 1).padStart(5, '0')}.png` : img.filename
      saved.push(await download(img, join(runOpts.out, name)))
    }
    return { promptId, images: list, files: saved }
  }

  async function free({ unloadModels = true, freeMemory = true } = {}) {
    return req('/free', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unload_models: unloadModels, free_memory: freeMemory }),
    })
  }

  return { base, clientId, objectInfo, writeUserdata, readUserdata, upload, submit, wait, images, download, run, free }
}
