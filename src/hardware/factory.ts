import type { EventBus } from '../lib/eventBus'
import { SimHal } from './sim'
import type { HalClient } from './types'

export interface HalFactoryOptions {
  events: EventBus
  /** `mqtt://host:1883` for a real hald; unset ⇒ simulator. */
  mqttUrl?: string
}

/**
 * Picks the hardware backend. With no HAL_MQTT_URL the simulator runs in
 * process, so `pnpm dev` and CI work without a Pi. The MQTT client lands in
 * Phase 3.1 once the contract (ADR-0007) is frozen.
 */
export async function createHal(opts: HalFactoryOptions): Promise<HalClient> {
  const url = opts.mqttUrl ?? process.env.HAL_MQTT_URL
  if (url) {
    throw new Error('MqttHalClient is not implemented yet (Phase 3.1); unset HAL_MQTT_URL to use the simulator')
  }
  const hal = new SimHal({ timeScale: Number(process.env.SIM_TIME_SCALE ?? 1) })
  hal.subscribe(event => opts.events.emit({ kind: 'hal', event }))
  return hal
}
