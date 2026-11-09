import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Reading } from '../../hardware/contract'
import { SimHal } from '../../hardware/sim'
import type { HalSnapshot } from '../../hardware/types'
import { createEventBus } from '../../lib/eventBus'
import { createMcpServer } from '../../mcp/server'
import { createCore } from '../../server/bootstrap'
import { openApiDocument } from '../../server/openapi'
import { appRouter } from '../../server/routers/app'
import { createCallerFactory } from '../../server/trpc'
import { MemoryStore } from '../../store/memory'
import type { Schedule } from '../../store/types'
import { CareEngine } from '../engine'
import { setupReport } from '../setup'

const NOW = new Date('2026-11-09T12:00:00Z')
const T = NOW.toISOString()
const light: Omit<Schedule, 'createdAt' | 'updatedAt'> = { id: 'day', kind: 'light', name: 'Day', enabled: true, days: 127, spec: { setpoints: [{ minute: 360, level: 80 }, { minute: 1200, level: 0 }] } }
const pump: Omit<Schedule, 'createdAt' | 'updatedAt'> = { id: 'cycle', kind: 'pump', name: 'Cycle', enabled: true, days: 127, spec: { minute: 480, durationS: 300 } }
const level = (quality: Reading['quality']): Reading => ({ ts: T, value: 62, unit: '%', quality })

function rig(snap: (s: HalSnapshot) => HalSnapshot = s => s) {
  const hal = new SimHal({ tickMs: 0, now: () => NOW })
  const base = hal.snapshot.bind(hal)
  let shape = snap
  hal.snapshot = () => shape(base())
  const store = new MemoryStore()
  const events = createEventBus()
  const seen: string[] = []
  events.subscribe((e) => {
    if (e.kind === 'mutation') seen.push(e.path)
  })
  const care = new CareEngine({ store, hal, events, now: () => NOW })
  const reshape = (f: (s: HalSnapshot) => HalSnapshot) => {
    shape = f
  }
  return { hal, store, events, care, seen, reshape }
}

const active = (store: MemoryStore) => store.alerts.list({ activeOnly: true }).map(a => a.kind).sort()

describe('setupReport', () => {
  it('is quiet with nothing planted, even with no schedules', () => {
    const { store, hal } = rig()
    expect(setupReport(store, hal.snapshot())).toEqual({ planted: 0, issues: [], summary: 'Nothing planted yet' })
  })

  it('warns that planted pods have no light and no pump schedule', () => {
    const { store, hal } = rig()
    store.pods.update(3, { plant: 'Basil', status: 'seeded' }, T)
    const r = setupReport(store, hal.snapshot())
    expect(r.planted).toBe(1)
    expect(r.issues.map(i => [i.id, i.alert])).toEqual([['no_light_schedule', 'setup_light_schedule'], ['no_pump_schedule', 'setup_pump_schedule']])
    expect(r.issues[0]?.detail).toBe('1 pod planted but no light schedule is on, so the light stays wherever it was last set.')
    expect(r.summary).toBe('No light schedule · No pump schedule')
  })

  it('counts only schedules that run: enabled, on some day, and a light that turns on', () => {
    const { store, hal } = rig()
    store.pods.update(1, { plant: 'Kale', status: 'growing' }, T)
    store.pods.update(2, { plant: 'Mint', status: 'growing' }, T)
    store.schedules.upsert({ ...light, spec: { setpoints: [{ minute: 0, level: 0 }] } })
    store.schedules.upsert({ ...pump, enabled: false })
    expect(setupReport(store, hal.snapshot()).issues.map(i => i.id)).toEqual(['no_light_schedule', 'no_pump_schedule'])
    store.schedules.upsert({ ...light })
    store.schedules.upsert({ ...pump, days: 0 })
    expect(setupReport(store, hal.snapshot()).issues.map(i => i.id)).toEqual(['no_pump_schedule'])
    store.schedules.upsert({ ...pump })
    expect(setupReport(store, hal.snapshot())).toMatchObject({ issues: [], summary: '2 pods planted · light and pump schedules on' })
  })

  it('warns when the tank level sensor is absent, naming hald\'s reason', () => {
    const { store, hal } = rig(s => ({ ...s, devices: s.devices && { ...s.devices, sensors: s.devices.sensors.map(d => (d.ids.includes('water_level_pct') ? { ...d, status: 'absent' as const, detail: 'no echo' } : d)) } }))
    const [issue] = setupReport(store, hal.snapshot()).issues
    expect(issue).toMatchObject({ id: 'water_sensor_absent', alert: 'setup_water_sensor', detail: 'No tank level sensor is answering (no echo), so the unit can\'t tell when the tank runs low.' })
  })

  it('warns when the unit has no tank level sensor at all', () => {
    const { store, hal } = rig(s => ({ ...s, devices: null, system: s.system && { ...s.system, caps: { ...s.system.caps, sensors: ['air_temp'] } } }))
    expect(setupReport(store, hal.snapshot()).issues).toMatchObject([{ id: 'water_sensor_absent', detail: 'No tank level sensor is answering, so the unit can\'t tell when the tank runs low.' }])
  })

  it('warns on a suspect tank level, and says nothing of the sensor while hald is offline or unknown', () => {
    const suspect = (s: HalSnapshot) => ({ ...s, sensors: { ...s.sensors, water_level_pct: level('suspect') } })
    const { store, hal, reshape } = rig(suspect)
    expect(setupReport(store, hal.snapshot()).issues).toMatchObject([{ id: 'water_sensor_suspect', title: 'Tank level suspect' }])
    reshape(s => ({ ...suspect(s), online: false }))
    expect(setupReport(store, hal.snapshot()).issues).toEqual([])
    reshape(s => ({ ...suspect(s), system: null }))
    expect(setupReport(store, hal.snapshot()).issues).toEqual([])
    reshape(s => ({ ...s, sensors: { ...s.sensors, water_level_pct: level('good') } }))
    expect(setupReport(store, hal.snapshot()).issues).toEqual([])
  })
})

