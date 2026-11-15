import { join, resolve, sep } from 'node:path'

import { TrainerError } from './errors.ts'

export type RootRegistry = Record<string, string>

const NAME_PATTERN = /^[a-z][a-z0-9_-]*$/i

// posix 绝对路径 or Windows 盘符路径（C:\ 或 C:/）
export function isAbsoluteRoot(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:([\\/]|$)/.test(path)
}

// 从 config.json 的 roots 构建注册表：名字合法 + 路径必须绝对。
// 目录不存在不在这里建（下载/上传时 mkdir），config 是模板时也能启动。
export function buildRoots(raw: unknown): RootRegistry {
  if (raw === undefined) return {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TrainerError('config roots must be an object')
  }
  const roots: RootRegistry = {}
  for (const [name, path] of Object.entries(raw as Record<string, unknown>)) {
    if (name.startsWith('//')) continue // config 注释键约定
    if (!NAME_PATTERN.test(name)) {
      throw new TrainerError(`root name must match [a-z][a-z0-9_-]*: ${name}`)
    }
    if (typeof path !== 'string' || path.trim() === '') {
      throw new TrainerError(`root ${name} must map to a path string`)
    }
    if (!isAbsoluteRoot(path)) {
      throw new TrainerError(
        `root ${name} path must be absolute (posix / or Windows C:\\): ${path}`,
      )
    }
    // posix 路径做一次 resolve 归一化；盘符路径原样保留（只在 Windows 上用）
    roots[name] = path.startsWith('/') ? resolve(path) : path
  }
  return roots
}

// 把 <root>/<相对路径> 解析成绝对路径；root 未在 config 注册时 404。
// 双保险：relativePath 已挡住 '..'，这里再校验解析结果仍在 root 内。
export function resolveInRoot(
  roots: RootRegistry,
  root: string,
  parts: string[],
): string {
  if (!NAME_PATTERN.test(root)) {
    throw new TrainerError('root name must match [a-z][a-z0-9_-]*')
  }
  const abs = roots[root]
  if (!abs) throw new TrainerError(`unknown root: ${root}`, 404)
  const target = join(abs, ...parts)
  const base = abs.endsWith(sep) || abs.endsWith('/') ? abs : abs + sep
  if (!resolve(target).startsWith(base)) {
    throw new TrainerError('invalid path')
  }
  return target
}
