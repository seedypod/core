/**
 * SimHal — a deterministic, dependency-free fake Gardyn used by `pnpm dev`
 * without hardware, by unit tests, and by the browser demo (VITE_DEMO=1).
 *
 * It models just enough physics to make the UI honest: the tank drains while
 * the pump runs, humidity rises with the light on, and the same safety rules
 * the Rust HAL enforces (bounded pump runs, dry-run interlock, latched faults)
 * apply here so the demo never shows behaviour the real unit would refuse.
 */
import kindsFixture from '../../hal/contract/fixtures/device_kinds.json'
import { CONTRACT_VERSION, DeviceKindInfo } from './contract'
import type { ActuatorCommand, ActuatorId, ActuatorState, Alert, AlertKind, ButtonPress, CalibrationCommand, CalibrationResult, DeviceEntry, DeviceInventory, DeviceResult, Reading, SensorId, SystemInfo } from './contract'
import type { HalClient, HalEvent, HalSnapshot, Unsubscribe } from './types'

export interface SimHalOptions {
  unitId?: string
  model?: string
  /** Simulated seconds per real tick. */
  timeScale?: number
  /** Tick period in ms; 0 disables the internal timer (tests call tick()). */
  tickMs?: number
  now?: () => Date
  limits?: Partial<SystemInfo['limits']>
}

const DEFAULT_LIMITS: SystemInfo['limits'] = { pumpMaxRunS: 900, pumpMaxDuty: 30, waterLowCm: 16 }

/** What hald can add at runtime: the same descriptors hald publishes (the fixture is checked against hald's `SensorKind`s). */
const ADDABLE = DeviceKindInfo.array().parse(kindsFixture)
const CALIBRATABLE: SensorId[] = ['ph', 'ec', 'water_temp']

/** The stock Gardyn parts behind the default sensor set, as hald reports them. */
const STOCK: DeviceEntry[] = [
  { kind: 'pct2075', label: 'Board temperature (PCT2075)', addr: 0x48, ids: ['pcb_temp'], source: 'config', status: 'ready', detail: '' },
  { kind: 'ina219', label: 'Pump power monitor (INA219)', addr: 0x40, ids: ['pump_v', 'pump_a', 'pump_w'], source: 'config', status: 'ready', detail: '' },
  { kind: 'dht20', label: 'Air temperature & humidity (DHT20)', addr: 0x38, ids: ['humidity', 'air_temp'], source: 'config', status: 'ready', detail: '' },
  { kind: 'dyp_a01', label: 'Water level (ultrasonic)', addr: null, ids: ['water_distance', 'water_level_pct'], source: 'config', status: 'ready', detail: '' },
]

const hex = (a: number) => `0x${a.toString(16).toUpperCase().padStart(2, '0')}`

export class SimHal implements HalClient {
  private readonly listeners = new Set<(e: HalEvent) => void>()
  private readonly now: () => Date
  private readonly timeScale: number
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly limits: SystemInfo['limits']
  private readonly system: SystemInfo

  // physical state
  private waterDistanceCm = 7 // 5 = full, 20 = empty
  private airTempC = 22.5
  private humidityPct = 48
  private pcbTempC = 31
  private lightLevel = 0
  private lightOn = false
  private pumpLevel = 0
  private pumpOn = false
  private pumpRunRemainingS: number | null = null
  private pumpFault: string | null = null
  private lightSince: Date
  private pumpSince: Date
  private readonly alerts = new Map<AlertKind, Alert>()
  private readonly devices: DeviceEntry[] = STOCK.map(d => ({ ...d, ids: [...d.ids] }))
  private readonly calPoints = new Map<SensorId, number>()

