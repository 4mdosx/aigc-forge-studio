#!/usr/bin/env node
/**
 * MCP 自检：起一个真实客户端连本服务，列工具、读手册、调全部只读工具。
 * 不提交任何生成任务（不占 GPU），但需要 runner 在跑。
 *
 *   node mcp/selftest.mjs
 */
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const client = new Client({ name: 'selftest', version: '0' })
await client.connect(
  new StdioClientTransport({ command: 'node', args: [`${here}server.mjs`] }),
)

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const { tools } = await client.listTools()
check('tools/list', tools.length >= 10, `${tools.length} 个`)
check(
  '每个工具都有 description 与 inputSchema',
  tools.every((t) => (t.description ?? '').length > 40 && t.inputSchema?.type === 'object'),
)

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args })
  return { error: res.isError === true, text: res.content?.[0]?.text ?? '' }
}

const manual = await call('runner_manual')
check('runner_manual', !manual.error && manual.text.includes('aigc-runner'), `${manual.text.length} 字符`)

for (const [name, args, probe] of [
  ['runner_status', {}, '"queue"'],
  ['list_works', {}, '"works"'],
  ['list_workflows', {}, '"workflows"'],
  ['list_poses', { source: 'synthetic', limit: 3 }, '"poses"'],
  ['list_loras', {}, '"style"'],
  ['describe_work', { name: 'mecha' }, '"slots"'],
  ['list_outputs', { size: 3 }, ''],
  ['list_datasets', {}, ''],
]) {
  const res = await call(name, args)
  const parsed = res.error ? null : JSON.parse(res.text)
  check(name, !res.error && (probe === '' || res.text.includes(probe)), res.error ? res.text.slice(0, 120) : '')
  if (name === 'describe_work' && parsed) {
    const slots = parsed.workflows?.[0]?.slots?.inputs ?? {}
    check('describe_work 槽位带当前值', Object.values(slots).some((s) => s.current !== undefined), Object.keys(slots).join(','))
  }
}

const { resources } = await client.listResources()
check('resources/list', resources.length >= 3, resources.map((r) => r.uri).join(' '))

await client.close()
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
