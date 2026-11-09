// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreEvent } from '@/src/lib/eventBus'
import { BURST_MS, touchedBy, useLiveEvents } from '../useLiveEvents'

const { live, invalidated, cache } = vi.hoisted(() => ({
  live: { onData: null as unknown as (e: CoreEvent) => void, onStarted: null as unknown as () => void, error: null as Error | null },
  invalidated: [] as string[],
  cache: { latest: undefined as Record<string, unknown> | undefined, writes: 0 },
}))

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => new Proxy({ invalidate: () => invalidated.push('all') }, {
      get: (t, k: string) => (k === 'invalidate'
        ? t.invalidate
        : {
            invalidate: () => invalidated.push(k),
            latest: {
              getData: () => cache.latest,
              setData: (_: undefined, next: Record<string, unknown>) => {
                cache.latest = next
                cache.writes += 1
              },
            },
          }),
    }),
    events: {
      onChange: {
        useSubscription: (_: undefined, o: { onData: (e: CoreEvent) => void, onStarted: () => void }) => {
          Object.assign(live, o)
          return { error: live.error }
        },
      },
    },
  },
}))

const mutation = (path: string): CoreEvent => ({ kind: 'mutation', path })
const hal = (event: unknown): CoreEvent => ({ kind: 'hal', event }) as CoreEvent
const reading = (value: number, ts = '2026-11-06T10:00:10Z') => ({ ts, value, unit: '°C', quality: 'good' })
const sensor = (id: string, r: unknown) => hal({ type: 'sensor', id, reading: r })

describe('touchedBy', () => {
  it('keeps a light or pump command to its own queries, off system.checks', () => {
    expect(touchedBy(mutation('actuators.light'))).toEqual(['light'])
    expect(touchedBy(mutation('actuators.pump'))).toEqual(['pump'])
  })

  it('narrows a dotted path by its first segment', () => {
    expect(touchedBy(mutation('alerts.reminder_sow'))).toEqual(touchedBy(mutation('alerts')))
    expect(touchedBy(mutation('sensors.ph.calibration'))).toEqual(['sensors', 'devices'])
    expect(touchedBy(mutation('actuators.doser_a'))).toEqual(['light', 'pump'])
  })

  it('reaches what each path changes beyond its own router', () => {
    // Acknowledging a pump fault re-enables the pump, and Status reads alerts in its checks.
    expect(touchedBy(mutation('alerts'))).toEqual(expect.arrayContaining(['alerts', 'pump', 'light', 'system']))
    // Harvest outlook is computed from pods, analyses and plant profiles.
    for (const path of ['pods', 'analyses', 'plants']) expect(touchedBy(mutation(path))).toContain('grow')
    // A rule can take the light without its level changing, which only light.owner shows.
    expect(touchedBy(mutation('automations'))).toContain('light')
    expect(touchedBy(mutation('devices'))).toEqual(expect.arrayContaining(['devices', 'sensors', 'system']))
    expect(touchedBy(mutation('network'))).toContain('system')
  })

  it('keeps an update\'s steps and its mutations to the update router', () => {
    expect(touchedBy({ kind: 'update', state: 'downloading', lines: ['downloading seedypod-core.tar.gz'] })).toEqual(['update'])
    expect(touchedBy(mutation('update'))).toEqual(['update'])
  })

  it('refreshes everything for settings, read nearly everywhere, and for a path nobody listed', () => {
    expect(touchedBy(mutation('settings'))).toBe('all')
    expect(touchedBy(mutation('something.new'))).toBe('all')
  })

  it('takes a path named like an Object member for an unlisted one', () => {
    for (const path of ['constructor', 'toString', '__proto__', 'constructor.name']) expect(touchedBy(mutation(path))).toBe('all')
  })

  it('maps schedule and HAL events', () => {
    expect(touchedBy({ kind: 'schedule', action: 'fired', id: 'light-curve' })).toEqual(['schedules', 'light'])
    expect(touchedBy(hal({ type: 'sensor' }))).toEqual([])
    expect(touchedBy(hal({ type: 'actuator', id: 'light' }))).toEqual(['light'])
    expect(touchedBy(hal({ type: 'actuator', id: 'pump' }))).toEqual(['pump'])
    expect(touchedBy(hal({ type: 'alert' }))).toEqual(['alerts'])
    expect(touchedBy(hal({ type: 'devices' }))).toEqual(['devices', 'sensors'])
    expect(touchedBy(hal({ type: 'availability' }))).toEqual(['system'])
  })
})

