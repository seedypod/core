import { describe, expect, it, vi } from 'vitest'
import type { SystemInfo } from '../../hardware/contract'
import { SimHal } from '../../hardware/sim'
import { createEventBus } from '../../lib/eventBus'
import { MemoryStore } from '../../store/memory'
import { type AdvertiseOptions, type Advertisement, ciaoAdvertise, type CiaoLike, CoreAdvertiser, type CoreTxt, coreTxt, hostLabel, mdnsEnabled, SERVICE_TYPE } from '../mdns'

const unit = (unitId: string): SystemInfo => ({
  contract: 1, unitId, model: 'gardyn 3.0', halVersion: '0.4.0',
  caps: { sensors: [], actuators: [], cameras: [] }, limits: { pumpMaxRunS: 900, pumpMaxDuty: 30, waterLowCm: 16 },
})

/** A HAL whose reported unit can be changed mid-test. */
function halWith(system: SystemInfo | null) {
  const hal = new SimHal({ tickMs: 0 })
  const snapshot = hal.snapshot.bind(hal)
  let reported = system
  hal.snapshot = () => ({ ...snapshot(), system: reported })
  return { hal, report: (s: SystemInfo) => (reported = s) }
}

/** Records every advertisement and TXT update instead of touching the network. */
function fakeAdvertise() {
  const calls: AdvertiseOptions[] = []
  const txts: CoreTxt[] = []
  const end = vi.fn(async () => undefined)
  const fail = { advertise: null as Error | null, update: null as Error | null, end: null as Error | null }
  let release: (() => void) | null = null
  const gate = { hold: false, release: () => release?.() }
  const advertise = async (o: AdvertiseOptions): Promise<Advertisement> => {
    calls.push(o)
    if (gate.hold) await new Promise<void>(r => (release = r))
    if (fail.advertise) throw fail.advertise
    return {
      updateTxt: (t) => {
        if (fail.update) throw fail.update
        txts.push(t)
      },
      end: async () => {
        await end()
        if (fail.end) throw fail.end
      },
    }
  }
  return { advertise, calls, txts, end, fail, gate }
}

function setup(o: { system?: SystemInfo | null, env?: NodeJS.ProcessEnv, host?: string, apiKey?: string } = {}) {
  const { hal, report } = halWith(o.system === undefined ? unit('gardyn-1a2b3c4d') : o.system)
  const store = new MemoryStore()
  if (o.apiKey) store.settings.update({ apiKey: o.apiKey })
  const events = createEventBus()
  const fake = fakeAdvertise()
  const log = vi.fn()
  const svc = new CoreAdvertiser({
    store, hal, events, version: 'dev@abc1234', port: 3000, host: o.host ?? '0.0.0.0', hostname: 'seedypod',
    env: o.env ?? {}, advertise: fake.advertise, log,
  })
  return { svc, store, events, fake, log, report }
}

describe('mdnsEnabled', () => {
  it('is on by default for a LAN bind', () => {
    expect(mdnsEnabled({}, '0.0.0.0')).toBe(true)
    expect(mdnsEnabled({ SEEDYPOD_MDNS: '1' }, '::')).toBe(true)
  })

  it('turns off with SEEDYPOD_MDNS=0, false or off', () => {
    for (const v of ['0', 'false', ' OFF ']) expect(mdnsEnabled({ SEEDYPOD_MDNS: v }, '0.0.0.0')).toBe(false)
  })

  it('stays off under tests', () => {
    expect(mdnsEnabled({ VITEST: 'true' }, '0.0.0.0')).toBe(false)
    expect(mdnsEnabled({ NODE_ENV: 'test' }, '0.0.0.0')).toBe(false)
  })

  it('stays off when core only listens on loopback', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1']) expect(mdnsEnabled({}, h)).toBe(false)
  })
})

