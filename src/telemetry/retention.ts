/**
 * Keeps `telemetry` from growing a row a minute for ever: about 1 MB a day,
 * which every scan and backup then has to carry. Rows stay at full resolution
 * for FULL_RESOLUTION_DAYS, as far back as any chart reaches, and older ones
 * thin to one per THIN_BUCKET_MIN. Nothing is ever dropped entirely: that's
 * about 27 MB a year, which a 64 GB card can keep. Deleted pages go back to
 * SQLite's free list, so the file stops growing without a VACUUM.
 *
 * It only deletes, a few hours of rows at a time with a pause between, about once
 * a week at night, and never rereads what it has done: about 10 MB of WAL a week,
 * beside the 150 MB of telemetry writes in the same week (ADR-0021).
 */
import { SensorId } from '../hardware/contract'
import { localTime } from '../scheduler/time'
import type { Store } from '../store/types'

export const FULL_RESOLUTION_DAYS = 90
export const THIN_BUCKET_MIN = 15
/** Thinned up to here, in epoch ms, so no run rereads older rows. */
export const THINNED_KEY = 'telemetry_thinned_through'

const DAY_MS = 86_400_000
const RUN_EVERY_DAYS = 7
/** After the nightly backup at 03:00, in the unit's timezone. */
const RUN_HOUR = 4
const CHECK_EVERY_MS = 30 * 60_000
/** One transaction, about 3000 rows: long enough to write each page once, short enough not to hold the event loop. */
const SLICE_MS = 6 * 3_600_000
/** Eight weeks: a unit with a long backlog catches up over a few nights. */
const MAX_SLICES_PER_RUN = 224
const PAUSE_MS = 2_000

export interface TelemetryRetentionOptions {
  store: Store
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}

export class TelemetryRetention {
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<void> | null = null
  private lastRunMs = -Infinity
  private stopped = false

  constructor(private readonly o: TelemetryRetentionOptions) {}

  private now(): Date {
    return this.o.now?.() ?? new Date()
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), CHECK_EVERY_MS)
    this.timer.unref()
  }

  /** Resolves once a run in progress has reached the end of its slice. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.running
  }

  /** Where the next run starts, a slice boundary so a bucket isn't split; null with nothing stored. */
  private from(): number | null {
    const through = this.o.store.counters.get(THINNED_KEY)
    if (through > 0) return through
    const oldest = this.o.store.telemetry.oldestTs()
    return oldest === null ? null : Math.floor(Date.parse(oldest) / SLICE_MS) * SLICE_MS
  }

  private cutoff(): number {
    return this.now().getTime() - FULL_RESOLUTION_DAYS * DAY_MS
  }

  due(): boolean {
    const now = this.now()
    if (now.getTime() - this.lastRunMs < 20 * 3_600_000) return false
    if (Math.floor(localTime(now, this.o.store.settings.get().timezone).minute / 60) !== RUN_HOUR) return false
    const from = this.from()
    return from !== null && this.cutoff() - from >= RUN_EVERY_DAYS * DAY_MS
  }

  async tick(): Promise<void> {
    if (this.running || !this.due()) return
    this.running = this.run().catch((e: Error) => console.warn(`telemetry retention: ${e.message}`)).finally(() => {
      this.running = null
    })
    await this.running
  }

  private async run(): Promise<void> {
    const { store } = this.o
    const sleep = this.o.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
    this.lastRunMs = this.now().getTime()
    const start = this.from() as number
    const cutoff = this.cutoff()
    let at = start
    let removed = 0
    for (let slice = 0; slice < MAX_SLICES_PER_RUN && at + SLICE_MS <= cutoff && !this.stopped; slice++) {
      removed += store.telemetry.thin(SensorId.options, new Date(at).toISOString(), new Date(at + SLICE_MS).toISOString(), THIN_BUCKET_MIN)
      at += SLICE_MS
      await sleep(PAUSE_MS)
    }
    if (at > start) store.counters.add(THINNED_KEY, at - store.counters.get(THINNED_KEY), this.now().toISOString())
    console.log(`telemetry retention: thinned ${removed} rows up to ${new Date(at).toISOString()}`)
  }
}
