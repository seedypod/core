/**
 * Air temperature, humidity and the tank on one "Sensors" accessory.
 *
 * The tank is a Battery service named "Tank": BatteryLevel is the tank's
 * percent full, which Home lists in the accessory's details. HomeKit has no
 * tank or level service, and Home's room header names a sensor by its type, so
 * a low flag would read as "Low Battery" (StatusLowBattery) or "Occupancy
 * Detected", never as the tank. StatusLowBattery therefore stays normal, and
 * a low tank is left to the app's alerts and Home Assistant's `water_low`
 * (ADR 0023, amendment 2026-11-09).
 */
import type { Reading, SensorId } from '../../hardware/contract'
import type { HalSnapshot } from '../../hardware/types'
import { type AccessoryDeps, type BuiltAccessory, COMMUNICATION_FAILURE, online, update } from './common'

// Characteristic values; hap-nodejs only exposes these as static members of generated classes.
const NO_FAULT = 0
const GENERAL_FAULT = 1
const BATTERY_NORMAL = 0
const NOT_CHARGEABLE = 2

const clampPct = (v: number) => Math.max(0, Math.min(100, Math.round(v)))

const fault = (r: Reading | undefined) => (r && r.quality === 'good' ? NO_FAULT : GENERAL_FAULT)

export function buildSensors(d: AccessoryDeps): BuiltAccessory {
  const { Characteristic, HapStatusError, Service } = d.hap
  const reading = (snap: HalSnapshot, id: SensorId): Reading => {
    const r = snap.sensors[id]
    if (!r) throw new HapStatusError(COMMUNICATION_FAILURE)
    return r
  }
  const air = new Service.TemperatureSensor('Air temperature', 'air_temp')
  air.getCharacteristic(Characteristic.CurrentTemperature)
    .setProps({ minValue: -40, maxValue: 100 })
    .onGet(() => reading(online(d), 'air_temp').value)
  air.getCharacteristic(Characteristic.StatusFault).onGet(() => fault(online(d).sensors.air_temp))

  const humidity = new Service.HumiditySensor('Humidity', 'humidity')
  humidity.getCharacteristic(Characteristic.CurrentRelativeHumidity).onGet(() => clampPct(reading(online(d), 'humidity').value))
  humidity.getCharacteristic(Characteristic.StatusFault).onGet(() => fault(online(d).sensors.humidity))

  const tank = new Service.Battery('Tank', 'tank')
  tank.addOptionalCharacteristic(Characteristic.ConfiguredName)
  tank.setCharacteristic(Characteristic.ConfiguredName, 'Tank')
  tank.getCharacteristic(Characteristic.BatteryLevel).onGet(() => clampPct(reading(online(d), 'water_level_pct').value))
  // Never low: Home would put "Low Battery" in the room header for an empty tank.
  tank.getCharacteristic(Characteristic.StatusLowBattery).onGet(() => BATTERY_NORMAL)
  tank.getCharacteristic(Characteristic.ChargingState).onGet(() => NOT_CHARGEABLE)

  const unsubscribe = d.events.subscribe((e) => {
    if (e.kind !== 'hal' || e.event.type !== 'sensor') return
    const ev = e.event
    if (ev.id === 'air_temp') {
      update(air, Characteristic.CurrentTemperature, ev.reading.value)
      update(air, Characteristic.StatusFault, fault(ev.reading))
    }
    else if (ev.id === 'humidity') {
      update(humidity, Characteristic.CurrentRelativeHumidity, clampPct(ev.reading.value))
      update(humidity, Characteristic.StatusFault, fault(ev.reading))
    }
    else if (ev.id === 'water_level_pct') {
      update(tank, Characteristic.BatteryLevel, clampPct(ev.reading.value))
    }
  })
  return { services: [air, humidity, tank], stop: unsubscribe }
}