describe('coreTxt', () => {
  const store = new MemoryStore()
  it('prefers hald\'s unit id, then HAL_UNIT_ID, then the hostname', () => {
    expect(coreTxt({ store, hal: halWith(unit('gardyn-9')).hal, version: 'v', env: { HAL_UNIT_ID: 'env-id' }, hostname: 'h' }).id).toBe('gardyn-9')
    expect(coreTxt({ store, hal: halWith(null).hal, version: 'v', env: { HAL_UNIT_ID: 'env-id' }, hostname: 'h' }).id).toBe('env-id')
    expect(coreTxt({ store, hal: halWith(null).hal, version: 'v', env: {}, hostname: 'h' })).toEqual({ id: 'h', v: 'v', auth: '0' })
  })

  it('sets auth=1 when an API key is configured', () => {
    const keyed = new MemoryStore()
    keyed.settings.update({ apiKey: 'secret' })
    expect(coreTxt({ store: keyed, hal: halWith(null).hal, version: 'v', env: {}, hostname: 'h' }).auth).toBe('1')
  })
})

describe('hostLabel', () => {
  it('makes one DNS label from the unit id', () => {
    expect(hostLabel('gardyn-1a2b3c4d')).toBe('gardyn-1a2b3c4d-core')
    expect(hostLabel('My Pod.local')).toBe('my-pod-local-core')
    expect(hostLabel('***')).toBe('seedypod-core')
    expect(hostLabel('a'.repeat(100)).length).toBeLessThanOrEqual(63)
  })
})

describe('ciaoAdvertise', () => {
  function fakeCiao() {
    const service = { advertise: vi.fn(async () => undefined), updateTxt: vi.fn(), destroy: vi.fn(async () => undefined) }
    const responder = { createService: vi.fn(() => service), shutdown: vi.fn(async () => undefined) }
    const ciao: CiaoLike = { getResponder: () => responder }
    return { ciao, responder, service }
  }
  const opts: AdvertiseOptions = { name: 'Kitchen', hostname: 'gardyn-1-core', port: 3000, txt: { id: 'gardyn-1', v: 'dev', auth: '0' } }

  it('publishes _seedypod._tcp and tears down service then responder', async () => {
    const { ciao, responder, service } = fakeCiao()
    const ad = await ciaoAdvertise(async () => ciao)(opts)
    expect(SERVICE_TYPE).toBe('seedypod')
    expect(responder.createService).toHaveBeenCalledWith({ name: 'Kitchen', type: 'seedypod', port: 3000, hostname: 'gardyn-1-core', txt: opts.txt })
    expect(service.advertise).toHaveBeenCalled()
    ad.updateTxt({ ...opts.txt, auth: '1' })
    expect(service.updateTxt).toHaveBeenCalledWith({ ...opts.txt, auth: '1' })
    await ad.end()
    expect(service.destroy).toHaveBeenCalled()
    expect(responder.shutdown).toHaveBeenCalled()
  })

  it('cleans up and rethrows when advertising fails', async () => {
    const { ciao, responder, service } = fakeCiao()
    service.advertise.mockRejectedValueOnce(new Error('EADDRINUSE'))
    service.destroy.mockRejectedValueOnce(new Error('already gone'))
    responder.shutdown.mockRejectedValueOnce(new Error('already down'))
    await expect(ciaoAdvertise(async () => ciao)(opts)).rejects.toThrow('EADDRINUSE')
    expect(service.destroy).toHaveBeenCalled()
    expect(responder.shutdown).toHaveBeenCalled()
  })

  it('loads the real ciao module by default', () => {
    expect(typeof ciaoAdvertise()).toBe('function')
  })
})

