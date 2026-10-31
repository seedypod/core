/**
 * Core-level Home Assistant bridge (ADR-0013, after sleepypod ADR-0019).
 *
 * `hald` already publishes discovery for the physical entities (light, pump,
 * sensors). This bridge adds what only core knows: grow-cycle reminders as
 * binary sensors with "done" buttons, the cycle day/stage, light hours, a
 * "water now" button bounded by the HAL, and an availability topic for core
 * itself. It is an MQTT *client* on the user's broker, dormant until a URL is
 * configured, LAN-only by design.
 */
import type { MqttLike } from '../hardware/mqttClient'
import type { CoreEvent, EventBus } from '../lib/eventBus'
import type { HalClient } from '../hardware/types'
import type { Store } from '../store/types'
import { cycleDay } from '../grow/grow'
import { LIGHT_HOURS_KEY } from '../telemetry/recorder'

export interface BridgeOptions {
  mqtt: MqttLike
  store: Store
  hal: HalClient
  events: EventBus
  unitId: string
  prefix?: string
  now?: () => Date
}

const REMINDERS = [
  ['reminder_thinning', 'Thin seedlings', 'mdi:content-cut'],
  ['reminder_root_check', 'Check roots', 'mdi:source-branch'],
  ['reminder_harvest', 'Harvest window', 'mdi:basket'],
  ['reminder_nutrients', 'Add nutrients', 'mdi:flask'],
] as const

export class HaBridge {
  private unsub: (() => void) | null = null
  private readonly p: string
  private readonly now: () => Date

  constructor(private readonly o: BridgeOptions) {
    this.p = `${o.prefix ?? 'seedypod'}/${o.unitId}/core`
    this.now = o.now ?? (() => new Date())
    o.mqtt.on('connect', () => this.onConnect())
    o.mqtt.on('message', (topic, payload) => this.onMessage(topic, new TextDecoder().decode(payload)))
  }

  start(): void {
    this.unsub = this.o.events.subscribe(e => this.onEvent(e))
  }

  stop(): void {
    this.unsub?.()
    this.o.mqtt.publish(`${this.p}/availability`, 'offline', { retain: true })
    this.o.mqtt.end()
  }

  /** Topic names, exposed for tests and docs. */
  topics() {
    return {
      availability: `${this.p}/availability`,
      state: `${this.p}/state`,
      waterNow: `${this.p}/water_now`,
      done: (kind: string) => `${this.p}/done/${kind}`,
    }
  }

  private device() {
    return { identifiers: [this.o.unitId], name: `Gardyn ${this.o.unitId}`, manufacturer: 'seedypod', model: this.o.hal.snapshot().system?.model ?? 'gardyn' }
  }

  onConnect(): void {
    const t = this.topics()
    this.o.mqtt.subscribe([t.waterNow, `${this.p}/done/+`])
    this.o.mqtt.publish(t.availability, 'online', { retain: true })
    const avail = { availability_topic: t.availability, payload_available: 'online', payload_not_available: 'offline', device: this.device() }
    const pub = (component: string, id: string, cfg: Record<string, unknown>) =>
      this.o.mqtt.publish(`homeassistant/${component}/${this.o.unitId}_core_${id}/config`, JSON.stringify({ unique_id: `${this.o.unitId}_core_${id}`, ...avail, ...cfg }), { retain: true })

    for (const [kind, name, icon] of REMINDERS) {
      pub('binary_sensor', kind, { name, icon, state_topic: t.state, value_template: `{{ 'ON' if value_json.reminders.${kind} else 'OFF' }}`, device_class: 'problem' })
      pub('button', `${kind}_done`, { name: `${name}: done`, icon: 'mdi:check', command_topic: t.done(kind), payload_press: '{}' })
    }
    pub('sensor', 'grow_day', { name: 'Grow day', icon: 'mdi:calendar-today', state_topic: t.state, value_template: '{{ value_json.grow.day if value_json.grow.day is not none else "unknown" }}', unit_of_measurement: 'd', state_class: 'measurement' })
    pub('sensor', 'grow_stage', { name: 'Grow stage', icon: 'mdi:sprout', state_topic: t.state, value_template: '{{ value_json.grow.stage or "none" }}' })
    pub('sensor', 'light_hours', { name: 'Grow light hours', icon: 'mdi:lightbulb-on', state_topic: t.state, value_template: '{{ value_json.lightHours }}', unit_of_measurement: 'h', state_class: 'total_increasing' })
    pub('binary_sensor', 'backup_stale', { name: 'Backup overdue', icon: 'mdi:backup-restore', state_topic: t.state, value_template: '{{ \'ON\' if value_json.backupStale else \'OFF\' }}', device_class: 'problem', entity_category: 'diagnostic' })
    pub('button', 'water_now', { name: 'Water now (5 min)', icon: 'mdi:watering-can', command_topic: t.waterNow, payload_press: '300' })
    this.publishState()
  }

