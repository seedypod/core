import type { Reading, SensorId } from '@/src/hardware/contract'
import { trpc } from '@/src/utils/trpc'
import { belowCutoff, cutoffPct } from './pumpCycles'

/**
 * The tank's reserve under the pump cutoff, for every view that draws the
 * level: the cutoff as a % of the tank (null when unknown, or at empty, where
 * there's no reserve) and whether the water is down in it, so the pump won't start.
 */
export function useTankReserve(readings: Partial<Record<SensorId, Reading>>): { cutoff: number | null, low: boolean } {
  const limits = trpc.system.info.useQuery().data?.system?.limits
  const cfg = trpc.settings.get.useQuery().data
  const pct = cutoffPct(limits?.waterLowCm, cfg?.waterFullCm, cfg?.waterEmptyCm)
  const cutoff = pct === 0 ? null : pct
  const low = cutoff !== null && belowCutoff({ distance: readings.water_distance, levelPct: readings.water_level_pct?.value, waterLowCm: limits?.waterLowCm, fullCm: cfg?.waterFullCm, emptyCm: cfg?.waterEmptyCm })
  return { cutoff, low }
}