describe('CoreAdvertiser', () => {
  it('advertises the unit on the HTTP port with its TXT', async () => {
    const { svc, fake, log } = setup({ apiKey: 'k' })
    await svc.start()
    expect(fake.calls).toEqual([{ name: 'Gardyn', hostname: 'gardyn-1a2b3c4d-core', port: 3000, txt: { id: 'gardyn-1a2b3c4d', v: 'dev@abc1234', auth: '1' } }])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('advertising _seedypod._tcp on port 3000'))
    await svc.start()
    expect(fake.calls).toHaveLength(1)
  })

  it('falls back to "seedypod" for a blank unit name', async () => {
    const { svc, store, fake } = setup()
    store.settings.update({ unitName: '  ' })
    await svc.start()
    expect(fake.calls[0]?.name).toBe('seedypod')
  })

  it('does nothing when disabled', async () => {
    const { svc, fake } = setup({ env: { SEEDYPOD_MDNS: '0' } })
    await svc.start()
    await svc.stop()
    expect(fake.calls).toHaveLength(0)
    expect(fake.end).not.toHaveBeenCalled()
  })

  it('logs and carries on when advertising fails', async () => {
    const { svc, fake, log } = setup()
    fake.fail.advertise = new Error('no multicast interface')
    await expect(svc.start()).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith('mdns: not advertising: no multicast interface')
    await svc.stop()
    expect(fake.end).not.toHaveBeenCalled()
  })

  it('updates auth when the API key changes, and id when hald reports', async () => {
    const { svc, store, events, fake, report } = setup({ system: null, env: { HAL_UNIT_ID: undefined } })
    await svc.start()
    expect(fake.calls[0]?.txt).toEqual({ id: 'seedypod', v: 'dev@abc1234', auth: '0' })

    events.emit({ kind: 'mutation', path: 'settings' })
    expect(fake.txts).toHaveLength(0)

    store.settings.update({ apiKey: 'k' })
    events.emit({ kind: 'mutation', path: 'settings' })
    expect(fake.txts.at(-1)).toEqual({ id: 'seedypod', v: 'dev@abc1234', auth: '1' })

    const s = unit('gardyn-77')
    report(s)
    events.emit({ kind: 'mutation', path: 'grow' })
    events.emit({ kind: 'hal', event: { type: 'availability', online: true } })
    expect(fake.txts).toHaveLength(1)
    events.emit({ kind: 'hal', event: { type: 'system', system: s } })
    expect(fake.txts.at(-1)).toEqual({ id: 'gardyn-77', v: 'dev@abc1234', auth: '1' })
  })

  it('logs a failed TXT update and retries on the next change', async () => {
    const { svc, store, events, fake, log } = setup()
    await svc.start()
    fake.fail.update = new Error('not announced')
    store.settings.update({ apiKey: 'k' })
    events.emit({ kind: 'mutation', path: 'settings' })
    expect(log).toHaveBeenCalledWith('mdns: TXT update failed: not announced')
    fake.fail.update = null
    events.emit({ kind: 'mutation', path: 'settings' })
    expect(fake.txts).toEqual([{ id: 'gardyn-1a2b3c4d', v: 'dev@abc1234', auth: '1' }])
  })

  it('says goodbye on stop and stops following settings', async () => {
    const { svc, store, events, fake } = setup()
    await svc.start()
    await svc.stop()
    expect(fake.end).toHaveBeenCalledTimes(1)
    store.settings.update({ apiKey: 'k' })
    events.emit({ kind: 'mutation', path: 'settings' })
    expect(fake.txts).toHaveLength(0)
    await svc.stop()
    expect(fake.end).toHaveBeenCalledTimes(1)
  })

  it('logs a failed goodbye without throwing', async () => {
    const { svc, fake, log } = setup()
    await svc.start()
    fake.fail.end = new Error('socket closed')
    await expect(svc.stop()).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith('mdns: goodbye failed: socket closed')
  })

  it('withdraws an advertisement that lands after stop', async () => {
    const { svc, fake } = setup()
    fake.gate.hold = true
    const started = svc.start()
    await Promise.resolve()
    await svc.stop()
    fake.fail.end = new Error('ignored')
    fake.gate.release()
    await started
    expect(fake.end).toHaveBeenCalledTimes(1)
  })

  it('defaults to process.env and console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { hal } = halWith(null)
    const svc = new CoreAdvertiser({ store: new MemoryStore(), hal, events: createEventBus(), version: 'v', port: 3000, host: '0.0.0.0', hostname: 'h' })
    await svc.start()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
