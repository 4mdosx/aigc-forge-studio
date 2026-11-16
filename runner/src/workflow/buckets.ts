// 模型谱系分辨率 bucket 注册表（2026-11-16 token 定）。
// pose 库统一 512 系三比例存储（512x768 / 768x512 / 512x512，meta 的
// canvases 字段），与生成模型解耦；消费端按 pose 比例在目标模型谱系的
// bucket 表里取最近邻，作为底图 latent 尺寸。
// bucket 值来自各谱系官方推荐表（面积锚定、64 对齐）：
//   sdxl = animagine/Illustrious 共用的九档 aspect-ratio bucket。
//   sd15 = SD1.5 时代 512 系档位（与 pose 存储系一致，恒等映射）。

export interface Bucket {
  width: number
  height: number
}

export interface BucketFamily {
  name: string
  buckets: Bucket[]
}

export const BUCKET_FAMILIES: Record<string, BucketFamily> = {
  sdxl: {
    name: 'sdxl',
    buckets: [
      { width: 1024, height: 1024 },
      { width: 1152, height: 896 },
      { width: 1216, height: 832 },
      { width: 1344, height: 768 },
      { width: 1536, height: 640 },
      { width: 896, height: 1152 },
      { width: 832, height: 1216 },
      { width: 768, height: 1344 },
      { width: 640, height: 1536 },
    ],
  },
  sd15: {
    name: 'sd15',
    buckets: [
      { width: 512, height: 768 },
      { width: 768, height: 512 },
      { width: 512, height: 512 },
    ],
  },
}

const logAspect = ({ width, height }: Bucket): number =>
  Math.log(width / height)

// 最近邻判据：比例的对数距离（对宽高对称，且对比例失真线性）。
export function resolveNearestBucket(
  familyName: string,
  width: number,
  height: number,
): Bucket {
  const family = BUCKET_FAMILIES[familyName]
  if (!family) throw new Error(`unknown bucket family ${familyName}`)
  const aspect = Math.log(width / height)
  let best: Bucket = family.buckets[0] as Bucket
  let bestDist = Infinity
  for (const bucket of family.buckets) {
    const dist = Math.abs(logAspect(bucket) - aspect)
    if (dist < bestDist) {
      best = bucket
      bestDist = dist
    }
  }
  return best
}

// canvases 键（如 '512768'）→ {width,height}。键是两段十进制数字的拼接，
// 无分隔符；按「两段都必须是 8 的倍数、落在 [256,4096]」过滤切分点。
export function parseCanvasKey(key: string): Bucket {
  for (let cut = 1; cut < key.length; cut++) {
    const width = Number(key.slice(0, cut))
    const height = Number(key.slice(cut))
    if (
      Number.isInteger(width) &&
      Number.isInteger(height) &&
      width % 8 === 0 &&
      height % 8 === 0 &&
      width >= 256 &&
      width <= 4096 &&
      height >= 256 &&
      height <= 4096
    ) {
      return { width, height }
    }
  }
  throw new Error(`unparsable canvas key ${key}`)
}
