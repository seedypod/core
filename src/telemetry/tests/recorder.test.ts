import { describe, expect, it } from 'vitest'
import { createEventBus } from '../../lib/eventBus'
import { MemoryStore } from '../../store/memory'
import { LIGHT_HOURS_KEY, Recorder } from '../recorder'

describe('Recorder', () => {
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