  constructor(opts: SimHalOptions = {}) {
    this.now = opts.now ?? (() => new Date())
    this.timeScale = opts.timeScale ?? 1
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits }
    this.lightSince = this.now()
    this.pumpSince = this.now()
    this.system = {
      contract: CONTRACT_VERSION,
      unitId: opts.unitId ?? 'sim-0001',
      model: opts.model ?? 'gardyn 3.0 (sim)',
      halVersion: '0.0.0-sim',
      caps: {
        sensors: ['air_temp', 'humidity', 'pcb_temp', 'water_distance', 'water_level_pct', 'pump_v', 'pump_a', 'pump_w'],
        actuators: ['light', 'pump'],
        cameras: ['upper', 'lower'],
      },
      limits: this.limits,
    }
    const tickMs = opts.tickMs ?? 1000
    if (tickMs > 0) {
      this.timer = setInterval(() => this.tick(this.timeScale), tickMs)
    }
  }

  snapshot(): HalSnapshot {
    const sensors: Partial<Record<SensorId, Reading>> = {}
    for (const id of this.system.caps.sensors) sensors[id] = this.read(id)
    return {
      system: this.system,
      online: true,
      sensors,
      actuators: { light: this.lightState(), pump: this.pumpState() },
      alerts: Object.fromEntries(this.alerts) as Partial<Record<AlertKind, Alert>>,
      devices: this.inventory(),
    }
  }

  async setActuator(id: ActuatorId, cmd: ActuatorCommand): Promise<ActuatorState> {
    if (id === 'light') {
      if (cmd.level !== undefined) this.lightLevel = clamp(cmd.level, 0, 100)
      if (cmd.on !== undefined) this.lightOn = cmd.on
      if (cmd.on === undefined && cmd.level !== undefined) this.lightOn = cmd.level > 0
      this.lightSince = this.now()
      const state = this.lightState()
      this.emit({ type: 'actuator', id, state })
      return state
    }
    if (id === 'pump') {
      if (this.pumpFault && (cmd.on ?? false)) {
        throw new HalRefused(`pump fault latched: ${this.pumpFault}; acknowledge before restarting`)
      }
      const wantOn = cmd.on ?? (cmd.level !== undefined ? cmd.level > 0 : this.pumpOn)
      if (wantOn && this.isDry()) {
        this.raiseAlert('water_low', 'refused pump start: water low')
        throw new HalRefused('refused: water level low (dry-run interlock)')
      }
      if (cmd.level !== undefined) this.pumpLevel = clamp(cmd.level, 0, this.limits.pumpMaxDuty)
      if (wantOn && !this.pumpOn) {
        if (this.pumpLevel === 0) this.pumpLevel = this.limits.pumpMaxDuty
      }
      this.pumpOn = wantOn
      this.pumpRunRemainingS = wantOn ? Math.min(cmd.durationS ?? this.limits.pumpMaxRunS, this.limits.pumpMaxRunS) : null
      this.pumpSince = this.now()
      const state = this.pumpState()
      this.emit({ type: 'actuator', id, state })
      return state
    }
    throw new HalRefused(`unknown actuator: ${id}`)
  }

  /** Mirrors hald + hal-sim: only configured pH/EC/RTD probes calibrate; each point stored counts up to 3, `clear` resets. */
  async calibrate(id: SensorId, cmd: CalibrationCommand): Promise<CalibrationResult> {
    const result = (ok: boolean, detail = ''): CalibrationResult =>
      ({ ts: this.now().toISOString(), point: cmd.point, ok, points: ok ? (this.calPoints.get(id) ?? 0) : null, detail })
    if (!this.system.caps.sensors.includes(id)) return result(false, `no ${id} sensor configured`)
    if (!CALIBRATABLE.includes(id)) return result(false, `${id} does not support calibration`)
    if (cmd.point !== 'dry' && cmd.point !== 'clear' && cmd.value === undefined) return result(false, `${cmd.point} calibration needs a reference value`)
    this.calPoints.set(id, cmd.point === 'clear' ? 0 : Math.min((this.calPoints.get(id) ?? 0) + 1, 3))
    return result(true)
  }

  /** Same rules and messages as hald's `devices/set`. */
  async addSensor(kind: string, addr: number): Promise<DeviceResult> {
    const requestId = `add-${kind}-${addr}`
    const refuse = (detail: string): DeviceResult => ({ requestId, ok: false, detail })
    const spec = ADDABLE.find(k => k.kind === kind)
    if (!spec) return refuse(`${kind} can't be added from the app`)
    if (addr < 0x08 || addr > 0x77) return refuse(`address ${hex(addr)} is outside 0x08–0x77`)
    const used = this.devices.find(d => d.addr === addr)
    if (used) return refuse(`${hex(addr)} is already used by ${used.label}`)
    const dup = spec.ids.find(id => this.system.caps.sensors.includes(id) || this.devices.some(d => d.ids.includes(id)))
    if (dup) return refuse(`a ${dup} sensor is already installed`)
    this.devices.push({ kind, label: spec.label, addr, ids: [...spec.ids], source: 'user', status: 'ready', detail: '' })
    this.system.caps.sensors.push(...spec.ids)
    this.publishCaps()
    for (const id of spec.ids) this.emit({ type: 'sensor', id, reading: this.read(id) })
    return { requestId, ok: true, detail: '' }
  }

  async removeSensor(kind: string, addr: number): Promise<DeviceResult> {
    const requestId = `remove-${kind}-${addr}`
    const entry = this.devices.find(d => d.kind === kind && d.addr === addr)
    if (!entry) return { requestId, ok: false, detail: `no ${kind} sensor at ${hex(addr)}` }
    if (entry.source === 'config') return { requestId, ok: false, detail: 'built-in sensors come from hal.toml and can\'t be removed from the app' }
    this.devices.splice(this.devices.indexOf(entry), 1)
    this.system.caps.sensors = this.system.caps.sensors.filter(id => !entry.ids.includes(id))
    for (const id of entry.ids) this.calPoints.delete(id)
    this.publishCaps()
    return { requestId, ok: true, detail: '' }
  }

  private inventory(): DeviceInventory {
    return { sensors: this.devices.map(d => ({ ...d, ids: [...d.ids] })), addable: ADDABLE }
  }

  private publishCaps(): void {
    this.emit({ type: 'system', system: { ...this.system, caps: { ...this.system.caps, sensors: [...this.system.caps.sensors] } } })
    this.emit({ type: 'devices', devices: this.inventory() })
  }

  async acknowledgeAlert(kind: AlertKind): Promise<void> {
    if (kind === 'pump_fault') this.pumpFault = null
    const a = this.alerts.get(kind)
    if (a) {
      const cleared = { ...a, active: false, ts: this.now().toISOString() }
      this.alerts.set(kind, cleared)
      this.emit({ type: 'alert', alert: cleared })
    }
    this.emit({ type: 'actuator', id: 'pump', state: this.pumpState() })
  }

  async captureStill(camera: 'upper' | 'lower'): Promise<Uint8Array> {
    // 1x1 JPEG placeholder; the demo UI renders a generated SVG instead.
    void camera
    return new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9])
  }

  subscribe(listener: (event: HalEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.listeners.clear()
  }

  /** Test hooks. */
  refill(): void {
    this.waterDistanceCm = 5
    this.clearAlert('water_low')
    this.emit({ type: 'sensor', id: 'water_distance', reading: this.read('water_distance') })
  }

  pressButton(press: ButtonPress): void {
    this.emit({ type: 'button', press })
  }

  /** Advance the simulation by `seconds`. */
  tick(seconds: number): void {
    const dt = seconds
    if (this.pumpOn) {
      // ~0.4 L/min at full duty against a ~19 L tank mapped to 15 cm of travel
      this.waterDistanceCm = Math.min(20, this.waterDistanceCm + (this.pumpLevel / 100) * 0.0053 * dt)
      if (this.isDry()) {
        // Dry-run is a latched fault: off until a human acknowledges (ADR-0009).
        this.pumpFault = 'dry-run'
        this.stopPump(this.pumpFault)
        this.raiseAlert('pump_fault', 'pump stopped: tank ran dry')
        this.raiseAlert('water_low', 'tank low')
      }
      else if (this.pumpRunRemainingS !== null) {
        // Every run is bounded (the HAL clamps durationS to pumpMaxRunS), so a
        // run ending here is clean, not a fault.
        this.pumpRunRemainingS = Math.max(0, this.pumpRunRemainingS - dt)
        if (this.pumpRunRemainingS === 0) this.stopPump('run complete')
      }
    }
    const target = this.lightOn ? 24.5 + this.lightLevel * 0.02 : 21.5
    this.airTempC += (target - this.airTempC) * Math.min(1, dt / 1800)
    this.humidityPct += ((this.lightOn ? 55 : 46) - this.humidityPct) * Math.min(1, dt / 2400)
    this.pcbTempC += ((this.lightOn ? 33 + this.lightLevel * 0.03 : 29) - this.pcbTempC) * Math.min(1, dt / 900)
    if (this.isDry() && !this.alerts.get('water_low')?.active) this.raiseAlert('water_low', 'tank low')
    for (const id of this.system.caps.sensors) this.emit({ type: 'sensor', id, reading: this.read(id) })
  }

  private stopPump(reason: string): void {
    void reason
    this.pumpOn = false
    this.pumpRunRemainingS = null
    this.pumpSince = this.now()
    this.emit({ type: 'actuator', id: 'pump', state: this.pumpState() })
  }

  private isDry(): boolean {
    return this.limits.waterLowCm !== null && this.waterDistanceCm >= this.limits.waterLowCm
  }

  private raiseAlert(kind: AlertKind, detail: string): void {
    const alert: Alert = { kind, active: true, ts: this.now().toISOString(), detail }
    this.alerts.set(kind, alert)
    this.emit({ type: 'alert', alert })
  }

  private clearAlert(kind: AlertKind): void {
    const a = this.alerts.get(kind)
    if (a?.active) {
      const cleared = { ...a, active: false, ts: this.now().toISOString() }
      this.alerts.set(kind, cleared)
      this.emit({ type: 'alert', alert: cleared })
    }
  }

  private lightState(): ActuatorState {
    return { on: this.lightOn, level: this.lightLevel, since: this.lightSince.toISOString(), fault: null, remainingS: null }
  }

  private pumpState(): ActuatorState {
    return {
      on: this.pumpOn,
      level: this.pumpLevel,
      since: this.pumpSince.toISOString(),
      fault: this.pumpFault,
      remainingS: this.pumpRunRemainingS === null ? null : Math.round(this.pumpRunRemainingS),
    }
  }

  private read(id: SensorId): Reading {
    const ts = this.now().toISOString()
    const pumpW = this.pumpOn ? 1.2 + (this.pumpLevel / 100) * 4.8 : 0
    const table: Record<string, [number, string]> = {
      air_temp: [round(this.airTempC, 1), '°C'],
      humidity: [round(this.humidityPct, 0), '%'],
      pcb_temp: [round(this.pcbTempC, 1), '°C'],
      water_distance: [round(this.waterDistanceCm, 1), 'cm'],
      water_level_pct: [round(clamp(((20 - this.waterDistanceCm) / 15) * 100, 0, 100), 0), '%'],
      pump_v: [this.pumpOn ? 12.1 : 12.3, 'V'],
      pump_a: [round(pumpW / 12.1, 2), 'A'],
      pump_w: [round(pumpW, 1), 'W'],
      ph: [6.1, 'pH'],
      ec: [1.4, 'mS/cm'],
      water_temp: [round(this.airTempC - 1, 1), '°C'],
    }
    const [value, unit] = table[id] ?? [0, '']
    return { ts, value, unit, quality: 'good' }
  }

  private emit(e: HalEvent): void {
    for (const l of this.listeners) l(e)
  }
}

export class HalRefused extends Error {
  readonly name = 'HalRefused'
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function round(n: number, d: number): number {
  const f = 10 ** d
  return Math.round(n * f) / f
}
