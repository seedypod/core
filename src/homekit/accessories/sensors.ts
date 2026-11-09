/**
 * Air temperature, humidity and the tank on one "Sensors" accessory.
 *
 * The tank is a Battery service: BatteryLevel is the tank's percent full and
 * StatusLowBattery is hald's `water_low` alert. It is the one HomeKit service
 * that carries a 0–100 level with a low flag, and Home shows a low one in its
 * status summary without the critical alarm a Leak sensor raises (ADR 0023).
 * Home keeps a battery level in the accessory's details, so the same alert is
 * also an Occupancy sensor, "Tank low", which gets its own row that reads
 * Detected or Not Detected and can notify.
 */
import type { Reading, SensorId } from '../../hardware/contract'
import type { HalSnapshot } from '../../hardware/types'
import { type AccessoryDeps, type BuiltAccessory, COMMUNICATION_FAILURE, online, update } from './common'

// Characteristic values; hap-nodejs only exposes these as static members of generated classes.
const NO_FAULT = 0
const GENERAL_FAULT = 1
const BATTERY_NORMAL = 0
const BATTERY_LOW = 1
const NOT_CHARGEABLE = 2
const NOT_DETECTED = 0
const DETECTED = 1

const clampPct = (v: number) => Math.max(0, Math.min(100, Math.round(v)))

const fault = (r: Reading | undefined) => (r && r.quality === 'good' ? NO_FAULT : GENERAL_FAULT)
const isLow = (snap: HalSnapshot) => snap.alerts.water_low?.active === true

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

  const tank = new Service.Battery('Water tank', 'tank')
  tank.getCharacteristic(Characteristic.BatteryLevel).onGet(() => clampPct(reading(online(d), 'water_level_pct').value))
  tank.getCharacteristic(Characteristic.StatusLowBattery).onGet(() => (isLow(online(d)) ? BATTERY_LOW : BATTERY_NORMAL))
  tank.getCharacteristic(Characteristic.ChargingState).onGet(() => NOT_CHARGEABLE)

  const tankLow = new Service.OccupancySensor('Tank low', 'tank_low')
  tankLow.getCharacteristic(Characteristic.OccupancyDetected).onGet(() => (isLow(online(d)) ? DETECTED : NOT_DETECTED))

  const unsubscribe = d.events.subscribe((e) => {
    if (e.kind !== 'hal') return
    const ev = e.event
    if (ev.type === 'sensor') {
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
    }
    else if (ev.type === 'alert' && ev.alert.kind === 'water_low') {
      update(tank, Characteristic.StatusLowBattery, ev.alert.active ? BATTERY_LOW : BATTERY_NORMAL)
      update(tankLow, Characteristic.OccupancyDetected, ev.alert.active ? DETECTED : NOT_DETECTED)
    }
  })
  return { services: [air, humidity, tank, tankLow], stop: unsubscribe }
}
