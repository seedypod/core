import { describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { LightArbiter } from '../light'

function rig() {
  const hal = new SimHal({ tickMs: 0 })
  let now = 1_000_000
  const writes: number[] = []
  const set = hal.setActuator.bind(hal)
  hal.setActuator = async (id, cmd) => {
    if (id === 'light') writes.push(cmd.on === false ? 0 : cmd.level ?? -1)
    return set(id, cmd)
  }
  const light = new LightArbiter({ hal, now: () => now, holdMs: 30 * 60_000 })
  return { hal, light, writes, advance: (ms: number) => (now += ms), at: () => now }
}

const lease = (id: string, level: number, priority: number, expiresAt: number, createdAt = 0) => ({ id, level, priority, expiresAt, createdAt })

describe('LightArbiter', () => {
  it('follows the schedule and writes only when the level changes', async () => {
    const { light, writes } = rig()
    await light.setSchedule(40)
    await light.setSchedule(40)
    await light.setSchedule(null)
    await light.setSchedule(0)
    await light.idle()
    expect(writes).toEqual([40, 0])
    expect(light.status()).toMatchObject({ source: 'schedule', level: 0, schedule: 0 })
  })

  it('ranks manual over Autopilot over the schedule, and the highest-priority lease wins', async () => {
    const r = rig()
    await r.light.setSchedule(80)
    await r.light.setLeases([lease('rule:1:0', 30, 50, r.at() + 120_000), lease('rule:2:0', 60, 70, r.at() + 120_000)])
    expect(r.light.status()).toMatchObject({ source: 'autopilot', level: 60, leaseId: 'rule:2:0' })
    await r.light.setManual(100)
    expect(r.light.status()).toMatchObject({ source: 'manual', level: 100 })
    r.advance(31 * 60_000)
    // The hold is over; the leases above have lapsed too, so the curve's current point wins.
    await r.light.setSchedule(70)
    await r.light.idle()
    expect(r.light.status()).toMatchObject({ source: 'schedule', level: 70, manualUntil: null })
    expect(r.writes).toEqual([80, 60, 100, 70])
  })

  it('breaks priority ties by the newest lease and resumes early on request', async () => {
    const r = rig()
    await r.light.setLeases([lease('rule:1:0', 30, 50, r.at() + 1e6, 1), lease('rule:2:0', 45, 50, r.at() + 1e6, 2)])
    expect(r.light.status().level).toBe(45)
    await r.light.setManual(10)
    await r.light.resume()
    await r.light.idle()
    expect(r.light.status()).toMatchObject({ source: 'autopilot', level: 45 })
  })

  it('treats a light change it didn\'t make (button, Home Assistant) as a manual hold', async () => {
    const r = rig()
    await r.light.setSchedule(50)
    await r.light.idle()
    // The button toggles the light inside hald; core only sees the new state.
    await r.hal.setActuator('light', { on: false, level: 0 })
    expect(r.light.status()).toMatchObject({ source: 'manual', level: 0 })
    await r.light.setSchedule(55)
    await r.light.idle()
    expect(r.writes.at(-1)).toBe(0)
  })

  it('adopts the first state it sees without calling it manual', async () => {
    const hal = new SimHal({ tickMs: 0 })
    await hal.setActuator('light', { on: true, level: 33 })
    const light = new LightArbiter({ hal })
    await hal.setActuator('light', { on: true, level: 33 })
    expect(light.status().source).toBeNull()
    light.close()
  })

  it('logs a failed write instead of throwing', async () => {
    const hal = new SimHal({ tickMs: 0 })
    hal.setActuator = async () => {
      throw new Error('hald unreachable')
    }
    const logs: string[] = []
    const light = new LightArbiter({ hal, log: m => logs.push(m) })
    await light.setSchedule(20)
    expect(logs).toEqual(['light: hald unreachable'])
    await expect(light.setManual(5)).rejects.toThrow('hald unreachable')
  })
})
