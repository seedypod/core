import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEventBus } from '../../lib/eventBus'
import { MemoryStore } from '../../store/memory'
import { LIGHT_HOURS_KEY, Recorder } from '../recorder'

describe('Recorder', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('downsamples telemetry per sensor', () => {
    const store = new MemoryStore()
    let t = 0
    const r = new Recorder({ store, events: createEventBus(), sampleIntervalS: 60, now: () => new Date(t) })
    for (let i = 0; i < 10; i++) {
      t = i * 10_000
      r.onHal({ type: 'sensor', id: 'air_temp', reading: { ts: new Date(t).toISOString(), value: 20 + i, unit: '°C', quality: 'good' } })
    }
    expect(store.telemetry.range('air_temp', '1970-01-01T00:00:00.000Z', '1970-01-02T00:00:00.000Z')).toHaveLength(2)
  })

  it('mirrors HAL alerts and actuator faults into the store', () => {
    const store = new MemoryStore()
    const r = new Recorder({ store, events: createEventBus() })
    r.onHal({ type: 'alert', alert: { kind: 'water_low', active: true, ts: 't', detail: 'low' } })
    r.onHal({ type: 'actuator', id: 'pump', state: { on: false, level: 0, since: 't', fault: 'dry-run', remainingS: null } })
    expect(store.alerts.list({ activeOnly: true }).map(a => a.kind).sort()).toEqual(['pump_fault', 'water_low'])
    r.onHal({ type: 'alert', alert: { kind: 'water_low', active: false, ts: 't2', detail: '' } })
    r.onHal({ type: 'actuator', id: 'pump', state: { on: false, level: 0, since: 't', fault: null, remainingS: null } })
    expect(store.alerts.list({ activeOnly: true })).toHaveLength(0)
    r.onHal({ type: 'availability', online: false })
    expect(store.alerts.list({ activeOnly: true })[0]?.kind).toBe('hal_offline')
  })

  it('hands HAL alert details over as live, so a changing reading never touches the row', () => {
    const store = new MemoryStore()
    const raise = vi.spyOn(store.alerts, 'raise')
    const r = new Recorder({ store, events: createEventBus() })
    r.onHal({ type: 'alert', alert: { kind: 'water_low', active: true, ts: 't', detail: 'water distance 151.4 cm' } })
    expect(raise).toHaveBeenCalledWith('water_low', 'water distance 151.4 cm', 't', { live: true })
  })

  it('flushes telemetry on the interval from settings, and stops when stopped', () => {
    vi.useFakeTimers()
    const store = new MemoryStore()
    const events = createEventBus()
    const flush = vi.spyOn(store.telemetry, 'flush')
    const r = new Recorder({ store, events })
    r.start()
    flush.mockClear()
    vi.advanceTimersByTime(4 * 60_000)
    expect(flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(flush).toHaveBeenCalledTimes(1)
    r.stop()
    vi.advanceTimersByTime(60 * 60_000)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('picks up a changed flush interval, flushing first so nothing waits longer than it should', () => {
    vi.useFakeTimers()
    const store = new MemoryStore()
    const events = createEventBus()
    const flush = vi.spyOn(store.telemetry, 'flush')
    const r = new Recorder({ store, events })
    r.start()
    flush.mockClear()
    events.emit({ kind: 'mutation', path: 'alerts' })
    events.emit({ kind: 'schedule', action: 'changed', id: 'x' })
    expect(flush).not.toHaveBeenCalled()
    store.settings.update({ telemetryFlushMin: 1 })
    events.emit({ kind: 'mutation', path: 'settings' })
    expect(flush).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(flush).toHaveBeenCalledTimes(2)
    r.stop()
  })

  it('leaves doser faults to the HAL dose_fault alert', () => {
    const store = new MemoryStore()
    const r = new Recorder({ store, events: createEventBus() })
    r.onHal({ type: 'actuator', id: 'dose_1', state: { on: false, level: 0, since: 't', fault: 'lockout', remainingS: null } })
    r.onHal({ type: 'alert', alert: { kind: 'dose_fault', active: true, ts: 't', detail: 'dose_1: lockout' } })
    expect(store.alerts.list({ activeOnly: true }).map(a => a.kind)).toEqual(['dose_fault'])
  })

  it('accumulates light hours across on/off', () => {
    const store = new MemoryStore()
    let t = 0
    const r = new Recorder({ store, events: createEventBus(), now: () => new Date(t) })
    r.onHal({ type: 'actuator', id: 'light', state: { on: true, level: 50, since: 't', fault: null, remainingS: null } })
    t = 2 * 3_600_000
    r.onHal({ type: 'actuator', id: 'light', state: { on: false, level: 0, since: 't', fault: null, remainingS: null } })
    expect(store.counters.get(LIGHT_HOURS_KEY)).toBe(2)
    r.onHal({ type: 'actuator', id: 'light', state: { on: true, level: 50, since: 't', fault: null, remainingS: null } })
    t = 3 * 3_600_000
    r.stop()
    expect(store.counters.get(LIGHT_HOURS_KEY)).toBe(3)
  })
})
