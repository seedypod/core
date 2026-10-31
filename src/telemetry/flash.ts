/**
 * Flash-writes meter (ADR-0021, after sleepypod's System → Storage): samples
 * the SD card's sectors-written counter hourly and turns it into bytes per
 * day, so an owner can see whether the card will last years or decades.
 *
 * The kernel counter restarts at every boot. Each sample stores the bytes
 * written since the previous one; a counter that went backwards means a
 * reboot, and the new reading is the whole delta.
 */
import type { Store } from '../store/types'

export const SECTOR_BYTES = 512
const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Rates average over this much history once there is a day of it. */
const WINDOW_DAYS = 7
const KEEP_DAYS = 30

export interface FlashStatus {
  available: boolean
  /** Block device name, e.g. `mmcblk0`. */
  device: string | null
  /** Card capacity, from the device's size in sectors. */
  cardBytes: number | null
  /** Written since this boot. */
  sinceBootBytes: number | null
  uptimeS: number | null
  /** Average write rate; null until there is something to average. */
  bytesPerDay: number | null
  /** `history`: the hourly samples, over `windowDays`; `boot`: since this boot, before a day of samples exists. */
  basis: 'history' | 'boot' | null
  windowDays: number | null
  lastSampleAt: string | null
}

/** `/sys/block/<dev>/stat`: field 7 is sectors written (Documentation/block/stat.rst). */
export function sectorsWritten(stat: string): number | null {
  const f = stat.trim().split(/\s+/)
  const v = Number(f[6])
  return f.length >= 7 && Number.isFinite(v) ? v : null
}

/** Where the counter comes from. Node-only (`flashSource.ts`), so the browser demo has none. */
export interface FlashSource {
  /** `/sys/block/<dev>/stat`; the device's `size` sits next to it. */
  statPath: string
  read: (path: string) => string | null
  uptimeS: () => number
}

export interface FlashMeterOptions {
  store: Store
  /** Null on machines without an SD card (CI, a laptop, the demo): the meter reports unavailable. */
  source: FlashSource | null
  now?: () => Date
}

const parent = (p: string) => p.slice(0, p.lastIndexOf('/'))

export class FlashMeter {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly now: () => Date

  constructor(private readonly o: FlashMeterOptions) {
    this.now = o.now ?? (() => new Date())
  }

  start(intervalMs = HOUR): void {
    this.sample()
    this.timer = setInterval(() => this.sample(), intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private sectors(): number | null {
    const text = this.o.source?.read(this.o.source.statPath) ?? null
    return text === null ? null : sectorsWritten(text)
  }

  /** Records one sample; returns it, or null when there is no counter to read. */
  sample() {
    const sectors = this.sectors()
    if (sectors === null) return null
    const { store } = this.o
    const now = this.now()
    const prev = store.flash.last()
    const bytes = prev ? (sectors >= prev.sectors ? sectors - prev.sectors : sectors) * SECTOR_BYTES : 0
    const sample = { ts: now.toISOString(), sectors, bytes }
    store.flash.add(sample)
    store.flash.prune(new Date(now.getTime() - KEEP_DAYS * DAY).toISOString())
    return sample
  }

  status(): FlashStatus {
    const sectors = this.sectors()
    const src = this.o.source
    if (sectors === null || !src) {
      return { available: false, device: null, cardBytes: null, sinceBootBytes: null, uptimeS: null, bytesPerDay: null, basis: null, windowDays: null, lastSampleAt: null }
    }
    const now = this.now()
    const size = Number(src.read(`${parent(src.statPath)}/size`)?.trim())
    const up = src.uptimeS()
    const sinceBootBytes = sectors * SECTOR_BYTES
    const samples = this.o.store.flash.since(new Date(now.getTime() - WINDOW_DAYS * DAY).toISOString())
    const first = samples[0]
    const last = samples.at(-1)
    const spanMs = first && last ? new Date(last.ts).getTime() - new Date(first.ts).getTime() : 0
    let bytesPerDay: number | null = null
    let basis: FlashStatus['basis'] = null
    let windowDays: number | null = null
    if (spanMs >= DAY) {
      // The first sample's bytes were written before the window opened.
      bytesPerDay = samples.slice(1).reduce((n, s) => n + s.bytes, 0) / (spanMs / DAY)
      basis = 'history'
      windowDays = spanMs / DAY
    }
    else if (up > 0) {
      bytesPerDay = sinceBootBytes / (up / 86_400)
      basis = 'boot'
    }
    return {
      available: true,
      device: parent(src.statPath).split('/').pop() ?? null,
      cardBytes: Number.isFinite(size) && size > 0 ? size * SECTOR_BYTES : null,
      sinceBootBytes,
      uptimeS: up,
      bytesPerDay,
      basis,
      windowDays,
      lastSampleAt: last?.ts ?? null,
    }
  }
}
