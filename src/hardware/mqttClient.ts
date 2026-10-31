/**
 * MqttHalClient — core's view of a real `hald` over the v1 contract
 * (ADR-0007): retained `system`/`availability`/actuator state topics rebuild
 * the snapshot on connect, sensor topics stream readings, commands go to
 * `actuator/<id>/set`, acknowledgements to `alert/<kind>/ack`, and stills come
 * over HTTP from the daemon's axum server.
 *
 * The MQTT connection is injected behind a tiny interface so tests drive it
 * without a broker; production passes an `mqtt.js` client.
 */
import type { AlertKind, CalibrationCommand } from './contract'
import { ActuatorCommand, ActuatorId, ActuatorState, Alert, ButtonPress, CalibrationCommand as CalibrationCommandSchema, CalibrationResult, DeviceInventory, DeviceResult, Reading, SensorId, SystemInfo, topics } from './contract'
import type { HalClient, HalEvent, HalSnapshot, Unsubscribe } from './types'
import { HalRefused } from './sim'

export interface MqttLike {
  /** True when the client is already connected (mqtt.js `connectAsync` resolves after `connect` fired). */
  readonly connected?: boolean
  publish(topic: string, payload: string, opts?: { retain?: boolean, qos?: 0 | 1 | 2 }): void
  subscribe(topic: string | string[]): void
  on(event: 'message', cb: (topic: string, payload: Uint8Array) => void): void
  on(event: 'connect' | 'close' | 'offline', cb: () => void): void
  end(): void
}

export interface MqttHalClientOptions {
  unitId: string
  mqtt: MqttLike
  /** Base URL of hald's HTTP server for stills, e.g. http://seedypod.local:3001 */
  httpBase: string
  /** How long to wait for the daemon to echo a new actuator state. */
  commandTimeoutMs?: number
  /** How long to wait for a calibration result (EZO commands take ~1–2 s). */
  calibrationTimeoutMs?: number
  /** How long to wait for hald to add/remove a sensor (includes probing it). */
  devicesTimeoutMs?: number
  fetchImpl?: typeof fetch
  now?: () => Date
}

export class MqttHalClient implements HalClient {
  private readonly listeners = new Set<(e: HalEvent) => void>()
  private readonly snap: HalSnapshot = { system: null, online: false, sensors: {}, actuators: {}, alerts: {}, devices: null }
  private readonly pending = new Map<ActuatorId, { resolve: (s: ActuatorState) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> }>()
  private readonly pendingDevices = new Map<string, { resolve: (r: DeviceResult) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> }>()
  private readonly pendingCal = new Map<SensorId, { point: CalibrationCommand['point'], resolve: (r: CalibrationResult) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> }>()
  private readonly u: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(private readonly o: MqttHalClientOptions) {
    this.u = o.unitId
    this.timeoutMs = o.commandTimeoutMs ?? 5000
    this.fetchImpl = o.fetchImpl ?? fetch
    const p = topics.prefix(this.u)
    const subscribe = () => o.mqtt.subscribe([`${p}/availability`, `${p}/system`, `${p}/sensor/+`, `${p}/sensor/+/calibration`, `${p}/actuator/+/state`, `${p}/alert/+`, `${p}/event/button`, `${p}/devices`, `${p}/devices/result`])
    // Re-subscribe on every reconnect, and now if the caller handed us a client that is already connected.
    o.mqtt.on('connect', subscribe)
    if (o.mqtt.connected) subscribe()
    o.mqtt.on('offline', () => this.setOnline(false))
    o.mqtt.on('close', () => this.setOnline(false))
    o.mqtt.on('message', (topic, payload) => this.onMessage(topic, new TextDecoder().decode(payload)))
  }

  snapshot(): HalSnapshot {
    return { ...this.snap, sensors: { ...this.snap.sensors }, actuators: { ...this.snap.actuators }, alerts: { ...this.snap.alerts } }
  }