describe('CareEngine', () => {
  let stop: (() => void) | undefined
  afterEach(() => stop?.())

  it('raises one alert per problem, writes nothing while it holds, and clears it once fixed', () => {
    const { store, care, seen } = rig()
    store.pods.update(3, { plant: 'Basil', status: 'seeded' }, T)
    care.tick()
    expect(active(store)).toEqual(['setup_light_schedule', 'setup_pump_schedule'])
    const raise = vi.spyOn(store.alerts, 'raise')
    care.tick()
    expect(raise).not.toHaveBeenCalled()
    store.pods.update(4, { plant: 'Mint', status: 'seeded' }, T)
    care.tick()
    expect(raise).toHaveBeenCalledTimes(2)
    expect(store.alerts.list({ activeOnly: true }).find(a => a.kind === 'setup_light_schedule')?.detail).toMatch(/^2 pods planted/)
    store.schedules.upsert(light)
    store.schedules.upsert(pump)
    care.tick()
    expect(active(store)).toEqual([])
    expect(seen).toEqual(['alerts.setup_light_schedule', 'alerts.setup_pump_schedule', 'alerts.setup_light_schedule', 'alerts.setup_pump_schedule', 'alerts.setup_light_schedule', 'alerts.setup_pump_schedule'])
  })

  it('keeps a dismissed warning dismissed until the problem changes, or goes away and comes back', () => {
    const { store, care } = rig()
    store.pods.update(3, { plant: 'Basil', status: 'seeded' }, T)
    store.schedules.upsert(pump)
    care.tick()
    const row = store.alerts.list({ activeOnly: true })[0]
    store.alerts.dismiss(row?.id ?? 0, T)
    care.tick()
    expect(active(store)).toEqual([])
    store.pods.update(4, { plant: 'Mint', status: 'seeded' }, T)
    care.tick()
    expect(active(store)).toEqual(['setup_light_schedule'])
    store.alerts.dismiss(store.alerts.list({ activeOnly: true })[0]?.id ?? 0, T)
    store.schedules.upsert(light)
    care.tick()
    store.schedules.remove('day')
    care.tick()
    expect(active(store)).toEqual(['setup_light_schedule'])
  })

  it('re-checks when a schedule, a pod, the devices or the tank level change, without waiting for its tick', () => {
    vi.useFakeTimers()
    const { store, care, events, reshape } = rig()
    care.start()
    stop = () => {
      care.stop()
      vi.useRealTimers()
    }
    expect(active(store)).toEqual([])
    store.pods.update(3, { plant: 'Basil', status: 'seeded' }, T)
    events.emit({ kind: 'mutation', path: 'pods' })
    expect(active(store)).toEqual(['setup_light_schedule', 'setup_pump_schedule'])
    store.schedules.upsert(light)
    events.emit({ kind: 'schedule', action: 'changed', id: 'day' })
    expect(active(store)).toEqual(['setup_pump_schedule'])
    store.schedules.upsert(pump)
    events.emit({ kind: 'mutation', path: 'plans' })
    expect(active(store)).toEqual(['setup_pump_schedule'])
    events.emit({ kind: 'mutation', path: 'devices' })
    expect(active(store)).toEqual([])

    reshape(s => ({ ...s, sensors: { ...s.sensors, water_level_pct: level('suspect') } }))
    events.emit({ kind: 'hal', event: { type: 'sensor', id: 'water_level_pct', reading: level('suspect') } })
    expect(active(store)).toEqual(['setup_water_sensor'])
    // Back to good clears on the tick, not on the reading, so a flapping sensor can't churn the card.
    reshape(s => ({ ...s, sensors: { ...s.sensors, water_level_pct: level('good') } }))
    events.emit({ kind: 'hal', event: { type: 'sensor', id: 'water_level_pct', reading: level('good') } })
    expect(active(store)).toEqual(['setup_water_sensor'])
    vi.advanceTimersByTime(15 * 60_000)
    expect(active(store)).toEqual([])
  })

  it('logs and carries on when a check throws', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { hal, care, events } = rig()
    care.start()
    stop = () => {
      care.stop()
      warn.mockRestore()
      vi.useRealTimers()
    }
    hal.snapshot = () => {
      throw new Error('boom')
    }
    events.emit({ kind: 'hal', event: { type: 'availability', online: true } })
    expect(warn).toHaveBeenCalledWith('care: boom')
  })
})

