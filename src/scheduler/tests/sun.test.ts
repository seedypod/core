import { describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createEventBus } from '../../lib/eventBus'
import { createCore } from '../../server/bootstrap'
import { appRouter } from '../../server/routers/app'
import { createCallerFactory } from '../../server/trpc'
import { MemoryStore } from '../../store/memory'
import { lightHours } from '../lightPlan'
import { Scheduler } from '../scheduler'
import { DEFAULT_SUN, followSun, sunDay, sunSetpoints, sunWindow } from '../sun'

const SF = { latitude: 37.7749, longitude: -122.4194, timezone: 'America/Los_Angeles' }
const at = (h: number, m: number) => h * 60 + m

describe('sunDay', () => {
  it('finds sunrise and sunset to within two minutes of the almanac, in the zone\'s clock', () => {
    // San Francisco: 06:48 and 17:01 PST in November; 05:48 and 20:35 PDT at midsummer.
    const nov = sunDay('2026-11-12', SF.latitude, SF.longitude, SF.timezone)
    expect(Math.abs((nov.sunrise ?? 0) - at(6, 48))).toBeLessThanOrEqual(2)
    expect(Math.abs((nov.sunset ?? 0) - at(17, 1))).toBeLessThanOrEqual(2)
    const june = sunDay('2026-06-21', SF.latitude, SF.longitude, SF.timezone)
    expect(Math.abs((june.sunrise ?? 0) - at(5, 48))).toBeLessThanOrEqual(2)
    expect(Math.abs((june.sunset ?? 0) - at(20, 35))).toBeLessThanOrEqual(2)
    // London in November, and Sydney at the March equinox, east of Greenwich and south of the equator.
    const london = sunDay('2026-11-12', 51.5, -0.13, 'Europe/London')
    expect(Math.abs((london.sunrise ?? 0) - at(7, 15))).toBeLessThanOrEqual(2)
    expect(Math.abs((london.sunset ?? 0) - at(16, 15))).toBeLessThanOrEqual(2)
    const sydney = sunDay('2026-03-20', -33.87, 151.21, 'Australia/Sydney')
    expect(Math.abs((sydney.sunrise ?? 0) - at(7, 0))).toBeLessThanOrEqual(2)
    expect(Math.abs((sydney.sunset ?? 0) - at(19, 8))).toBeLessThanOrEqual(2)
  })

  it('has no sunrise in polar night or sunset under the midnight sun, and keeps midday', () => {
    expect(sunDay('2026-12-21', 69.65, 18.96, 'Europe/Oslo')).toMatchObject({ sunrise: null, sunset: null, day: 0 })
    const summer = sunDay('2026-06-21', 69.65, 18.96, 'Europe/Oslo')
    expect(summer).toMatchObject({ sunrise: null, sunset: null, day: 1440 })
    expect(Math.abs(summer.noon - at(12, 46))).toBeLessThanOrEqual(2)
  })
})

describe('sunWindow and sunSetpoints', () => {
  it('stretches a short day to minHours about midday, keeps one in range, and trims a long one', () => {
    expect(sunWindow(DEFAULT_SUN, { noon: 720, day: 600 })).toEqual({ on: 300, off: 1140 })
    expect(sunWindow(DEFAULT_SUN, { noon: 780, day: 900 })).toEqual({ on: 330, off: 1230 })
    expect(sunWindow(DEFAULT_SUN, { noon: 780, day: 1100 })).toEqual({ on: 300, off: 1260 })
  })

  it('moves the window by shiftMin', () => {
    expect(sunWindow({ ...DEFAULT_SUN, shiftMin: 90 }, { noon: 720, day: 600 })).toEqual({ on: 390, off: 1230 })
  })

  it('centres each ramp on on and off, so the hours of full light are the window', () => {
    const setpoints = sunSetpoints(DEFAULT_SUN, { on: 300, off: 1140 })
    expect(setpoints).toEqual([{ minute: 270, level: 0 }, { minute: 330, level: 100 }, { minute: 1110, level: 100 }, { minute: 1170, level: 0 }])
    expect(lightHours({ setpoints })).toEqual({ full: 14, lit: 15 })
  })

  it('wraps a window that runs past midnight', () => {
    expect(sunSetpoints(DEFAULT_SUN, { on: 600, off: 1440 })).toEqual([{ minute: 570, level: 0 }, { minute: 630, level: 100 }, { minute: 1410, level: 100 }, { minute: 30, level: 0 }])
  })
})

