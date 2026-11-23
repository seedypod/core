import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LightSource } from '../../control/light'
import type { ActuatorState, PumpRun } from '../../hardware/contract'
import { FOLLOW_ALERT, noteFollow } from '../../care/follow'
import { createEventBus } from '../../lib/eventBus'
import { MemoryStore } from '../../store/memory'
import type { DeviceSettings } from '../../store/types'
import { Notifier } from '../notifier'

const T0 = new Date('2026-11-20T10:00:00.000Z')

function setup(settings: Partial<DeviceSettings> = { notifyTarget: 'ntfy', ntfyTopic: 'seedypod-test' }, respond: (n: number) => Response | Promise<Response> = () => new Response('ok'), lightSource?: () => LightSource) {
  const store = new MemoryStore()
  store.settings.update(settings)
  const events = createEventBus()
  let now = T0
  const sent: Array<{ url: string, body: Record<string, unknown>, headers: Record<string, string> }> = []
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(init.body as string), headers: init.headers as Record<string, string> })
    return respond(sent.length)
  })
  const logs: string[] = []
  const n = new Notifier({ store, events, now: () => now, fetch: fetch as unknown as typeof globalThis.fetch, log: m => logs.push(m), lightSource })
  n.start()
  return { store, events, n, sent, fetch, logs, at: (ms: number) => (now = new Date(T0.getTime() + ms)) }
}

const run = (o: Partial<PumpRun> = {}): PumpRun => ({ startedAt: '2026-11-20T09:57:30.000Z', endedAt: '2026-11-20T10:00:00.000Z', everyMs: 1000, samples: [], wetA: null, endedBy: 'deadline', fault: null, levelPct: 62.4, levelCm: 10, ...o })

const lamp = (level: number): ActuatorState => ({ on: level > 0, level, since: T0.toISOString(), fault: null, remainingS: null })

afterEach(() => vi.useRealTimers())

