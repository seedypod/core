/**
 * SimHal — a deterministic, dependency-free fake Gardyn used by `pnpm dev`
 * without hardware, by unit tests, and by the browser demo (VITE_DEMO=1).
 *
 * It models just enough physics to make the UI honest: the tank drains while
 * the pump runs, humidity rises with the light on, and the same safety rules
 * the Rust HAL enforces (bounded pump runs, dry-run interlock, latched faults)
 * apply here so the demo never shows behaviour the real unit would refuse.
 */
import { CONTRACT_VERSION } from './contract'
import type { ActuatorCommand, ActuatorId, ActuatorState, Alert, AlertKind, Reading, SensorId, SystemInfo } from './contract'
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

  pressButton(press: 'single' | 'double' | 'long'): void {
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