describe('setup check over the API, Status and MCP', () => {
  function core() {
    const hal = new SimHal({ tickMs: 0, now: () => NOW })
    const c = createCore({ hal, store: new MemoryStore(), events: createEventBus(), version: 'test', now: () => NOW })
    return { ...c, caller: createCallerFactory(appRouter)(c.ctx) }
  }

  it('reports through tRPC and REST, and as a Status line', async () => {
    const { ctx, caller } = core()
    expect(Object.keys(openApiDocument('http://x/api').paths ?? {})).toContain('/care/setup')
    let checks = Object.fromEntries((await caller.system.checks()).checks.map(k => [k.id, k]))
    expect(checks.setup).toMatchObject({ label: 'Setup', state: 'ok', detail: 'Nothing planted yet' })
    await caller.grow.updatePod({ slot: 5, plant: 'Kale', status: 'growing' })
    expect((await caller.care.setup()).issues.map(i => i.id)).toEqual(['no_light_schedule', 'no_pump_schedule'])
    checks = Object.fromEntries((await caller.system.checks()).checks.map(k => [k.id, k]))
    expect(checks.setup).toMatchObject({ state: 'stalled', detail: 'No light schedule · No pump schedule' })
    expect(ctx.store.alerts.list()).toEqual([])
  })

  it('lets an agent read it with setup_check', async () => {
    const { ctx } = core()
    ctx.store.pods.update(2, { plant: 'Basil', status: 'seeded' }, T)
    ctx.store.schedules.upsert(light)
    const server = createMcpServer(ctx)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(b)
    const res = await client.callTool({ name: 'setup_check', arguments: {} })
    const body = JSON.parse((res.content as Array<{ text: string }>)[0]?.text ?? 'null') as { planted: number, issues: Array<{ id: string }> }
    expect(body).toMatchObject({ planted: 1, issues: [{ id: 'no_pump_schedule' }] })
  })
})
