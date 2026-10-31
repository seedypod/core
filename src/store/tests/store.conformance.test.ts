import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../memory'
import { defaultMigrationsFolder, SqliteStore } from '../sqlite'
import type { AnalysisRow, Store } from '../types'

const impls: [string, () => Store][] = [
  ['MemoryStore', () => new MemoryStore(30)],
  ['SqliteStore', () => new SqliteStore({ url: ':memory:' })],
]

for (const [name, make] of impls) {
  describe(`${name} conformance`, () => {
    let store: Store
    afterEach(() => store?.close())

    it('settings have defaults and patch', () => {
      store = make()
      expect(store.settings.get().thinningReminderDays).toBe(14)
      const s = store.settings.update({ timezone: 'America/Los_Angeles', waterFullCm: 6 })
      expect(s.timezone).toBe('America/Los_Angeles')
      expect(store.settings.get().waterFullCm).toBe(6)
    })

    it('schedules upsert, list, remove; runs are idempotent by key', () => {
      store = make()
      store.schedules.upsert({ id: 'l1', kind: 'light', name: 'Day', enabled: true, days: 127, spec: { setpoints: [{ minute: 360, level: 0 }, { minute: 420, level: 70 }] } })
      store.schedules.upsert({ id: 'l1', kind: 'light', name: 'Daylight', enabled: true, days: 127, spec: { setpoints: [] } })
      expect(store.schedules.list().map(s => s.name)).toEqual(['Daylight'])
      expect(store.schedules.recordRun({ scheduleId: 'l1', key: 'l1:2026-10-31:420', firedAt: 't', result: 'ok' })).toBe(true)
      expect(store.schedules.recordRun({ scheduleId: 'l1', key: 'l1:2026-10-31:420', firedAt: 't', result: 'ok' })).toBe(false)
      expect(store.schedules.recentRuns()).toHaveLength(1)
      expect(store.schedules.remove('l1')).toBe(true)
      expect(store.schedules.list()).toHaveLength(0)
    })

    it('alerts raise once per kind, clear, acknowledge, dismiss', () => {
      store = make()
      const a = store.alerts.raise('water_low', 'low', '2026-01-01T00:00:00Z')
      const b = store.alerts.raise('water_low', 'still low', '2026-01-01T00:01:00Z')
      expect(b.id).toBe(a.id)
      expect(store.alerts.list({ activeOnly: true })).toHaveLength(1)
      expect(store.alerts.list({ activeOnly: true })[0]?.detail).toBe('still low')
      store.alerts.acknowledge(a.id, '2026-01-01T00:02:00Z')
      expect(store.alerts.clear('water_low', '2026-01-01T00:03:00Z')?.active).toBe(false)
      expect(store.alerts.clear('water_low', 'x')).toBeNull()
      const c = store.alerts.raise('reminder_thinning', 'thin', 't')
      store.alerts.dismiss(c.id, 't2')
      expect(store.alerts.list({ activeOnly: true })).toHaveLength(0)
      expect(store.alerts.list()).toHaveLength(2)
    })

    it('grow cycles: start ends the previous one; stages and issued reminders persist', () => {
      store = make()
      expect(store.grow.current()).toBeNull()
      const c1 = store.grow.start('2026-01-01T00:00:00Z', 'first')
      store.grow.setStage('seedling', 't')
      store.grow.markIssued('thinning')
      store.grow.markIssued('thinning')
      expect(store.grow.current()).toMatchObject({ id: c1.id, stage: 'seedling', issued: ['thinning'] })
      const c2 = store.grow.start('2026-03-01T00:00:00Z')
      expect(c2.id).not.toBe(c1.id)
      expect(store.grow.history()).toHaveLength(2)
      expect(store.grow.history().find(c => c.id === c1.id)?.stage).toBe('ended')
      store.grow.end('t')
      expect(store.grow.current()).toBeNull()
    })

    it('pods: 30 slots seeded empty and updatable', () => {
      store = make()
      expect(store.pods.list()).toHaveLength(30)
      const p = store.pods.update(7, { plant: 'Basil', status: 'seeded', plantedAt: '2026-01-01' }, 't')
      expect(p).toMatchObject({ slot: 7, plant: 'Basil', status: 'seeded' })
      expect(() => store.pods.update(31, {}, 't')).toThrow()
    })

    it('captures list newest first and prune keeps N', () => {
      store = make()
      for (let i = 0; i < 5; i++) store.captures.add({ id: `c${i}`, camera: 'upper', ts: `2026-01-0${i + 1}T00:00:00Z`, path: `/x/${i}.jpg`, bytes: 100 })
      store.captures.add({ id: 'low', camera: 'lower', ts: '2026-01-09T00:00:00Z', path: '/x/l.jpg', bytes: 1 })
      expect(store.captures.list('upper')[0]?.id).toBe('c4')
      const dropped = store.captures.prune('upper', 2)
      expect(dropped.map(d => d.id).sort()).toEqual(['c0', 'c1', 'c2'])
      expect(store.captures.list('upper')).toHaveLength(2)
      expect(store.captures.list('lower')).toHaveLength(1)
    })

    it('telemetry range filters by sensor/time and downsamples', () => {
      store = make()
      const pts = Array.from({ length: 1000 }, (_, i) => ({ ts: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), sensor: 'air_temp' as const, value: 20 + (i % 5) }))
      store.telemetry.add(pts)
      store.telemetry.add([{ ts: '2026-01-01T00:30:00.000Z', sensor: 'humidity', value: 50 }])
      const r = store.telemetry.range('air_temp', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 100)
      expect(r).toHaveLength(100)
      expect(r.every(p => p.sensor === 'air_temp')).toBe(true)
    })

    it('analysis rows upsert, version per series and stats per analyser', () => {
      store = make()
      const row = (o: Partial<AnalysisRow>): AnalysisRow => ({ captureId: 'a', ts: '2026-01-01T00:00:00Z', camera: 'upper', analyzer: 'green-threshold', version: 1, source: 'device', slot: 1, metric: 'green_fraction', value: 0.1, detail: null, artifact: null, ...o })
      store.analyses.add([
        row({}),
        row({ captureId: 'b', ts: '2026-01-02T00:00:00Z', value: 0.2 }),
        row({ slot: 2, value: 0.5 }),
        row({ analyzer: 'exg-otsu', value: 0.15, detail: { threshold: 140 }, artifact: 'analysis/a/exg-otsu@1/mask.pbm' }),
        row({ analyzer: 'exg-otsu', version: 2, value: 0.17 }),
        row({ analyzer: 'leaf-unet', source: 'remote', value: 0.12 }),
      ])
      // Re-running the same analyser@version on a capture replaces, never duplicates.
      store.analyses.add([row({ value: 0.11 })])
      expect(store.analyses.series({ analyzer: 'green-threshold', slot: 1, metric: 'green_fraction' }).map(p => p.value)).toEqual([0.11, 0.2])
      expect(store.analyses.series({ analyzer: 'exg-otsu', slot: 1, metric: 'green_fraction' }).map(p => p.value)).toEqual([0.17])
      expect(store.analyses.series({ analyzer: 'exg-otsu', version: 1, slot: 1, metric: 'green_fraction' }).map(p => p.value)).toEqual([0.15])
      expect(store.analyses.series({ analyzer: 'nothing', slot: 1, metric: 'green_fraction' })).toEqual([])
      const a = store.analyses.forCapture('a')
      expect(a).toHaveLength(5)
      expect(a.find(r => r.analyzer === 'exg-otsu' && r.version === 1)).toMatchObject({ detail: { threshold: 140 }, artifact: 'analysis/a/exg-otsu@1/mask.pbm' })
      expect(store.analyses.range('2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z').map(r => r.captureId)).toEqual(['b'])
      expect(store.analyses.stats().map(s => [s.analyzer, s.version, s.source, s.rows, s.captures])).toEqual([
        ['exg-otsu', 1, 'device', 1, 1],
        ['exg-otsu', 2, 'device', 1, 1],
        ['green-threshold', 1, 'device', 3, 2],
        ['leaf-unet', 1, 'remote', 1, 1],
      ])
      expect(store.analyses.stats().find(s => s.analyzer === 'green-threshold')).toMatchObject({ firstTs: '2026-01-01T00:00:00Z', lastTs: '2026-01-02T00:00:00Z' })
    })

    it('automations round-trip their AST, update in place and keep a pruned run log', () => {
      store = make()
      const rule = { name: 'pH high', enabled: true, dryRun: true, priority: 50, cooldownMin: 30, trigger: { kind: 'tick' as const, everyMin: 5 }, conditions: { kind: 'compare' as const, op: '>' as const, left: { kind: 'signal' as const, signal: 'sensor.ph' }, right: { kind: 'literal' as const, value: 6.5 } }, actions: [{ kind: 'notify' as const, message: 'high' }] }
      const a = store.automations.create(rule, '2026-10-01T00:00:00Z')
      const b = store.automations.create({ ...rule, name: 'other' }, '2026-10-01T00:00:00Z')
      expect(a).toMatchObject({ ...rule, id: a.id, createdAt: '2026-10-01T00:00:00Z' })
      expect(store.automations.update(a.id, { dryRun: false, cooldownMin: null }, '2026-10-02T00:00:00Z')).toMatchObject({ dryRun: false, cooldownMin: null, name: 'pH high', updatedAt: '2026-10-02T00:00:00Z' })
      expect(store.automations.update(999, { name: 'x' }, 't')).toBeNull()
      expect(store.automations.get(999)).toBeNull()
      store.automations.addRun({ automationId: a.id, firedAt: '2026-10-01T00:00:00Z', outcome: 'skipped', detail: { reason: 'condition-false' } })
      store.automations.addRun({ automationId: a.id, firedAt: '2026-10-03T00:00:00Z', outcome: 'fired', detail: { actions: [] } })
      store.automations.addRun({ automationId: b.id, firedAt: '2026-10-03T00:00:00Z', outcome: 'dry_run', detail: {} })
      expect(store.automations.runs({ automationId: a.id }).map(r => r.outcome)).toEqual(['fired', 'skipped'])
      expect(store.automations.runs({ limit: 1 })[0]).toMatchObject({ automationId: b.id })
      expect(store.automations.runs({ automationId: a.id })[1]?.detail).toEqual({ reason: 'condition-false' })
      expect(store.automations.pruneRuns('2026-10-02T00:00:00Z')).toBe(1)
      expect(store.automations.remove(a.id)).toBe(true)
      expect(store.automations.remove(a.id)).toBe(false)
      expect(store.automations.runs()).toHaveLength(1)
      expect(store.automations.list().map(r => r.name)).toEqual(['other'])
      expect(store.settings.get().autopilotEnabled).toBe(true)
    })

    it('counters accumulate', () => {
      store = make()
      store.counters.add('light_hours', 1.5, 't')
      expect(store.counters.add('light_hours', 2, 't')).toBe(3.5)
      expect(store.counters.get('nothing')).toBe(0)
    })

    it('backups log newest first and finds the last success per destination', () => {
      store = make()
      expect(store.backups.lastSuccess()).toBeNull()
      store.backups.add({ ts: '2026-10-01T03:00:00Z', destination: 'bucket', name: 'a', bytes: 10, ok: true, detail: '' })
      store.backups.add({ ts: '2026-10-02T03:00:00Z', destination: 'bucket', name: 'b', bytes: 0, ok: false, detail: 'timeout' })
      const d = store.backups.add({ ts: '2026-10-01T12:00:00Z', destination: 'download', name: 'c', bytes: 20, ok: true, detail: '' })
      expect(d.id).toBeGreaterThan(0)
      expect(store.backups.list().map(r => r.name)).toEqual(['b', 'c', 'a'])
      expect(store.backups.list(1)[0]).toMatchObject({ name: 'b', ok: false, detail: 'timeout', destination: 'bucket' })
      expect(store.backups.lastSuccess()?.name).toBe('c')
      expect(store.backups.lastSuccess('bucket')?.name).toBe('a')
    })

    it('flash samples keep order, upsert on ts and prune by age', () => {
      store = make()
      expect(store.flash.last()).toBeNull()
      store.flash.add({ ts: '2026-10-02T00:00:00Z', sectors: 200, bytes: 51200 })
      store.flash.add({ ts: '2026-10-01T00:00:00Z', sectors: 100, bytes: 0 })
      store.flash.add({ ts: '2026-10-02T00:00:00Z', sectors: 300, bytes: 102400 })
      expect(store.flash.last()).toEqual({ ts: '2026-10-02T00:00:00Z', sectors: 300, bytes: 102400 })
      expect(store.flash.since('2026-10-01T00:00:00Z').map(s => s.sectors)).toEqual([100, 300])
      expect(store.flash.prune('2026-10-02T00:00:00Z')).toBe(1)
      expect(store.flash.since('2000-01-01T00:00:00Z')).toHaveLength(1)
    })
  })
}

