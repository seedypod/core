import { describe, expect, it, vi } from 'vitest'
import { SimHal } from '../../hardware/sim'
import type { HomeKitControl, HomeKitStatus } from '../../homekit/types'
import { createEventBus } from '../../lib/eventBus'
import { MemoryStore } from '../../store/memory'
import { createCore } from '../bootstrap'
import { openApiDocument } from '../openapi'
import { appRouter } from '../routers/app'
import { createCallerFactory } from '../trpc'

const ON: HomeKitStatus = { enabled: true, running: true, transitioning: false, setupCode: '316-88-759', setupURI: 'X-HM://0023ABCDA3J5', qrSvg: '<svg/>', pairedControllers: 0, error: null }

function caller(homekit?: HomeKitControl) {
  const hk = homekit && { ...homekit, attach: vi.fn(), shutdown: vi.fn(async () => undefined) }
  const core = createCore({ hal: new SimHal({ tickMs: 0 }), store: new MemoryStore(), events: createEventBus(), version: 'test', homekit: hk })
  return createCallerFactory(appRouter)(core.ctx)
}

function fake(o: Partial<HomeKitControl> = {}): HomeKitControl {
  return {
    status: async () => ON,
    setEnabled: async enabled => ({ ...ON, enabled, running: enabled }),
    resetPairing: async () => ({ ...ON, setupCode: '111-22-333' }),
    seedProbe: () => ({ resolved: 'hal-unit-id', sources: [{ source: 'hal-unit-id', present: true, usable: true }], identity: { derivedFrom: 'hal-unit-id', rotation: 0, derivedAt: 1 } }),
    ...o,
  }
}

describe('homekit router', () => {
  it('reports unavailable where core has no bridge (demo, tests), and refuses changes there', async () => {
    const c = caller()
    expect(await c.homekit.status()).toMatchObject({ available: false, enabled: false, running: false })
    await expect(c.homekit.setEnabled({ enabled: true })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(c.homekit.resetPairing()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(c.homekit.seedProbe()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('passes status, toggles, resets and the seed probe through', async () => {
    const hk = fake()
    const setEnabled = vi.spyOn(hk, 'setEnabled')
    const c = caller(hk)
    expect(await c.homekit.status()).toEqual({ available: true, ...ON })
    expect(await c.homekit.setEnabled({ enabled: false })).toMatchObject({ available: true, enabled: false, running: false })
    expect(setEnabled).toHaveBeenCalledWith(false)
    expect((await c.homekit.resetPairing()).setupCode).toBe('111-22-333')
    expect((await c.homekit.seedProbe()).resolved).toBe('hal-unit-id')
  })

  it('a failed start comes back as an error with the reason', async () => {
    const c = caller(fake({ setEnabled: () => Promise.reject(new Error('listen EADDRINUSE :::51827')) }))
    await expect(c.homekit.setEnabled({ enabled: true })).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'HomeKit: listen EADDRINUSE :::51827' })
  })

  it('is on the REST facade', () => {
    const paths = Object.keys(openApiDocument('http://localhost:3000/api').paths ?? {})
    expect(paths).toEqual(expect.arrayContaining(['/homekit', '/homekit/enabled', '/homekit/reset', '/homekit/seed-probe']))
  })

  it('the generic settings update can\'t flip the HomeKit switch behind the bridge\'s back', async () => {
    const c = caller(fake())
    await c.settings.update({ homekitEnabled: true } as never)
    expect(await c.settings.get()).not.toHaveProperty('homekitEnabled')
  })
})
