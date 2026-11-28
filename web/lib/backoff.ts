// PIN 连续失败的指数退避。计数只放在进程内存里，重启 Web 就清零。
// 第 n 次失败锁定 30 秒 * 3^(n-1)，第 9 次起封顶 24 小时。
// 锁定期内不能再记失败，否则一直点会把锁定顶到上限。

export type BackoffConfig = {
  baseMs: number
  multiplier: number
  maxMs: number
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 30_000,
  multiplier: 3,
  maxMs: 24 * 60 * 60 * 1000,
}

export const MAX_BACKOFF_MS = DEFAULT_BACKOFF.maxMs

type Attempt = {
  failures: number
  blockedUntil: number
  firstFailureAt: number
}

const attempts = new Map<string, Attempt>()
let lastSweepAt = 0
const SWEEP_INTERVAL_MS = 10 * 60 * 1000

export function backoffMs(failures: number, config: BackoffConfig = DEFAULT_BACKOFF): number {
  if (failures <= 0) return 0
  const { baseMs, multiplier, maxMs } = config
  const capSteps = Math.ceil(Math.log(maxMs / baseMs) / Math.log(multiplier)) + 1
  if (failures >= capSteps) return maxMs
  return Math.min(baseMs * multiplier ** (failures - 1), maxMs)
}

export function lockedFor(key: string, now = Date.now()): number {
  if (now - lastSweepAt > SWEEP_INTERVAL_MS) {
    lastSweepAt = now
    sweep(now)
  }
  const entry = attempts.get(key)
  if (!entry) return 0
  return Math.max(0, entry.blockedUntil - now)
}

export function failureCount(key: string): number {
  return attempts.get(key)?.failures ?? 0
}

export function recordFailure(
  key: string,
  config: BackoffConfig = DEFAULT_BACKOFF,
  now = Date.now(),
): number {
  const existing = attempts.get(key)
  const failures = (existing?.failures ?? 0) + 1
  const duration = backoffMs(failures, config)
  attempts.set(key, {
    failures,
    blockedUntil: now + duration,
    firstFailureAt: existing?.firstFailureAt ?? now,
  })
  return duration
}

export function recordSuccess(key: string): void {
  attempts.delete(key)
}

export function sweep(now = Date.now()): number {
  let removed = 0
  for (const [key, entry] of attempts) {
    if (now - entry.firstFailureAt < MAX_BACKOFF_MS) continue
    attempts.delete(key)
    failureStamps.delete(key)
    removed += 1
  }
  return removed
}

export function describeRemaining(remainingMs: number): string {
  const seconds = Math.ceil(remainingMs / 1000)
  if (seconds <= 0) return '现在可以重试'
  if (seconds < 60) return `请 ${seconds} 秒后再试`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `请 ${minutes} 分钟后再试`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) {
    return restMinutes > 0 ? `请 ${hours} 小时 ${restMinutes} 分钟后再试` : `请 ${hours} 小时后再试`
  }
  return '已被锁定 24 小时'
}

export type SignalConfig = {
  windowMs: number
  minFailures: number
  globalKeys: number
}

export const DEFAULT_SIGNAL: SignalConfig = {
  windowMs: 10 * 60 * 1000,
  minFailures: 5,
  globalKeys: 3,
}

export type AttackSignal = {
  suspicious: boolean
  reason: 'burst' | 'distributed' | 'none'
  failures: number
  lockedKeys: number
}

const failureStamps = new Map<string, number[]>()

export function recordFailureSignal(
  key: string,
  config: SignalConfig = DEFAULT_SIGNAL,
  now = Date.now(),
): AttackSignal {
  const stamps = (failureStamps.get(key) ?? []).filter((at) => now - at < config.windowMs)
  stamps.push(now)
  failureStamps.set(key, stamps)
  const lockedKeys = countLocked(now)
  if (stamps.length >= config.minFailures) {
    return { suspicious: true, reason: 'burst', failures: stamps.length, lockedKeys }
  }
  if (lockedKeys >= config.globalKeys) {
    return { suspicious: true, reason: 'distributed', failures: stamps.length, lockedKeys }
  }
  return { suspicious: false, reason: 'none', failures: stamps.length, lockedKeys }
}

export function clearSignal(key: string): void {
  failureStamps.delete(key)
}

export function describeSignal(signal: AttackSignal, key: string): string {
  if (!signal.suspicious) return ''
  if (signal.reason === 'burst') {
    return `[pin-attack] 单 IP 爆发：${key} 在窗口内失败 ${signal.failures} 次`
  }
  return `[pin-attack] 疑似分布式扫描：同时有 ${signal.lockedKeys} 个来源被锁（本 IP 失败 ${signal.failures} 次）`
}

function countLocked(now: number): number {
  let count = 0
  for (const entry of attempts.values()) {
    if (entry.blockedUntil > now) count += 1
  }
  return count
}

export function resetBackoff(): void {
  attempts.clear()
  failureStamps.clear()
  lastSweepAt = 0
}
