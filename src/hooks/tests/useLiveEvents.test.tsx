// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreEvent } from '@/src/lib/eventBus'
import { BURST_MS, touchedBy, useLiveEvents } from '../useLiveEvents'

const { live, invalidated } = vi.hoisted(() => ({
  live: { onData: null as unknown as (e: CoreEvent) => void },
  invalidated: [] as string[],
}))

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => new Proxy({ invalidate: () => invalidated.push('all') }, {
      get: (t, k: string) => (k === 'invalidate' ? t.invalidate : { invalidate: () => invalidated.push(k) }),
    }),
    events: {
      onChange: {
        useSubscription: (_: undefined, o: { onData: (e: CoreEvent) => void }) => {
          live.onData = o.onData
        },
      },
    },
  },
}))

const mutation = (path: string): CoreEvent => ({ kind: 'mutation', path })
const hal = (event: unknown): CoreEvent => ({ kind: 'hal', event }) as CoreEvent

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

  it('refreshes everything for settings, read nearly everywhere, and for a path nobody listed', () => {
    expect(touchedBy(mutation('settings'))).toBe('all')
    expect(touchedBy(mutation('something.new'))).toBe('all')
  })

  it('maps schedule and HAL events', () => {
    expect(touchedBy({ kind: 'schedule', action: 'fired', id: 'light-curve' })).toEqual(['schedules', 'light'])
    expect(touchedBy(hal({ type: 'sensor' }))).toEqual(['sensors'])
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
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })
  const send = (...events: CoreEvent[]) => act(() => events.forEach(e => live.onData(e)))

  it('answers a burst with one invalidation per area', () => {
    renderHook(() => useLiveEvents())
    send(hal({ type: 'actuator', id: 'light' }), mutation('actuators.light'), hal({ type: 'sensor' }), hal({ type: 'sensor' }))
    expect(invalidated).toEqual([])
    vi.advanceTimersByTime(BURST_MS)
    expect(invalidated.sort()).toEqual(['light', 'sensors'])
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
})
