import { replaceEqualDeep } from '@tanstack/react-query'
import type { Reading, SensorId } from '@/src/hardware/contract'

type Readings = Partial<Record<SensorId, Reading>>

/** Whether `r` was taken before `than`. By instant, since `ts` can carry an offset. */
export const isOlder = (r: Reading, than: Reading | undefined) => !!than && Date.parse(r.ts) < Date.parse(than.ts)

/**
 * `next` with any reading `prev` holds a newer one of kept, whichever arrived
 * last. `next` decides which sensors there are, so a removed one goes.
 */
export function newestReadings(prev: unknown, next: unknown): unknown {
  const held = (prev ?? {}) as Readings
  const merged = Object.fromEntries(Object.entries(next as Readings).map(([id, r]) => {
    const old = held[id as SensorId]
    return [id, old && isOlder(r, old) ? old : r]
  }))
  return replaceEqualDeep(prev, merged)
}