  setActuator(id: ActuatorId, cmd: ActuatorCommand): Promise<ActuatorState> {
    const parsed = ActuatorCommand.parse(cmd)
    return new Promise((resolve, reject) => {
      const prev = this.pending.get(id)
      if (prev) {
        clearTimeout(prev.timer)
        prev.reject(new Error('superseded by a newer command'))
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`hald did not acknowledge ${id} command within ${this.timeoutMs} ms`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.o.mqtt.publish(topics.actuatorSet(this.u, id), JSON.stringify(parsed), { qos: 1 })
    })
  }

  calibrate(id: SensorId, cmd: CalibrationCommand): Promise<CalibrationResult> {
    const parsed = CalibrationCommandSchema.parse(cmd)
    const timeoutMs = this.o.calibrationTimeoutMs ?? 10_000
    return new Promise((resolve, reject) => {
      const prev = this.pendingCal.get(id)
      if (prev) {
        clearTimeout(prev.timer)
        prev.reject(new Error('superseded by a newer calibration'))
      }
      const timer = setTimeout(() => {
        this.pendingCal.delete(id)
        reject(new Error(`hald did not report ${id} calibration within ${timeoutMs} ms`))
      }, timeoutMs)
      this.pendingCal.set(id, { point: parsed.point, resolve, reject, timer })
      this.o.mqtt.publish(topics.sensorCalibrate(this.u, id), JSON.stringify(parsed), { qos: 1 })
    })
  }

  addSensor(kind: string, addr: number): Promise<DeviceResult> {
    return this.devicesCommand('add', kind, addr)
  }

  removeSensor(kind: string, addr: number): Promise<DeviceResult> {
    return this.devicesCommand('remove', kind, addr)
  }

  private devicesCommand(op: 'add' | 'remove', kind: string, addr: number): Promise<DeviceResult> {
    const requestId = `${op}-${kind}-${addr}-${Math.random().toString(36).slice(2, 8)}`
    const timeoutMs = this.o.devicesTimeoutMs ?? 10_000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDevices.delete(requestId)
        reject(new Error(`hald did not answer the ${op} ${kind} request within ${timeoutMs} ms`))
      }, timeoutMs)
      this.pendingDevices.set(requestId, { resolve, reject, timer })
      this.o.mqtt.publish(topics.devicesSet(this.u), JSON.stringify({ requestId, op, kind, addr }), { qos: 1 })
    })
  }

  async acknowledgeAlert(kind: AlertKind): Promise<void> {
    this.o.mqtt.publish(topics.alertAck(this.u, kind), '{}', { qos: 1 })
  }

  async captureStill(camera: 'upper' | 'lower'): Promise<Uint8Array> {
    const r = await this.fetchImpl(`${this.o.httpBase}/camera/${camera}.jpg`)
    if (!r.ok) throw new Error(`camera ${camera}: HTTP ${r.status}`)
    return new Uint8Array(await r.arrayBuffer())
  }

  subscribe(listener: (event: HalEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async close(): Promise<void> {
    for (const p of [...this.pending.values(), ...this.pendingCal.values(), ...this.pendingDevices.values()]) {
      clearTimeout(p.timer)
      p.reject(new Error('client closed'))
    }
    this.pending.clear()
    this.pendingCal.clear()
    this.pendingDevices.clear()
    this.o.mqtt.end()
    this.listeners.clear()
  }

  /** Exposed for tests. */
  onMessage(topic: string, payload: string): void {
    const rel = topic.startsWith(`${topics.prefix(this.u)}/`) ? topic.slice(topics.prefix(this.u).length + 1) : null
    if (!rel) return
    const parts = rel.split('/')
    try {
      if (rel === 'availability') return this.setOnline(payload.trim() === 'online')
      if (rel === 'system') {
        const system = SystemInfo.parse(JSON.parse(payload))
        this.snap.system = system
        return this.emit({ type: 'system', system })
      }
      if (parts[0] === 'sensor' && parts[1] && parts[2] === 'calibration') {
        const id = SensorId.parse(parts[1])
        const result = CalibrationResult.parse(JSON.parse(payload))
        const p = this.pendingCal.get(id)
        // Retained results from earlier sessions arrive on connect; only a pending request consumes one.
        if (p && result.point === p.point) {
          clearTimeout(p.timer)
          this.pendingCal.delete(id)
          p.resolve(result)
        }
        return
      }
      if (parts[0] === 'sensor' && parts[1] && parts.length === 2) {
        const id = SensorId.parse(parts[1])
        const reading = Reading.parse(JSON.parse(payload))
        this.snap.sensors[id] = reading
        return this.emit({ type: 'sensor', id, reading })
      }
      if (parts[0] === 'actuator' && parts[1] && parts[2] === 'state') {
        const id = ActuatorId.parse(parts[1])
        const state = ActuatorState.parse(JSON.parse(payload))
        this.snap.actuators[id] = state
        const p = this.pending.get(id)
        if (p) {
          clearTimeout(p.timer)
          this.pending.delete(id)
          // A state echo carrying a fault after a start request means the daemon refused.
          if (state.fault && !state.on) p.reject(new HalRefused(state.fault))
          else p.resolve(state)
        }
        return this.emit({ type: 'actuator', id, state })
      }
      if (parts[0] === 'alert' && parts[1] && parts.length === 2) {
        const alert = Alert.parse(JSON.parse(payload))
        this.snap.alerts[alert.kind] = alert
        return this.emit({ type: 'alert', alert })
      }
      if (rel === 'devices') {
        const devices = DeviceInventory.parse(JSON.parse(payload))
        this.snap.devices = devices
        return this.emit({ type: 'devices', devices })
      }
      if (rel === 'devices/result') {
        const result = DeviceResult.parse(JSON.parse(payload))
        const p = this.pendingDevices.get(result.requestId)
        if (p) {
          clearTimeout(p.timer)
          this.pendingDevices.delete(result.requestId)
          p.resolve(result)
        }
        return
      }
      if (rel === 'event/button') {
        const press = ButtonPress.parse(JSON.parse(payload).press)
        return this.emit({ type: 'button', press })
      }
    }
    catch {
      // Malformed payloads are dropped; the contract tests on both sides make this rare.
    }
  }

  private setOnline(online: boolean): void {
    if (this.snap.online === online) return
    this.snap.online = online
    this.emit({ type: 'availability', online })
  }

  private emit(e: HalEvent): void {
    for (const l of this.listeners) l(e)
  }
}
