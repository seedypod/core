import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SystemInfo } from '../../hardware/contract'
import { deriveIdentity, derivePincode, deriveSetupId, deriveUsername, IdentityStore, piSerialUnitId, probeSeeds, usableUnitId, type SeedInputs } from '../identity'

const system = (o: Partial<SystemInfo> = {}): SystemInfo => ({
  contract: 1,
  unitId: 'gardyn-1a2b3c4d',
  model: 'gardyn 3.0',
  halVersion: '0.4.0',
  caps: { sensors: [], actuators: [], cameras: [] },
  limits: { pumpMaxRunS: 900, pumpMaxDuty: 30, waterLowCm: 16 },
  ...o,
})

const CPUINFO = 'processor\t: 0\nmodel name\t: ARMv6-compatible processor rev 7 (v6l)\nHardware\t: BCM2835\nSerial\t\t: 000000001a2b3c4d\nModel\t\t: Raspberry Pi Zero W Rev 1.1\n'

/** A fake filesystem for the seed chain. */
function inputs(files: Record<string, string>, sys: SystemInfo | null = null): SeedInputs {
  return {
    system: () => sys,
    readFile: (p) => {
      if (p in files) return files[p] as string
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    },
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'homekit-id-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('seed chain', () => {
  it('prefers the unit id hald reports, so the identity follows the tower', () => {
    const r = probeSeeds(inputs({ '/proc/cpuinfo': CPUINFO, '/etc/machine-id': 'abc123' }, system({ unitId: 'gardyn-kitchen' })))
    expect(r).toMatchObject({ resolved: 'hal-unit-id', value: 'gardyn-kitchen' })
    expect(r.sources).toEqual([
      { source: 'hal-unit-id', present: true, usable: true },
      { source: 'pi-serial', present: true, usable: true },
      { source: 'machine-id', present: true, usable: true },
      { source: 'random', present: true, usable: true },
    ])
  })

  it('reads the Pi serial the way hald does, so core on the unit derives the same seed before hald reports', () => {
    expect(piSerialUnitId(CPUINFO)).toBe('gardyn-1a2b3c4d')
    const before = probeSeeds(inputs({ '/proc/cpuinfo': CPUINFO }))
    const after = probeSeeds(inputs({ '/proc/cpuinfo': CPUINFO }, system()))
    expect(before).toMatchObject({ resolved: 'pi-serial', value: 'gardyn-1a2b3c4d' })
    expect(after).toMatchObject({ resolved: 'hal-unit-id', value: 'gardyn-1a2b3c4d' })
    expect(deriveIdentity(before, 0).pincode).toBe(deriveIdentity(after, 0).pincode)
  })

  it('skips ids every simulator or serial-less Pi shares, and degenerate serials', () => {
    expect(usableUnitId(system({ unitId: 'sim-0001', model: 'gardyn 3.0 (sim)', halVersion: '0.0.0-sim' }))).toBeNull()
    expect(usableUnitId(system({ unitId: 'gardyn-unknown' }))).toBeNull()
    expect(usableUnitId(system({ unitId: '  ' }))).toBeNull()
    expect(usableUnitId(null)).toBeNull()
    expect(piSerialUnitId('Serial\t\t: 0000000000000000\n')).toBeNull()
    expect(piSerialUnitId('Serial\t\t: ffffffffffffffff\n')).toBeNull()
    expect(piSerialUnitId('model name\t: x86\n')).toBeNull()
    const r = probeSeeds(inputs({ '/proc/cpuinfo': 'Serial : 0000\n', '/etc/machine-id': 'f00dfeed\n' }, system({ unitId: 'gardyn-unknown' })))
    expect(r).toMatchObject({ resolved: 'machine-id', value: 'f00dfeed' })
    expect(r.sources[0]).toEqual({ source: 'hal-unit-id', present: true, usable: false })
  })

  it('falls back to a random seed with nothing usable (dev machines)', () => {
    const a = probeSeeds(inputs({ '/etc/machine-id': '00000000' }))
    const b = probeSeeds(inputs({}))
    expect(a.resolved).toBe('random')
    expect(a.value).toMatch(/^[0-9a-f]{64}$/)
    expect(a.value).not.toBe(b.value)
    expect(b.sources.slice(0, 3).map(s => s.present)).toEqual([false, false, false])
  })
})

