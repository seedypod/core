/**
 * The grow light as a Lightbulb (On, Brightness).
 *
 * Writes go through `light.set`, the Light page's path: a change from Home is a
 * manual change, so it holds over Autopilot and the schedule for the light
 * arbiter's hold (30 min, ADR 0020) and then hands back. The tile follows the
 * light's real state from the event bus, so it moves when the hold ends.
 */
import type { ActuatorState } from '../../hardware/contract'
import { type AccessoryDeps, type BuiltAccessory, COMMUNICATION_FAILURE, online } from './common'

const isOn = (s: ActuatorState | undefined) => !!s && s.on && s.level > 0

export function buildLight(d: AccessoryDeps): BuiltAccessory {
  const { Characteristic, HapStatusError, Service } = d.hap
  const service = new Service.Lightbulb('Grow light', 'light')
  const on = service.getCharacteristic(Characteristic.On)
  const brightness = service.getCharacteristic(Characteristic.Brightness)
  // Home keeps a brightness while the light is off; remember the last lit level.
  let lastLevel = 100
  const lit = (s: ActuatorState | undefined) => {
    if (isOn(s)) lastLevel = Math.round((s as ActuatorState).level)
    return lastLevel
  }
  lit(d.hal.snapshot().actuators.light)

  const push = (s: ActuatorState) => {
    service.updateCharacteristic(Characteristic.On, isOn(s))
    service.updateCharacteristic(Characteristic.Brightness, lit(s))
  }

  // Turning the light on with a brightness arrives as two writes in one request.
  // Coalesce them into one `light.set` so the light doesn't flash to its old level first.
  let pending: { on?: boolean, level?: number } = {}
  let flushing: Promise<void> | null = null
  const queue = (patch: { on?: boolean, level?: number }): Promise<void> => {
    pending = { ...pending, ...patch }
    flushing ??= new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      const want = pending
      pending = {}
      flushing = null
      const input = want.on === false ? { on: false } : want.level !== undefined ? { level: want.level } : { on: true }
      try {
        push(await d.api.light.set(input))
      }
      catch (e) {
        d.log(`homekit: light: ${(e as Error).message}`)
        throw new HapStatusError(COMMUNICATION_FAILURE)
      }
    })
    return flushing
  }

  on.onGet(() => isOn(online(d).actuators.light))
  on.onSet(async (v) => {
    const want = v === true || v === 1
    // Home re-sends On with every brightness change; an already-lit light needs no write (or new hold).
    if (want && isOn(d.hal.snapshot().actuators.light) && pending.level === undefined) return
    await queue({ on: want })
  })
  brightness.onGet(() => lit(online(d).actuators.light))
  brightness.onSet(async (v) => {
    await queue({ level: Number(v) })
  })

  const unsubscribe = d.events.subscribe((e) => {
    if (e.kind === 'hal' && e.event.type === 'actuator' && e.event.id === 'light') push(e.event.state)
  })
  return { services: [service], stop: unsubscribe }
}
