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
import type { Capture } from '../store/types'
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
  /** The newest stored still per camera (`latestStill`); omitted = no camera entities. */
  stills?: (camera: Camera) => Promise<{ capture: Capture, bytes: Uint8Array } | null>
}

type Camera = 'upper' | 'lower'
const CAMERA_NAMES: Record<Camera, string> = { upper: 'Upper camera', lower: 'Lower camera' }

const REMINDERS = [
  ['reminder_thinning', 'Thin seedlings', 'mdi:content-cut'],
  ['reminder_root_check', 'Check roots', 'mdi:source-branch'],
  ['reminder_harvest', 'Harvest window', 'mdi:basket'],
  ['reminder_nutrients', 'Add nutrients', 'mdi:flask'],
  ['reminder_sow', 'Start new yCubes', 'mdi:seed'],
] as const

/** The bridge as System › Status shows it: off with no broker set, else whether it holds a connection and since when. */
export interface BridgeStatus {
  state: 'off' | 'connected' | 'disconnected'
  /** `host:port` of the broker, without credentials. */
  broker: string | null
  since: string | null
  /** Why the last connect failed. */
  error: string | null
}

function brokerHost(url: string): string {
  try {
    return new URL(url).host || url
  }
  catch {
    return url
  }
}

/** Status for the configured broker URL, the running bridge (null when it isn't up) and the last connect error. */
export function bridgeStatus(mqttUrl: string | null, bridge: HaBridge | null, error: string | null): BridgeStatus {
  if (!mqttUrl) return { state: 'off', broker: null, since: null, error: null }
  const link = bridge?.link() ?? null
  return { state: link?.connected ? 'connected' : 'disconnected', broker: brokerHost(mqttUrl), since: link?.since ?? null, error: link?.connected ? null : error }
}

export class HaBridge {
  private unsub: (() => void) | null = null
  private readonly p: string
  private readonly now: () => Date
  private linkState: { connected: boolean, since: string }
  /** The capture each camera topic last carried, so a new still is sent once. */
  private readonly sentStill = new Map<Camera, string>()

  constructor(private readonly o: BridgeOptions) {
    this.p = `${o.prefix ?? 'seedypod'}/${o.unitId}/core`
    this.now = o.now ?? (() => new Date())
    this.linkState = { connected: !!o.mqtt.connected, since: this.now().toISOString() }
    o.mqtt.on('connect', () => this.onConnect())
    o.mqtt.on('close', () => this.setLink(false))
    o.mqtt.on('offline', () => this.setLink(false))
    o.mqtt.on('message', (topic, payload) => this.onMessage(topic, new TextDecoder().decode(payload)))
  }

  /** Whether the broker connection is up, and since when. */
  link(): { connected: boolean, since: string } {
    return this.linkState
  }

  private setLink(connected: boolean): void {
    if (this.linkState.connected !== connected) this.linkState = { connected, since: this.now().toISOString() }
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
      camera: (camera: Camera) => `${this.p}/camera/${camera}`,
    }
  }

  /** The cameras hald reports; both until it has reported. */
  private cameras(): Camera[] {
    return this.o.hal.snapshot().system?.caps.cameras ?? ['upper', 'lower']
  }

  private device() {
    return { identifiers: [this.o.unitId], name: `Gardyn ${this.o.unitId}`, manufacturer: 'seedypod', model: this.o.hal.snapshot().system?.model ?? 'gardyn' }
  }

  onConnect(): void {
    this.setLink(true)
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
    if (this.o.stills) {
      // An MQTT camera shows the last image on its topic: the newest stored still, retained (ADR 0027).
      for (const cam of this.cameras()) pub('camera', `camera_${cam}`, { name: CAMERA_NAMES[cam], icon: 'mdi:camera', topic: t.camera(cam) })
    }
    this.publishState()
    this.sentStill.clear()
    void this.publishStills()
  }

  /** Sends each camera's newest stored still when it isn't the one its topic already has. */
  async publishStills(): Promise<void> {
    if (!this.o.stills) return
    for (const cam of this.cameras()) {
      const got = await this.o.stills(cam).catch(() => null)
      if (!got || this.sentStill.get(cam) === got.capture.id) continue
      this.sentStill.set(cam, got.capture.id)
      // mqtt.js takes a string or a Buffer; this wraps the bytes without copying.
      this.o.mqtt.publish(this.topics().camera(cam), Buffer.from(got.bytes.buffer, got.bytes.byteOffset, got.bytes.byteLength), { retain: true })
    }
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
    if (e.kind === 'mutation' && e.path === 'captures') void this.publishStills()
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

const RETRY_MIN_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000

/**
 * `connectBridge`, tried until it works, without holding up the caller: core starts
 * before Wi-Fi, and `connectAsync` rejects and ends its client on a socket error, so
 * one attempt would leave Home Assistant down until a restart. Returns a cancel.
 */
export function keepConnecting(connect: () => Promise<HaBridge | null>, on: { up(b: HaBridge | null): void, failed(e: Error): void }): () => void {
  let cancelled = false
  let delay = RETRY_MIN_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  const attempt = () => {
    connect().then((b) => {
      if (cancelled) b?.stop()
      else on.up(b)
    }).catch((e: Error) => {
      if (cancelled) return
      on.failed(e)
      timer = setTimeout(attempt, delay)
      delay = Math.min(delay * 2, RETRY_MAX_MS)
    })
  }
  attempt()
  return () => {
    cancelled = true
    if (timer) clearTimeout(timer)
  }
}

/** The bridge for this core's lifetime: it keeps connecting, and starts over when settings change. */
export function superviseBridge(connect: () => Promise<HaBridge | null>, events: EventBus) {
  let bridge: HaBridge | null = null
  let error: string | null = null
  const start = () => keepConnecting(connect, {
    up: (b) => {
      bridge = b
      error = null
    },
    failed: (e) => {
      console.warn(`HA bridge: ${e.message}`)
      error = e.message
    },
  })
  let cancel = start()
  const unsubscribe = events.subscribe((e) => {
    if (e.kind === 'mutation' && e.path === 'settings') {
      cancel()
      bridge?.stop()
      bridge = null
      cancel = start()
    }
  })
  return {
    bridge: () => bridge,
    error: () => error,
    stop: () => {
      unsubscribe()
      cancel()
      bridge?.stop()
    },
  }
}

/** Build a real mqtt.js connection from settings; returns null when the bridge is dormant. */
export async function connectBridge(o: Omit<BridgeOptions, 'mqtt'>): Promise<HaBridge | null> {
  const s = o.store.settings.get()
  if (!s.mqttUrl) return null
  const { connectAsync } = await import('./connect')
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
