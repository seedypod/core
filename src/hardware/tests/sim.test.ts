import { describe, expect, it } from 'vitest'
import { HalRefused, SimHal } from '../sim'

function sim(limits?: Partial<{ pumpMaxRunS: number, pumpMaxDuty: number, waterLowCm: number | null }>) {
  return new SimHal({ tickMs: 0, limits })
}

describe('SimHal safety invariants (mirror of hal-core::safety)', () => {
  it('clamps pump duty to the HAL limit', async () => {
    const h = sim({ pumpMaxDuty: 30 })
    const s = await h.setActuator('pump', { on: true, level: 100 })
    expect(s.level).toBe(30)
  })

  it('bounds every pump run to pumpMaxRunS even when a longer duration is requested', async () => {
    const h = sim({ pumpMaxRunS: 10 })
    const s = await h.setActuator('pump', { on: true, durationS: 3600 })
    expect(s.remainingS).toBe(10)
    h.tick(11)
    expect(h.snapshot().actuators.pump?.on).toBe(false)
  })

  it('refuses to start the pump when the tank is low and raises water_low', async () => {
    const h = sim({ waterLowCm: 8, pumpMaxRunS: 900 })
    await h.setActuator('pump', { on: true, level: 30 })
    for (let i = 0; i < 30; i++) h.tick(60) // drains past 8 cm and trips the latch
    await h.acknowledgeAlert('pump_fault')
    await expect(h.setActuator('pump', { on: true })).rejects.toBeInstanceOf(HalRefused)
    expect(h.snapshot().alerts.water_low?.active).toBe(true)
  })

  it('latches a dry-run fault until acknowledged, then allows a restart after refill', async () => {
    const h = sim({ waterLowCm: 8, pumpMaxRunS: 900 })
    await h.setActuator('pump', { on: true, level: 30 })
    for (let i = 0; i < 30; i++) h.tick(60)
    const snap = h.snapshot()
    expect(snap.actuators.pump?.on).toBe(false)
    expect(snap.actuators.pump?.fault).toBe('dry-run')
    expect(snap.alerts.pump_fault?.active).toBe(true)
    await expect(h.setActuator('pump', { on: true })).rejects.toBeInstanceOf(HalRefused)
    await h.acknowledgeAlert('pump_fault')
    expect(h.snapshot().actuators.pump?.fault).toBeNull()
    // still dry: the interlock, not the latch, refuses now
    await expect(h.setActuator('pump', { on: true })).rejects.toThrow(/dry-run interlock/)
    h.refill()
    const s = await h.setActuator('pump', { on: true, durationS: 60 })
    expect(s.on).toBe(true)
    expect(s.remainingS).toBe(60)
  })

  it('emits sensor events on tick and actuator events on change', async () => {
    const h = sim()
    const seen: string[] = []
    h.subscribe(e => seen.push(e.type))
    await h.setActuator('light', { on: true, level: 60 })
    h.tick(1)
    expect(seen).toContain('actuator')
    expect(seen).toContain('sensor')
    expect(h.snapshot().actuators.light).toMatchObject({ on: true, level: 60 })
  })
})
