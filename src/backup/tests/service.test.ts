import { describe, expect, it } from 'vitest'
import { MemorySink } from '../../camera/captures'
import { MirroredSink, type BucketObject, type MirrorConfig } from '../../camera/mirrorSink'
import { SimHal } from '../../hardware/sim'
import { createEventBus } from '../../lib/eventBus'
import { MemoryStore } from '../../store/memory'
import { backupName, BUNDLE_NAMES, collect, parseBackupName } from '../bundle'
import { BackupService, STALE_ALERT, type Bucket } from '../service'
import type { BackupSources } from '../sources'
import { sha256, untar } from './untar'

const enc = new TextEncoder()
const DAY = 86_400_000

function enoent(path: string) {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
}

/** A unit's files in memory; `denied` paths fail like a file core may not read. */
function sources(files: Record<string, string>, denied: string[] = []): BackupSources {
  return {
    paths: { etcDir: '/etc/seedypod', stateDir: '/var/lib/seedypod', mosquittoPasswd: '/etc/mosquitto/seedypod.passwd', capturesDir: './data/captures' },
    database: async () => enc.encode('SQLite format 3\0…'),
    systemFiles: () => [
      { name: 'etc/seedypod/hal.toml', path: '/etc/seedypod/hal.toml', optional: false },
      { name: 'etc/mosquitto/seedypod.passwd', path: '/etc/mosquitto/seedypod.passwd', optional: true },
      { name: 'var/lib/seedypod/state.json', path: '/var/lib/seedypod/state.json', optional: true },
    ],
    read: async (path) => {
      if (denied.includes(path)) throw Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' })
      if (!(path in files)) throw enoent(path)
      return enc.encode(files[path])
    },
    schema: () => ({ migrations: 7, tag: '0006_black_silver_sable' }),
  }
}

/** An in-memory bucket behind both the mirror's upload path and the listing the service does itself. */
function fakeBucket() {
  const objects = new Map<string, { bytes: Uint8Array, at: string }>()
  const remote = {
    put: async (key: string, bytes: Uint8Array) => {
      objects.set(key, { bytes, at: new Date().toISOString() })
      return key
    },
    get: async (key: string) => objects.get(key)?.bytes ?? null,
    remove: async (key: string) => void objects.delete(key),
  }
  const bucket: Bucket = {
    list: async (under: string): Promise<BucketObject[]> => [...objects.entries()].filter(([k]) => k.startsWith(under)).map(([key, o]) => ({ key, size: o.bytes.length, lastModified: o.at })),
    get: remote.get,
    remove: remote.remove,
  }
  return { objects, remote, bucket }
}

function rig(opts: { files?: Record<string, string>, denied?: string[], mirror?: boolean, at?: string } = {}) {
  let now = new Date(opts.at ?? '2026-10-31T12:00:00Z')
  const store = new MemoryStore()
  const events = createEventBus()
  const seen: string[] = []
  events.subscribe(e => e.kind === 'mutation' && seen.push(e.path))
  const hal = new SimHal({ tickMs: 0, unitId: 'kitchen' })
  const b = fakeBucket()
  const cfg: MirrorConfig = { endpoint: 'https://s3.example.com', bucket: 'pods', region: 'auto', prefix: '', accessKeyId: 'AK', secretAccessKey: 'SK' }
  if (opts.mirror) store.settings.update({ mirrorEndpoint: cfg.endpoint, mirrorBucket: cfg.bucket, mirrorAccessKeyId: cfg.accessKeyId, mirrorSecretAccessKey: cfg.secretAccessKey })
  const mirror = new MirroredSink({ local: new MemorySink(), store, events, remote: () => b.remote, retryDelayMs: 1 })
  const files = opts.files ?? { '/etc/seedypod/hal.toml': 'unit_id = "kitchen"\n', '/var/lib/seedypod/state.json': '{"light":40}' }
  const svc = new BackupService({ store, hal, events, version: 'main@abc1234', sources: sources(files, opts.denied), mirror, bucket: () => b.bucket, now: () => now })
  return { svc, store, b, cfg, seen, advance: (ms: number) => (now = new Date(now.getTime() + ms)), at: (iso: string) => (now = new Date(iso)) }
}

describe('bundle names', () => {
  it('sort by time within a unit and parse back', () => {
    const n = backupName('Kitchen Tower', new Date('2026-10-31T03:00:05Z'))
    expect(n).toBe('seedypod-backup-kitchen-tower-20261031-030005.tar.gz')
    expect(parseBackupName(n)).toEqual({ unit: 'kitchen-tower', createdAt: '2026-10-31T03:00:05Z' })
    expect(parseBackupName('notes.txt')).toBeNull()
  })

  it('only allow the paths the restore helper accepts', () => {
    const ok = (p: string) => BUNDLE_NAMES.some(re => re.test(p))
    expect(['seedypod.db', 'etc/seedypod/hal.toml', 'etc/mosquitto/seedypod.passwd', 'var/lib/seedypod/sensors.json', 'captures/upper-2026-10-31T03-00-00-000Z.jpg'].every(ok)).toBe(true)
    expect(['etc/passwd', '../seedypod.db', 'captures/../../etc/shadow', 'var/lib/seedypod/x/state.json', 'captures/.hidden'].some(ok)).toBe(false)
  })
})

