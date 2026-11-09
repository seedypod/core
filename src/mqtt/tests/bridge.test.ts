import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimHal } from '../../hardware/sim'
import { createEventBus } from '../../lib/eventBus'
import { MemoryStore } from '../../store/memory'
import { bridgeStatus, HaBridge, keepConnecting, superviseBridge } from '../bridge'
import type { MqttLike } from '../../hardware/mqttClient'
import type { Capture } from '../../store/types'

class FakeMqtt implements MqttLike {
  published: { topic: string, payload: string, bytes?: Uint8Array, retain?: boolean }[] = []
  subscribed: string[] = []
  private h = new Map<string, ((...a: never[]) => void)[]>()
  publish(topic: string, payload: string | Uint8Array, opts?: { retain?: boolean }) {
    if (typeof payload === 'string') this.published.push({ topic, payload, retain: opts?.retain })
    else this.published.push({ topic, payload: '', bytes: payload, retain: opts?.retain })
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

  it('backup_stale is a problem sensor that follows the alert', () => {
    const { mqtt, store, events } = setup()
    mqtt.fire('connect')
    const cfg = JSON.parse(mqtt.published.find(p => p.topic === 'homeassistant/binary_sensor/u1_core_backup_stale/config')?.payload ?? '{}') as Record<string, string>
    expect(cfg).toMatchObject({ name: 'Backup overdue', device_class: 'problem', state_topic: 'seedypod/u1/core/state' })
    store.alerts.raise('backup_stale', 'No off-card backup yet', '2026-10-31T00:00:00Z')
    events.emit({ kind: 'mutation', path: 'alerts.backup_stale' })
    expect(JSON.parse(mqtt.published.at(-1)?.payload ?? '{}')).toMatchObject({ backupStale: true })
  })

  it('cameras: an MQTT camera per reported camera, carrying the newest stored still, retained and sent once', async () => {
    const mqtt = new FakeMqtt()
    const hal = new SimHal({ tickMs: 0 })
    const events = createEventBus()
    const snapshot = hal.snapshot.bind(hal)
    const system = snapshot().system
    if (!system) throw new Error('sim reports no system')
    hal.snapshot = () => ({ ...snapshot(), system: { ...system, caps: { ...system.caps, cameras: ['upper'] } } })
    let newest: { capture: Capture, bytes: Uint8Array } | null = null
    const stills = vi.fn(async () => newest)
    const bridge = new HaBridge({ mqtt, store: new MemoryStore(), hal, events, unitId: 'u1', stills })
    bridge.start()
    mqtt.fire('connect')
    await vi.waitFor(() => expect(stills).toHaveBeenCalled())
    const cfgs = mqtt.published.filter(p => p.topic.startsWith('homeassistant/camera/'))
    expect(cfgs.map(c => c.topic)).toEqual(['homeassistant/camera/u1_core_camera_upper/config'])
    expect(JSON.parse(cfgs[0]?.payload ?? '{}')).toMatchObject({ name: 'Upper camera', topic: 'seedypod/u1/core/camera/upper', unique_id: 'u1_core_camera_upper' })
    const frames = () => mqtt.published.filter(p => p.topic === 'seedypod/u1/core/camera/upper')
    expect(frames()).toEqual([])

    const bytes = new Uint8Array([0xFF, 0xD8, 1, 2, 0xFF, 0xD9])
    newest = { capture: { id: 'upper-1', camera: 'upper', ts: '2026-11-08T00:00:00.000Z', path: 'upper-1.jpg', bytes: 6 }, bytes }
    events.emit({ kind: 'mutation', path: 'captures' })
    await vi.waitFor(() => expect(frames()).toHaveLength(1))
    expect(Buffer.isBuffer(frames()[0]?.bytes)).toBe(true)
    expect([...(frames()[0]?.bytes ?? [])]).toEqual([...bytes])
    expect(frames()[0]?.retain).toBe(true)
    events.emit({ kind: 'mutation', path: 'captures' })
    await bridge.publishStills()
    expect(frames()).toHaveLength(1)
    // A reconnect sends it again: the broker may have lost its retained copy.
    mqtt.fire('connect')
    await vi.waitFor(() => expect(frames()).toHaveLength(2))
  })

  it('without a still source there are no camera entities, and a failing one sends nothing', async () => {
    const { mqtt, bridge } = setup()
    mqtt.fire('connect')
    await bridge.publishStills()
    expect(mqtt.published.some(p => p.topic.includes('camera'))).toBe(false)
    const broken = new FakeMqtt()
    const failing = new HaBridge({ mqtt: broken, store: new MemoryStore(), hal: new SimHal({ tickMs: 0 }), events: createEventBus(), unitId: 'u1', stills: () => Promise.reject(new Error('EIO')) })
    await failing.publishStills()
    expect(broken.published).toEqual([])
  })

  it('water_now runs a bounded pump cycle through the HAL', async () => {
    const { hal, bridge } = setup()
    await bridge.onMessage('seedypod/u1/core/water_now', '120')
    expect(hal.snapshot().actuators.pump).toMatchObject({ on: true, remainingS: 120 })
  })

  it('tracks the broker link: down on close or offline, back up on connect, since each change', () => {
    let now = new Date('2026-10-31T00:00:00Z')
    const mqtt = new FakeMqtt()
    const bridge = new HaBridge({ mqtt, store: new MemoryStore(), hal: new SimHal({ tickMs: 0 }), events: createEventBus(), unitId: 'u1', now: () => now })
    expect(bridge.link()).toEqual({ connected: false, since: '2026-10-31T00:00:00.000Z' })
    now = new Date('2026-10-31T00:01:00Z')
    mqtt.fire('connect')
    expect(bridge.link()).toEqual({ connected: true, since: '2026-10-31T00:01:00.000Z' })
    now = new Date('2026-10-31T00:02:00Z')
    mqtt.fire('offline')
    mqtt.fire('close')
    expect(bridge.link()).toEqual({ connected: false, since: '2026-10-31T00:02:00.000Z' })
  })
})

