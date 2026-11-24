// API graph ↔ UI workflow 转换器。
//
// 这份逻辑在本仓库被复制过 5 次（freeze_mecha_workflow / freeze_quick_workflows /
// import_base_ax4z_lora_cn_1 / import_baseline_ax4z_lora / run_work_workflow），
// 每次都带一份自己的 widgets_values 双写路径。改一处漏四处，所以收到这里。
//
// 两个硬约束，改的时候别丢：
//   1. ComfyUI 前端只认 widgets_values（位置数组），runner 的 promptFromUi 只认
//      widgets_values_named（取值真相源）——必须同写。
//   2. 未赋值的纯连线输入（如 ControlNetApplyAdvanced 的可选 vae）不能写进 inputs：
//      promptFromUi 会把没有 link 的 input 当 widget 去 named 里查，而它本来就没有值。
//
// 用法：
//   const info = await (await fetch(`${COMFY}/object_info`)).json()
//   const conv = createGraphConverter(info)
//   const ui = conv.apiToUi(graph, { id: 'mecha-fullbody-v1' })
//   conv.assertRoundTrip(graph, ui)   // 转完自校验，不一致直接抛

const SEED_NAMES = new Set(['seed', 'noise_seed'])
// 这些类型只走连线，不会有 widget 值
const LINK_ONLY_TYPES = new Set([
  'MODEL', 'CLIP', 'VAE', 'LATENT', 'IMAGE', 'MASK', 'CONDITIONING', 'CONTROL_NET', 'IPADAPTER', 'CLIP_VISION',
])

function isLink(v) {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1]) && /^\d+$/.test(v[0])
}

