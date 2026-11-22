/**
 * How each sensor has been reading lately: of the last hour's readings, how
 * many were flaky (`suspect`), and the last good one. A sensor that mostly
 * reads is used through its flaky moments; one that mostly doesn't is
 * warned about. The ultrasonic tank ranger drops pings now and then.
 */
import type { Reading, SensorId } from './contract'

export const QUALITY_WINDOW_MS = 3_600_000

export interface SensorQuality {
  flaky: number
  total: number
  /** The newest reading of good quality, however old. */
  lastGood: Reading | null
}

export class QualityTracker {
  private seen = new Map<SensorId, Array<{ t: number, flaky: boolean }>>()
  private good = new Map<SensorId, Reading>()

  record(id: SensorId, r: Reading, now: number): void {
    const list = this.seen.get(id) ?? []
    list.push({ t: now, flaky: r.quality === 'suspect' })
    this.seen.set(id, list.filter(e => now - e.t <= QUALITY_WINDOW_MS))
    if (r.quality === 'good') this.good.set(id, r)
  }

  get(now: number): Partial<Record<SensorId, SensorQuality>> {
    const out: Partial<Record<SensorId, SensorQuality>> = {}
    for (const [id, list] of this.seen) {
      const recent = list.filter(e => now - e.t <= QUALITY_WINDOW_MS)
      out[id] = { flaky: recent.filter(e => e.flaky).length, total: recent.length, lastGood: this.good.get(id) ?? null }
    }
    return out
  }
}
