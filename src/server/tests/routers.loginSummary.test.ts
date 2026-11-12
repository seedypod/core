import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HalSnapshot } from '../../hardware/types'
import { SimHal } from '../../hardware/sim'
import { createEventBus } from '../../lib/eventBus'
import { SimWifi } from '../../network/wifi'
import { MemoryStore } from '../../store/memory'
import { createCore, type CoreOptions } from '../bootstrap'
import type { ModelRegistry } from '../../vision/registry'
import { UpdateClient } from '../../update/client'
import { openApiDocument } from '../openapi'
import { appRouter } from '../routers/app'
import { createCallerFactory } from '../trpc'

const NOW = new Date('2026-11-01T12:00:00Z')
const iso = (sAgo: number) => new Date(NOW.getTime() - sAgo * 1000).toISOString()
const reading = (value: number, sAgo: number, quality: 'good' | 'suspect' = 'good') => ({ ts: iso(sAgo), value, unit: '', quality })

function rig(snap: (s: HalSnapshot) => HalSnapshot = s => s, opts: Partial<CoreOptions> = {}) {
  const hal = new SimHal({ tickMs: 0, now: () => NOW })
  const base = hal.snapshot.bind(hal)
  hal.snapshot = () => snap(base())
  const store = new MemoryStore()
  const core = createCore({ hal, store, events: createEventBus(), version: 'test', now: () => NOW, wifi: new SimWifi(true), ...opts })
  return { c: createCallerFactory(appRouter)(core.ctx), store }
}

const sensors = (s: HalSnapshot): HalSnapshot => ({
  ...s,
  system: s.system && { ...s.system, unitId: 'gardyn-db753a85', model: 'gardyn 3.0', caps: { ...s.system.caps, sensors: ['air_temp', 'humidity', 'pcb_temp', 'water_level_pct', 'water_distance'] } },
  sensors: {
    air_temp: reading(26.214, 4),
    humidity: reading(50.35, 4),
    pcb_temp: reading(36, 4),
    water_level_pct: reading(18.17, 4),
    water_distance: reading(17.27, 4, 'suspect'),
  },
})

describe('system.loginSummary', () => {
  it('flattens the unit, the outputs and the readings, rounded to a decimal', async () => {
    const { c, store } = rig(sensors)
    store.captures.add({ id: 'c1', camera: 'upper', ts: iso(2640), path: 'x', bytes: 10 })
    store.captures.add({ id: 'c2', camera: 'lower', ts: iso(600), path: 'x', bytes: 10 })
    store.alerts.raise('water_low', 'water level sensor unavailable', iso(60))
    store.alerts.raise('backup_stale', 'No off-card backup yet', iso(30))
    expect(await c.system.loginSummary()).toEqual({
      coreVersion: 'test',
      unitId: 'gardyn-db753a85',
      model: 'gardyn 3.0',
      halOnline: true,
      lightOn: false,
      lightLevel: 0,
      lightFault: false,
      pumpOn: false,
      pumpRemainingS: null,
      pumpFault: false,
      tankPct: 18.2,
      airC: 26.2,
      humidityPct: 50.4,
      boardC: 36,
      readingAgeS: 4,
      staleSensors: 1,
      activeAlerts: 2,
      captureAgeS: 600,
      visionRunner: 'typescript',
      visionFallback: false,
      podStateModels: null,
      updateState: null,
      updateTo: null,
      updateCheckedAgeS: null,
    })
  })

  it('reports a lit light, a running pump and latched faults', async () => {
    const { c } = rig(s => ({ ...s, actuators: { light: { on: true, level: 80, since: iso(60), fault: null, remainingS: null }, pump: { on: true, level: 30, since: iso(1), fault: 'dry run', remainingS: 42 } } }))
    expect(await c.system.loginSummary()).toMatchObject({ lightOn: true, lightLevel: 80, lightFault: false, pumpOn: true, pumpRemainingS: 42, pumpFault: true })
  })

  it('counts a reading older than the stale window, and ages it from the newest', async () => {
    const { c } = rig(s => ({ ...sensors(s), sensors: { ...sensors(s).sensors, water_distance: reading(17, 4), humidity: reading(50, 3600) } }))
    expect(await c.system.loginSummary()).toMatchObject({ readingAgeS: 4, staleSensors: 1 })
  })

  it('leaves out what hald hasn\'t told core yet, without failing', async () => {
    const { c } = rig(s => ({ ...s, online: false, system: null, sensors: {}, actuators: {} }))
    expect(await c.system.loginSummary()).toEqual({
      coreVersion: 'test',
      unitId: null,
      model: null,
      halOnline: false,
      lightOn: null,
      lightLevel: null,
      lightFault: false,
      pumpOn: null,
      pumpRemainingS: null,
      pumpFault: false,
      tankPct: null,
      airC: null,
      humidityPct: null,
      boardC: null,
      readingAgeS: null,
      staleSensors: 0,
      activeAlerts: 0,
      captureAgeS: null,
      visionRunner: 'typescript',
      visionFallback: false,
      podStateModels: null,
      updateState: null,
      updateTo: null,
      updateCheckedAgeS: null,
    })
  })

  it('says where pod-state runs and how many models it has', async () => {
    let lastError: string | null = null
    const models = { specs: () => [{ id: 'pod-state', label: 'a', text: '{}' }, { id: 'pod-state-b', label: 'b', text: '{}' }, { id: 'pod-state', label: 'shipped', text: null, missing: 'no file' }] } as unknown as ModelRegistry
    const { c } = rig(undefined, { podvision: { bin: '/usr/local/bin/podvision', lastError: () => lastError }, models })
    expect(await c.system.loginSummary()).toMatchObject({ visionRunner: 'podvision', visionFallback: false, podStateModels: 2 })
    lastError = 'timed out after 60000 ms'
    expect(await c.system.loginSummary()).toMatchObject({ visionFallback: true })
  })

  it('says what the last update check found, against the build core runs', async () => {
    const work = mkdtempSync(join(tmpdir(), 'login-update-'))
    const check = (commit: string, tag = 'dev-latest') => writeFileSync(join(work, 'check.json'), JSON.stringify({ at: iso(7200), channel: 'dev', available: { tag, commit, name: tag }, problem: null }))
    const { c } = rig(undefined, { update: new UpdateClient({ command: ['true'], workDir: work, version: 'dev@aaaaaaa' }) })
    expect(await c.system.loginSummary()).toMatchObject({ updateState: 'unchecked', updateTo: null, updateCheckedAgeS: null })
    check(`bbbbbbb${'0'.repeat(33)}`)
    expect(await c.system.loginSummary()).toMatchObject({ updateState: 'available', updateTo: 'dev@bbbbbbb', updateCheckedAgeS: 7200 })
    check(`aaaaaaa${'0'.repeat(33)}`)
    expect(await c.system.loginSummary()).toMatchObject({ updateState: 'current', updateTo: null, updateCheckedAgeS: 7200 })
    check('c'.repeat(40), 'v1.2.0')
    expect(await c.system.loginSummary()).toMatchObject({ updateTo: 'v1.2.0' })
    rmSync(work, { recursive: true, force: true })
  })

  it('is a GET in the REST API, where login-stats reads it', () => {
    expect(openApiDocument('http://localhost:3000/api').paths?.['/system/login-summary']?.get).toBeDefined()
  })
})
