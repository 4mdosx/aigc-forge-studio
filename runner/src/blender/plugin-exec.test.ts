import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { runPlugin } from './plugin-exec.ts'
import type { BlenderTools } from './mcp-tools.ts'

function fixture(): { dir: string; entry: string; base: Parameters<typeof runPlugin>[1] } {
  // 目录层级要和真实插件一致：dataDir/plugins/<id>/scripts/main.ts
  const dir = mkdtempSync(join(tmpdir(), 'aigc-plugin-'))
  const entry = join(dir, 'plugins', 'probe', 'scripts', 'main.ts')
  mkdirSync(join(dir, 'plugins', 'probe', 'scripts'), { recursive: true })
  const mcp = {
    call: async () => '',
    code: async () => '',
    scene: { open: async () => '', select: async () => '' },
    objects: { clear: async () => '', boxes: async () => '' },
    render: { to: async () => '' },
  } satisfies BlenderTools
  return {
    dir,
    entry,
    base: {
      vars: {},
      scene: null,
      runId: 'test',
      pluginId: 'probe',
      outputDir: join(dir, 'out'),
      mcp,
    },
  }
}

test('reloads plugin source after edit', async () => {
  const { entry, base } = fixture()
  writeFileSync(entry, "export function run(ctx) { ctx.log('v1') }\n")
  assert.equal(await runPlugin(entry, base), 'v1')

  // 不改 mtime 也不行：改内容通常也会改 mtime，这里显式写新内容。
  writeFileSync(entry, "export function run(ctx) { ctx.log('v2') }\n")
  assert.equal(await runPlugin(entry, base), 'v2')
})

test('reloads relative imports of a plugin after edit', async () => {
  const { entry, base } = fixture()
  const helper = join(entry, '..', 'helper.ts')
  writeFileSync(helper, "export const version = 'h1'\n")
  writeFileSync(
    entry,
    "import { version } from './helper.ts'\nexport function run(ctx) { ctx.log(version) }\n",
  )
  assert.equal(await runPlugin(entry, base), 'h1')

  writeFileSync(helper, "export const version = 'h2'\n")
  assert.equal(await runPlugin(entry, base), 'h2')
})

test('reports error when run export is missing', async () => {
  const { entry, base } = fixture()
  writeFileSync(entry, 'export const nope = 1\n')
  await assert.rejects(() => runPlugin(entry, base), /未导出 run\(ctx\)/)
})

test('collects logs on success and includes them on failure', async () => {
  const { entry, base } = fixture()
  writeFileSync(
    entry,
    "export function run(ctx) { ctx.log('before'); throw new Error('boom') }\n",
  )
  await assert.rejects(() => runPlugin(entry, base), /before\nboom/)
})