describe('derivation', () => {
  it('is deterministic per seed and differs between units and rotations', () => {
    const a = deriveIdentity({ resolved: 'hal-unit-id', value: 'gardyn-1' }, 0, 1_700_000_000_000)
    expect(deriveIdentity({ resolved: 'hal-unit-id', value: 'gardyn-1' }, 0, 1_700_000_000_000)).toEqual(a)
    const other = deriveIdentity({ resolved: 'hal-unit-id', value: 'gardyn-2' }, 0)
    const rotated = deriveIdentity({ resolved: 'hal-unit-id', value: 'gardyn-1' }, 1)
    for (const k of ['username', 'pincode', 'setupId'] as const) {
      expect(other[k]).not.toBe(a[k])
      expect(rotated[k]).not.toBe(a[k])
    }
    expect(a).toMatchObject({ derivedFrom: 'hal-unit-id', derivedAt: 1_700_000_000, rotation: 0 })
  })

  it('pins the derivation, so a refactor can\'t silently re-key every unit', () => {
    expect(deriveUsername('gardyn-1a2b3c4d', 0)).toBe('B6:C2:6B:92:03:40')
    expect(derivePincode('gardyn-1a2b3c4d', 0)).toBe('316-88-759')
    expect(deriveSetupId('gardyn-1a2b3c4d', 0)).toBe('A3J5')
  })

  it('formats like HAP wants: locally administered unicast MAC, XXX-XX-XXX, 4-char setup id', () => {
    for (let i = 0; i < 50; i++) {
      const id = deriveIdentity({ resolved: 'random', value: `seed-${i}` }, i % 3)
      expect(id.username).toMatch(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/)
      const first = Number.parseInt(id.username.slice(0, 2), 16)
      expect(first & 0x01).toBe(0)
      expect(first & 0x02).toBe(2)
      expect(id.pincode).toMatch(/^\d{3}-\d{2}-\d{3}$/)
      expect(['000-00-000', '111-11-111', '123-45-678', '876-54-321']).not.toContain(id.pincode)
      expect(id.setupId).toMatch(/^[A-Z0-9]{4}$/)
    }
  })

  it('gives up instead of looping when every attempt is banned', () => {
    expect(() => derivePincode('anything', 0, 0)).toThrow(/ran out of attempts/)
  })
})

describe('IdentityStore', () => {
  const unit = () => inputs({}, system())

  it('derives once, caches identity.json (0600) and comes back the same after a wipe', () => {
    const store = new IdentityStore(join(dir, 'homekit'), unit(), () => undefined)
    expect(store.read()).toBeNull()
    const a = store.loadOrCreate()
    expect(a).toMatchObject({ derivedFrom: 'hal-unit-id', rotation: 0 })
    expect(statSync(join(dir, 'homekit/identity.json')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'homekit')).mode & 0o777).toBe(0o700)
    expect(store.loadOrCreate()).toEqual(a)
    // A reinstall: a new data dir on the same unit.
    const reinstalled = new IdentityStore(join(dir, 'other'), unit(), () => undefined).loadOrCreate()
    expect({ ...reinstalled, derivedAt: 0 }).toEqual({ ...a, derivedAt: 0 })
  })

  it('keeps a corrupt identity.json aside and derives again', () => {
    const log: string[] = []
    const store = new IdentityStore(dir, unit(), m => log.push(m))
    writeFileSync(join(dir, 'identity.json'), '{"username":')
    expect(store.read()).toBeNull()
    expect(store.loadOrCreate().rotation).toBe(0)
    expect(readdirSync(dir).some(f => f.startsWith('identity.json.corrupt.'))).toBe(true)
    expect(log.join('\n')).toMatch(/unreadable/)
    expect(log.join('\n')).not.toMatch(/\d{3}-\d{2}-\d{3}/)
  })

  it('rotates to a new username and code from the same seed', () => {
    const store = new IdentityStore(dir, unit(), () => undefined)
    const a = store.loadOrCreate()
    const b = store.rotate()
    expect(b.rotation).toBe(1)
    expect(b.username).not.toBe(a.username)
    expect(b.pincode).not.toBe(a.pincode)
    expect(store.read()).toEqual(b)
    expect(new IdentityStore(join(dir, 'fresh'), unit(), () => undefined).rotate().rotation).toBe(0)
  })

  it('reads and clears hap-nodejs pairing files, and spots a stranded identity', () => {
    const store = new IdentityStore(dir, unit(), () => undefined)
    const id = store.loadOrCreate()
    const key = id.username.replace(/:/g, '')
    expect(store.pairedControllers(id.username)).toEqual([])
    writeFileSync(join(dir, `AccessoryInfo.${key}.json`), JSON.stringify({ pairedClients: { 'ios-1': {}, 'ios-2': {} } }))
    writeFileSync(join(dir, `IdentifierCache.${key}.json`), '{}')
    expect(store.pairedControllers(id.username)).toEqual(['ios-1', 'ios-2'])
    expect(store.isStranded(id)).toBe(false)

    store.markPaired()
    store.markPaired()
    const paired = store.read() as NonNullable<ReturnType<typeof store.read>>
    expect(paired.wasPaired).toBe(true)
    expect(store.isStranded(paired)).toBe(false)

    writeFileSync(join(dir, `AccessoryInfo.${key}.json`), JSON.stringify({ pairedClients: {} }))
    expect(store.isStranded(paired)).toBe(true)
    // Never paired: an empty pairing list is just a new bridge.
    expect(store.isStranded({ ...paired, wasPaired: undefined })).toBe(false)

    writeFileSync(join(dir, `AccessoryInfo.${key}.json`), 'not json')
    expect(store.pairedControllers(id.username)).toEqual([])
    store.clearPairings(id.username)
    expect(existsSync(join(dir, `AccessoryInfo.${key}.json`))).toBe(false)
    expect(existsSync(join(dir, `IdentifierCache.${key}.json`))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, 'identity.json'), 'utf8')).username).toBe(id.username)
  })

  it('markPaired does nothing without an identity', () => {
    const store = new IdentityStore(dir, unit(), () => undefined)
    store.markPaired()
    expect(existsSync(join(dir, 'identity.json'))).toBe(false)
  })
})
