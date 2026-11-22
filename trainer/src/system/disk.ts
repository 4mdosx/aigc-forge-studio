import { statfs } from 'node:fs/promises'

// 磁盘余量。存在的理由：一个 SDXL LoRA 实验四档 ckpt 就是 0.8 GB 起，
// latent cache 还能再翻一倍，几轮下来几十 GB。清理前得先知道「还剩多少」。
//
// 用 fs.statfs：Node 18.15 起可用，libuv 在 Windows 上走 GetDiskFreeSpaceExW，
// 与 POSIX 同一套 blocks/bsize 语义。拿不到（目录还没建、平台不支持）就跳过该 root，
// 不让一个探测接口把整页拖成 500。

export interface DiskEntry {
  root: string
  path: string
  totalBytes: number
  freeBytes: number
  usedBytes: number
}

export interface DiskReport {
  disks: DiskEntry[]
  /** 所有 root 都探测失败时为 true（返回空列表，不是错误） */
  unavailable: boolean
}

export async function readDisk(roots: Record<string, string>): Promise<DiskReport> {
  const disks: DiskEntry[] = []
  for (const [root, path] of Object.entries(roots)) {
    try {
      const info = await statfs(path)
      const totalBytes = info.blocks * info.bsize
      const freeBytes = info.bavail * info.bsize
      disks.push({
        root,
        path,
        totalBytes,
        freeBytes,
        usedBytes: totalBytes - freeBytes,
      })
    } catch {
      // root 目录尚未创建，或该平台 statfs 不可用：跳过，不当作错误
    }
  }
  return { disks, unavailable: disks.length === 0 }
}
