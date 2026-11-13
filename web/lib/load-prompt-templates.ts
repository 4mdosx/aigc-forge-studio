import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

export async function loadPromptTemplates(
  start = process.cwd(),
): Promise<unknown> {
  const file = findTemplate(start)
  if (!file) throw new Error('data/promptTemplates.ts is missing')
  const href = `${pathToFileURL(file).href}?t=${statSync(file).mtimeMs}`
  const { stdout } = await run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const mod = await import(${JSON.stringify(href)}); process.stdout.write(JSON.stringify(mod.promptTemplates ?? null))`,
    ],
    { timeout: 15_000 },
  )
  return JSON.parse(stdout)
}

function findTemplate(start: string): string | null {
  let dir = start
  for (let step = 0; step < 4; step += 1) {
    const file = join(dir, 'data', 'promptTemplates.ts')
    if (existsSync(file)) return file
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}
