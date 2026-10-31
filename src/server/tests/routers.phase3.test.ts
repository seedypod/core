import { describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { MemoryStore } from '../../store/memory'
import { createCore } from '../bootstrap'
import { appRouter } from '../routers/app'
import { createCallerFactory } from '../trpc'

function caller(now = new Date('2026-10-31T12:00:00Z'), waterLowCm = 16) {
  const hal = new SimHal({ tickMs: 0, limits: { waterLowCm } })
  const core = createCore({ hal, store: new MemoryStore(), version: 'test', now: () => now })
  return { hal, store: core.ctx.store, c: createCallerFactory(appRouter)(core.ctx), core }
}

describe('phase 3 routers', () => {
  it('settings hide secrets and report their presence', async () => {
    const { c } = caller()
    const s = await c.settings.update({ apiKey: 'secret', mqttPassword: 'pw', timezone: 'Europe/Zurich' })
    expect(s).not.toHaveProperty('apiKey')
    expect(s).toMatchObject({ hasApiKey: true, hasMqttPassword: true, timezone: 'Europe/Zurich' })
  })

  it('schedules validate kind/spec pairing and preview curves', async () => {
    const { c } = caller()
    await expect(c.schedules.upsert({ id: 'x', kind: 'pump', name: 'bad', enabled: true, days: 127, spec: { setpoints: [] } })).rejects.toThrow(/spec does not match kind/)
    await c.schedules.upsert({ id: 'l', kind: 'light', name: 'day', enabled: true, days: 127, spec: { setpoints: [{ minute: 0, level: 0 }, { minute: 720, level: 100 }] } })
    const preview = await c.schedules.previewCurve({ setpoints: [{ minute: 0, level: 0 }, { minute: 720, level: 100 }] })
    expect(preview).toHaveLength(96)
    expect(preview[24]?.level).toBe(50)
    expect((await c.schedules.remove({ id: 'l' })).removed).toBe(true)
  })

  it('grow cycle and pods round-trip', async () => {
    const { c } = caller()
    expect((await c.grow.current()).cycle).toBeNull()
    await c.grow.start({ notes: 'test' })
    await c.grow.setStage({ stage: 'seedling' })
    expect((await c.grow.current())).toMatchObject({ day: 0, cycle: { stage: 'seedling' } })
    const pod = await c.grow.updatePod({ slot: 3, plant: 'Basil', status: 'seeded' })
    expect(pod).toMatchObject({ slot: 3, plant: 'Basil' })
    expect((await c.grow.pods()).filter(p => p.status !== 'empty')).toHaveLength(1)
  })

  it('alert acknowledge by id clears a latched HAL fault', async () => {
    const { c, hal, core } = caller(undefined, 8)
    core.recorder.start()
    await c.pump.runOnce({ durationS: 900, level: 30 })
    for (let i = 0; i < 15; i++) hal.tick(60) // the 900 s run drains past the 8 cm threshold and trips the latch
    const active = await c.alerts.list({ activeOnly: true })
    const fault = active.find(a => a.kind === 'pump_fault')
    expect(fault).toBeDefined()
    await c.alerts.acknowledge({ id: fault?.id ?? -1 })
    expect(hal.snapshot().actuators.pump?.fault).toBeNull()
    expect((await c.alerts.list({ activeOnly: true })).find(a => a.kind === 'pump_fault')).toBeUndefined()
  })

  it('camera capture surfaces a missing camera as SERVICE_UNAVAILABLE and lists captures with URLs', async () => {
    const { c, hal } = caller()
    await expect(c.camera.capture({ camera: 'upper' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    hal.captureStill = async () => new Uint8Array(4096)
    const cap = await c.camera.capture({ camera: 'lower' })
    expect(cap.url).toMatch(/^\/api\/captures\/lower-.*\.jpg$/)
    expect(await c.camera.list({ camera: 'lower', limit: 10 })).toHaveLength(1)
  })

  it('telemetry history and light hours', async () => {
    const { c, store } = caller()
    store.telemetry.add([{ ts: '2026-10-31T11:00:00.000Z', sensor: 'air_temp', value: 21 }])
    expect(await c.telemetry.history({ sensor: 'air_temp', hours: 2, maxPoints: 100 })).toHaveLength(1)
    store.counters.add('light_hours', 2500, 't')
    expect(await c.telemetry.lightHours()).toMatchObject({ hours: 2500, pctUsed: 10 })
  })
})
