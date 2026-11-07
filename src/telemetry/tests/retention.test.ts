import { describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../../store/memory'
import type { TelemetryPoint } from '../../store/types'
import { FULL_RESOLUTION_DAYS, TelemetryRetention, THINNED_KEY } from '../retention'

const DAY = 86_400_000
const NIGHT = new Date('2026-11-06T04:10:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

/** One row a minute for `sensor` across [fromMs, toMs). */
function minutes(store: MemoryStore, fromMs: number, toMs: number, sensor: TelemetryPoint['sensor'] = 'air_temp') {
  const pts: TelemetryPoint[] = []
  for (let t = fromMs; t < toMs; t += 60_000) pts.push({ ts: iso(t), sensor, value: 20 })
  store.telemetry.add(pts)
}

const count = (store: MemoryStore, fromMs: number, toMs: number, sensor: TelemetryPoint['sensor'] = 'air_temp') =>
  store.telemetry.range(sensor, iso(fromMs), iso(toMs - 1), Number.MAX_SAFE_INTEGER).length

function rig(now = NIGHT) {
  const store = new MemoryStore()
  const clock = { now }
  const sleep = vi.fn(async (): Promise<void> => undefined)
  const retention = new TelemetryRetention({ store, now: () => clock.now, sleep })
  return { store, clock, sleep, retention }
}

const cutoff = NIGHT.getTime() - FULL_RESOLUTION_DAYS * DAY
const hourBefore = (ms: number) => Math.floor(ms / 3_600_000) * 3_600_000

describe('telemetry retention', () => {
  it('starts where setInterval returns a number, as in the browser demo', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval').mockReturnValue(1 as unknown as NodeJS.Timeout)
    const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined)
    const retention = new TelemetryRetention({ store: new MemoryStore() })
    expect(() => retention.start()).not.toThrow()
    await retention.stop()
    interval.mockRestore()
    clear.mockRestore()
  })

  it('thins rows past the window to one per 15 minutes and keeps the recent ones whole', async () => {
    const { store, retention } = rig()
    const old = hourBefore(cutoff - 10 * DAY)
    minutes(store, old, old + DAY)
    minutes(store, NIGHT.getTime() - DAY, NIGHT.getTime())
    await retention.tick()
    expect(count(store, old, old + DAY)).toBe(96)
    expect(count(store, NIGHT.getTime() - DAY, NIGHT.getTime())).toBe(1440)
  })

  it('thins every sensor, pausing after each slice', async () => {
    const { store, retention, sleep } = rig()
    const old = hourBefore(cutoff - 10 * DAY)
    minutes(store, old, old + 3_600_000, 'humidity')
    minutes(store, old, old + 3_600_000, 'ph')
    await retention.tick()
    expect(count(store, old, old + 3_600_000, 'humidity')).toBe(4)
    expect(count(store, old, old + 3_600_000, 'ph')).toBe(4)
    expect(sleep).toHaveBeenCalledWith(2_000)
  })

  it('doesn\'t touch the last 90 days, not even a slice that straddles them', async () => {
    const { store, retention } = rig()
    minutes(store, cutoff - 8 * DAY, cutoff + DAY)
    await retention.tick()
    expect(count(store, cutoff - 3_600_000, cutoff + DAY)).toBe(60 + 1440)
  })

  it('remembers how far it got, so a later run doesn\'t reread older rows', async () => {
    const { store, clock, retention } = rig()
    minutes(store, cutoff - 8 * DAY, cutoff)
    await retention.tick()
    const through = store.counters.get(THINNED_KEY)
    expect(through).toBeGreaterThan(cutoff - DAY)
    clock.now = new Date(NIGHT.getTime() + 8 * DAY)
    const thin = vi.spyOn(store.telemetry, 'thin')
    await retention.tick()
    expect(thin.mock.calls[0]?.[1]).toBe(iso(through))
    expect(store.counters.get(THINNED_KEY)).toBeGreaterThan(through)
  })

  it('catches a long backlog up over several nights', async () => {
    const { store, clock, retention } = rig()
    minutes(store, cutoff - 120 * DAY, cutoff - 120 * DAY + 3_600_000)
    await retention.tick()
    expect(store.counters.get(THINNED_KEY)).toBeLessThan(cutoff - 7 * DAY)
    expect(retention.due()).toBe(false)
    clock.now = new Date(NIGHT.getTime() + DAY)
    expect(retention.due()).toBe(true)
  })

  describe('when it runs', () => {
    const oldRows = (store: MemoryStore) => minutes(store, cutoff - 30 * DAY, cutoff - 30 * DAY + 3_600_000)

    it('at 04:00 in the unit\'s timezone only', () => {
      const { store, retention } = rig(new Date('2026-11-06T12:10:00.000Z'))
      oldRows(store)
      expect(retention.due()).toBe(false)
      store.settings.update({ timezone: 'America/Los_Angeles' })
      expect(retention.due()).toBe(true)
    })

    it('not with nothing stored', () => {
      expect(rig().retention.due()).toBe(false)
    })

    it('not until a week of rows has aged out', () => {
      const { store, retention } = rig()
      minutes(store, cutoff - 6 * DAY, cutoff - 6 * DAY + 3_600_000)
      expect(retention.due()).toBe(false)
    })

    it('not twice in a night', async () => {
      const { store, retention } = rig()
      oldRows(store)
      await retention.tick()
      store.counters.add(THINNED_KEY, -store.counters.get(THINNED_KEY))
      expect(retention.due()).toBe(false)
    })

    it('not while it\'s already running', async () => {
      const { store, retention, sleep } = rig()
      oldRows(store)
      let release = () => {}
      sleep.mockImplementationOnce(() => new Promise<void>((resolve) => {
        release = resolve
      }))
      const first = retention.tick()
      const thin = vi.spyOn(store.telemetry, 'thin')
      await retention.tick()
      expect(thin).not.toHaveBeenCalled()
      release()
      await first
    })
  })

  it('stops at the end of a slice and keeps what it did', async () => {
    const { store, retention, sleep } = rig()
    minutes(store, cutoff - 30 * DAY, cutoff)
    let calls = 0
    sleep.mockImplementation(async () => {
      if (++calls === 3) void retention.stop()
    })
    await retention.tick()
    const through = store.counters.get(THINNED_KEY)
    expect(through).toBeGreaterThan(0)
    expect(through).toBeLessThan(cutoff - 28 * DAY)
    await retention.stop()
  })

  it('records nothing when stopped before it began', async () => {
    const { store, retention } = rig()
    minutes(store, cutoff - 30 * DAY, cutoff)
    await retention.stop()
    await retention.tick()
    expect(store.counters.get(THINNED_KEY)).toBe(0)
  })

  it('logs a failure, and tries again another night', async () => {
    const { store, clock, retention } = rig()
    minutes(store, cutoff - 30 * DAY, cutoff)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const thin = vi.spyOn(store.telemetry, 'thin').mockImplementationOnce(() => {
      throw new Error('disk I/O error')
    })
    await retention.tick()
    expect(warn).toHaveBeenCalledWith('telemetry retention: disk I/O error')
    expect(store.counters.get(THINNED_KEY)).toBe(0)
    thin.mockRestore()
    warn.mockRestore()
    clock.now = new Date(NIGHT.getTime() + DAY)
    await retention.tick()
    expect(store.counters.get(THINNED_KEY)).toBeGreaterThan(0)
  })

  it('checks on a timer that doesn\'t hold the process open', async () => {
    vi.useFakeTimers({ now: NIGHT })
    try {
      const store = new MemoryStore()
      minutes(store, cutoff - 30 * DAY, cutoff - 30 * DAY + 3_600_000)
      const retention = new TelemetryRetention({ store, sleep: async () => undefined })
      retention.start()
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(store.counters.get(THINNED_KEY)).toBeGreaterThan(0)
      await retention.stop()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('uses the real clock and a real pause by default', async () => {
    const store = new MemoryStore()
    const retention = new TelemetryRetention({ store })
    expect(retention.due()).toBe(false)
    await retention.stop()
  })
})
