/**
 * Assembles a Context plus the background services (recorder, scheduler, grow
 * engine, captures) around a HAL and a Store. Used by server/index.ts, the
 * browser demo and the tests — one wiring, three hosts.
 */
import type { AutopilotEngine } from '../autopilot/engine'
import { createAutopilot } from '../autopilot/instance'
import { CaptureService, MemorySink, type BlobSink } from '../camera/captures'
import type { MirroredSink } from '../camera/mirrorSink'
import { LightArbiter } from '../control/light'
import { GrowEngine } from '../grow/grow'
import type { HalClient } from '../hardware/types'
import { createEventBus, type EventBus } from '../lib/eventBus'
import { SimWifi, type Wifi } from '../network/wifi'
import { Scheduler } from '../scheduler/scheduler'
import type { Store } from '../store/types'
import { FlashMeter, type FlashSource } from '../telemetry/flash'
import { Recorder } from '../telemetry/recorder'
import type { Executor } from '../vision/execute'
import { AnalysisService } from '../vision/service'
import type { Context } from './context'

export interface CoreOptions {
  hal: HalClient
  store: Store
  version: string
  events?: EventBus
  sink?: BlobSink
  /** The off-device mirror, when `sink` is one; exposed to the storage router. */
  mirror?: MirroredSink
  now?: () => Date
  /** Start timers (scheduler minute tick, grow tick, periodic captures). Off in tests. */
  startServices?: boolean
  captureMinBytes?: number
  /** Where capture analysis runs; defaults to this thread (tests, browser demo). */
  analysisExecutor?: Executor
  /** NetworkManager on a unit; an in-memory stand-in for tests and the demo. */
  wifi?: Wifi
  /** The SD card's write counter (ADR-0021); omitted off a Pi. */
  flashSource?: FlashSource | null
}

export interface Core {
  ctx: Context
  recorder: Recorder
  scheduler: Scheduler
  grow: GrowEngine
  autopilot: AutopilotEngine
  stop(): Promise<void>
}

export function createCore(o: CoreOptions): Core {
  const events = o.events ?? createEventBus()
  // Every HAL event becomes a CoreEvent: the recorder, SSE/WS clients and the UI all hang off this bus.
  const wifi = o.wifi ?? new SimWifi()
  const unsubHal = o.hal.subscribe((event) => {
    events.emit({ kind: 'hal', event })
    // Holding the button for 10 s opens the Wi-Fi setup hotspot.
    if (event.type === 'button' && event.press === 'setup') {
      void wifi.startSetup().then(() => events.emit({ kind: 'mutation', path: 'network' })).catch((e: Error) => console.warn(`wifi setup: ${e.message}`))
    }
  })
  const sink = o.sink ?? new MemorySink()
  const analysis = new AnalysisService({ store: o.store, sink, events, executor: o.analysisExecutor })
  const captures = new CaptureService({ hal: o.hal, store: o.store, sink, now: o.now, minBytes: o.captureMinBytes, analysis })
  // The light's single owner: manual > Autopilot > schedule (ADR-0020).
  const light = new LightArbiter({ hal: o.hal, now: () => (o.now?.() ?? new Date()).getTime(), log: m => console.warn(m) })
  const autopilot = createAutopilot({ hal: o.hal, store: o.store, events, light, now: o.now, log: m => console.warn(m) })
  const flash = new FlashMeter({ store: o.store, source: o.flashSource ?? null, now: o.now })
  const ctx: Context = { hal: o.hal, events, store: o.store, captures, analysis, mirror: o.mirror, flash, wifi, light, autopilot, version: o.version, now: o.now }
  const recorder = new Recorder({ store: o.store, events, now: o.now })
  const scheduler = new Scheduler({ store: o.store, hal: o.hal, events, light, now: o.now })
  const grow = new GrowEngine({ store: o.store, events, now: o.now })

  let growTimer: ReturnType<typeof setInterval> | null = null
  if (o.startServices) {
    recorder.start()
    scheduler.start()
    autopilot.start()
    flash.start()
    grow.tick()
    growTimer = setInterval(() => grow.tick(), 15 * 60_000)
    captures.start(o.store.settings.get().captureIntervalMin)
    events.subscribe((e) => {
      if (e.kind === 'mutation' && e.path === 'settings') captures.start(o.store.settings.get().captureIntervalMin)
    })
  }

  return {
    ctx,
    recorder,
    scheduler,
    grow,
    autopilot,
    async stop() {
      unsubHal()
      scheduler.stop()
      autopilot.stop()
      light.close()
      captures.stop()
      flash.stop()
      await analysis.idle()
      recorder.stop()
      if (growTimer) clearInterval(growTimer)
      await o.hal.close()
      o.store.close()
    },
  }
}
