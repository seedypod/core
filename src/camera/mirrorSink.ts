/**
 * Opt-in off-device copy of stills and analysis artifacts (ADR-0019 phase 3).
 * The local sink stays the source of truth: writes land locally first and are
 * copied to an S3-compatible bucket (R2, MinIO, a NAS) in the background, so
 * the timelapse keeps working offline. Local pruning still applies; the bucket
 * keeps everything, and reads fall back to it once the local copy is gone.
 */
import { AwsClient } from 'aws4fetch'
import type { EventBus } from '../lib/eventBus'
import type { DeviceSettings, Store } from '../store/types'
import type { BlobSink } from './captures'

export interface MirrorConfig {
  endpoint: string
  bucket: string
  region: string
  prefix: string
  accessKeyId: string
  secretAccessKey: string
}

/** The mirror is on only when every required setting is present. */
export function mirrorConfig(s: DeviceSettings): MirrorConfig | null {
  if (!s.mirrorEndpoint || !s.mirrorBucket || !s.mirrorAccessKeyId || !s.mirrorSecretAccessKey) return null
  return { endpoint: s.mirrorEndpoint, bucket: s.mirrorBucket, region: s.mirrorRegion || 'auto', prefix: s.mirrorPrefix, accessKeyId: s.mirrorAccessKeyId, secretAccessKey: s.mirrorSecretAccessKey }
}

/** Path-style S3 client over SigV4: `PUT {endpoint}/{bucket}/{prefix}{key}`. */
export class S3Sink implements BlobSink {
  private readonly aws: AwsClient

  constructor(private readonly cfg: MirrorConfig, private readonly fetchImpl: typeof fetch = fetch) {
    this.aws = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: cfg.region, service: 's3' })
  }

  url(key: string): string {
    const path = `${this.cfg.prefix}${key}`.split('/').map(encodeURIComponent).join('/')
    return `${this.cfg.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(this.cfg.bucket)}/${path}`
  }

  private async send(method: string, key: string, body?: Uint8Array): Promise<Response> {
    const req = await this.aws.sign(this.url(key), { method, body: body as BodyInit | undefined, headers: body ? { 'content-type': contentType(key) } : undefined })
    return this.fetchImpl(req)
  }

  async put(key: string, bytes: Uint8Array): Promise<string> {
    const r = await this.send('PUT', key, bytes)
    if (!r.ok) throw new Error(`mirror PUT ${key}: ${r.status} ${await r.text().catch(() => '')}`.trim())
    return key
  }

  async get(key: string): Promise<Uint8Array | null> {
    const r = await this.send('GET', key)
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`mirror GET ${key}: ${r.status}`)
    return new Uint8Array(await r.arrayBuffer())
  }

  async remove(key: string): Promise<void> {
    const r = await this.send('DELETE', key)
    if (!r.ok && r.status !== 404) throw new Error(`mirror DELETE ${key}: ${r.status}`)
  }
}

function contentType(key: string): string {
  if (key.endsWith('.jpg')) return 'image/jpeg'
  if (key.endsWith('.pbm')) return 'image/x-portable-bitmap'
  return 'application/octet-stream'
}

export interface MirrorStatus {
  enabled: boolean
  pending: number
  uploaded: number
  failed: number
  lastError: string | null
  lastUploadAt: string | null
}

export interface MirroredSinkOptions {
  local: BlobSink
  store: Store
  events?: EventBus
  /** Maps a local path back to the key it was stored under (FsSink paths are `<dir>/<key>`). */
  keyOf?: (path: string) => string
  remote?: (cfg: MirrorConfig) => BlobSink
  now?: () => Date
  /** Attempts per upload before it counts as failed. */
  attempts?: number
  retryDelayMs?: number
}

/** Local sink plus a background copy to the configured mirror. */
export class MirroredSink implements BlobSink {
  private chain: Promise<void> = Promise.resolve()
  private pending = 0
  private uploaded = 0
  private failed = 0
  private lastError: string | null = null
  private lastUploadAt: string | null = null
  private readonly keyOf: (path: string) => string
  private readonly remoteFor: (cfg: MirrorConfig) => BlobSink

  constructor(private readonly o: MirroredSinkOptions) {
    this.keyOf = o.keyOf ?? (p => p)
    this.remoteFor = o.remote ?? (cfg => new S3Sink(cfg))
  }

  private remote(): BlobSink | null {
    const cfg = mirrorConfig(this.o.store.settings.get())
    return cfg ? this.remoteFor(cfg) : null
  }

  async put(key: string, bytes: Uint8Array): Promise<string> {
    const path = await this.o.local.put(key, bytes)
    this.mirror(key, bytes)
    return path
  }

  async get(path: string): Promise<Uint8Array | null> {
    const local = await this.o.local.get(path)
    if (local) return local
    try {
      return (await this.remote()?.get(this.keyOf(path))) ?? null
    }
    catch {
      return null
    }
  }

  /** Local only: the mirror is the long-term copy. */
  async remove(path: string): Promise<void> {
    await this.o.local.remove(path)
  }

  /** Copy existing local blobs (by path) to the mirror, e.g. right after enabling it. Returns how many were queued. */
  async sync(paths: string[]): Promise<number> {
    if (!this.remote()) throw new Error('the mirror is not configured')
    let n = 0
    for (const path of paths) {
      const bytes = await this.o.local.get(path)
      if (!bytes) continue
      this.mirror(this.keyOf(path), bytes)
      n++
    }
    return n
  }

  /** Write, read back and delete a probe object to check the credentials and bucket. */
  async test(): Promise<{ ok: boolean, detail: string }> {
    const remote = this.remote()
    if (!remote) return { ok: false, detail: 'the mirror is not configured' }
    const key = `.seedypod-probe-${Date.now()}`
    try {
      await remote.put(key, new TextEncoder().encode('ok'))
      const back = await remote.get(key)
      await remote.remove(key)
      return back && new TextDecoder().decode(back) === 'ok' ? { ok: true, detail: 'wrote, read back and deleted a probe object' } : { ok: false, detail: 'the probe object did not read back' }
    }
    catch (e) {
      return { ok: false, detail: (e as Error).message }
    }
  }

  status(): MirrorStatus {
    return { enabled: !!this.remote(), pending: this.pending, uploaded: this.uploaded, failed: this.failed, lastError: this.lastError, lastUploadAt: this.lastUploadAt }
  }

  /** Resolves once every queued upload has finished or given up. */
  flush(): Promise<void> {
    return this.chain
  }

  private mirror(key: string, bytes: Uint8Array): void {
    const remote = this.remote()
    if (!remote) return
    this.pending++
    this.chain = this.chain.then(async () => {
      const attempts = this.o.attempts ?? 3
      for (let i = 1; i <= attempts; i++) {
        try {
          await remote.put(key, bytes)
          this.uploaded++
          this.lastUploadAt = (this.o.now?.() ?? new Date()).toISOString()
          this.lastError = null
          this.o.store.alerts.clear('mirror_failed', this.lastUploadAt)
          return
        }
        catch (e) {
          this.lastError = (e as Error).message
          if (i < attempts) await new Promise(r => setTimeout(r, (this.o.retryDelayMs ?? 2000) * i))
        }
      }
      this.failed++
      const ts = (this.o.now?.() ?? new Date()).toISOString()
      this.o.store.alerts.raise('mirror_failed', `couldn't copy ${key} to the mirror: ${this.lastError ?? 'unknown error'}`, ts)
      this.o.events?.emit({ kind: 'mutation', path: 'alerts' })
    }).finally(() => {
      this.pending--
    })
  }
}
