/**
 * Recorder — turns HAL events into durable rows: downsampled telemetry,
 * persisted alerts (mirroring the HAL's latched state), and the cumulative
 * light-hours counter used for LED-aging reminders.
 */
import type { SensorId } from '../hardware/contract'
import type { HalEvent } from '../hardware/types'
import type { CoreEvent, EventBus } from '../lib/eventBus'
import type { Store, TelemetryPoint } from '../store/types'

export interface RecorderOptions {
  store: Store
  events: EventBus
  /** Minimum seconds between stored samples per sensor. */
  sampleIntervalS?: number
  now?: () => Date
}

export const LIGHT_HOURS_KEY = 'light_hours'

export class Recorder {
  private readonly lastSample = new Map<SensorId, number>()
  private lightOnSince: number | null = null
  private unsub: (() => void) | null = null
  private readonly now: () => Date
  private readonly intervalMs: number

  constructor(private readonly opts: RecorderOptions) {
    this.now = opts.now ?? (() => new Date())
    this.intervalMs = (opts.sampleIntervalS ?? 60) * 1000
  }

  start(): void {
    this.unsub = this.opts.events.subscribe(e => this.handle(e))
  }

  stop(): void {
    this.flushLightHours()
    this.unsub?.()
    this.unsub = null
  }

  handle(e: CoreEvent): void {
    if (e.kind !== 'hal') return
    this.onHal(e.event)
  }

  onHal(event: HalEvent): void {
    const { store } = this.opts
    const now = this.now()
    switch (event.type) {
      case 'sensor': {
        const last = this.lastSample.get(event.id)
        if (last === undefined || now.getTime() - last >= this.intervalMs) {
          this.lastSample.set(event.id, now.getTime())
          const point: TelemetryPoint = { ts: event.reading.ts, sensor: event.id, value: event.reading.value }
          store.telemetry.add([point])
        }
        break
      }
      case 'actuator': {
        if (event.id === 'light') {
          if (event.state.on && this.lightOnSince === null) this.lightOnSince = now.getTime()
          if (!event.state.on) this.flushLightHours()
        }
        if (event.state.fault) store.alerts.raise(`${event.id}_fault`, event.state.fault, now.toISOString())
        else store.alerts.clear(`${event.id}_fault`, now.toISOString())
        break
      }
      case 'alert': {
        if (event.alert.active) store.alerts.raise(event.alert.kind, event.alert.detail, event.alert.ts)
        else store.alerts.clear(event.alert.kind, event.alert.ts)
        break
      }
      case 'availability': {
        if (event.online) store.alerts.clear('hal_offline', now.toISOString())
        else store.alerts.raise('hal_offline', 'hardware daemon unreachable', now.toISOString())
        break
      }
      default:
        break
    }
  }

  /** Accumulate on-time into the counter (called on off, on stop, and may be called periodically). */
  flushLightHours(): void {
    if (this.lightOnSince === null) return
    const now = this.now().getTime()
    const hours = (now - this.lightOnSince) / 3_600_000
    if (hours > 0) this.opts.store.counters.add(LIGHT_HOURS_KEY, hours, this.now().toISOString())
    this.lightOnSince = null
  }
}
