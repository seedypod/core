import { describe, expect, it, vi } from 'vitest'
import { MqttHalClient, type MqttLike } from '../mqttClient'
import { HalRefused } from '../sim'

class FakeMqtt implements MqttLike {
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
    expect(mqtt.subscribed).toContain(`leafypod/${U}/sensor/+`)
    mqtt.msg(`leafypod/${U}/availability`, 'online')
    mqtt.msg(`leafypod/${U}/system`, { contract: 1, unitId: U, model: 'gardyn 3.0', halVersion: '0.1.0', caps: { sensors: ['air_temp'], actuators: ['light', 'pump'], cameras: ['upper'] }, limits: { pumpMaxRunS: 900, pumpMaxDuty: 30, waterLowCm: 16 } })
    mqtt.msg(`leafypod/${U}/sensor/air_temp`, { ts: '2026-10-31T00:00:00Z', value: 22.5, unit: '°C' })
    mqtt.msg(`leafypod/${U}/alert/water_low`, { kind: 'water_low', active: true, ts: '2026-10-31T00:00:00Z', detail: 'low' })
    const s = client.snapshot()
    expect(s.online).toBe(true)
    expect(s.system?.limits.pumpMaxDuty).toBe(30)
    expect(s.sensors.air_temp?.value).toBe(22.5)
    expect(s.alerts.water_low?.active).toBe(true)
  })

  it('publishes a command and resolves when hald echoes the new state', async () => {
    const { mqtt, client } = make()
    const p = client.setActuator('light', { on: true, level: 60 })
    expect(mqtt.published.at(-1)).toMatchObject({ topic: `leafypod/${U}/actuator/light/set`, payload: JSON.stringify({ on: true, level: 60 }) })
    mqtt.msg(`leafypod/${U}/actuator/light/state`, { on: true, level: 60, since: '2026-10-31T00:00:00Z', fault: null, remainingS: null })
    await expect(p).resolves.toMatchObject({ on: true, level: 60 })
  })

  it('maps a refused start (state echo with fault, off) to HalRefused and times out otherwise', async () => {
    const { mqtt, client } = make()
    const p = client.setActuator('pump', { on: true })
    mqtt.msg(`leafypod/${U}/actuator/pump/state`, { on: false, level: 0, since: '2026-10-31T00:00:00Z', fault: 'dry-run', remainingS: null })
    await expect(p).rejects.toBeInstanceOf(HalRefused)
    await expect(client.setActuator('pump', { on: false })).rejects.toThrow(/did not acknowledge/)
  })

  it('acknowledges alerts, fetches stills over HTTP, forwards button events, and drops garbage', async () => {
    const { mqtt, client } = make()
    const events: string[] = []
    client.subscribe(e => events.push(e.type))
    await client.acknowledgeAlert('pump_fault')
    expect(mqtt.published.at(-1)?.topic).toBe(`leafypod/${U}/alert/pump_fault/ack`)
    expect((await client.captureStill('upper')).byteLength).toBe(3000)
    mqtt.msg(`leafypod/${U}/event/button`, { press: 'double' })
    mqtt.msg(`leafypod/${U}/sensor/air_temp`, 'not json')
    mqtt.msg(`leafypod/${U}/alert/water_low`, { kind: 'water_low', active: true, ts: 'not-a-date', detail: '' })
    mqtt.msg(`other/${U}/sensor/air_temp`, { ts: '2026-10-31T00:00:00Z', value: 1, unit: 'x' })
    expect(events).toEqual(['button'])
  })
})
