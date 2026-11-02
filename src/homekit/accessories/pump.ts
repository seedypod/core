/**
 * The pump as a Switch. On starts one bounded run through `pump.runOnce` (the
 * Water page's path); hald clamps it to its max run and refuses it on a dry
 * tank, over-temperature or a latched fault. Off stops the pump. A refusal
 * reads back as off and fails the write, so Home never shows a pump that
 * isn't running.
 */
import type { ActuatorState } from '../../hardware/contract'
import { type AccessoryDeps, type BuiltAccessory, COMMUNICATION_FAILURE, NOT_ALLOWED_IN_CURRENT_STATE, online } from './common'

/** One run from Home, the same default as the Water page and the HA "water now" button. */
export const HOMEKIT_PUMP_RUN_S = 300

export function buildPump(d: AccessoryDeps): BuiltAccessory {
  const { Characteristic, HapStatusError, Service } = d.hap
  const service = new Service.Switch('Pump', 'pump')
  const on = service.getCharacteristic(Characteristic.On)
  const push = (s: ActuatorState) => service.updateCharacteristic(Characteristic.On, s.on)

  on.onGet(() => !!online(d).actuators.pump?.on)
  on.onSet(async (v) => {
    const want = v === true || v === 1
    if (!want) {
      try {
        push(await d.api.pump.stop())
      }
      catch (e) {
        d.log(`homekit: pump stop: ${(e as Error).message}`)
        throw new HapStatusError(COMMUNICATION_FAILURE)
      }
      return
    }
    let state: ActuatorState
    try {
      state = await d.api.pump.runOnce({ durationS: HOMEKIT_PUMP_RUN_S })
    }
    catch (e) {
      d.log(`homekit: pump refused: ${(e as Error).message}`)
      service.updateCharacteristic(Characteristic.On, false)
      throw new HapStatusError(NOT_ALLOWED_IN_CURRENT_STATE)
    }
    push(state)
    if (!state.on) throw new HapStatusError(NOT_ALLOWED_IN_CURRENT_STATE)
  })

  // The run ending (or the guard stopping it) arrives as an actuator event and flips the switch off.
  const unsubscribe = d.events.subscribe((e) => {
    if (e.kind === 'hal' && e.event.type === 'actuator' && e.event.id === 'pump') push(e.event.state)
  })
  return { services: [service], stop: unsubscribe }
}