describe('SqliteStore on disk', () => {
  it('migrates pod_growth into analysis_results as green-threshold@1', () => {
    const root = mkdtempSync(join(tmpdir(), 'store-'))
    const url = join(root, 'core.db')
    try {
      // Bring a database up to the last schema that had pod_growth, with history in it.
      const old = mkdtempSync(join(tmpdir(), 'migrations-'))
      const src = defaultMigrationsFolder()
      cpSync(src, old, { recursive: true })
      const journal = JSON.parse(readFileSync(join(old, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> }
      journal.entries = journal.entries.slice(0, 2)
      writeFileSync(join(old, 'meta/_journal.json'), JSON.stringify(journal))
      const db = new Database(url)
      migrate(drizzle(db), { migrationsFolder: old })
      db.prepare('INSERT INTO captures (id, camera, ts, path, bytes) VALUES (?, ?, ?, ?, ?)').run('lower-1', 'lower', '2026-01-01T00:00:00Z', 'x', 1)
      db.prepare('INSERT INTO pod_growth (ts, slot, green, captureId) VALUES (?, ?, ?, ?)').run('2026-01-01T00:00:00Z', 16, 0.4, 'lower-1')
      db.prepare('INSERT INTO pod_growth (ts, slot, green, captureId) VALUES (?, ?, ?, ?)').run('2026-01-01T00:00:00Z', 3, 0.2, 'pruned-long-ago')
      db.close()
      rmSync(old, { recursive: true, force: true })

      const store = new SqliteStore({ url })
      expect(store.analyses.forCapture('lower-1')).toMatchObject([{ analyzer: 'green-threshold', version: 1, source: 'device', camera: 'lower', slot: 16, metric: 'green_fraction', value: 0.4 }])
      // A capture pruned before the migration still lands on the camera its slot implies.
      expect(store.analyses.forCapture('pruned-long-ago')).toMatchObject([{ camera: 'upper', slot: 3 }])
      expect(store.settings.get().primaryAnalyzer).toBe('green-threshold')
      store.close()
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('starts a new database on Welcome, but migrates an existing one as set up', () => {
    const root = mkdtempSync(join(tmpdir(), 'store-'))
    try {
      const fresh = new SqliteStore({ url: join(root, 'fresh.db') })
      expect(fresh.settings.get().setupComplete).toBe(false)
      fresh.close()
      // A database from before migration 0007, with its settings row.
      const url = join(root, 'old.db')
      const journal = JSON.parse(readFileSync(join(defaultMigrationsFolder(), 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] }
      const old = join(root, 'migrations-0006')
      cpSync(defaultMigrationsFolder(), old, { recursive: true })
      writeFileSync(join(old, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.filter(e => !e.tag.startsWith('0007')) }))
      const db = new Database(url)
      migrate(drizzle(db), { migrationsFolder: old })
      db.prepare('INSERT INTO device_settings (id, updatedAt) VALUES (1, ?)').run('2026-10-01T00:00:00Z')
      db.close()
      const after = new SqliteStore({ url })
      expect(after.settings.get().setupComplete).toBe(true)
      after.close()
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('backs up to a single-file copy that counts as set up', async () => {
    const root = mkdtempSync(join(tmpdir(), 'store-'))
    try {
      const store = new SqliteStore({ url: join(root, 'live.db') })
      store.settings.update({ unitName: 'Kitchen' })
      await store.backupTo(join(root, 'copy.db'))
      store.close()
      expect(existsSync(join(root, 'copy.db-wal'))).toBe(false)
      const copy = new SqliteStore({ url: join(root, 'copy.db') })
      expect(copy.settings.get()).toMatchObject({ unitName: 'Kitchen', setupComplete: true })
      copy.close()
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates a missing data directory on first boot', () => {
    const root = mkdtempSync(join(tmpdir(), 'store-'))
    const url = join(root, 'data', 'nested', 'core.db')
    try {
      const store = new SqliteStore({ url })
      expect(existsSync(url)).toBe(true)
      expect(store.settings.get().thinningReminderDays).toBe(14)
      store.close()
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