describe('keepConnecting', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const bridge = () => ({ stop: vi.fn() }) as unknown as HaBridge
  const quiet = { up: () => undefined, failed: () => undefined }

  it('retries with growing gaps until it connects, without holding up the caller', async () => {
    const up = bridge()
    const connect = vi.fn(async (): Promise<HaBridge | null> => {
      if (connect.mock.calls.length < 3) throw new Error('no route to host')
      return up
    })
    const on = { up: vi.fn(), failed: vi.fn() }
    keepConnecting(connect, on)
    await vi.advanceTimersByTimeAsync(0)
    expect(on.failed).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(connect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(connect).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(connect).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(on.up).toHaveBeenCalledWith(up)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(connect).toHaveBeenCalledTimes(3)
  })

  it('backs off to 5 minutes at most', async () => {
    const connect = vi.fn(async (): Promise<HaBridge | null> => {
      throw new Error('down')
    })
    keepConnecting(connect, quiet)
    await vi.advanceTimersByTimeAsync(3_600_000)
    const calls = connect.mock.calls.length
    await vi.advanceTimersByTimeAsync(300_000)
    expect(connect.mock.calls.length).toBe(calls + 1)
  })

  it('stops trying when cancelled', async () => {
    const connect = vi.fn(async (): Promise<HaBridge | null> => {
      throw new Error('down')
    })
    const cancel = keepConnecting(connect, quiet)
    await vi.advanceTimersByTimeAsync(0)
    cancel()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('drops a bridge that arrives after being cancelled, and ignores a late failure', async () => {
    const late = bridge()
    let settle: (b: HaBridge) => void = () => undefined
    const on = { up: vi.fn(), failed: vi.fn() }
    keepConnecting(() => new Promise<HaBridge>((resolve) => {
      settle = resolve
    }), on)()
    settle(late)
    await vi.advanceTimersByTimeAsync(0)
    expect(late.stop).toHaveBeenCalled()
    expect(on.up).not.toHaveBeenCalled()
    keepConnecting(async () => {
      throw new Error('down')
    }, on)()
    await vi.advanceTimersByTimeAsync(0)
    expect(on.failed).not.toHaveBeenCalled()
  })

  it('takes a dormant bridge as connected', async () => {
    const on = { up: vi.fn(), failed: vi.fn() }
    keepConnecting(async () => null, on)
    await vi.advanceTimersByTimeAsync(0)
    expect(on.up).toHaveBeenCalledWith(null)
  })
})

describe('superviseBridge', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const bridge = () => ({ stop: vi.fn() }) as unknown as HaBridge

  it('holds the bridge, and the last error until it connects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const up = bridge()
    const connect = vi.fn(async (): Promise<HaBridge | null> => {
      if (connect.mock.calls.length === 1) throw new Error('no route to host')
      return up
    })
    const s = superviseBridge(connect, createEventBus())
    await vi.advanceTimersByTimeAsync(0)
    expect(s.error()).toBe('no route to host')
    expect(s.bridge()).toBeNull()
    expect(warn).toHaveBeenCalledWith('HA bridge: no route to host')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(s.bridge()).toBe(up)
    expect(s.error()).toBeNull()
    warn.mockRestore()
    s.stop()
    expect(up.stop).toHaveBeenCalled()
  })

  it('starts over when settings change, and only then', async () => {
    const events = createEventBus()
    const first = bridge()
    const second = bridge()
    const connect = vi.fn(async (): Promise<HaBridge | null> => (connect.mock.calls.length === 1 ? first : second))
    const s = superviseBridge(connect, events)
    await vi.advanceTimersByTimeAsync(0)
    events.emit({ kind: 'mutation', path: 'grow' })
    expect(connect).toHaveBeenCalledTimes(1)
    events.emit({ kind: 'mutation', path: 'settings' })
    await vi.advanceTimersByTimeAsync(0)
    expect(first.stop).toHaveBeenCalled()
    expect(s.bridge()).toBe(second)
    s.stop()
  })

  it('stops listening when stopped, with no bridge to stop', async () => {
    const events = createEventBus()
    const connect = vi.fn(async (): Promise<HaBridge | null> => null)
    const s = superviseBridge(connect, events)
    await vi.advanceTimersByTimeAsync(0)
    s.stop()
    events.emit({ kind: 'mutation', path: 'settings' })
    expect(connect).toHaveBeenCalledTimes(1)
  })
})

describe('bridgeStatus', () => {
  it('is off without a broker URL', () => {
    expect(bridgeStatus(null, null, 'stale error')).toEqual({ state: 'off', broker: null, since: null, error: null })
  })

  it('names the broker without credentials, and carries the connect error while down', () => {
    expect(bridgeStatus('mqtt://ha:secret@192.168.1.5:1883', null, 'ECONNREFUSED')).toEqual({ state: 'disconnected', broker: '192.168.1.5:1883', since: null, error: 'ECONNREFUSED' })
    expect(bridgeStatus('not a url', null, null)).toMatchObject({ broker: 'not a url' })
  })

  it('follows the running bridge', () => {
    const { mqtt, bridge } = setup()
    mqtt.fire('connect')
    expect(bridgeStatus('mqtt://broker.local', bridge, 'old')).toEqual({ state: 'connected', broker: 'broker.local', since: '2026-10-31T00:00:00.000Z', error: null })
  })
})