describe('Notifier', () => {
  it('sends an alert once when it is raised, not on every refresh, and once when it clears by itself', async () => {
    const { store, sent } = setup()
    const ts = T0.toISOString()
    store.alerts.raise('water_low', 'Tank at 8%', ts)
    store.alerts.raise('water_low', 'Tank at 7%', ts)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]?.body).toMatchObject({ topic: 'seedypod-test', title: 'Gardyn: Water low', message: 'Tank at 8%', priority: 4 })
    store.alerts.clear('water_low', ts)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]?.body).toMatchObject({ title: 'Gardyn: Water low: resolved', priority: 2 })
    expect(store.alerts.clear('water_low', ts)).toBeNull()
  })

  it('sends each watering move, though the last one\'s notice is still open', async () => {
    const { store, sent, at } = setup()
    noteFollow(store, 'Watering moved to Seedlings: 1 × 6 min (08:00), day 8 since sowing.', T0.toISOString())
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const later = at(6 * 86_400_000)
    noteFollow(store, 'Watering moved to Young plants: 2 × 6 min (08:00, 16:00), day 14 since sowing.', later.toISOString())
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]?.body).toMatchObject({ title: 'Gardyn: Watering moved to the next stage', message: 'Watering moved to Young plants: 2 × 6 min (08:00, 16:00), day 14 since sowing.' })
    // One open notice, the latest; the older one closed without a "resolved".
    expect(store.alerts.list({ activeOnly: true }).filter(a => a.kind === FOLLOW_ALERT).map(a => a.raisedAt)).toEqual([later.toISOString()])
  })

  it('stays quiet about alerts already open at start, reminders closing, and faults the owner cleared', async () => {
    const store = new MemoryStore()
    store.settings.update({ notifyTarget: 'ntfy', ntfyTopic: 't' })
    const ts = T0.toISOString()
    store.alerts.raise('pump_fault', 'dry run', ts)
    const fetch = vi.fn(async () => new Response('ok'))
    const n = new Notifier({ store, events: createEventBus(), now: () => T0, fetch: fetch as unknown as typeof globalThis.fetch })
    n.start()
    store.alerts.raise('pump_fault', 'still dry', ts)
    store.alerts.raise('reminder_harvest', 'Harvest', ts)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    store.alerts.clear('reminder_harvest', ts)
    const row = store.alerts.list({ activeOnly: true }).find(a => a.kind === 'pump_fault')
    store.alerts.acknowledge(row?.id ?? -1, ts)
    store.alerts.clear('pump_fault', ts)
    const dismissed = store.alerts.raise('chore_feed', 'Feed', ts)
    store.alerts.dismiss(dismissed.id, ts)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    await new Promise(r => setTimeout(r, 20))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('doesn\'t repeat a flapping alert within 15 minutes', async () => {
    const { store, sent, at } = setup()
    const flap = () => {
      store.alerts.raise('camera_missing', 'upper', T0.toISOString())
      store.alerts.clear('camera_missing', T0.toISOString())
    }
    flap()
    flap()
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    at(16 * 60_000)
    flap()
    await vi.waitFor(() => expect(sent).toHaveLength(4))
  })

  it('holds an unreadable tank level for 10 minutes, saying nothing if it reads again by then', async () => {
    vi.useFakeTimers({ now: T0 })
    const { store, sent, n } = setup()
    const ts = T0.toISOString()
    store.alerts.raise('water_low', 'water level sensor unavailable', ts)
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    store.alerts.clear('water_low', ts)
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(sent).toHaveLength(0)

    store.alerts.raise('water_low', 'water level sensor unavailable', ts)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(sent.map(s => s.body)).toEqual([expect.objectContaining({ title: 'Gardyn: Tank level unreadable', message: 'No trusted tank reading for 10 minutes. Check the sensor under the lid.' })])
    store.alerts.clear('water_low', ts)
    await vi.advanceTimersByTimeAsync(0)
    expect(sent[1]?.body).toMatchObject({ title: 'Gardyn: Tank level unreadable: resolved', message: 'The tank reads again.' })

    // Held, then dismissed or stopped: nothing goes out later.
    const held = store.alerts.raise('water_low', 'water level sensor unavailable', ts)
    store.alerts.dismiss(held.id, ts)
    store.alerts.raise('water_low', 'water level sensor unavailable', ts)
    n.stop()
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(sent).toHaveLength(2)
  })

  it('sends a held unreadable tank level at once when it turns into a low reading', async () => {
    vi.useFakeTimers({ now: T0 })
    const { store, sent } = setup()
    const ts = T0.toISOString()
    store.alerts.raise('water_low', 'water level sensor unavailable', ts)
    await vi.advanceTimersByTimeAsync(60_000)
    store.alerts.raise('water_low', 'water distance 19.0 cm ≥ 16.0 cm', ts)
    await vi.advanceTimersByTimeAsync(0)
    expect(sent.map(s => s.body)).toEqual([expect.objectContaining({ title: 'Gardyn: Water low', message: 'water distance 19.0 cm ≥ 16.0 cm' })])
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(sent).toHaveLength(1)
  })

  it('sends only the groups the owner picked, and nothing when off', async () => {
    const { store, sent, events } = setup({ notifyTarget: 'webhook', webhookUrl: 'https://x.test/h', notifyGroups: ['watering', 'autopilot'] })
    store.alerts.raise('water_low', 'low', T0.toISOString())
    store.alerts.raise('autopilot_3', 'Hot: dim the light', T0.toISOString())
    events.emit({ kind: 'hal', event: { type: 'pumpRun', run: run() } })
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent.map(s => s.body.event)).toEqual(['autopilot.raised', 'watering.ran'])
    expect(sent[0]?.body).toMatchObject({ title: 'Autopilot', message: 'Hot: dim the light' })
    store.settings.update({ notifyTarget: 'off' })
    store.alerts.raise('autopilot_4', 'x', T0.toISOString())
    await new Promise(r => setTimeout(r, 20))
    expect(sent).toHaveLength(2)
  })

  it('describes pump runs and skips the broker\'s retained copy', async () => {
    const { events, sent, at } = setup({ notifyTarget: 'ntfy', ntfyTopic: 't', notifyGroups: ['watering'] })
    const pump = (r: PumpRun) => events.emit({ kind: 'hal', event: { type: 'pumpRun', run: r } })
    pump(run())
    pump(run())
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]?.body).toMatchObject({ title: 'Gardyn: Watering', message: 'Watered for 2 min 30 s, tank 62% full.', priority: 2 })
    pump(run({ startedAt: '2026-11-20T09:59:15.000Z', endedBy: 'fault', fault: 'dry run', levelPct: null }))
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]?.body).toMatchObject({ message: 'Watering stopped after 45 s: dry run.', priority: 4 })
    pump(run({ startedAt: '2026-11-20T09:58:00.000Z', endedBy: 'stop', levelPct: null }))
    await vi.waitFor(() => expect(sent).toHaveLength(3))
    expect(sent[2]?.body).toMatchObject({ message: 'Watered for 2 min (stopped early).' })
    at(60 * 60_000)
    pump(run({ startedAt: '2026-11-20T09:00:00.000Z' }))
    await new Promise(r => setTimeout(r, 20))
    expect(sent).toHaveLength(3)
  })

  it('reports the light once it settles, with who changed it, and skips the first state and small moves', async () => {
    vi.useFakeTimers({ now: T0 })
    let source: LightSource = 'schedule'
    const { events, sent, n } = setup({ notifyTarget: 'webhook', webhookUrl: 'https://x.test/h', notifyGroups: ['lights'] }, undefined, () => source)
    const light = (level: number) => events.emit({ kind: 'hal', event: { type: 'actuator', id: 'light', state: lamp(level) } })
    light(0)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(sent).toHaveLength(0)
    for (const level of [10, 30, 50, 70, 80]) {
      light(level)
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(sent.map(s => s.body)).toEqual([expect.objectContaining({ event: 'lights.changed', title: 'Light on', message: 'On at 80%, on schedule.', priority: 'low', data: { from: 0, to: 80, source: 'schedule' } })])
    light(83)
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(sent).toHaveLength(1)
    source = 'autopilot'
    light(40)
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    source = 'manual'
    light(100)
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    source = null
    light(0)
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(sent.slice(1).map(s => [s.body.title, s.body.message])).toEqual([
      ['Light dimmed', 'Now 40%, by Autopilot.'],
      ['Light brightened', 'Now 100%, by hand.'],
      ['Light off', 'Turned off.'],
    ])
    light(60)
    n.stop()
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(sent).toHaveLength(4)
  })

  it('keeps the light quiet unless Lights is on, without reporting the old change once it is', async () => {
    vi.useFakeTimers({ now: T0 })
    const { events, sent, store } = setup({ notifyTarget: 'ntfy', ntfyTopic: 't' })
    const light = (level: number) => events.emit({ kind: 'hal', event: { type: 'actuator', id: 'light', state: lamp(level) } })
    light(0)
    light(80)
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(sent).toHaveLength(0)
    store.settings.update({ notifyGroups: ['lights'] })
    light(80)
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(sent).toHaveLength(0)
    light(0)
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(sent.map(s => s.body)).toEqual([expect.objectContaining({ title: 'Gardyn: Light off', message: 'Turned off.', tags: ['crescent_moon'], priority: 2 })])
  })

  it('retries server errors with backoff, gives up after four tries, and never logs the URL', async () => {
    vi.useFakeTimers()
    const url = 'https://discord.com/api/webhooks/1/topsecret'
    const { store, sent, logs, n } = setup({ notifyTarget: 'webhook', webhookUrl: url, webhookFormat: 'discord' }, () => new Response('', { status: 503 }))
    store.alerts.raise('hal_offline', 'unreachable', T0.toISOString())
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(n.status().pending).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sent).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(sent).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(sent).toHaveLength(4)
    expect(n.status()).toMatchObject({ pending: 0, last: { ok: false, detail: 'HTTP 503' } })
    expect(logs.join('\n')).not.toContain('topsecret')
  })

  it('doesn\'t retry a refused request, and reports network failures without the URL', async () => {
    const url = 'https://hooks.example.com/abc'
    const { store, sent, n } = setup({ notifyTarget: 'webhook', webhookUrl: url }, (i) => {
      if (i === 1) return new Response('', { status: 404 })
      throw Object.assign(new TypeError(`fetch failed for ${url}`), { cause: { code: 'ENOTFOUND' } })
    })
    store.alerts.raise('water_low', 'low', T0.toISOString())
    await vi.waitFor(() => expect(n.status().last?.detail).toBe('HTTP 404'))
    expect(n.status().pending).toBe(0)
    expect(await n.test()).toMatchObject({ ok: false, detail: 'couldn\'t connect (ENOTFOUND)', title: 'Test notification' })
    expect(sent).toHaveLength(2)
  })

  it('reports a timeout and a plain error by name, with the URL scrubbed', async () => {
    const url = 'https://hooks.example.com/abc'
    let mode = 0
    const { n } = setup({ notifyTarget: 'webhook', webhookUrl: url }, () => {
      if (mode++ === 0) throw Object.assign(new Error('aborted'), { name: 'TimeoutError' })
      throw new Error(`bad ${url}`)
    })
    expect(await n.test()).toMatchObject({ ok: false, detail: 'no answer in 10 s' })
    expect(await n.test()).toMatchObject({ ok: false, detail: 'bad the server' })
  })

  it('refuses a test with no target, drops the queue when turned off, and unhooks the store on stop', async () => {
    const { store, n, sent } = setup({ notifyTarget: 'off' })
    await expect(n.test()).rejects.toThrow(/Pick where/)
    store.settings.update({ notifyTarget: 'webhook', webhookUrl: 'https://x.test/h' })
    expect(await n.test()).toMatchObject({ ok: true, detail: 'HTTP 200' })
    n.start()
    n.stop()
    store.alerts.raise('water_low', 'low', T0.toISOString())
    await new Promise(r => setTimeout(r, 20))
    expect(sent).toHaveLength(1)
  })

  it('stops retrying once notifications are turned off', async () => {
    vi.useFakeTimers()
    const { store, sent, n } = setup({ notifyTarget: 'ntfy', ntfyTopic: 't' }, () => new Response('', { status: 500 }))
    store.alerts.raise('water_low', 'low', T0.toISOString())
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    store.settings.update({ notifyTarget: 'off' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sent).toHaveLength(1)
    expect(n.status().pending).toBe(0)
  })

  it('keeps at most 20 waiting', async () => {
    vi.useFakeTimers()
    const { store, n, sent } = setup({ notifyTarget: 'ntfy', ntfyTopic: 't' }, () => new Response('', { status: 500 }))
    for (let i = 0; i < 30; i++) store.alerts.raise(`kind_${i}`, 'x', T0.toISOString())
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(n.status().pending).toBe(20)
  })
})
