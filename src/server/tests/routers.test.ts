import { describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createEventBus } from '../../lib/eventBus'
import { MemoryStore } from '../../store/memory'
import { createCore } from '../bootstrap'
import { appRouter } from '../routers/app'
import { createCallerFactory } from '../trpc'

function caller() {
  const hal = new SimHal({ tickMs: 0, limits: { waterLowCm: 8 } })
  const events = createEventBus()
  const core = createCore({ hal, store: new MemoryStore(), events, version: 'test' })
  const c = createCallerFactory(appRouter)(core.ctx)
  return { hal, events, c, store: core.ctx.store }
}

describe('routers', () => {
  it('sensors.latest validates with a partial sensor set', async () => {
    const { c } = caller()
    const s = await c.sensors.latest()
    expect(Object.keys(s)).toContain('air_temp')
    expect(s.ph).toBeUndefined()
  })

  it('sensors.calibrate surfaces the HAL refusal as a precondition failure', async () => {
    const { c } = caller()
    await expect(c.sensors.calibrate({ id: 'ph', point: 'mid', value: 7 })).rejects.toThrow(/no ph sensor configured/)
  })

  it('system.info reports the HAL identity and limits', async () => {
    const { c } = caller()
    const info = await c.system.info()
    expect(info.halOnline).toBe(true)
    expect(info.system?.limits.pumpMaxRunS).toBeGreaterThan(0)
  })

  it('light.set clamps and broadcasts a mutation event', async () => {
    const { c, events } = caller()
    const seen: string[] = []
    events.subscribe(e => seen.push(e.kind === 'mutation' ? e.path : e.kind))
    const s = await c.light.set({ level: 70 })
    expect(s).toMatchObject({ on: true, level: 70 })
    expect(seen).toContain('actuators.light')
  })

  it('pump.runOnce maps a HAL refusal to PRECONDITION_FAILED', async () => {
    const { c, hal } = caller()
    await c.pump.runOnce({ durationS: 900, level: 30 })
    for (let i = 0; i < 40; i++) hal.tick(60) // drain to dry-run fault
    await expect(c.pump.runOnce({ durationS: 60 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await hal.acknowledgeAlert('pump_fault')
    expect((await c.pump.get())?.fault).toBeNull()
  })
})