  publishState(): void {
    const cycle = this.o.store.grow.current()
    const active = new Set(this.o.store.alerts.list({ activeOnly: true }).map(a => a.kind))
    const state = {
      grow: { day: cycle ? cycleDay(cycle, this.now()) : null, stage: cycle?.stage ?? null },
      reminders: Object.fromEntries(REMINDERS.map(([k]) => [k, active.has(k)])),
      backupStale: active.has('backup_stale'),
      lightHours: Math.round(this.o.store.counters.get(LIGHT_HOURS_KEY) * 10) / 10,
      ts: this.now().toISOString(),
    }
    this.o.mqtt.publish(this.topics().state, JSON.stringify(state), { retain: true })
  }

  onEvent(e: CoreEvent): void {
    if (e.kind === 'mutation' && (e.path.startsWith('alerts') || e.path === 'grow')) this.publishState()
    if (e.kind === 'hal' && e.event.type === 'actuator' && e.event.id === 'light' && !e.event.state.on) this.publishState()
  }

  async onMessage(topic: string, payload: string): Promise<void> {
    const t = this.topics()
    if (topic === t.waterNow) {
      const secs = Math.max(1, Math.min(3600, Number(payload) || 300))
      await this.o.hal.setActuator('pump', { on: true, durationS: secs }).catch(() => undefined) // refusals surface via hald's own alert topics
      return
    }
    if (topic.startsWith(`${this.p}/done/`)) {
      const kind = topic.slice(`${this.p}/done/`.length)
      const now = this.now().toISOString()
      const a = this.o.store.alerts.list({ activeOnly: true }).find(x => x.kind === kind)
      if (a) {
        this.o.store.alerts.acknowledge(a.id, now)
        this.o.store.alerts.clear(kind, now)
        this.o.events.emit({ kind: 'mutation', path: `alerts.${kind}` })
      }
    }
  }
}

/** Build a real mqtt.js connection from settings; returns null when the bridge is dormant. */
export async function connectBridge(o: Omit<BridgeOptions, 'mqtt'>): Promise<HaBridge | null> {
  const s = o.store.settings.get()
  if (!s.mqttUrl) return null
  const { connectAsync } = await import('mqtt')
  const url = s.mqttTlsEnabled ? s.mqttUrl.replace(/^mqtt:\/\//, 'mqtts://') : s.mqttUrl
  const mqtt = await connectAsync(url, {
    username: s.mqttUsername ?? undefined,
    password: s.mqttPassword ?? undefined,
    rejectUnauthorized: !s.mqttTlsInsecure,
    reconnectPeriod: 5000,
    keepalive: 30,
    will: { topic: `${o.prefix ?? 'seedypod'}/${o.unitId}/core/availability`, payload: Buffer.from('offline'), retain: true, qos: 0 },
    clientId: `seedypod-core-bridge-${o.unitId}`,
  })
  const bridge = new HaBridge({ ...o, mqtt })
  bridge.start()
  bridge.onConnect()
  return bridge
}