describe('BackupService bundle', () => {
  it('holds the database, config and state, with a manifest of checksums last', async () => {
    const { svc } = rig()
    const { name, stream } = await svc.bundle({ photos: false })
    expect(name).toBe('seedypod-backup-kitchen-20261031-120000.tar.gz')
    const files = untar(await collect(stream))
    expect([...files.keys()]).toEqual(['seedypod.db', 'etc/seedypod/hal.toml', 'var/lib/seedypod/state.json', 'manifest.json'])
    const m = JSON.parse(new TextDecoder().decode(files.get('manifest.json')))
    expect(m).toMatchObject({
      format: { name: 'seedypod-backup', version: 1 },
      createdAt: '2026-10-31T12:00:00.000Z',
      unit: { id: 'kitchen', name: 'Gardyn' },
      core: { version: 'main@abc1234' },
      hald: { version: '0.0.0-sim' },
      schema: { migrations: 7, tag: '0006_black_silver_sable' },
      photos: false,
      skipped: [],
    })
    for (const [n, f] of files) if (n !== 'manifest.json') expect(m.files[n]).toEqual({ bytes: f.length, sha256: sha256(f) })
  })

  it('leaves out a missing optional file silently and names an unreadable one', async () => {
    const { svc } = rig({ files: { '/etc/seedypod/hal.toml': 'x', '/etc/mosquitto/seedypod.passwd': 'ha:$7$…' }, denied: ['/etc/mosquitto/seedypod.passwd'] })
    const files = untar(await collect((await svc.bundle({ photos: false })).stream))
    expect(files.has('etc/mosquitto/seedypod.passwd')).toBe(false)
    const m = JSON.parse(new TextDecoder().decode(files.get('manifest.json')))
    expect(m.skipped).toEqual([{ path: '/etc/mosquitto/seedypod.passwd', reason: 'permission denied: rerun install-hal so core can read it' }])
  })

  it('adds the photos under captures/ when asked', async () => {
    const { svc, store } = rig({ files: { '/etc/seedypod/hal.toml': 'x', './data/captures/upper-1.jpg': 'jpeg' } })
    store.captures.add({ id: 'upper-1', camera: 'upper', ts: '2026-10-31T00:00:00Z', path: './data/captures/upper-1.jpg', bytes: 4 })
    store.captures.add({ id: 'upper-0', camera: 'upper', ts: '2026-10-30T00:00:00Z', path: './data/captures/upper-0.jpg', bytes: 4 })
    const files = untar(await collect((await svc.bundle({ photos: true })).stream))
    expect(new TextDecoder().decode(files.get('captures/upper-1.jpg'))).toBe('jpeg')
    const m = JSON.parse(new TextDecoder().decode(files.get('manifest.json')))
    expect(m.photos).toBe(true)
    expect(m.skipped).toEqual([{ path: './data/captures/upper-0.jpg', reason: 'missing (pruned)' }])
  })
})

describe('download', () => {
  it('counts as an off-card backup once fully read, and clears backup_stale', async () => {
    const { svc, store, advance } = rig()
    svc.checkStale()
    advance(8 * DAY)
    svc.checkStale()
    expect(store.alerts.list({ activeOnly: true }).map(a => a.kind)).toEqual([STALE_ALERT])
    const { stream } = await svc.download({ photos: false })
    expect(store.backups.lastSuccess()).toBeNull()
    const bytes = await collect(stream)
    expect(store.backups.lastSuccess()).toMatchObject({ destination: 'download', bytes: bytes.length, ok: true })
    expect(store.alerts.list({ activeOnly: true })).toEqual([])
  })
})

