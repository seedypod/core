import { describe, expect, it, vi } from 'vitest'
import { MqttHalClient, type MqttLike } from '../mqttClient'
import { HalRefused } from '../sim'

class FakeMqtt implements MqttLike {
  connected = false
  published: { topic: string, payload: string, opts?: unknown }[] = []
  subscribed: string[] = []
  private handlers = new Map<string, ((...a: never[]) => void)[]>()
  publish(topic: string, payload: string, opts?: unknown) {
    this.published.push({ topic, payload, opts })
  }

  subscribe(t: string | string[]) {
    this.subscribed.push(...(Array.isArray(t) ? t : [t]))
  }

  on(event: string, cb: (...a: never[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb])
  }

  end() {}
  fire(event: string, ...args: unknown[]) {
    for (const h of this.handlers.get(event) ?? []) (h as (...a: unknown[]) => void)(...args)
  }

  msg(topic: string, payload: unknown) {
    this.fire('message', topic, new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify(payload)))
  }
}

const U = 'gardyn-abc'
function make() {
  const mqtt = new FakeMqtt()
  const client = new MqttHalClient({ unitId: U, mqtt, httpBase: 'http://hal.local:3001', commandTimeoutMs: 50, fetchImpl: vi.fn(async () => new Response(new Uint8Array(3000), { status: 200 })) as unknown as typeof fetch })
  return { mqtt, client }
}

describe('MqttHalClient', () => {
  it('subscribes to the contract topics on connect and rebuilds the snapshot from retained messages', () => {
    const { mqtt, client } = make()
    mqtt.fire('connect')
    expect(mqtt.subscribed).toContain(`seedypod/${U}/sensor/+`)
    mqtt.msg(`seedypod/${U}/availability`, 'online')
    mqtt.msg(`seedypod/${U}/system`, { contract: 1, unitId: U, model: 'gardyn 3.0', halVersion: '0.1.0', caps: { sensors: ['air_temp'], actuators: ['light', 'pump'], cameras: ['upper'] }, limits: { pumpMaxRunS: 900, pumpMaxDuty: 30, waterLowCm: 16 } })
    mqtt.msg(`seedypod/${U}/sensor/air_temp`, { ts: '2026-10-31T00:00:00Z', value: 22.5, unit: '°C' })
    mqtt.msg(`seedypod/${U}/alert/water_low`, { kind: 'water_low', active: true, ts: '2026-10-31T00:00:00Z', detail: 'low' })
    const s = client.snapshot()
    expect(s.online).toBe(true)
    expect(s.system?.limits.pumpMaxDuty).toBe(30)
    expect(s.sensors.air_temp?.value).toBe(22.5)
    expect(s.alerts.water_low?.active).toBe(true)
  })

  it('publishes a command and resolves when hald echoes the new state', async () => {
    const { mqtt, client } = make()
    const p = client.setActuator('light', { on: true, level: 60 })
    expect(mqtt.published.at(-1)).toMatchObject({ topic: `seedypod/${U}/actuator/light/set`, payload: JSON.stringify({ on: true, level: 60 }) })
    mqtt.msg(`seedypod/${U}/actuator/light/state`, { on: true, level: 60, since: '2026-10-31T00:00:00Z', fault: null, remainingS: null })
    await expect(p).resolves.toMatchObject({ on: true, level: 60 })
  })

  it('maps a refused start (state echo with fault, off) to HalRefused and times out otherwise', async () => {
    const { mqtt, client } = make()
    const p = client.setActuator('pump', { on: true })
    mqtt.msg(`seedypod/${U}/actuator/pump/state`, { on: false, level: 0, since: '2026-10-31T00:00:00Z', fault: 'dry-run', remainingS: null })
    await expect(p).rejects.toBeInstanceOf(HalRefused)
    await expect(client.setActuator('pump', { on: false })).rejects.toThrow(/did not acknowledge/)
  })

  it('subscribes immediately when handed an already-connected client (connectAsync)', () => {
    const mqtt = new FakeMqtt()
    mqtt.connected = true
    void new MqttHalClient({ unitId: U, mqtt, httpBase: '' })
    expect(mqtt.subscribed).toContain(`seedypod/${U}/system`)
    mqtt.fire('connect')
    expect(mqtt.subscribed.filter(t => t === `seedypod/${U}/system`)).toHaveLength(2)
  })

  it('round-trips a calibration and ignores retained results nobody asked for', async () => {
    const { mqtt, client } = make()
    mqtt.fire('connect')
    expect(mqtt.subscribed).toContain(`seedypod/${U}/sensor/+/calibration`)
    mqtt.msg(`seedypod/${U}/sensor/ph/calibration`, { ts: '2026-10-30T00:00:00Z', point: 'low', ok: true, points: 2, detail: '' })
    const p = client.calibrate('ph', { point: 'mid', value: 7 })
    expect(mqtt.published.at(-1)).toMatchObject({ topic: `seedypod/${U}/sensor/ph/calibrate`, payload: JSON.stringify({ point: 'mid', value: 7 }) })
    mqtt.msg(`seedypod/${U}/sensor/ph/calibration`, { ts: '2026-10-31T00:00:00Z', point: 'low', ok: true, points: 2, detail: '' })
    mqtt.msg(`seedypod/${U}/sensor/ph/calibration`, { ts: '2026-10-31T00:00:01Z', point: 'mid', ok: true, points: 1, detail: '' })
    await expect(p).resolves.toMatchObject({ ok: true, points: 1 })
    expect(client.snapshot().sensors.ph).toBeUndefined()
    const slow = new MqttHalClient({ unitId: U, mqtt, httpBase: '', calibrationTimeoutMs: 10 })
    await expect(slow.calibrate('ec', { point: 'dry' })).rejects.toThrow(/did not report ec calibration/)
  })

  it('acknowledges alerts, fetches stills over HTTP, forwards button events, and drops garbage', async () => {
    const { mqtt, client } = make()
    const events: string[] = []
    client.subscribe(e => events.push(e.type))
    await client.acknowledgeAlert('pump_fault')
    expect(mqtt.published.at(-1)?.topic).toBe(`seedypod/${U}/alert/pump_fault/ack`)
    expect((await client.captureStill('upper')).byteLength).toBe(3000)
    mqtt.msg(`seedypod/${U}/event/button`, { press: 'double' })
    mqtt.msg(`seedypod/${U}/sensor/air_temp`, 'not json')
    mqtt.msg(`seedypod/${U}/alert/water_low`, { kind: 'water_low', active: true, ts: 'not-a-date', detail: '' })
    mqtt.msg(`other/${U}/sensor/air_temp`, { ts: '2026-10-31T00:00:00Z', value: 1, unit: 'x' })
    expect(events).toEqual(['button'])
  })
})
