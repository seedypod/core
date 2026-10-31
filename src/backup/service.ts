/**
 * Off-card backups (ADR-0021 phase 2). A bundle can always be downloaded; when
 * the mirror (ADR-0019) is set up, one goes to `backups/` in its bucket every
 * night after 03:00 local time, through the mirror's retry queue, keeping the
 * newest 14 per unit. `backup_stale` fires when no off-card backup has
 * succeeded for 7 days (counted from core's first start on a unit that never
 * had one).
 */
import type { MirrorConfig, MirroredSink, BucketObject } from '../camera/mirrorSink'
import { mirrorConfig, S3Sink } from '../camera/mirrorSink'
import type { HalClient } from '../hardware/types'
import type { EventBus } from '../lib/eventBus'
import { localTime } from '../scheduler/time'
import type { BackupRecord, Store } from '../store/types'
import { backupName, bundleEntries, collect, gzipTar, parseBackupName, type BackupManifest, type BundleFile } from './bundle'
import type { BackupSources } from './sources'

const DAY = 86_400_000
export const BACKUPS_DIR = 'backups/'
export const STALE_ALERT = 'backup_stale'
const BASELINE_KEY = 'backup_baseline_ms'

export interface Bucket {
  list(under: string): Promise<BucketObject[]>
  get(key: string): Promise<Uint8Array | null>
  remove(key: string): Promise<void>
}

export interface BucketBackup {
  /** Relative to the mirror prefix, e.g. `backups/seedypod-backup-kitchen-20261031-030000.tar.gz`. */
  key: string
  name: string
  unit: string | null
  createdAt: string
  size: number
}

export interface BackupStatus {
  lastSuccess: BackupRecord | null
  lastBucketAttempt: BackupRecord | null
  nightly: { enabled: boolean, hour: number, keep: number }
  staleAfterDays: number
  stale: boolean
  recent: BackupRecord[]
}

export interface BackupServiceOptions {
  store: Store
  hal: HalClient
  events: EventBus
  version: string
  sources: BackupSources
  /** Uploads go through its retry queue. */
  mirror?: MirroredSink
  bucket?: (cfg: MirrorConfig) => Bucket
  now?: () => Date
  keep?: number
  staleDays?: number
  nightlyHour?: number
  /** Minimum gap between nightly attempts after a failure. */
  retryAfterMs?: number
}

export class BackupService {
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<BackupRecord> | null = null
  private readonly now: () => Date
  private readonly keep: number
  private readonly staleDays: number
  private readonly hour: number

  constructor(private readonly o: BackupServiceOptions) {
    this.now = o.now ?? (() => new Date())
    this.keep = o.keep ?? 14
    this.staleDays = o.staleDays ?? 7
    this.hour = o.nightlyHour ?? 3
  }

  start(intervalMs = 10 * 60_000): void {
    void this.tick()
    this.timer = setInterval(() => void this.tick(), intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private unit(): string {
    return this.o.hal.snapshot().system?.unitId ?? this.o.store.settings.get().unitName
  }

  private bucketFor(cfg: MirrorConfig): Bucket {
    return this.o.bucket?.(cfg) ?? new S3Sink(cfg)
  }

  /** The bundle as a gzip stream. Entries are produced lazily, so photos are read one at a time. */
  async bundle(opts: { photos: boolean }): Promise<{ name: string, stream: ReadableStream<Uint8Array> }> {
    const at = this.now()
    const settings = this.o.store.settings.get()
    const system = this.o.hal.snapshot().system
    const { sources } = this.o
    const skipped: BackupManifest['skipped'] = []
    const files: BundleFile[] = [{ name: 'seedypod.db', bytes: await sources.database() }]
    for (const f of sources.systemFiles()) {
      try {
        files.push({ name: f.name, bytes: await sources.read(f.path) })
      }
      catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'ENOENT' && f.optional) continue
        skipped.push({ path: f.path, reason: code === 'EACCES' ? 'permission denied: rerun install-hal so core can read it' : code === 'ENOENT' ? 'missing' : (e as Error).message })
      }
    }
    const photos = opts.photos ? this.photoFiles(skipped) : []
    const meta: Omit<BackupManifest, 'files'> = {
      format: { name: 'seedypod-backup', version: 1 },
      createdAt: at.toISOString(),
      unit: { id: system?.unitId ?? null, name: settings.unitName },
      core: { version: this.o.version },
      hald: { version: system?.halVersion ?? null },
      schema: sources.schema(),
      photos: opts.photos,
      skipped,
    }
    async function* all(): AsyncGenerator<BundleFile> {
      yield* files
      yield* photos
    }
    return { name: backupName(this.unit(), at), stream: gzipTar(bundleEntries(all(), meta)) }
  }

