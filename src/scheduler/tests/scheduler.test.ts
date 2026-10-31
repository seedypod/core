import { describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createEventBus } from '../../lib/eventBus'
import { LightArbiter } from '../../control/light'
import { MemoryStore } from '../../store/memory'
import { lightLevelAt, Scheduler } from '../scheduler'
import { dayEnabled, localTime, minuteToHHMM } from '../time'

describe('lightLevelAt', () => {
  const curve = { setpoints: [{ minute: 360, level: 0 }, { minute: 420, level: 80 }, { minute: 1200, level: 80 }, { minute: 1260, level: 0 }] }
  it('interpolates ramps', () => {
    expect(lightLevelAt(curve, 360)).toBe(0)
    expect(lightLevelAt(curve, 390)).toBe(40)
    expect(lightLevelAt(curve, 420)).toBe(80)
    expect(lightLevelAt(curve, 800)).toBe(80)
    expect(lightLevelAt(curve, 1230)).toBe(40)
  })
  it('wraps across midnight using the last → first segment', () => {
    expect(lightLevelAt(curve, 1300)).toBe(0)
    expect(lightLevelAt(curve, 100)).toBe(0)
    const night = { setpoints: [{ minute: 1380, level: 100 }, { minute: 60, level: 0 }] }
    // 23:00 → 01:00 ramps 100 → 0; at 00:00 we are halfway.
    expect(lightLevelAt(night, 0)).toBe(50)
  })
  it('handles empty and single-point curves', () => {
    expect(lightLevelAt({ setpoints: [] }, 100)).toBeNull()
    expect(lightLevelAt({ setpoints: [{ minute: 0, level: 33 }] }, 999)).toBe(33)
  })
})

describe('time helpers', () => {
  it('converts to the zone and weekday bitmask', () => {
    const lt = localTime(new Date('2026-10-31T07:30:00Z'), 'America/Los_Angeles') // Sat 00:30 PDT
    expect(lt).toEqual({ date: '2026-10-31', minute: 30, weekday: 5 })
    expect(dayEnabled(0b0100000, 5)).toBe(true)
    expect(dayEnabled(0b0011111, 5)).toBe(false)
    expect(minuteToHHMM(1439)).toBe('23:59')
  })
  it('falls back to UTC on a bad zone', () => {
    expect(localTime(new Date('2026-01-01T12:00:00Z'), 'Not/AZone').minute).toBe(720)
  })
})

describe('Scheduler', () => {
  function setup(nowIso: string, waterLowCm = 16) {
    const store = new MemoryStore()
    store.settings.update({ timezone: 'UTC' })
    const hal = new SimHal({ tickMs: 0, limits: { waterLowCm } })
    const events = createEventBus()
    let now = new Date(nowIso)
    const s = new Scheduler({ store, hal, events, now: () => now })
    return { store, hal, events, s, setNow: (iso: string) => (now = new Date(iso)) }
  }

  it('applies the light curve and only re-sends on change', async () => {
    const { store, hal, s, setNow } = setup('2026-10-31T07:00:00Z')
    store.schedules.upsert({ id: 'l', kind: 'light', name: 'day', enabled: true, days: 127, spec: { setpoints: [{ minute: 360, level: 0 }, { minute: 480, level: 60 }] } })
    let sets = 0
    hal.subscribe(e => e.type === 'actuator' && e.id === 'light' && sets++)
    await s.tick()
    expect(hal.snapshot().actuators.light).toMatchObject({ on: true, level: 30 })
    await s.tick()
    expect(sets).toBe(1)
    setNow('2026-10-31T08:00:00Z')
    await s.tick()
    expect(hal.snapshot().actuators.light?.level).toBe(60)
    expect(sets).toBe(2)
  })

  it('hands the curve to the light arbiter, which lets a manual hold win until it ends', async () => {
    const store = new MemoryStore()
    store.settings.update({ timezone: 'UTC' })
    const hal = new SimHal({ tickMs: 0 })
    let now = new Date('2026-10-31T07:00:00Z')
    const light = new LightArbiter({ hal, now: () => now.getTime(), holdMs: 30 * 60_000 })
    const s = new Scheduler({ store, hal, events: createEventBus(), light, now: () => now })
    store.schedules.upsert({ id: 'l', kind: 'light', name: 'day', enabled: true, days: 127, spec: { setpoints: [{ minute: 360, level: 0 }, { minute: 480, level: 60 }] } })
    expect((await s.tick()).lightTarget).toBe(30)
    await light.idle()
    expect(hal.snapshot().actuators.light?.level).toBe(30)
    await light.setManual(100)
    now = new Date('2026-10-31T07:20:00Z')
    await s.tick()
    await light.idle()
    expect(hal.snapshot().actuators.light?.level).toBe(100)
    now = new Date('2026-10-31T07:40:00Z')
    await s.tick()
    await light.idle()
    // The hold is over: the light lands on the curve's current point, not the one it skipped.
    expect(hal.snapshot().actuators.light?.level).toBe(50)
    light.close()
  })

  it('fires a pump schedule exactly once per minute-of-day, bounded by the HAL', async () => {
    const { store, hal, s } = setup('2026-10-31T08:00:30Z')
    store.schedules.upsert({ id: 'p', kind: 'pump', name: 'morning', enabled: true, days: 127, spec: { minute: 480, durationS: 300 } })
    const r1 = await s.tick()
    expect(r1.pumpFired).toEqual(['p'])
    expect(hal.snapshot().actuators.pump).toMatchObject({ on: true, remainingS: 300 })
    const r2 = await s.tick()
    expect(r2.pumpFired).toEqual([])
    expect(store.schedules.recentRuns()).toHaveLength(1)
  })

  it('respects the day mask and disabled flag', async () => {
    const { store, s } = setup('2026-10-31T08:00:00Z') // Saturday → bit 5
    store.schedules.upsert({ id: 'wk', kind: 'pump', name: 'weekdays', enabled: true, days: 0b0011111, spec: { minute: 480, durationS: 60 } })
    store.schedules.upsert({ id: 'off', kind: 'pump', name: 'off', enabled: false, days: 127, spec: { minute: 480, durationS: 60 } })
    expect((await s.tick()).pumpFired).toEqual([])
  })

  it('records a refused pump run without throwing', async () => {
    const { store, hal, s } = setup('2026-10-31T08:00:00Z', 8)
    store.schedules.upsert({ id: 'p', kind: 'pump', name: 'm', enabled: true, days: 127, spec: { minute: 480, durationS: 60 } })
    // drain the sim tank to trip the interlock
    await hal.setActuator('pump', { on: true, level: 30, durationS: 900 })
    for (let i = 0; i < 60; i++) hal.tick(60)
    await hal.acknowledgeAlert('pump_fault')
    const r = await s.tick()
    expect(r.pumpFired).toEqual([])
    expect(store.schedules.recentRuns()[0]?.result).toBe('pending')
  })
})