export function createGraphConverter(info) {
  if (!info || typeof info !== 'object') throw new Error('createGraphConverter 需要 object_info')

  function apiToUi(apiNodes, opts = {}) {
    const idNum = (s) => Number(s)
    const nodeIds = Object.keys(apiNodes).map(idNum).sort((a, b) => a - b)
    const links = []
    let nextLink = 1

    const linkByTarget = new Map()
    for (const id of nodeIds) {
      const nd = apiNodes[String(id)]
      for (const [arg, v] of Object.entries(nd.inputs || {})) {
        if (!isLink(v)) continue
        const [srcId, srcSlot] = [Number(v[0]), v[1]]
        const srcClass = apiNodes[v[0]]?.class_type
        const outNames = info[srcClass]?.output_name || info[srcClass]?.output || []
        const type = outNames[srcSlot] || 'unknown'
        const linkId = nextLink++
        links.push([linkId, srcId, srcSlot, id, 0, type])
        linkByTarget.set(`${id}:${arg}`, linkId)
      }
    }

    const nodes = []
    let order = 0
    for (const id of nodeIds) {
      const nd = apiNodes[String(id)]
      const def = info[nd.class_type]
      if (!def) throw new Error(`unknown node class: ${nd.class_type}`)
      const req = Object.keys(def.input.required || {})
      const opt = Object.keys(def.input.optional || {})
      const argOrder = [...req, ...opt]
      const inputs = []
      const widgets = []
      const named = {}
      let targetSlot = 0

      for (const arg of argOrder) {
        const v = nd.inputs?.[arg]
        const spec = (def.input.required || {})[arg] || (def.input.optional || {})[arg]
        const specType = Array.isArray(spec) ? spec[0] : spec
        const linked = isLink(v)
        if (!linked && v === undefined && typeof specType === 'string' && LINK_ONLY_TYPES.has(specType)) continue
        const linkId = linked ? linkByTarget.get(`${id}:${arg}`) : null
        if (linked) {
          const l = links.find((x) => x[0] === linkId)
          if (l) l[3] = targetSlot
        }
        const uiInput = {
          name: arg,
          type: Array.isArray(specType) ? specType : String(specType),
          link: linkId ?? null,
        }
        if (Array.isArray(specType)) uiInput.widget = { name: arg }
        inputs.push(uiInput)
        targetSlot++

        if (!linked && v !== undefined) {
          widgets.push(v)
          named[arg] = v
          // ComfyUI 的 seed 控件是两个 widget：数值 + control_after_generate
          if (SEED_NAMES.has(arg) && typeof v === 'number') widgets.push('fixed')
        }
      }

      const outNames = def.output_name || def.output || []
      const outputs = outNames.map((name, i) => ({
        name,
        type: (def.output || [])[i] || name,
        links: links.filter((l) => l[1] === id && l[2] === i).map((l) => l[0]),
      }))

      nodes.push({
        id,
        type: nd.class_type,
        title: nd._title || undefined,
        pos: opts.pos ? opts.pos(id, nd) : [60 + (order % 5) * 340, 60 + Math.floor(order / 5) * 420],
        size: [300, 140],
        flags: {},
        order: order++,
        mode: 0,
        inputs,
        outputs,
        properties: { 'Node name for S&R': nd.class_type },
        widgets_values: widgets,
        widgets_values_named: named,
      })
    }

    return {
      id: opts.id,
      revision: 0,
      last_node_id: Math.max(...nodeIds),
      last_link_id: links.length,
      nodes,
      links,
      groups: [],
      config: {},
      extra: { info: opts.extra || '' },
      version: 0.4,
    }
  }

  function uiToApi(ui) {
    const linkById = new Map(ui.links.map((l) => [l[0], l]))
    const api = {}
    for (const node of ui.nodes) {
      const def = info[node.type]
      const argOrder = [...Object.keys(def.input.required || {}), ...Object.keys(def.input.optional || {})]
      const inputs = {}
      let wi = 0
      for (let i = 0; i < node.inputs.length; i++) {
        const inp = node.inputs[i]
        // 用 input.name 而不是 argOrder[i]：apiToUi 会跳过未赋值的纯连线输入，位置会错位
        const arg = inp.name ?? argOrder[i]
        if (inp.link != null) {
          const l = linkById.get(inp.link)
          inputs[arg] = [String(l[1]), l[2]]
          continue
        }
        const spec = (def.input.required || {})[arg] || (def.input.optional || {})[arg]
        const st = Array.isArray(spec) ? spec[0] : spec
        if (typeof st === 'string' && LINK_ONLY_TYPES.has(st)) continue
        inputs[arg] = node.widgets_values[wi++]
        if (SEED_NAMES.has(arg) && typeof inputs[arg] === 'number') wi++
      }
      api[String(node.id)] = { class_type: node.type, inputs }
    }
    return api
  }

  function assertRoundTrip(api, ui) {
    const norm = (o) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(o).map(([k, v]) => [
            k,
            {
              class_type: v.class_type,
              inputs: Object.fromEntries(
                Object.entries(v.inputs || {}).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)),
              ),
            },
          ]),
        ),
      )
    const a = norm(api)
    const b = norm(uiToApi(ui))
    if (a !== b) {
      throw new Error(`UI->API roundtrip mismatch\n  original: ${a.slice(0, 900)}\n  roundtrip: ${b.slice(0, 900)}`)
    }
    return true
  }

  return { apiToUi, uiToApi, assertRoundTrip }
}

// 按 class_type + 标题找唯一节点。与 runner/src/workflow/binding.ts 的 matchNode 同语义：
// 不给 name 时要求该类节点全图唯一，给 name 时按 _meta.title 精确匹配。
export function matchBinding(api, binding) {
  const found = Object.entries(api).filter(([, node]) => node.class_type === binding.class_type)
  const named = binding.name ? found.filter(([, node]) => node._meta?.title === binding.name) : found
  if (named.length !== 1) {
    throw new Error(
      named.length === 0
        ? `no ${binding.class_type}${binding.name ? ` named ${binding.name}` : ''}`
        : `${binding.class_type} matched ${named.length} nodes`,
    )
  }
  return named[0]
}
