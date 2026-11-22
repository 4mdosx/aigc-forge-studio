import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// 数据集目录盘点。存在的理由很具体：createTrainJob 原来只 readdir 判空就把
// 结果丢了，于是「脚本以为传了 19 张、训练机上其实躺着 55 张」这件事在 job 记录里
// 查无实据（2026-11-22 实际踩到，多跑了一轮 1650 步）。

export const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp']
const CAPTION_EXT = '.txt'

export interface DatasetStats {
  /** 数据集目录绝对路径 */
  dir: string
  imageCount: number
  captionCount: number
  /** 有图但没有同名 .txt 的文件名（最多 20 个，够定位问题就行） */
  missingCaptions: string[]
  /** 有 .txt 但没有同名图（通常是删图留下的残骸） */
  orphanCaptions: string[]
  /** 图片 + caption 的字节总数（不含子目录） */
  totalBytes: number
}

export function stemOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

export function scanDataset(dir: string): DatasetStats {
  const names = readdirSync(dir)
  const images = names.filter((name) => IMAGE_EXTS.includes(extOf(name)))
  const captionNames = names.filter((name) => extOf(name) === CAPTION_EXT)
  const captionStems = new Set(captionNames.map(stemOf))
  const imageStems = new Set(images.map(stemOf))

  let totalBytes = 0
  const counted = new Set([...images, ...captionNames])
  for (const name of counted) {
    const st = statSync(join(dir, name), { throwIfNoEntry: false })
    if (st?.isFile()) totalBytes += st.size
  }

  return {
    dir,
    imageCount: images.length,
    captionCount: captionStems.size,
    missingCaptions: images.filter((name) => !captionStems.has(stemOf(name))).slice(0, 20),
    orphanCaptions: [...captionStems].filter((stem) => !imageStems.has(stem)).slice(0, 20),
    totalBytes,
  }
}
