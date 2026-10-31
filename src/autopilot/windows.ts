/**
 * Windowed-aggregate buffers behind `avg|min|max|sum|count(signal, last N min)`
 * (ported from sleepypod). The engine records each windowed signal once per
 * tick; buffers are pruned to the largest window any rule asks for.
 */
import type { WindowFn } from './types'

interface Sample { t: number, v: number }

export class WindowStore {
  private readonly buffers = new Map<string, Sample[]>()

  record(key: string, value: number, atMs: number): void {
    const buf = this.buffers.get(key) ?? []
    buf.push({ t: atMs, v: value })
    this.buffers.set(key, buf)
  }

  /** `undefined` when nothing falls in the window, except `count`, which is 0. */
  aggregate(fn: WindowFn, key: string, lastMin: number, nowMs: number): number | undefined {
    const buf = this.buffers.get(key)
    if (!buf) return fn === 'count' ? 0 : undefined
    const cutoff = nowMs - lastMin * 60_000
    const values = buf.filter(s => s.t >= cutoff && s.t <= nowMs).map(s => s.v)
    if (fn === 'count') return values.length
    if (values.length === 0) return undefined
    switch (fn) {
      case 'avg': return values.reduce((a, b) => a + b, 0) / values.length
      case 'sum': return values.reduce((a, b) => a + b, 0)
      case 'min': return Math.min(...values)
      case 'max': return Math.max(...values)
    }
  }

  prune(nowMs: number, maxAgeMin: number): void {
    const cutoff = nowMs - maxAgeMin * 60_000
    for (const [key, buf] of this.buffers) {
      const kept = buf.filter(s => s.t >= cutoff)
      if (kept.length === 0) this.buffers.delete(key)
      else this.buffers.set(key, kept)
    }
  }
}
