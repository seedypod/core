/**
 * Captures — stills from the HAL stored as files (unit) or data URLs (demo),
 * indexed in the Store, pruned to a cap, and served by the server.
 */
import type { HalClient } from '../hardware/types'
import type { Capture, Store } from '../store/types'

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

export class CaptureService {
  private readonly now: () => Date
  private readonly keep: number
  private readonly minBytes: number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly o: CaptureServiceOptions) {
    this.now = o.now ?? (() => new Date())
    this.keep = o.keep ?? 720
    this.minBytes = o.minBytes ?? 1024
  }

  async capture(camera: 'upper' | 'lower'): Promise<Capture> {
    const bytes = await this.o.hal.captureStill(camera)
    const ts = this.now().toISOString()
    if (bytes.byteLength < this.minBytes) {
      this.o.store.alerts.raise('camera_missing', `${camera} camera returned ${bytes.byteLength} bytes`, ts)
      throw new Error(`${camera} camera returned no usable image`)
    }
    this.o.store.alerts.clear('camera_missing', ts)
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
