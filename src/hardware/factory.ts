import type { EventBus } from '../lib/eventBus'
import { MqttHalClient } from './mqttClient'
import { SimHal } from './sim'
import type { HalClient } from './types'

export interface HalFactoryOptions {
  events: EventBus
  /** `mqtt://host:1883` for a real hald; unset ⇒ simulator. */
  mqttUrl?: string
  unitId?: string
  httpBase?: string
}

/**
 * Picks the hardware backend. With no HAL_MQTT_URL the simulator runs in
 * process, so `pnpm dev` and CI work without a Pi. With it, core connects to
 * the daemon over MQTT (and to its HTTP server for stills).
 */
export async function createHal(opts: HalFactoryOptions): Promise<HalClient> {
  const url = opts.mqttUrl ?? process.env.HAL_MQTT_URL
  if (!url) {
    return new SimHal({ timeScale: Number(process.env.SIM_TIME_SCALE ?? 1) })
  }
  const unitId = opts.unitId ?? process.env.HAL_UNIT_ID
  if (!unitId) throw new Error('HAL_UNIT_ID is required with HAL_MQTT_URL (the daemon prints it at startup / `hald --check`)')
  const httpBase = opts.httpBase ?? process.env.HAL_HTTP_URL ?? 'http://127.0.0.1:3001'
  const { connectAsync } = await import('mqtt')
  const mqtt = await connectAsync(url, {
    username: process.env.HAL_MQTT_USERNAME,
    password: process.env.HAL_MQTT_PASSWORD,
    reconnectPeriod: 5000,
    keepalive: 30,
    clientId: `seedypod-core-${Math.random().toString(36).slice(2, 8)}`,
  })
  return new MqttHalClient({ unitId, mqtt, httpBase })
}
