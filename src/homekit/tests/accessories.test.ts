/**
 * The HomeKit mappings against a real SimHal and core's own tRPC caller, so a
 * HomeKit write takes the same path (light arbiter, HAL guard) as the app.
 */
import * as hap from 'hap-nodejs'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActuatorId, ActuatorState } from '../../hardware/contract'
import { SimHal } from '../../hardware/sim'
import type { HalClient } from '../../hardware/types'
import { createEventBus } from '../../lib/eventBus'
import { createCore } from '../../server/bootstrap'
import { appRouter } from '../../server/routers/app'
import { createCallerFactory } from '../../server/trpc'
import { MemoryStore } from '../../store/memory'
import type { AccessoryDeps, BuiltAccessory } from '../accessories/common'
import { buildLight } from '../accessories/light'
import { buildPump, HOMEKIT_PUMP_RUN_S } from '../accessories/pump'
import { buildSensors } from '../accessories/sensors'

const { Characteristic } = hap
const stops: Array<() => void> = []
afterEach(() => {
  for (const s of stops.splice(0)) s()
})

function setup(simOpts: ConstructorParameters<typeof SimHal>[0] = {}) {
  const hal = new SimHal({ tickMs: 0, ...simOpts })
  const events = createEventBus()
  const core = createCore({ hal, store: new MemoryStore(), events, version: 'test' })
  const caller = createCallerFactory(appRouter)(core.ctx)
  const writes: Array<{ id: ActuatorId, cmd: unknown }> = []
  const set = hal.setActuator.bind(hal)
  hal.setActuator = (id, cmd) => {
    writes.push({ id, cmd })
    return set(id, cmd)
  }
  const log: string[] = []
  const deps: AccessoryDeps = { hap, api: caller, hal, events, log: m => log.push(m) }
  stops.push(() => void core.stop())
  return { hal, events, caller, deps, writes, log, light: core.ctx.light }
}

function build(fn: (d: AccessoryDeps) => BuiltAccessory, d: AccessoryDeps) {
  const built = fn(d)
  stops.push(built.stop)
  const char = (svc: number, c: hap.WithUUID<new () => hap.Characteristic>) => (built.services[svc] as hap.Service).getCharacteristic(c)
  return { ...built, char }
}

const offline = (hal: HalClient): Pick<HalClient, 'snapshot'> => ({ snapshot: () => ({ ...hal.snapshot(), online: false }) })

describe('grow light → Lightbulb', () => {
  it('a change from Home is a manual hold, like the Light page', async () => {
    const { deps, caller, hal, light } = setup()
    const { char } = build(buildLight, deps)
    await char(0, Characteristic.Brightness).handleSetRequest(40)
    expect(hal.snapshot().actuators.light).toMatchObject({ on: true, level: 40 })
    const owner = await caller.light.owner()
    expect(owner).toMatchObject({ source: 'manual', level: 40 })
    expect(owner.manualUntil).not.toBeNull()
    // The schedule loses to the hold...
    await light.setSchedule(80)
    expect(hal.snapshot().actuators.light?.level).toBe(40)
    // ...until it ends (Resume on the Light page, or the 30 minutes run out); Home follows.
    await caller.light.resume()
    expect(hal.snapshot().actuators.light?.level).toBe(80)
    expect(char(0, Characteristic.Brightness).value).toBe(80)
    expect(await char(0, Characteristic.On).handleGetRequest()).toBe(true)
  })

  it('turning on with a brightness is one write, not a flash to the old level first', async () => {
    const { deps, writes } = setup()
    const { char } = build(buildLight, deps)
    await Promise.all([
      char(0, Characteristic.On).handleSetRequest(true),
      char(0, Characteristic.Brightness).handleSetRequest(25),
    ])
    expect(writes).toEqual([{ id: 'light', cmd: { on: true, level: 25 } }])
    expect(await char(0, Characteristic.Brightness).handleGetRequest()).toBe(25)
    expect(await char(0, Characteristic.On).handleGetRequest()).toBe(true)
  })

  it('On for a lit light writes nothing (Home re-sends it with each brightness change)', async () => {
    const { deps, writes, caller } = setup()
    await caller.light.set({ level: 60 })
    writes.length = 0
    const { char } = build(buildLight, deps)
    await char(0, Characteristic.On).handleSetRequest(true)
    expect(writes).toEqual([])
    await char(0, Characteristic.On).handleSetRequest(false)
    expect(writes).toEqual([{ id: 'light', cmd: { on: false, level: 0 } }])
    // Off keeps the last lit brightness for Home's slider.
    expect(await char(0, Characteristic.Brightness).handleGetRequest()).toBe(60)
    await char(0, Characteristic.On).handleSetRequest(true)
    expect(writes.at(-1)).toEqual({ id: 'light', cmd: { on: true, level: 100 } })
  })

  it('follows the light when something else changes it (a hold ending, the schedule)', async () => {
    const { deps, caller } = setup()
    const { char } = build(buildLight, deps)
    await caller.light.set({ level: 70 })
    expect(char(0, Characteristic.On).value).toBe(true)
    expect(char(0, Characteristic.Brightness).value).toBe(70)
    await caller.light.set({ on: false })
    expect(char(0, Characteristic.On).value).toBe(false)
  })

  it('answers No Response while hald is offline, and fails a write the HAL rejects', async () => {
    const { deps, hal, log } = setup()
    const { char } = build(buildLight, { ...deps, hal: offline(hal) })
    await expect(char(0, Characteristic.On).handleGetRequest()).rejects.toBe(-70402)
    await expect(char(0, Characteristic.Brightness).handleGetRequest()).rejects.toBe(-70402)
    const broken = build(buildLight, { ...deps, api: { ...deps.api, light: { set: () => Promise.reject(new Error('hald timed out')) } } })
    await expect(broken.char(0, Characteristic.Brightness).handleSetRequest(30)).rejects.toBe(-70402)
    expect(log).toContain('homekit: light: hald timed out')
  })
})