describe('useLiveEvents', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    invalidated.length = 0
    live.error = null
    Object.assign(cache, { latest: { air_temp: reading(20, '2026-11-06T10:00:00Z'), humidity: reading(50, '2026-11-06T10:00:00Z') }, writes: 0 })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })
  const send = (...events: CoreEvent[]) => act(() => events.forEach(e => live.onData(e)))

  it('answers a burst with one invalidation per area', () => {
    renderHook(() => useLiveEvents())
    send(hal({ type: 'actuator', id: 'light' }), mutation('actuators.light'), mutation('sensors'), mutation('sensors'))
    expect(invalidated).toEqual([])
    vi.advanceTimersByTime(BURST_MS)
    expect(invalidated.sort()).toEqual(['devices', 'light', 'sensors'])
  })

  it('starts a new burst after a flush', () => {
    renderHook(() => useLiveEvents())
    send(mutation('actuators.light'))
    vi.advanceTimersByTime(BURST_MS)
    send(mutation('actuators.pump'))
    vi.advanceTimersByTime(BURST_MS)
    expect(invalidated).toEqual(['light', 'pump'])
  })

  it('lets an everything event swallow the rest of its burst', () => {
    renderHook(() => useLiveEvents())
    send(mutation('actuators.light'), mutation('settings'))
    vi.advanceTimersByTime(BURST_MS)
    expect(invalidated).toEqual(['all'])
  })

  it('drops a pending burst on unmount', () => {
    const again = renderHook(() => useLiveEvents())
    send(mutation('plans'))
    again.unmount()
    vi.advanceTimersByTime(BURST_MS)
    expect(invalidated).toEqual([])
  })

  it('writes a tick into the cache once, without fetching', () => {
    renderHook(() => useLiveEvents())
    send(sensor('air_temp', reading(21)), sensor('humidity', reading(51)))
    expect(cache.writes).toBe(0)
    vi.advanceTimersByTime(BURST_MS)
    expect(cache.writes).toBe(1)
    expect(cache.latest).toEqual({ air_temp: reading(21), humidity: reading(51) })
    expect(invalidated).toEqual([])
  })

  it('keeps the newer of two readings of one sensor in a burst, whatever order they came in', () => {
    renderHook(() => useLiveEvents())
    send(sensor('air_temp', reading(22, '2026-11-06T10:00:20Z')), sensor('air_temp', reading(21, '2026-11-06T10:00:10Z')))
    vi.advanceTimersByTime(BURST_MS)
    expect(cache.latest?.air_temp).toEqual(reading(22, '2026-11-06T10:00:20Z'))
  })

  it('refetches for a sensor the cache has never seen', () => {
    renderHook(() => useLiveEvents())
    send(sensor('ph', reading(6.1)))
    vi.advanceTimersByTime(BURST_MS)
    expect(invalidated).toEqual(['sensors'])
  })

  it('leaves the cache to the first fetch while it is still empty', () => {
    cache.latest = undefined
    renderHook(() => useLiveEvents())
    send(sensor('air_temp', reading(21)))
    vi.advanceTimersByTime(BURST_MS)
    expect(cache.writes).toBe(0)
    expect(invalidated).toEqual([])
  })

  it('refetches the sensors when the first connect only succeeds on a retry', () => {
    const hook = renderHook(() => useLiveEvents())
    live.error = new Error('stream refused')
    hook.rerender()
    live.error = null
    hook.rerender()
    act(() => live.onStarted())
    vi.advanceTimersByTime(BURST_MS)
    expect(invalidated).toEqual(['sensors'])
    invalidated.length = 0
    act(() => live.onData(mutation('plans')))
    vi.advanceTimersByTime(BURST_MS)
    expect(invalidated).toEqual(['planner'])
  })

  it('refetches the sensors on a reconnect, not on the first connect', () => {
    renderHook(() => useLiveEvents())
    act(() => live.onStarted())
    vi.advanceTimersByTime(BURST_MS)
    expect(invalidated).toEqual([])
    act(() => live.onStarted())
    vi.advanceTimersByTime(BURST_MS)
    expect(invalidated).toEqual(['sensors'])
  })
})