describe('followSun', () => {
  const spec = { setpoints: [], sun: DEFAULT_SUN }

  it('writes San Francisco\'s November day out to 14 hours about its midday', () => {
    const { setpoints } = followSun(spec, SF, new Date('2026-11-12T18:00:00Z'))
    // Midday is 11:54 PST, so 14 hours runs 04:54–18:54, ramps half an hour either side.
    expect(setpoints.map(p => p.level)).toEqual([0, 100, 100, 0])
    expect(Math.abs((setpoints[0]?.minute ?? 0) - at(4, 24))).toBeLessThanOrEqual(2)
    expect(Math.abs((setpoints[3]?.minute ?? 0) - at(19, 24))).toBeLessThanOrEqual(2)
  })

  it('without a place, runs minHours centred on 12:00', () => {
    expect(followSun(spec, { latitude: null, longitude: null, timezone: 'UTC' }, new Date('2026-11-12T18:00:00Z')).setpoints).toEqual(sunSetpoints(DEFAULT_SUN, { on: 300, off: 1140 }))
  })

  it('leaves a curve that doesn\'t follow the sun as it is', () => {
    const plain = { setpoints: [{ minute: 0, level: 50 }] }
    expect(followSun(plain, SF, new Date())).toBe(plain)
  })
})

describe('following the sun day to day', () => {
  it('the scheduler rewrites the curve as the days move, and says so', async () => {
    const store = new MemoryStore()
    store.settings.update(SF)
    const events = createEventBus()
    const changed: string[] = []
    events.subscribe(e => e.kind === 'schedule' && e.action === 'changed' && changed.push(e.id))
    let now = new Date('2026-05-01T19:00:00Z')
    const s = new Scheduler({ store, hal: new SimHal({ tickMs: 0 }), events, now: () => now })
    store.schedules.upsert({ id: 'sun', kind: 'light', name: 'Sun', enabled: true, days: 127, spec: { setpoints: [], sun: DEFAULT_SUN } })
    await s.tick()
    const may = store.schedules.get('sun')?.spec
    // 13 h 54 min of daylight on 1 May, stretched to 14.
    expect(may && 'setpoints' in may && lightHours(may).full).toBe(14)
    expect(changed).toEqual(['sun'])
    await s.tick()
    expect(changed).toEqual(['sun'])
    now = new Date('2026-06-01T19:00:00Z')
    await s.tick()
    const june = store.schedules.get('sun')?.spec
    // 14 h 40 min by June: the curve follows sunrise and sunset themselves.
    expect(june && 'setpoints' in june && lightHours(june).full).toBe(14.5)
    expect(changed).toEqual(['sun', 'sun'])
  })

  it('a new curve gets today\'s setpoints when saved, and a new place moves them', async () => {
    const core = createCore({ hal: new SimHal({ tickMs: 0 }), store: new MemoryStore(), version: 'test', now: () => new Date('2026-11-12T18:00:00Z') })
    const c = createCallerFactory(appRouter)(core.ctx)
    const saved = await c.schedules.upsert({ id: 'sun', kind: 'light', name: 'Sun', enabled: true, days: 127, spec: { setpoints: [], sun: DEFAULT_SUN } })
    expect(saved.spec).toMatchObject({ setpoints: sunSetpoints(DEFAULT_SUN, { on: 300, off: 1140 }), sun: DEFAULT_SUN })
    await c.settings.update(SF)
    const moved = (await c.schedules.list()).find(s => s.id === 'sun')?.spec
    expect(moved && 'setpoints' in moved && Math.abs((moved.setpoints[0]?.minute ?? 0) - at(4, 24))).toBeLessThanOrEqual(2)
    await expect(c.schedules.upsert({ id: 'bad', kind: 'light', name: 'Bad', enabled: true, days: 127, spec: { setpoints: [], sun: { ...DEFAULT_SUN, minHours: 17 } } })).rejects.toThrow(/minHours is more than maxHours/)
  })
})
