import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

// nvidia-smi 一把梭：整卡显存/利用率/温度/功耗 + 逐进程显存。
// 只读、无状态，训练页每几秒轮询一次也没有副作用。
// Windows 上 nvidia-smi.exe 在 System32（默认在 PATH），可用 NVIDIA_SMI_PATH 覆盖。

export interface GpuCard {
  index: number
  name: string
  memTotalMiB: number
  memUsedMiB: number
  memFreeMiB: number
  utilization: number | null
  temperatureC: number | null
  powerW: number | null
}

export interface GpuProcess {
  pid: number
  name: string
  usedMiB: number
}

export interface GpuReport {
  gpus: GpuCard[]
  processes: GpuProcess[]
}

const CARD_FIELDS =
  'index,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,power.draw'
const PROC_FIELDS = 'pid,process_name,used_memory'

function num(text: string): number | null {
  const value = Number(text.trim())
  return Number.isFinite(value) ? value : null
}

function rows(stdout: string): string[][] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => line.split(',').map((cell) => cell.trim()))
}

export async function readGpu(): Promise<GpuReport> {
  const bin = process.env.NVIDIA_SMI_PATH ?? 'nvidia-smi'
  const opts = { timeout: 5000, windowsHide: true, maxBuffer: 1 << 20 }

  const [cards, procs] = await Promise.all([
    run(bin, [`--query-gpu=${CARD_FIELDS}`, '--format=csv,noheader,nounits'], opts),
    run(bin, [`--query-compute-apps=${PROC_FIELDS}`, '--format=csv,noheader,nounits'], opts).catch(
      // 没有计算进程时部分驱动直接非零退出，按空处理
      () => ({ stdout: '', stderr: '' }),
    ),
  ])

  return {
    gpus: rows(cards.stdout).map((cells) => ({
      index: num(cells[0] ?? '') ?? 0,
      name: cells[1] ?? 'unknown',
      memTotalMiB: num(cells[2] ?? '') ?? 0,
      memUsedMiB: num(cells[3] ?? '') ?? 0,
      memFreeMiB: num(cells[4] ?? '') ?? 0,
      utilization: num(cells[5] ?? ''),
      temperatureC: num(cells[6] ?? ''),
      powerW: num(cells[7] ?? ''),
    })),
    processes: rows(procs.stdout).map((cells) => ({
      pid: num(cells[0] ?? '') ?? 0,
      name: (cells[1] ?? '').replace(/^.*[\\/]/, ''),
      usedMiB: num(cells[2] ?? '') ?? 0,
    })),
  }
}