describe('bucket backups', () => {
  it('uploads to backups/ through the mirror and keeps the newest 14 for this unit', async () => {
    const { svc, b, store, advance } = rig({ mirror: true })
    b.objects.set('backups/seedypod-backup-garage-20260101-030000.tar.gz', { bytes: new Uint8Array(1), at: '' })
    for (let i = 0; i < 16; i++) {
      const r = await svc.backupToBucket()
      expect(r.ok).toBe(true)
      advance(DAY)
    }
    const keys = [...b.objects.keys()].sort()
    expect(keys.filter(k => k.includes('-kitchen-'))).toHaveLength(14)
    expect(keys).toContain('backups/seedypod-backup-garage-20260101-030000.tar.gz')
    expect(keys.filter(k => k.includes('-kitchen-'))[0]).toBe('backups/seedypod-backup-kitchen-20261102-120000.tar.gz')
    expect(store.backups.list(1)[0]).toMatchObject({ destination: 'bucket', ok: true, detail: 'removed 1 older' })
    const files = untar(b.objects.get(keys.at(-1) as string)?.bytes as Uint8Array)
    expect(files.has('seedypod.db')).toBe(true)
  })

  it('records a failed upload and refuses without a mirror', async () => {
    await expect(rig().svc.backupToBucket()).rejects.toThrow(/not configured/)
    const { svc, b, store } = rig({ mirror: true })
    b.remote.put = async () => {
      throw new Error('503 SlowDown')
    }
    const r = await svc.backupToBucket()
    expect(r).toMatchObject({ ok: false, detail: '503 SlowDown' })
    expect(store.backups.lastSuccess()).toBeNull()
  })

  it('lists newest first across units and only fetches backup keys', async () => {
    const { svc, b, cfg } = rig({ mirror: true })
    b.objects.set('backups/seedypod-backup-kitchen-20261001-030000.tar.gz', { bytes: new Uint8Array([1]), at: '' })
    b.objects.set('backups/seedypod-backup-garage-20261003-030000.tar.gz', { bytes: new Uint8Array([2]), at: '' })
    b.objects.set('backups/readme.txt', { bytes: new Uint8Array([3]), at: '' })
    const list = await svc.list(cfg)
    expect(list.map(x => [x.unit, x.createdAt])).toEqual([['garage', '2026-10-03T03:00:00Z'], ['kitchen', '2026-10-01T03:00:00Z']])
    expect([...await svc.fetch(list[0]?.key as string)]).toEqual([2])
    await expect(svc.fetch('../hal.toml')).rejects.toThrow(/not a backup key/)
    await expect(svc.fetch('backups/missing.tar.gz')).rejects.toThrow(/not in the bucket/)
  })
})

describe('nightly schedule', () => {
  it('runs after 03:00 local time, once a day, and retries a failure an hour later', async () => {
    const { svc, store, at, b } = rig({ mirror: true, at: '2026-10-31T02:30:00Z' })
    expect(svc.nightlyDue()).toBe(false)
    at('2026-10-31T03:01:00Z')
    expect(svc.nightlyDue()).toBe(true)
    await svc.tick()
    expect(b.objects.size).toBe(1)
    at('2026-10-31T20:00:00Z')
    expect(svc.nightlyDue()).toBe(false)
    at('2026-11-01T03:05:00Z')
    expect(svc.nightlyDue()).toBe(true)
    const put = b.remote.put
    b.remote.put = async () => {
      throw new Error('offline')
    }
    await svc.tick()
    expect(store.backups.list(1)[0]?.ok).toBe(false)
    at('2026-11-01T03:35:00Z')
    expect(svc.nightlyDue()).toBe(false)
    at('2026-11-01T04:06:00Z')
    b.remote.put = put
    expect(svc.nightlyDue()).toBe(true)
  })

  it('uses the unit timezone and stays off without a mirror', () => {
    const { svc, store, at } = rig({ mirror: true })
    store.settings.update({ timezone: 'America/Los_Angeles' })
    at('2026-10-31T09:00:00Z') // 02:00 in LA
    expect(svc.nightlyDue()).toBe(false)
    at('2026-10-31T10:30:00Z') // 03:30 in LA
    expect(svc.nightlyDue()).toBe(true)
    expect(rig().svc.nightlyDue()).toBe(false)
  })
})

describe('backup_stale', () => {
  it('counts 7 days from first start, then from the last success', async () => {
    const { svc, store, advance, seen } = rig({ mirror: true })
    svc.checkStale()
    advance(6 * DAY)
    svc.checkStale()
    expect(store.alerts.list({ activeOnly: true })).toEqual([])
    advance(DAY)
    svc.checkStale()
    expect(store.alerts.list({ activeOnly: true })[0]).toMatchObject({ kind: STALE_ALERT, detail: expect.stringMatching(/^No off-card backup yet\./) })
    expect(seen).toContain(`alerts.${STALE_ALERT}`)
    await svc.backupToBucket()
    expect(store.alerts.list({ activeOnly: true })).toEqual([])
    advance(7 * DAY)
    svc.checkStale()
    expect(store.alerts.list({ activeOnly: true })[0]?.detail).toBe('No off-card backup for 7 days (last 2026-11-07). Download one from Settings → Backup, or check the mirror.')
    expect(svc.status()).toMatchObject({ stale: true, staleAfterDays: 7, nightly: { enabled: true, hour: 3, keep: 14 } })
  })
})
