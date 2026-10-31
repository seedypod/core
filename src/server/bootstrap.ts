/**
 * Assembles a Context plus the background services (recorder, scheduler, grow
 * engine, captures) around a HAL and a Store. Used by server/index.ts, the
 * browser demo and the tests — one wiring, three hosts.
 */
import { CaptureService, MemorySink, type BlobSink } from '../camera/captures'
import type { MirroredSink } from '../camera/mirrorSink'
import { GrowEngine } from '../grow/grow'
import type { HalClient } from '../hardware/types'
import { createEventBus, type EventBus } from '../lib/eventBus'
import { Scheduler } from '../scheduler/scheduler'
import type { Store } from '../store/types'
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
}

export interface Core {
  ctx: Context
  recorder: Recorder
  scheduler: Scheduler
  grow: GrowEngine
  stop(): Promise<void>
}

export function createCore(o: CoreOptions): Core {
  const events = o.events ?? createEventBus()
  // Every HAL event becomes a CoreEvent: the recorder, SSE/WS clients and the UI all hang off this bus.
  const unsubHal = o.hal.subscribe(event => events.emit({ kind: 'hal', event }))
  const sink = o.sink ?? new MemorySink()
  const analysis = new AnalysisService({ store: o.store, sink, events, executor: o.analysisExecutor })
  const captures = new CaptureService({ hal: o.hal, store: o.store, sink, now: o.now, minBytes: o.captureMinBytes, analysis })
  const ctx: Context = { hal: o.hal, events, store: o.store, captures, analysis, mirror: o.mirror, version: o.version, now: o.now }
  const recorder = new Recorder({ store: o.store, events, now: o.now })
  const scheduler = new Scheduler({ store: o.store, hal: o.hal, events, now: o.now })
  const grow = new GrowEngine({ store: o.store, events, now: o.now })

  let growTimer: ReturnType<typeof setInterval> | null = null
  if (o.startServices) {
    recorder.start()
    scheduler.start()
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
    async stop() {
      unsubHal()
      scheduler.stop()
      captures.stop()
      await analysis.idle()
      recorder.stop()
      if (growTimer) clearInterval(growTimer)
      await o.hal.close()
      o.store.close()
    },
  }
}
