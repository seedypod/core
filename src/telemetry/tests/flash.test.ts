import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../../store/memory'
import { FlashMeter, SECTOR_BYTES, sectorsWritten } from '../flash'
import { nodeFlashSource } from '../flashSource'

const STAT = '/sys/block/mmcblk0/stat'
// reads completed, merged, sectors read, ms reading, writes completed, merged, sectors written, …
const stat = (written: number) => `   5021     1544   412366     8133     2210     3122  ${written}    14880        0    11440    23010`

function rig(opts: { sectors?: number, uptimeS?: number, size?: string | null } = {}) {
  const store = new MemoryStore()
  let sectors = opts.sectors ?? 0
  let now = new Date('2026-10-01T00:00:00Z')
  const files: Record<string, () => string | null> = {
    [STAT]: () => stat(sectors),
    '/sys/block/mmcblk0/size': () => (opts.size === undefined ? '62333952' : opts.size),
  }
  const meter = new FlashMeter({ store, source: { statPath: STAT, read: p => files[p]?.() ?? null, uptimeS: () => opts.uptimeS ?? 3600 }, now: () => now })
  return {
    store,
    meter,
    write: (n: number) => (sectors += n),
    reboot: () => (sectors = 0),
    advance: (h: number) => (now = new Date(now.getTime() + h * 3_600_000)),
  }
}

describe('sectorsWritten', () => {
  it('reads field 7 of /sys/block/<dev>/stat', () => {
    expect(sectorsWritten(stat(98765))).toBe(98765)
  })
  it('is null for anything shorter', () => {
    expect(sectorsWritten('1 2 3')).toBeNull()
    expect(sectorsWritten('')).toBeNull()
  })
})

describe('nodeFlashSource', () => {
  it('prefers FLASH_STAT_PATH', () => {
    expect(nodeFlashSource({ FLASH_STAT_PATH: '/tmp/fake' })?.statPath).toBe('/tmp/fake')
  })
})

describe('FlashMeter', () => {
  it('stores the bytes written between samples', () => {
    const r = rig({ sectors: 1000 })
    expect(r.meter.sample()).toMatchObject({ sectors: 1000, bytes: 0 })
    r.write(2048)
    r.advance(1)
    expect(r.meter.sample()).toMatchObject({ sectors: 3048, bytes: 2048 * SECTOR_BYTES })
  })

  it('treats a counter that went backwards as a reboot', () => {
    const r = rig({ sectors: 50_000 })
    r.meter.sample()
    r.reboot()
    r.write(100)
    r.advance(1)
    expect(r.meter.sample()).toMatchObject({ sectors: 100, bytes: 100 * SECTOR_BYTES })
  })

  it('averages since boot until a day of samples exists', () => {
    // 2 GiB written in the 12 h since boot → 4 GiB/day.
    const r = rig({ sectors: (2 * 1024 ** 3) / SECTOR_BYTES, uptimeS: 12 * 3600 })
    r.meter.sample()
    const s = r.meter.status()
    expect(s).toMatchObject({ available: true, device: 'mmcblk0', basis: 'boot', cardBytes: 62333952 * SECTOR_BYTES })
    expect(s.bytesPerDay).toBeCloseTo(4 * 1024 ** 3)
  })

  it('averages the hourly samples over up to 7 days once there is a day of them', () => {
    const r = rig({ sectors: 10_000_000, uptimeS: 30 * 86400 })
    r.meter.sample()
    for (let h = 0; h < 48; h++) {
      r.advance(1)
      r.write(2048) // 1 MiB an hour
      r.meter.sample()
    }
    const s = r.meter.status()
    expect(s.basis).toBe('history')
    expect(s.windowDays).toBeCloseTo(2)
    expect(s.bytesPerDay).toBeCloseTo(24 * 1024 ** 2)
  })

  it('keeps 30 days of samples', () => {
    const r = rig()
    r.meter.sample()
    r.advance(31 * 24)
    r.meter.sample()
    expect(r.store.flash.since('2000-01-01T00:00:00Z')).toHaveLength(1)
  })

  it('reports unavailable without an SD card, and samples nothing', () => {
    const store = new MemoryStore()
    const meter = new FlashMeter({ store, source: null })
    expect(meter.sample()).toBeNull()
    expect(meter.status()).toMatchObject({ available: false, bytesPerDay: null })
    expect(store.flash.last()).toBeNull()
  })

  it('leaves the card size out when the kernel does not report it', () => {
    const r = rig({ size: null })
    expect(r.meter.status().cardBytes).toBeNull()
  })
})
