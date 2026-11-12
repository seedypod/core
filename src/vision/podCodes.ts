/**
 * yCube dot codes (#224): each camera's full-size pod-ID still, read by
 * `podvision --codes`, gives a four-mark code per pod where the dots are
 * readable. Core keeps the latest read of every pod. Which code is which plant
 * is learnt only from the owner's confirmations: an unconfirmed pair is never
 * stored or trusted.
 *
 * This runs in the browser demo too, so podvision itself (node-only) is
 * passed in as a `CodeReader`: `podvisionCodeReader` in nativeExecutor.ts.
 */
import { localTime } from '../scheduler/time'
import type { PodCodePair, PodCodeRead, Store } from '../store/types'
import { CAMERAS, podRegions, type Camera, type PodRegions } from './regions'

/** The local hour of the daily read: midday, when the grow light is most likely on. */
export const DAILY_READ_HOUR = 12
/** How often the daily read checks the clock. */
const DAILY_CHECK_MS = 10 * 60_000

/** Darker than this (mean of R, G and B, 0–1), the still says nothing: the last reads stay. */
export const DARK_STILL = 0.08

/** What `podvision --codes` prints. */
export interface CodesOutput {
  width: number
  height: number
  brightness: number
  damaged: boolean
  pods: Array<{ slot: number, code: string | null, confidence: number, dots: Array<[number, number]> }>
  ms: { decode: number, read: number }
}

export type CodeReader = (bytes: Uint8Array, regions: PodRegions) => Promise<CodesOutput>

/** One pod as Label pods shows it: what was read, and what the owner has said that code is. */
export interface PodCodeView extends PodCodeRead {
  /** The confirmed plant for this code, or null when the owner hasn't said. */
  confirmed: string | null
  /** The pod record's plant, which is the guess to confirm when the code is new. */
  recorded: string | null
}

/** Every pod a code was read under, with its confirmed plant and its record's. Unread pods are left out. */
export function podCodeViews(store: Pick<Store, 'podCodes' | 'pods'>): PodCodeView[] {
  const pairs = new Map(store.podCodes.pairs().map(p => [p.code, p.plant]))
  const pods = new Map(store.pods.list().map(p => [p.slot, p.plant]))
  return store.podCodes.reads().flatMap(r => r.code ? [{ ...r, confirmed: pairs.get(r.code) ?? null, recorded: pods.get(r.slot) ?? null }] : [])
}

export interface PodCodeServiceOptions {
  store: Store
  captures: { capturePodId(camera: Camera): Promise<{ still: { ts: string }, bytes: Uint8Array }> }
  /** Null where podvision isn't installed: then nothing can be read. */
  reader: CodeReader | null
  log?: (msg: string) => void
  /** After every read, scheduled or on demand: what is out of order may have changed. */
  onRead?: () => void
}

export interface ReadResult {
  camera: Camera
  ts: string | null
  /** Pods a code was read under. */
  read: number
  /** Why nothing new was stored for this camera, if so. */
  error: string | null
}

export class PodCodeService {
  private running: Promise<ReadResult[]> | null = null
  private lastDay: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly o: PodCodeServiceOptions) {}

  get available(): boolean {
    return this.o.reader !== null
  }

  /** Take one camera's pod-ID still and store what it reads. Throws when nothing could be read. */
  async readCamera(camera: Camera): Promise<ReadResult> {
    const reader = this.o.reader
    if (!reader) throw new Error('podvision isn\'t installed, so dot codes can\'t be read')
    const { still, bytes } = await this.o.captures.capturePodId(camera)
    const out = await reader(bytes, podRegions(camera, this.o.store.settings.get().podRegions))
    if (out.damaged) throw new Error(`the ${camera} pod-ID still was damaged`)
    if (out.brightness < DARK_STILL) throw new Error(`the ${camera} pod-ID still was too dark to read`)
    const reads: PodCodeRead[] = out.pods.map(p => ({ slot: p.slot, camera, code: p.code, confidence: p.confidence, ts: still.ts }))
    this.o.store.podCodes.setReads(camera, reads)
    return { camera, ts: still.ts, read: reads.filter(r => r.code).length, error: null }
  }

  /** Both cameras, one after the other; a failure on one leaves the other's reads. Concurrent calls share one run. */
  readAll(): Promise<ReadResult[]> {
    this.running ??= (async () => {
      const out: ReadResult[] = []
      for (const camera of CAMERAS) {
        try {
          out.push(await this.readCamera(camera))
        }
        catch (e) {
          const error = (e as Error).message
          this.o.log?.(`pod codes: ${error}`)
          out.push({ camera, ts: null, read: 0, error })
        }
      }
      this.o.onRead?.()
      return out
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  /** Read once a day, in DAILY_READ_HOUR local time. Resolves with whether it read. */
  async daily(now: Date, timezone: string): Promise<boolean> {
    if (!this.available) return false
    const local = localTime(now, timezone)
    if (Math.floor(local.minute / 60) !== DAILY_READ_HOUR || this.lastDay === local.date) return false
    this.lastDay = local.date
    await this.readAll()
    return true
  }

  /** Check for the daily read every few minutes. */
  start(now: () => Date, timezone: () => string): void {
    this.stop()
    if (!this.available) return
    this.timer = setInterval(() => void this.daily(now(), timezone()), DAILY_CHECK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** The owner says this code is this plant. */
  confirm(code: string, plant: string, ts: string): PodCodePair {
    return this.o.store.podCodes.confirm(code, plant.trim(), ts)
  }
}
