import { describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { lightHours } from '../../scheduler/lightPlan'
import { createCore } from '../../server/bootstrap'
import { appRouter } from '../../server/routers/app'
import { createCallerFactory } from '../../server/trpc'
import { MemoryStore } from '../../store/memory'

const day = { setpoints: [{ minute: 359, level: 0 }, { minute: 360, level: 100 }, { minute: 1260, level: 100 }, { minute: 1261, level: 0 }] }

function core() {
  const c = createCore({ hal: new SimHal({ tickMs: 0 }), store: new MemoryStore(), version: 'test', now: () => new Date('2026-11-12T18:00:00Z') })
  return { store: c.ctx.store, c: createCallerFactory(appRouter)(c.ctx) }
}
const lights = (store: MemoryStore) => store.schedules.list().filter(s => s.kind === 'light').map(s => [s.id, s.enabled]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))

describe('Auto on and off', () => {
  it('on, makes the Auto curve, runs it alone, and remembers the curves it stopped; off, brings them back', async () => {
    const { store, c } = core()
    store.schedules.upsert({ id: 'day', kind: 'light', name: 'Day', enabled: true, days: 127, spec: day })
    store.schedules.upsert({ id: 'weekend', kind: 'light', name: 'Weekend', enabled: false, days: 96, spec: day })
    expect(await c.schedules.setAuto({ on: true })).toEqual({ on: true, changed: ['day', 'auto'] })
    expect(lights(store as MemoryStore)).toEqual([['auto', true], ['day', false], ['weekend', false]])
    const auto = store.schedules.get('auto')?.spec
    // Greens and herbs by default: 14 hours of full light.
    expect(auto && 'setpoints' in auto && lightHours(auto).full).toBe(14)
    expect(store.settings.get().autoLightsOff).toEqual(['day'])

    expect((await c.schedules.setAuto({ on: false })).changed).toEqual(['auto', 'day'])
    expect(lights(store as MemoryStore)).toEqual([['auto', false], ['day', true], ['weekend', false]])
    expect(store.settings.get().autoLightsOff).toBeNull()
  })

  it('on again reuses the Auto curve and keeps its ramps and shift', async () => {
    const { store, c } = core()
    await c.schedules.setAuto({ on: true })
    const before = store.schedules.get('auto')
    store.schedules.upsert({ ...(before as NonNullable<typeof before>), enabled: false, spec: { setpoints: [], sun: { minHours: 14, maxHours: 16, rampMin: 120, shiftMin: 60, auto: true } } })
    await c.schedules.setAuto({ on: true })
    expect(store.schedules.list().filter(s => s.kind === 'light')).toHaveLength(1)
    expect(store.schedules.get('auto')).toMatchObject({ enabled: true, spec: { sun: { rampMin: 120, shiftMin: 60 } } })
  })

  it('off brings back only curves that still exist, and leaves curves turned on meanwhile alone', async () => {
    const { store, c } = core()
    store.schedules.upsert({ id: 'day', kind: 'light', name: 'Day', enabled: true, days: 127, spec: day })
    store.schedules.upsert({ id: 'gone', kind: 'light', name: 'Gone', enabled: true, days: 127, spec: day })
    await c.schedules.setAuto({ on: true })
    store.schedules.remove('gone')
    expect((await c.schedules.setAuto({ on: false })).changed).toEqual(['auto', 'day'])
    expect(lights(store as MemoryStore)).toEqual([['auto', false], ['day', true]])
  })

  it('takes the light at once, ending a hand\'s hold, rather than at the next minute\'s tick', async () => {
    const { c } = core()
    await c.light.set({ level: 20 })
    expect(await c.light.owner()).toMatchObject({ source: 'manual', level: 20 })
    await c.schedules.setAuto({ on: true })
    // 18:00 UTC, inside a 14 h day centred on 12:00 with no place set.
    expect(await c.light.owner()).toMatchObject({ source: 'schedule', level: 100, manualUntil: null })
    expect(await c.light.get()).toMatchObject({ on: true, level: 100 })
  })
})