describe('pump → Switch', () => {
  it('on starts one bounded run through pump.runOnce; off stops it', async () => {
    const { deps, hal, writes } = setup()
    const { char } = build(buildPump, deps)
    await char(0, Characteristic.On).handleSetRequest(true)
    expect(writes).toEqual([{ id: 'pump', cmd: { on: true, durationS: HOMEKIT_PUMP_RUN_S } }])
    expect(hal.snapshot().actuators.pump).toMatchObject({ on: true, remainingS: HOMEKIT_PUMP_RUN_S })
    expect(await char(0, Characteristic.On).handleGetRequest()).toBe(true)
    await char(0, Characteristic.On).handleSetRequest(false)
    expect(writes.at(-1)).toEqual({ id: 'pump', cmd: { on: false } })
    expect(await char(0, Characteristic.On).handleGetRequest()).toBe(false)
  })

  it('the HAL caps the run, not HomeKit', async () => {
    const { deps, hal } = setup({ limits: { pumpMaxRunS: 60 } })
    const { char } = build(buildPump, deps)
    await char(0, Characteristic.On).handleSetRequest(true)
    expect(hal.snapshot().actuators.pump?.remainingS).toBe(60)
  })

  it('a dry-tank refusal reads back as off and fails the write', async () => {
    // waterLowCm 0: the tank always reads dry, so the HAL's interlock refuses every start.
    const { deps, hal, log } = setup({ limits: { waterLowCm: 0 } })
    const { char } = build(buildPump, deps)
    char(0, Characteristic.On).updateValue(true)
    await expect(char(0, Characteristic.On).handleSetRequest(true)).rejects.toBe(-70412)
    expect(char(0, Characteristic.On).value).toBe(false)
    expect(hal.snapshot().actuators.pump?.on).toBe(false)
    expect(await char(0, Characteristic.On).handleGetRequest()).toBe(false)
    expect(log.join('\n')).toMatch(/pump refused: .*dry-run interlock/)
  })

  it('a start that comes back not running (over-temperature, latched fault) is off, never on', async () => {
    const { deps } = setup()
    const off: ActuatorState = { on: false, level: 0, since: new Date().toISOString(), fault: 'over-temp', remainingS: null }
    const { char } = build(buildPump, { ...deps, api: { ...deps.api, pump: { ...deps.api.pump, runOnce: async () => off } } })
    await expect(char(0, Characteristic.On).handleSetRequest(true)).rejects.toBe(-70412)
    expect(char(0, Characteristic.On).value).toBe(false)
  })

  it('flips off when the run ends', async () => {
    const { deps, hal } = setup({ limits: { pumpMaxRunS: 10 } })
    const { char } = build(buildPump, deps)
    await char(0, Characteristic.On).handleSetRequest(true)
    expect(char(0, Characteristic.On).value).toBe(true)
    hal.tick(11)
    expect(char(0, Characteristic.On).value).toBe(false)
  })

  it('reports No Response offline and a failed stop', async () => {
    const { deps, hal } = setup()
    const { char } = build(buildPump, { ...deps, hal: offline(hal) })
    await expect(char(0, Characteristic.On).handleGetRequest()).rejects.toBe(-70402)
    const broken = build(buildPump, { ...deps, api: { ...deps.api, pump: { ...deps.api.pump, stop: () => Promise.reject(new Error('gone')) } } })
    await expect(broken.char(0, Characteristic.On).handleSetRequest(false)).rejects.toBe(-70402)
  })
})