  private async* photoFiles(skipped: BackupManifest['skipped']): AsyncGenerator<BundleFile> {
    const dir = this.o.sources.paths.capturesDir.replace(/\/+$/, '').replace(/^\.\//, '')
    for (const c of this.o.store.captures.list(undefined, Number.MAX_SAFE_INTEGER)) {
      const path = c.path.replace(/^\.\//, '')
      if (!path.startsWith(`${dir}/`)) continue
      const name = `captures/${path.slice(dir.length + 1)}`
      try {
        if (new TextEncoder().encode(name).length > 100) throw new Error('name too long for the archive')
        yield { name, bytes: await this.o.sources.read(c.path) }
      }
      catch (e) {
        skipped.push({ path: c.path, reason: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing (pruned)' : (e as Error).message })
      }
    }
  }

  /** A download: recorded as an off-card backup once the whole stream has been read. */
  async download(opts: { photos: boolean }): Promise<{ name: string, stream: ReadableStream<Uint8Array> }> {
    const { name, stream } = await this.bundle(opts)
    let bytes = 0
    const record = (ok: boolean, detail: string) => this.record({ destination: 'download', name, bytes, ok, detail })
    const counted = stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        bytes += chunk.length
        ctl.enqueue(chunk)
      },
      flush: () => {
        record(true, opts.photos ? 'with photos' : '')
      },
    }))
    return { name, stream: counted }
  }

  /** Build without photos (the mirror already has them), upload, then drop all but the newest `keep`. */
  backupToBucket(): Promise<BackupRecord> {
    this.running ??= this.uploadOnce().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async uploadOnce(): Promise<BackupRecord> {
    const cfg = mirrorConfig(this.o.store.settings.get())
    if (!cfg || !this.o.mirror) throw new Error('the mirror is not configured: set an endpoint, bucket and keys under Settings → Off-device storage')
    let name = backupName(this.unit(), this.now())
    let bytes: Uint8Array | null = null
    try {
      const b = await this.bundle({ photos: false })
      name = b.name
      bytes = await collect(b.stream)
      await this.o.mirror.upload(`${BACKUPS_DIR}${name}`, bytes)
    }
    catch (e) {
      return this.record({ destination: 'bucket', name, bytes: bytes?.length ?? 0, ok: false, detail: (e as Error).message })
    }
    let detail = ''
    try {
      const pruned = await this.prune(cfg)
      if (pruned) detail = `removed ${pruned} older`
    }
    catch (e) {
      detail = `uploaded; pruning old backups failed: ${(e as Error).message}`
    }
    return this.record({ destination: 'bucket', name, bytes: bytes.length, ok: true, detail })
  }

  /** Keep the newest `keep` bundles for this unit; other units sharing the prefix are left alone. */
  private async prune(cfg: MirrorConfig): Promise<number> {
    const unit = parseBackupName(backupName(this.unit(), this.now()))?.unit
    const mine = (await this.list(cfg)).filter(b => b.unit === unit)
    const old = mine.slice(this.keep)
    const bucket = this.bucketFor(cfg)
    for (const b of old) await bucket.remove(b.key)
    return old.length
  }

  /** Bundles in the bucket, newest first. `cfg` lists a bucket that isn't saved yet (the Welcome screen). */
  async list(cfg?: MirrorConfig): Promise<BucketBackup[]> {
    const c = cfg ?? mirrorConfig(this.o.store.settings.get())
    if (!c) throw new Error('the mirror is not configured')
    const objects = await this.bucketFor(c).list(BACKUPS_DIR)
    return objects
      .map((o) => {
        const name = o.key.slice(o.key.lastIndexOf('/') + 1)
        const parsed = parseBackupName(name)
        return { key: o.key, name, unit: parsed?.unit ?? null, createdAt: parsed?.createdAt ?? o.lastModified, size: o.size }
      })
      .filter(b => b.name.endsWith('.tar.gz'))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.key.localeCompare(a.key))
  }

