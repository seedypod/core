import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createEventBus } from '../../lib/eventBus'
import { MemoryStore } from '../../store/memory'
import { nodeFlashSource } from '../../telemetry/flashSource'
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

  it('devices: list, add (412 on refusal), remove', async () => {
    const { c, events } = caller()
    const seen: string[] = []
    events.subscribe(e => seen.push(e.kind === 'mutation' ? e.path : e.kind))
    expect((await c.devices.list()).addable.map(k => k.kind)).toContain('ezo_ph')
    expect(await c.devices.addSensor({ kind: 'ezo_ph', addr: 0x63 })).toMatchObject({ ok: true })
    expect(seen).toContain('devices')
    await expect(c.devices.addSensor({ kind: 'ezo_ph', addr: 0x63 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect((await c.sensors.calibrate({ id: 'ph', point: 'mid', value: 7 })).points).toBe(1)
    await expect(c.devices.removeSensor({ kind: 'ina219', addr: 0x40 })).rejects.toThrow(/hal.toml/)
    expect(await c.devices.removeSensor({ kind: 'ezo_ph', addr: 0x63 })).toMatchObject({ ok: true })
    expect((await c.devices.list()).sensors.some(d => d.kind === 'ezo_ph')).toBe(false)
  })

  it('system.info reports the HAL identity and limits', async () => {
    const { c } = caller()
    const info = await c.system.info()
    expect(info.halOnline).toBe(true)
    expect(info.system?.limits.pumpMaxRunS).toBeGreaterThan(0)
    // Off the server entry (tests, the browser demo) there is no host to name.
    expect(info.coreHost).toBeNull()
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

  it('backup: without backups or restore (demo, tests) every procedure says so', async () => {
    const { c } = caller()
    expect(await c.backup.status()).toMatchObject({ available: false, lastSuccess: null, nightly: { enabled: false } })
    expect(await c.backup.list()).toEqual([])
    expect(await c.backup.restoreInfo()).toEqual({ available: false, status: null, undo: null })
    await expect(c.backup.runNow()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(c.backup.browse({})).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(c.backup.restoreFromBucket({ key: 'backups/a.tar.gz' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: /no restore/ })
    await expect(c.backup.undo()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: /no restore/ })
  })

  it('storage.flash reports unavailable without an SD card, and the since-boot rate with one', async () => {
    expect(await caller().c.storage.flash()).toMatchObject({ available: false, bytesPerDay: null })
    const dir = mkdtempSync(join(tmpdir(), 'flash-'))
    try {
      mkdirSync(join(dir, 'mmcblk0'))
      writeFileSync(join(dir, 'mmcblk0/stat'), '1 0 8 1 400 0 204800 10 0 10 10')
      const core = createCore({ hal: new SimHal({ tickMs: 0 }), store: new MemoryStore(), version: 'test', flashSource: nodeFlashSource({ FLASH_STAT_PATH: join(dir, 'mmcblk0/stat') }) })
      const s = await createCallerFactory(appRouter)(core.ctx).storage.flash()
      expect(s).toMatchObject({ available: true, device: 'mmcblk0', sinceBootBytes: 204800 * 512, basis: 'boot', cardBytes: null })
      expect(s.bytesPerDay).toBeGreaterThan(0)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