describe('sensors', () => {
  it('air temperature, humidity and the tank as a battery level', async () => {
    const { deps, hal } = setup()
    const { char, services } = build(buildSensors, deps)
    expect(services.map(s => s.UUID)).toEqual([hap.Service.TemperatureSensor.UUID, hap.Service.HumiditySensor.UUID, hap.Service.Battery.UUID, hap.Service.OccupancySensor.UUID])
    expect(services[3]?.getCharacteristic(Characteristic.Name).value).toBe('Tank low')
    const snap = hal.snapshot()
    expect(await char(0, Characteristic.CurrentTemperature).handleGetRequest()).toBe(snap.sensors.air_temp?.value)
    expect(await char(0, Characteristic.StatusFault).handleGetRequest()).toBe(0)
    expect(await char(1, Characteristic.CurrentRelativeHumidity).handleGetRequest()).toBe(Math.round(snap.sensors.humidity?.value ?? -1))
    expect(await char(2, Characteristic.BatteryLevel).handleGetRequest()).toBe(Math.round(snap.sensors.water_level_pct?.value ?? -1))
    expect(await char(2, Characteristic.StatusLowBattery).handleGetRequest()).toBe(0)
    expect(await char(2, Characteristic.ChargingState).handleGetRequest()).toBe(2)
    expect(await char(3, Characteristic.OccupancyDetected).handleGetRequest()).toBe(0)
  })

  it('low water raises the low-battery flag and Tank low from hald\'s water_low alert', async () => {
    const { deps, hal } = setup({ limits: { waterLowCm: 0 } })
    const { char } = build(buildSensors, deps)
    hal.tick(1)
    expect(char(2, Characteristic.StatusLowBattery).value).toBe(1)
    expect(await char(2, Characteristic.StatusLowBattery).handleGetRequest()).toBe(1)
    expect(char(3, Characteristic.OccupancyDetected).value).toBe(1)
    expect(await char(3, Characteristic.OccupancyDetected).handleGetRequest()).toBe(1)
  })

  it('pushes new readings and marks a stale one as a fault', () => {
    const { deps, events } = setup()
    const { char } = build(buildSensors, deps)
    const ts = new Date().toISOString()
    events.emit({ kind: 'hal', event: { type: 'sensor', id: 'air_temp', reading: { ts, value: 27.5, unit: '°C', quality: 'stale' } } })
    events.emit({ kind: 'hal', event: { type: 'sensor', id: 'humidity', reading: { ts, value: 104, unit: '%', quality: 'good' } } })
    events.emit({ kind: 'hal', event: { type: 'sensor', id: 'water_level_pct', reading: { ts, value: 41.6, unit: '%', quality: 'good' } } })
    events.emit({ kind: 'hal', event: { type: 'alert', alert: { kind: 'water_low', active: true, ts, detail: '' } } })
    expect(char(0, Characteristic.CurrentTemperature).value).toBe(27.5)
    expect(char(0, Characteristic.StatusFault).value).toBe(1)
    expect(char(1, Characteristic.CurrentRelativeHumidity).value).toBe(100)
    expect(char(2, Characteristic.BatteryLevel).value).toBe(42)
    expect(char(2, Characteristic.StatusLowBattery).value).toBe(1)
    expect(char(3, Characteristic.OccupancyDetected).value).toBe(1)
    events.emit({ kind: 'hal', event: { type: 'alert', alert: { kind: 'water_low', active: false, ts, detail: '' } } })
    events.emit({ kind: 'mutation', path: 'settings' })
    expect(char(2, Characteristic.StatusLowBattery).value).toBe(0)
    expect(char(3, Characteristic.OccupancyDetected).value).toBe(0)
  })

  it('answers No Response offline or with no reading yet', async () => {
    const { deps, hal } = setup()
    const { char } = build(buildSensors, { ...deps, hal: offline(hal) })
    await expect(char(0, Characteristic.CurrentTemperature).handleGetRequest()).rejects.toBe(-70402)
    await expect(char(3, Characteristic.OccupancyDetected).handleGetRequest()).rejects.toBe(-70402)
    const empty = build(buildSensors, { ...deps, hal: { snapshot: () => ({ ...hal.snapshot(), sensors: {} }) } })
    await expect(empty.char(2, Characteristic.BatteryLevel).handleGetRequest()).rejects.toBe(-70402)
    expect(await empty.char(1, Characteristic.StatusFault).handleGetRequest()).toBe(1)
  })
})