  async fetch(key: string, cfg?: MirrorConfig): Promise<Uint8Array> {
    const c = cfg ?? mirrorConfig(this.o.store.settings.get())
    if (!c) throw new Error('the mirror is not configured')
    if (!key.startsWith(BACKUPS_DIR) || key.includes('..')) throw new Error('not a backup key')
    const bytes = await this.bucketFor(c).get(key)
    if (!bytes) throw new Error(`${key} is not in the bucket`)
    return bytes
  }

  private record(r: Omit<BackupRecord, 'id' | 'ts'>): BackupRecord {
    const row = this.o.store.backups.add({ ...r, ts: this.now().toISOString() })
    this.o.events.emit({ kind: 'mutation', path: 'backup' })
    if (row.ok) this.checkStale()
    return row
  }

  /** Raise or clear `backup_stale`. */
  checkStale(): void {
    const { store } = this.o
    const now = this.now()
    if (!store.counters.get(BASELINE_KEY)) store.counters.add(BASELINE_KEY, now.getTime(), now.toISOString())
    const last = store.backups.lastSuccess()
    const since = last ? new Date(last.ts).getTime() : store.counters.get(BASELINE_KEY)
    const days = Math.floor((now.getTime() - since) / DAY)
    const active = store.alerts.list({ activeOnly: true }).some(a => a.kind === STALE_ALERT)
    if (days >= this.staleDays) {
      const detail = last
        ? `No off-card backup for ${days} days (last ${last.ts.slice(0, 10)}). Download one from Settings → Backup, or check the mirror.`
        : 'No off-card backup yet. Download one from Settings → Backup, or set up the mirror for nightly backups.'
      store.alerts.raise(STALE_ALERT, detail, now.toISOString())
      if (!active) this.o.events.emit({ kind: 'mutation', path: `alerts.${STALE_ALERT}` })
    }
    else if (active) {
      store.alerts.clear(STALE_ALERT, now.toISOString())
      this.o.events.emit({ kind: 'mutation', path: `alerts.${STALE_ALERT}` })
    }
  }

  /** True when the nightly upload should run now. */
  nightlyDue(): boolean {
    if (!this.o.mirror || !mirrorConfig(this.o.store.settings.get())) return false
    const now = this.now()
    if (localTime(now, this.o.store.settings.get().timezone).minute < this.hour * 60) return false
    const ok = this.o.store.backups.lastSuccess('bucket')
    if (ok && now.getTime() - new Date(ok.ts).getTime() < 20 * 3_600_000) return false
    const tried = this.o.store.backups.list(20).find(r => r.destination === 'bucket')
    return !tried || now.getTime() - new Date(tried.ts).getTime() >= (this.o.retryAfterMs ?? 3_600_000)
  }

  async tick(): Promise<void> {
    if (this.nightlyDue()) await this.backupToBucket().catch((e: Error) => console.warn(`nightly backup: ${e.message}`))
    this.checkStale()
  }

  status(): BackupStatus {
    const { store } = this.o
    return {
      lastSuccess: store.backups.lastSuccess(),
      lastBucketAttempt: store.backups.list(20).find(r => r.destination === 'bucket') ?? null,
      nightly: { enabled: !!this.o.mirror && !!mirrorConfig(store.settings.get()), hour: this.hour, keep: this.keep },
      staleAfterDays: this.staleDays,
      stale: store.alerts.list({ activeOnly: true }).some(a => a.kind === STALE_ALERT),
      recent: store.backups.list(5),
    }
  }
}
