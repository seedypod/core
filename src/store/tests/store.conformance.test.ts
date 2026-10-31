import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../memory'
import { SqliteStore } from '../sqlite'
import type { Store } from '../types'

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

    it('pod growth series and latest per slot', () => {
      store = make()
      store.podGrowth.add([
        { ts: '2026-01-01T00:00:00Z', slot: 1, green: 0.1, captureId: 'a' },
        { ts: '2026-01-02T00:00:00Z', slot: 1, green: 0.2, captureId: 'b' },
        { ts: '2026-01-01T00:00:00Z', slot: 2, green: 0.5, captureId: 'a' },
      ])
      expect(store.podGrowth.series(1).map(p => p.green)).toEqual([0.1, 0.2])
      expect(store.podGrowth.latest().map(p => [p.slot, p.green])).toEqual([[1, 0.2], [2, 0.5]])
    })

    it('counters accumulate', () => {
      store = make()
      store.counters.add('light_hours', 1.5, 't')
      expect(store.counters.add('light_hours', 2, 't')).toBe(3.5)
      expect(store.counters.get('nothing')).toBe(0)
    })
  })
}
