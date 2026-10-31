import { describe, expect, it } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createEventBus } from '../../lib/eventBus'
import { MemoryStore } from '../../store/memory'
import { HaBridge } from '../bridge'
import type { MqttLike } from '../../hardware/mqttClient'

class FakeMqtt implements MqttLike {
  published: { topic: string, payload: string, retain?: boolean }[] = []
  subscribed: string[] = []
  private h = new Map<string, ((...a: never[]) => void)[]>()
  publish(topic: string, payload: string, opts?: { retain?: boolean }) {
    this.published.push({ topic, payload, retain: opts?.retain })
  }

  subscribe(t: string | string[]) {
    this.subscribed.push(...(Array.isArray(t) ? t : [t]))
  }

  on(e: string, cb: (...a: never[]) => void) {
    this.h.set(e, [...(this.h.get(e) ?? []), cb])
  }

  end() {}
  fire(e: string, ...a: unknown[]) {
    for (const cb of this.h.get(e) ?? []) (cb as (...x: unknown[]) => void)(...a)
  }
}

function setup() {
  const mqtt = new FakeMqtt()
  const store = new MemoryStore()
  const hal = new SimHal({ tickMs: 0 })
  const events = createEventBus()
  const bridge = new HaBridge({ mqtt, store, hal, events, unitId: 'u1', now: () => new Date('2026-10-31T00:00:00Z') })
  bridge.start()
  return { mqtt, store, hal, events, bridge }
}

describe('HaBridge', () => {
  it('publishes discovery for reminders, grow sensors, light hours and the water button', () => {
    const { mqtt } = setup()
    mqtt.fire('connect')
    const cfgs = mqtt.published.filter(p => p.topic.startsWith('homeassistant/'))
    expect(cfgs.map(c => c.topic)).toEqual(expect.arrayContaining([
      'homeassistant/binary_sensor/u1_core_reminder_thinning/config',
      'homeassistant/button/u1_core_reminder_thinning_done/config',
      'homeassistant/sensor/u1_core_grow_day/config',
      'homeassistant/button/u1_core_water_now/config',
    ]))
    expect(cfgs.every(c => c.retain)).toBe(true)
    expect(mqtt.published.find(p => p.topic === 'seedypod/u1/core/availability')?.payload).toBe('online')
  })

  it('state reflects reminders and grow day; done button clears a reminder', async () => {
    const { mqtt, store, bridge } = setup()
    store.grow.start('2026-10-20T00:00:00Z')
    store.alerts.raise('reminder_nutrients', 'feed', '2026-10-31T00:00:00Z')
    bridge.publishState()
    const state = JSON.parse(mqtt.published.at(-1)?.payload ?? '{}') as { grow: { day: number }, reminders: Record<string, boolean> }
    expect(state.grow.day).toBe(11)
    expect(state.reminders.reminder_nutrients).toBe(true)
    await bridge.onMessage('seedypod/u1/core/done/reminder_nutrients', '{}')
    expect(store.alerts.list({ activeOnly: true })).toHaveLength(0)
    const after = JSON.parse(mqtt.published.at(-1)?.payload ?? '{}') as { reminders: Record<string, boolean> }
    expect(after.reminders.reminder_nutrients).toBe(false)
  })

  it('water_now runs a bounded pump cycle through the HAL', async () => {
    const { hal, bridge } = setup()
    await bridge.onMessage('seedypod/u1/core/water_now', '120')
    expect(hal.snapshot().actuators.pump).toMatchObject({ on: true, remainingS: 120 })
  })
})
