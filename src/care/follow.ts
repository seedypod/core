/**
 * Watering that follows the grow cycle: as the plants age, the pump cycles
 * move to the next growth stage's preset (src/scheduler/pumpPlan.ts), so a
 * tower sown with the seedling schedule is on the young plants' one by week
 * two. It only ever replaces cycles that are exactly a preset; a schedule
 * someone made or edited by hand is left alone, as is the soak after sowing.
 * Off with Settings → followGrowCycle.
 */
import { appliedPreset, daysSinceSowing, lightWindow, plantCategories, presetSchedules, PUMP_PRESETS, recommendedPreset, type PumpPresetId } from '../scheduler/pumpPlan'
import { dayEnabled, localTime } from '../scheduler/time'
import type { LightSpec, PumpSpec, Schedule, Store } from '../store/types'

export const FOLLOW_ALERT = 'watering_followed'

export interface FollowChange {
  from: PumpPresetId | null
  to: PumpPresetId
  days: number
  /** What the notice says: the new cycles and why. */
  detail: string
}

const fmt = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

/** Move the pump cycles to the preset for the plants' age, if they follow a preset and it changed. Writes only on a change. */
export function followGrowCycle(store: Store, now: Date): FollowChange | null {
  const settings = store.settings.get()
  if (!settings.followGrowCycle) return null
  const planted = store.pods.list().filter(p => p.status !== 'empty' && p.plant)
  if (!planted.length) return null
  const days = daysSinceSowing(store.grow.current()?.startedAt, planted.map(p => p.plantedAt), now)
  const rec = recommendedPreset(days, plantCategories(planted.map(p => p.plant)))
  if (!rec || rec.soak || days === null) return null

  const schedules = store.schedules.list()
  const weekday = localTime(now, settings.timezone).weekday
  const lights = schedules.filter((s): s is Schedule & { spec: LightSpec } => s.kind === 'light' && s.enabled && dayEnabled(s.days, weekday))
  const light = lightWindow(lights.map(s => s.spec))
  const cycles = schedules.filter((s): s is Schedule & { spec: PumpSpec } => s.kind === 'pump')
  const from = appliedPreset(cycles, light)
  if (from === rec.id) return null
  // Cycles that aren't a preset were set by hand: leave them be.
  if (cycles.length && from === null) return null

  const preset = PUMP_PRESETS.find(p => p.id === rec.id)
  if (!preset) return null
  const next = presetSchedules(preset, { enabled: true, light })
  for (const s of next) store.schedules.upsert(s)
  for (const c of cycles) if (!next.some(s => s.id === c.id)) store.schedules.remove(c.id)
  const runs = next.map(s => fmt(s.spec.minute)).join(', ')
  const min = Math.round((next[0]?.spec.durationS ?? 0) / 60)
  return { from, to: rec.id, days, detail: `Watering moved to ${preset.name}: ${next.length} × ${min} min (${runs}), day ${days} since sowing. Turn off "Follow the grow cycle" on Water to keep a schedule as it is.` }
}
