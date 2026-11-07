/**
 * Captures — stills from the HAL stored as files (unit) or data URLs (demo),
 * indexed in the Store, pruned to a cap, and served by the server.
 *
 * hald refuses torn frames, which only it can see. This only checks that a
 * whole JPEG arrived, which also covers an older hald or a dropped connection.
 */
import type { HalClient } from '../hardware/types'
import type { Capture, Store } from '../store/types'
import { LinkWatch } from './linkHealth'

export interface BlobSink {
  put(key: string, bytes: Uint8Array): Promise<string>
  get(key: string): Promise<Uint8Array | null>
  remove(key: string): Promise<void>
}

/** In-memory sink for tests and the browser demo. */
export class MemorySink implements BlobSink {
  private readonly m = new Map<string, Uint8Array>()
  async put(key: string, bytes: Uint8Array) {
    this.m.set(key, bytes)
    return key
  }

  async get(key: string) {
    return this.m.get(key) ?? null
  }

  async remove(key: string) {
    this.m.delete(key)
  }
}

export interface CaptureServiceOptions {
  hal: HalClient
  store: Store
  sink: BlobSink
  /** Frames kept per camera (upstream default 720 ≈ 30 days hourly). */
  keep?: number
  now?: () => Date
  /** Minimum plausible JPEG size; smaller means the camera is missing (upstream #144). */
  minBytes?: number
  /** Scores each still after it is stored (ADR-0019); omitted = no analysis. */
  analysis?: { enqueue(c: Capture, bytes: Uint8Array): void, removeArtifacts(captureId: string): Promise<void> }
}

/** SOI at the start and EOI at the end: the whole file arrived. */
export function isWholeJpeg(b: Uint8Array): boolean {
  return b[0] === 0xFF && b[1] === 0xD8 && b.at(-2) === 0xFF && b.at(-1) === 0xD9
}

type Cam = 'upper' | 'lower'

export class CaptureService {
  private readonly now: () => Date
  private readonly keep: number
  private readonly minBytes: number
  /** Why each failing camera failed. `camera_missing` covers both, so it only clears once this is empty. */
  private readonly failing = new Map<Cam, string>()
  /** What `camera_missing` last said, so a camera that stays failing doesn't rewrite it on every still. */
  private said = ''
  private readonly link: LinkWatch
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly o: CaptureServiceOptions) {
    this.now = o.now ?? (() => new Date())
    this.keep = o.keep ?? 720
    this.minBytes = o.minBytes ?? 1024
    this.link = new LinkWatch(o.store.alerts)
  }

  /** What this capture says about the link. `good` is a frame hald was happy with. */
  private noteLink(camera: Cam, good: boolean, ts: string): void {
    this.link.record(camera, this.o.hal.damagedFrames?.(camera) ?? 0, good, ts)
    this.link.recordBoots(this.o.hal.hubBoots?.() ?? null, ts)
  }

  private fail(camera: Cam, detail: string, ts: string): void {
    this.failing.set(camera, detail)
    this.report(ts)
  }

  private recovered(camera: Cam, ts: string): void {
    this.failing.delete(camera)
    this.report(ts)
  }

  private report(ts: string): void {
    const detail = [...this.failing.values()].join('; ')
    if (!detail) this.o.store.alerts.clear('camera_missing', ts)
    else if (detail !== this.said) this.o.store.alerts.raise('camera_missing', detail, ts)
    this.said = detail
  }

  async capture(camera: Cam): Promise<Capture> {
    let bytes: Uint8Array
    try {
      bytes = await this.o.hal.captureStill(camera)
    }
    catch (e) {
      const detail = `${camera} camera failed: ${(e as Error).message}`
      const failedAt = this.now().toISOString()
      this.fail(camera, detail, failedAt)
      this.noteLink(camera, false, failedAt)
      throw new Error(detail)
    }
    const ts = this.now().toISOString()
    this.noteLink(camera, true, ts)
    if (bytes.byteLength < this.minBytes) {
      this.fail(camera, `${camera} camera returned ${bytes.byteLength} bytes`, ts)
      throw new Error(`${camera} camera returned no usable image`)
    }
    if (!isWholeJpeg(bytes)) {
      this.fail(camera, `${camera} camera sent an incomplete JPEG`, ts)
      throw new Error(`${camera} camera returned no usable image`)
    }
    this.recovered(camera, ts)
    const id = `${camera}-${ts.replace(/[:.]/g, '-')}`
    const path = await this.o.sink.put(`${id}.jpg`, bytes)
    const row: Capture = { id, camera, ts, path, bytes: bytes.byteLength }
    this.o.store.captures.add(row)
    this.o.analysis?.enqueue(row, bytes)
    for (const dropped of this.o.store.captures.prune(camera, this.keep)) {
      await this.o.sink.remove(dropped.path)
      await this.o.analysis?.removeArtifacts(dropped.id)
    }
    return row
  }

  async bytes(id: string): Promise<{ capture: Capture, bytes: Uint8Array } | null> {
    const capture = this.o.store.captures.get(id)
    if (!capture) return null
    const bytes = await this.o.sink.get(capture.path)
    return bytes ? { capture, bytes } : null
  }

  /** Periodic captures of both cameras. */
  start(intervalMin: number): void {
    this.stop()
    if (intervalMin <= 0) return
    this.timer = setInterval(() => void this.captureAll(), intervalMin * 60_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async captureAll(): Promise<void> {
    for (const cam of ['upper', 'lower'] as const) {
      await this.capture(cam).catch(() => undefined)
    }
  }
}
