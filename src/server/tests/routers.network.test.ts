import { describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createEventBus } from '../../lib/eventBus'
import { SimWifi } from '../../network/wifi'
import { MemoryStore } from '../../store/memory'
import { createCore } from '../bootstrap'
import { appRouter } from '../routers/app'
import { createCallerFactory } from '../trpc'

function unit(wifi = new SimWifi()) {
  const hal = new SimHal({ tickMs: 0 })
  const events = createEventBus()
  const seen: string[] = []
  events.subscribe(e => e.kind === 'mutation' && seen.push(e.path))
  const core = createCore({ hal, store: new MemoryStore(), version: 'test', events, wifi })
  return { hal, wifi, seen, c: createCallerFactory(appRouter)(core.ctx) }
}

describe('network router and the setup hold', () => {
  it('holding the button for 10 s opens the setup hotspot', async () => {
    const { hal, c, seen } = unit()
    expect((await c.network.status()).mode).toBe('client')
    hal.pressButton('long')
    await new Promise(r => setTimeout(r, 0))
    expect((await c.network.status()).mode).toBe('client')
    hal.pressButton('setup')
    await new Promise(r => setTimeout(r, 0))
    expect(await c.network.status()).toMatchObject({ mode: 'setup', setup: { url: 'http://10.42.0.1:3000/wifi' } })
    expect(seen).toContain('network')
  })

  it('opens and closes the hotspot, lists networks and joins one', async () => {
    const { c } = unit()
    expect((await c.network.startSetup({ minutes: 5 })).mode).toBe('setup')
    expect((await c.network.scan()).map(n => n.ssid)).toContain('Garden Shed')
    expect(await c.network.connect({ ssid: 'Home', password: 'short' })).toEqual({ ok: false, detail: 'a WPA password is 8–63 characters' })
    expect((await c.network.connect({ ssid: 'Garden Shed', password: '' })).ok).toBe(true)
    expect(await c.network.status()).toMatchObject({ mode: 'client', ssid: 'Garden Shed' })
    await c.network.startSetup({ minutes: 5 })
    expect((await c.network.stopSetup()).mode).toBe('client')
  })

  it('survives a hotspot that fails to start', async () => {
    const wifi = new SimWifi()
    wifi.startSetup = async () => {
      throw new Error('nmcli: permission denied')
    }
    const { hal, c } = unit(wifi)
    hal.pressButton('setup')
    await new Promise(r => setTimeout(r, 0))
    expect((await c.network.status()).mode).toBe('client')
  })
})
