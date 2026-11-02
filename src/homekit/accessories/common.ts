import type * as HapNodeJs from 'hap-nodejs'
import type { Characteristic, HAPStatus, Service, WithUUID } from 'hap-nodejs'
import type { ActuatorState } from '../../hardware/contract'
import type { HalClient, HalSnapshot } from '../../hardware/types'
import type { EventBus } from '../../lib/eventBus'

// hap-nodejs declares HAPStatus as a `const enum`, which isolatedModules can't read.
export const COMMUNICATION_FAILURE = -70402 as HAPStatus
export const NOT_ALLOWED_IN_CURRENT_STATE = -70412 as HAPStatus

/**
 * The slice of core's tRPC caller the accessories write through, so every
 * HomeKit command takes the same path (and safety checks) as the app.
 */
export interface HomeKitApi {
  light: { set(input: { on?: boolean, level?: number }): Promise<ActuatorState> }
  pump: {
    runOnce(input: { durationS: number }): Promise<ActuatorState>
    stop(): Promise<ActuatorState>
  }
}

/**
 * hap-nodejs, handed in rather than imported: the server bundle hoists static
 * imports of external packages, which would load it even with HomeKit off.
 */
export type Hap = typeof HapNodeJs

export interface AccessoryDeps {
  hap: Hap
  api: HomeKitApi
  hal: Pick<HalClient, 'snapshot'>
  events: EventBus
  log: (msg: string) => void
}

export interface BuiltAccessory {
  services: Service[]
  stop(): void
}

/** Sets a value only when it changed: hald repeats readings every few seconds and each push is a HAP event. */
export function update(service: Service, char: WithUUID<new () => Characteristic>, value: number | boolean): void {
  const c = service.getCharacteristic(char)
  if (c.value !== value) c.updateValue(value)
}

/** The HAL snapshot, or HomeKit's "No Response" when hald is offline: a stale value would look live. */
export function online(d: Pick<AccessoryDeps, 'hap' | 'hal'>): HalSnapshot {
  const snap = d.hal.snapshot()
  if (!snap.online) throw new d.hap.HapStatusError(COMMUNICATION_FAILURE)
  return snap
}
