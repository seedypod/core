import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEventBus } from '../../lib/eventBus'
import { Recorder } from '../../telemetry/recorder'
import { MemoryStore } from '../memory'
import { defaultMigrationsFolder, MAX_HELD_TELEMETRY, SqliteStore } from '../sqlite'
import type { AnalysisRow, Store, TelemetryPoint } from '../types'

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
      // Pod boxes are JSON: they come back as they went in, and null clears them.
      expect(store.settings.get().podRegions).toBeNull()
      const podRegions = { lower: { 16: { x: 0.1, y: 0.2, w: 0.3, h: 0.25 } } }
      expect(store.settings.update({ podRegions }).podRegions).toEqual(podRegions)
      expect(store.settings.get().podRegions).toEqual(podRegions)
      expect(store.settings.update({ podRegions: null }).podRegions).toBeNull()
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

    it('a live alert refresh shows at once, and its last value stays in the history', () => {
      store = make()
      const a = store.alerts.raise('water_low', '151.4 cm', 't1')
      const b = store.alerts.raise('water_low', '151.9 cm', 't2', { live: true })
      expect(b).toMatchObject({ id: a.id, detail: '151.9 cm', raisedAt: 't1' })
      expect(store.alerts.list({ activeOnly: true })[0]?.detail).toBe('151.9 cm')
      expect(store.alerts.clear('water_low', 't3')).toMatchObject({ active: false, detail: '151.9 cm' })
      expect(store.alerts.list()[0]?.detail).toBe('151.9 cm')

      const c = store.alerts.raise('over_temp', 'pcb 71.0 °C', 't4')
      store.alerts.raise('over_temp', 'pcb 72.0 °C', 't5', { live: true })
      expect(store.alerts.acknowledge(c.id, 't6')?.detail).toBe('pcb 72.0 °C')
      store.alerts.raise('over_temp', 'pcb 73.0 °C', 't7', { live: true })
      expect(store.alerts.dismiss(c.id, 't8')).toMatchObject({ active: false, detail: 'pcb 73.0 °C' })
      expect(store.alerts.acknowledge(999, 't9')).toBeNull()
      expect(store.alerts.dismiss(999, 't9')).toBeNull()
    })

    it('telemetry reads back before and after a flush, without doubling', () => {
      store = make()
      store.telemetry.add([{ ts: '2026-01-01T00:00:00.000Z', sensor: 'air_temp', value: 20 }, { ts: '2026-01-01T00:00:00.000Z', sensor: 'humidity', value: 50 }])
      const read = () => store.telemetry.range('air_temp', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
      expect(read()).toEqual([{ ts: '2026-01-01T00:00:00.000Z', sensor: 'air_temp', value: 20 }])
      store.telemetry.flush()
      store.telemetry.flush()
      expect(read()).toHaveLength(1)
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

    it('pods: a status change moves statusSince; other edits leave it', () => {
      store = make()
      store.pods.update(3, { status: 'growing' }, '2026-02-01T00:00:00Z')
      expect(store.pods.update(3, { notes: 'pinch tops' }, '2026-02-05T00:00:00Z').statusSince).toBe('2026-02-01T00:00:00Z')
      expect(store.pods.update(3, { status: 'growing' }, '2026-02-06T00:00:00Z').statusSince).toBe('2026-02-01T00:00:00Z')
      const cut = store.pods.update(3, { status: 'harvest', lastHarvestAt: '2026-02-07T00:00:00Z' }, '2026-02-07T00:00:00Z')
      expect(cut).toMatchObject({ statusSince: '2026-02-07T00:00:00Z', lastHarvestAt: '2026-02-07T00:00:00Z' })
    })

    it('plant profiles upsert by case-folded name, list in key order, and remove', () => {
      store = make()
      const p = { harvestMinDays: 21, harvestMaxDays: 35, targetCover: 0.35, notes: '', source: 'agent' as const }
      store.plants.upsert({ name: 'Kale', ...p }, 't1')
      store.plants.upsert({ name: 'Basil', ...p, harvestMinDays: 25 }, 't1')
      const again = store.plants.upsert({ name: ' kale ', ...p, harvestMaxDays: 50, source: 'user' }, 't2')
      expect(again).toMatchObject({ key: 'kale', name: ' kale ', harvestMaxDays: 50, source: 'user', updatedAt: 't2' })
      expect(store.plants.list().map(x => [x.key, x.harvestMaxDays])).toEqual([['basil', 35], ['kale', 50]])
      expect(store.plants.remove('KALE')).toBe(true)
      expect(store.plants.remove('kale')).toBe(false)
      expect(store.plants.list().map(x => x.key)).toEqual(['basil'])
    })

    it('custom plants upsert by id keeping createdAt, list oldest first, and remove', () => {
      store = make()
      const shiso = { id: 'purple-shiso', name: 'Purple Shiso', category: 'herb' as const, zone: 'medium' as const, harvestMonths: [2, 3] as [number, number], careLevel: null, size: 'normal' as const, succession: 'long-greens-herbs' as const, source: 'user' as const }
      expect(store.customPlants.upsert(shiso, 't1')).toEqual({ ...shiso, createdAt: 't1', updatedAt: 't1' })
      store.customPlants.upsert({ ...shiso, id: 'okra', name: 'Okra', category: 'fruiting', zone: 'high', size: 'large', succession: 'fast-fruiting', careLevel: 'expert' }, 't2')
      const again = store.customPlants.upsert({ ...shiso, name: 'Shiso', harvestMonths: [1, 2], source: 'agent' }, 't3')
      expect(again).toMatchObject({ id: 'purple-shiso', name: 'Shiso', harvestMonths: [1, 2], source: 'agent', createdAt: 't1', updatedAt: 't3' })
      expect(store.customPlants.list().map(x => [x.id, x.careLevel])).toEqual([['purple-shiso', null], ['okra', 'expert']])
      expect(store.customPlants.get('okra')).toMatchObject({ size: 'large', zone: 'high' })
      expect(store.customPlants.get('nope')).toBeNull()
      expect(store.customPlants.remove('okra')).toBe(true)
      expect(store.customPlants.remove('okra')).toBe(false)
      expect(store.customPlants.list().map(x => x.id)).toEqual(['purple-shiso'])
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

    it('telemetry thins one sensor in a window to the first row of each bucket', () => {
      store = make()
      const at = (h: number, m: number, s = 0) => `2026-01-01T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`
      const pts: TelemetryPoint[] = []
      for (let m = 0; m < 60; m++) pts.push({ ts: at(1, m), sensor: 'air_temp', value: m })
      pts.push({ ts: at(1, 0, 30), sensor: 'humidity', value: 50 }, { ts: at(1, 1, 30), sensor: 'humidity', value: 51 })
      pts.push({ ts: at(2, 0), sensor: 'air_temp', value: 99 }, { ts: at(2, 1), sensor: 'air_temp', value: 100 })
      store.telemetry.add(pts)
      store.telemetry.flush()
      expect(store.telemetry.thin(['air_temp'], at(1, 0), at(2, 0), 15)).toBe(56)
      const air = store.telemetry.range('air_temp', at(0, 0), at(3, 0), 1000).map(p => p.value)
      expect(air).toEqual([0, 15, 30, 45, 99, 100])
      expect(store.telemetry.range('humidity', at(0, 0), at(3, 0), 1000)).toHaveLength(2)
      expect(store.telemetry.thin(['air_temp'], at(1, 0), at(2, 0), 15)).toBe(0)
      // Buckets are per sensor: two sensors in the same quarter hour each keep a row.
      store.telemetry.add([{ ts: at(1, 2), sensor: 'ph', value: 6 }])
      store.telemetry.flush()
      expect(store.telemetry.thin(['humidity', 'ph'], at(1, 0), at(2, 0), 15)).toBe(1)
      expect(store.telemetry.range('ph', at(0, 0), at(3, 0), 1000)).toHaveLength(1)
    })

    it('telemetry knows its first row, and that there may be none', () => {
      store = make()
      expect(store.telemetry.oldestTs()).toBeNull()
      store.telemetry.add([{ ts: '2026-01-02T00:00:00.000Z', sensor: 'air_temp', value: 1 }, { ts: '2026-01-03T00:00:00.000Z', sensor: 'air_temp', value: 2 }])
      store.telemetry.flush()
      expect(store.telemetry.oldestTs()).toBe('2026-01-02T00:00:00.000Z')
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

    it('removing a capture\'s device scores keeps its remote ones and every other capture\'s', () => {
      store = make()
      const row = (o: Partial<AnalysisRow>): AnalysisRow => ({ captureId: 'a', ts: '2026-01-01T00:00:00Z', camera: 'upper', analyzer: 'green-threshold', version: 1, source: 'device', slot: 1, metric: 'green_fraction', value: 0.1, detail: null, artifact: null, ...o })
      store.analyses.add([row({}), row({ analyzer: 'exg-otsu' }), row({ analyzer: 'leaf-unet', source: 'remote' }), row({ captureId: 'b' })])
      store.analyses.removeDevice('a')
      expect(store.analyses.forCapture('a').map(r => r.analyzer)).toEqual(['leaf-unet'])
      expect(store.analyses.forCapture('b')).toHaveLength(1)
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
      expect(store.settings.get().homekitEnabled).toBe(false)
      expect(store.settings.update({ homekitEnabled: true }).homekitEnabled).toBe(true)
    })

    it('plans save, update, apply, issue and remove', () => {
      store = make()
      const layout = { model: 'home' as const, assignments: [], unplaced: [], free: [1], zones: [], suggestions: [] }
      const p = store.plans.save({ id: 'p1', name: 'Autumn', model: 'home', mode: 'staggered', request: [{ plantId: 'basil', count: 2 }], layout, sowing: [] })
      expect(p.appliedAt).toBeNull()
      store.plans.save({ ...p, name: 'Autumn greens' })
      expect(store.plans.get('p1')?.name).toBe('Autumn greens')
      expect(store.plans.get('p1')?.createdAt).toBe(p.createdAt)
      expect(store.plans.markApplied('p1', '2026-11-02T00:00:00Z')?.appliedAt).toBe('2026-11-02T00:00:00Z')
      store.plans.markIssued('p1', 'basil:2')
      store.plans.markIssued('p1', 'basil:2')
      expect(store.plans.get('p1')?.issued).toEqual(['basil:2'])
      expect(store.plans.list()).toHaveLength(1)
      expect(store.plans.remove('p1')).toBe(true)
      expect(store.plans.get('p1')).toBeNull()
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
      writeFileSync(join(old, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.filter(e => e.tag < '0007') }))
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

  it('carries custom catalog plants in a backup (#130)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'store-'))
    try {
      const store = new SqliteStore({ url: join(root, 'live.db') })
      store.customPlants.upsert({ id: 'okra', name: 'Okra', category: 'fruiting', zone: 'high', harvestMonths: [2, 3], careLevel: null, size: 'large', succession: 'fast-fruiting', source: 'user' }, 't1')
      await store.backupTo(join(root, 'copy.db'))
      store.close()
      const copy = new SqliteStore({ url: join(root, 'copy.db') })
      expect(copy.customPlants.list()).toMatchObject([{ id: 'okra', name: 'Okra', harvestMonths: [2, 3], size: 'large' }])
      copy.close()
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  describe('card writes (ADR-0021)', () => {
    const FRAME = 4096 + 24
    const point = (i: number): TelemetryPoint => ({ ts: new Date(i * 60_000).toISOString(), sensor: 'air_temp', value: i })
    const from = new Date(0).toISOString()
    const to = new Date(1e13).toISOString()

    /** A store on a real file, plus a second connection that sees only what reached the database. */
    function onDisk(test: (o: { url: string, root: string, store: SqliteStore, card: Database.Database, walBytes: () => number }) => Promise<void> | void) {
      return async () => {
        const root = mkdtempSync(join(tmpdir(), 'store-'))
        const url = join(root, 'core.db')
        const store = new SqliteStore({ url })
        const card = new Database(url)
        try {
          await test({ url, root, store, card, walBytes: () => statSync(`${url}-wal`).size })
        }
        finally {
          card.close()
          rmSync(root, { recursive: true, force: true })
          vi.restoreAllMocks()
        }
      }
    }
    const stored = (card: Database.Database) => (card.prepare('SELECT count(*) AS n FROM telemetry').get() as { n: number }).n
    const failWrites = (card: Database.Database) => card.exec(`CREATE TRIGGER card_failed BEFORE INSERT ON telemetry BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`)

    it('keeps a live alert detail off the card until the alert changes state', onDisk(({ store, card, walBytes }) => {
      const a = store.alerts.raise('water_low', '151.4 cm', 't1')
      const row = () => card.prepare('SELECT detail, acknowledgedAt FROM alerts WHERE id = ?').get(a.id)
      const before = walBytes()
      for (let i = 0; i < 20; i++) store.alerts.raise('water_low', `15${i} cm`, 't2', { live: true })
      expect(walBytes()).toBe(before)
      expect(row()).toEqual({ detail: '151.4 cm', acknowledgedAt: null })

      store.alerts.acknowledge(a.id, 't3')
      expect(row()).toEqual({ detail: '1519 cm', acknowledgedAt: 't3' })
      store.alerts.raise('water_low', '160 cm', 't4', { live: true })
      store.alerts.clear('water_low', 't5')
      expect(row()).toEqual({ detail: '160 cm', acknowledgedAt: 't3' })
      store.close()
    }))

    it('writes the raise itself at once, so a power cut keeps the alert', onDisk(({ store, card }) => {
      store.alerts.raise('water_low', '151.4 cm', 't1', { live: true })
      expect(card.prepare('SELECT kind, detail, active FROM alerts').all()).toEqual([{ kind: 'water_low', detail: '151.4 cm', active: 1 }])
      store.close()
    }))

    it('shows the detail on the row after a restart, until hald sends a new one', onDisk(({ url, store }) => {
      store.alerts.raise('water_low', '151.4 cm', 't1')
      store.alerts.raise('water_low', '155.0 cm', 't2', { live: true })
      store.close()
      const after = new SqliteStore({ url })
      expect(after.alerts.list({ activeOnly: true })[0]?.detail).toBe('151.4 cm')
      after.alerts.raise('water_low', '156.0 cm', 't3', { live: true })
      expect(after.alerts.list({ activeOnly: true })).toMatchObject([{ detail: '156.0 cm', raisedAt: 't1' }])
      after.close()
    }))

    it('writes a plain refresh through, replacing any live detail', onDisk(({ store, card }) => {
      store.alerts.raise('camera_missing', 'upper: no frame', 't1')
      store.alerts.raise('camera_missing', 'upper: timeout', 't2', { live: true })
      store.alerts.raise('camera_missing', 'lower camera returned 0 bytes', 't3')
      expect(card.prepare('SELECT detail FROM alerts').get()).toEqual({ detail: 'lower camera returned 0 bytes' })
      expect(store.alerts.list({ activeOnly: true })[0]?.detail).toBe('lower camera returned 0 bytes')
      store.close()
    }))

    it('holds telemetry off the card, and serves it without a write', onDisk(({ store, card, walBytes }) => {
      const before = walBytes()
      store.telemetry.add([point(1), point(2)])
      expect(store.telemetry.range('air_temp', from, to)).toHaveLength(2)
      expect(stored(card)).toBe(0)
      expect(walBytes()).toBe(before)
      store.telemetry.flush()
      expect(stored(card)).toBe(2)
      store.close()
    }))

    it('merges held rows with stored ones in time order, inside the window', onDisk(({ store }) => {
      store.telemetry.add([point(3)])
      store.telemetry.flush()
      store.telemetry.add([point(1), point(5), { ...point(2), sensor: 'humidity' }])
      expect(store.telemetry.range('air_temp', from, to).map(p => p.value)).toEqual([1, 3, 5])
      expect(store.telemetry.range('air_temp', point(2).ts, point(4).ts).map(p => p.value)).toEqual([3])
      expect(store.telemetry.range('air_temp', from, to, 2)).toHaveLength(2)
      store.close()
    }))

    it('flushes on close', onDisk(({ url, store }) => {
      store.telemetry.add([point(1)])
      store.close()
      const card = new Database(url)
      expect(stored(card)).toBe(1)
      card.close()
    }))

    it('flushes before a backup, so the copy has the latest rows', onDisk(async ({ root, store }) => {
      store.telemetry.add([point(1)])
      const dest = join(root, 'copy.db')
      await store.backupTo(dest)
      const copy = new Database(dest)
      expect(stored(copy)).toBe(1)
      copy.close()
      store.close()
    }))

    it('refuses a backup that would leave held rows out, until they reach the card', onDisk(async ({ root, store, card }) => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      failWrites(card)
      store.telemetry.add([point(1), point(2)])
      const dest = join(root, 'copy.db')
      await expect(store.backupTo(dest)).rejects.toThrow('the card refused 2 telemetry rows')
      expect(existsSync(dest)).toBe(false)
      card.exec('DROP TRIGGER card_failed')
      await store.backupTo(dest)
      const copy = new Database(dest)
      expect(stored(copy)).toBe(2)
      copy.close()
      store.close()
    }))

    it('keeps rows through a failed write and lands them on the next one', onDisk(({ store, card }) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      failWrites(card)
      store.telemetry.add([point(1)])
      expect(() => store.telemetry.flush()).not.toThrow()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('holding 1 rows'))
      expect(store.telemetry.range('air_temp', from, to)).toHaveLength(1)
      card.exec('DROP TRIGGER card_failed')
      store.telemetry.flush()
      expect(stored(card)).toBe(1)
      expect(store.telemetry.range('air_temp', from, to)).toHaveLength(1)
      store.close()
    }))

    it('still closes when the last flush fails', onDisk(({ store, card }) => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      failWrites(card)
      store.telemetry.add([point(1)])
      expect(() => store.close()).not.toThrow()
    }))

    it('drops the oldest rows once a failing card has filled the buffer', onDisk(({ store, card }) => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      failWrites(card)
      store.telemetry.add(Array.from({ length: MAX_HELD_TELEMETRY + 10 }, (_, i) => point(i)))
      store.telemetry.add([point(MAX_HELD_TELEMETRY + 10)])
      const rows = store.telemetry.range('air_temp', from, to, Number.MAX_SAFE_INTEGER)
      expect(rows).toHaveLength(MAX_HELD_TELEMETRY)
      expect(rows[0]?.value).toBe(11)
      expect(rows.at(-1)?.value).toBe(MAX_HELD_TELEMETRY + 10)
      store.close()
    }))

    it('tries a full buffer once, then leaves retries to the timer until a flush lands', onDisk(({ store, card }) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const fill = () => store.telemetry.add(Array.from({ length: MAX_HELD_TELEMETRY }, (_, i) => point(i)))
      failWrites(card)
      fill()
      expect(warn).toHaveBeenCalledTimes(1)
      for (let i = 0; i < 20; i++) store.telemetry.add([point(MAX_HELD_TELEMETRY + i)])
      expect(warn).toHaveBeenCalledTimes(1)
      const held = store.telemetry.range('air_temp', from, to, Number.MAX_SAFE_INTEGER)
      expect(held).toHaveLength(MAX_HELD_TELEMETRY)
      expect(held.at(-1)?.value).toBe(MAX_HELD_TELEMETRY + 19)

      // The timer's flush isn't gated, and a failure leaves the gate shut.
      store.telemetry.flush()
      expect(warn).toHaveBeenCalledTimes(2)
      store.telemetry.add([point(MAX_HELD_TELEMETRY + 20)])
      expect(warn).toHaveBeenCalledTimes(2)

      card.exec('DROP TRIGGER card_failed')
      store.telemetry.flush()
      expect(stored(card)).toBe(MAX_HELD_TELEMETRY)

      // A flush that lands opens the gate, so a full buffer writes itself again.
      fill()
      expect(stored(card)).toBe(2 * MAX_HELD_TELEMETRY)
      failWrites(card)
      fill()
      expect(warn).toHaveBeenCalledTimes(3)
      card.exec('DROP TRIGGER card_failed')
      store.close()
    }))

    it('writes a full buffer straight away on a healthy card', onDisk(({ store, card }) => {
      store.telemetry.add(Array.from({ length: MAX_HELD_TELEMETRY }, (_, i) => point(i)))
      expect(stored(card)).toBe(MAX_HELD_TELEMETRY)
      store.close()
    }))

    it('stays inside the wear budget for an hour with an alert firing', onDisk(({ store, walBytes }) => {
      const sensors = ['air_temp', 'humidity', 'pcb_temp', 'water_distance', 'water_level_pct', 'pump_v', 'pump_a', 'pump_w'] as const
      const events = createEventBus()
      let t = Date.parse('2026-11-01T00:00:00Z')
      const r = new Recorder({ store, events, now: () => new Date(t) })
      r.onHal({ type: 'alert', alert: { kind: 'water_low', active: true, ts: new Date(t).toISOString(), detail: 'water distance 150.0 cm ≥ 16.0 cm' } })
      const start = walBytes()
      for (let tick = 1; tick <= 360; tick++) {
        t += 10_000
        const ts = new Date(t).toISOString()
        for (const id of sensors) r.onHal({ type: 'sensor', id, reading: { ts, value: tick, unit: 'x', quality: 'good' } })
        r.onHal({ type: 'alert', alert: { kind: 'water_low', active: true, ts, detail: `water distance ${150 + tick / 10} cm ≥ 16.0 cm` } })
        if (tick % 30 === 0) store.telemetry.flush()
      }
      // Measured before batching: about 1,850 frames an hour. Row-by-row inserts or a detail written per reading blow this.
      expect((walBytes() - start) / FRAME).toBeLessThan(300)
      store.close()
    }))
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
