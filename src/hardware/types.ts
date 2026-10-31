import type { ActuatorCommand, ActuatorId, ActuatorState, Alert, AlertKind, ButtonPress, CalibrationCommand, CalibrationResult, DeviceInventory, DeviceResult, Reading, SensorId, SystemInfo } from './contract'

export interface HalSnapshot {
  system: SystemInfo | null
  online: boolean
  sensors: Partial<Record<SensorId, Reading>>
  actuators: Partial<Record<ActuatorId, ActuatorState>>
  alerts: Partial<Record<AlertKind, Alert>>
  /** Configured sensor devices and addable kinds; null until hald publishes it. */
  devices: DeviceInventory | null
}

export type HalEvent
  = | { type: 'sensor', id: SensorId, reading: Reading }
    | { type: 'actuator', id: ActuatorId, state: ActuatorState }
    | { type: 'alert', alert: Alert }
    | { type: 'availability', online: boolean }
    | { type: 'system', system: SystemInfo }
    | { type: 'devices', devices: DeviceInventory }
    | { type: 'button', press: ButtonPress }

export type Unsubscribe = () => void

/**
 * The one interface core uses to talk to hardware. Implemented by
 * MqttHalClient (real hald over MQTT/HTTP) and SimHal (in-process fake used
 * by dev, tests and the browser demo).
 */
export interface HalClient {
  snapshot(): HalSnapshot
  setActuator(id: ActuatorId, cmd: ActuatorCommand): Promise<ActuatorState>
  acknowledgeAlert(kind: AlertKind): Promise<void>
  /** Store a probe calibration point; resolves with the daemon's result (ok or the refusal). */
  calibrate(id: SensorId, cmd: CalibrationCommand): Promise<CalibrationResult>
  /** Add a probe of an addable kind at an I²C address; resolves with hald's verdict (ok or the refusal). */
  addSensor(kind: string, addr: number): Promise<DeviceResult>
  /** Remove an app-added probe; sensors from hal.toml are refused. */
  removeSensor(kind: string, addr: number): Promise<DeviceResult>
  captureStill(camera: 'upper' | 'lower'): Promise<Uint8Array>
  subscribe(listener: (event: HalEvent) => void): Unsubscribe
  close(): Promise<void>
}
