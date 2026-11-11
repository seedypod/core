/**
 * Watering that follows the grow cycle: as the plants age, the pump cycles
 * move to the next growth stage's preset (src/scheduler/pumpPlan.ts), so a
 * tower sown with the seedling schedule is on the young plants' one by week
 * two. It only ever replaces cycles that are still exactly as a preset wrote
 * them — all on, every day, the preset's length — and never creates cycles
 * where there are none: a schedule someone set, paused, trimmed or deleted is
 * theirs. It does nothing during the soak after sowing. Off with Settings →
 * followGrowCycle.
 */
import { daysSinceSowing, lightWindow, plantCategories, presetSchedules, PUMP_PRESETS, recommendedPreset, SOAK_DAYS, type PumpPreset, type PumpPresetId } from '../scheduler/pumpPlan'
import { dayEnabled, localTime } from '../scheduler/time'
import type { LightSpec, PumpSpec, Schedule, Store } from '../store/types'

export const FOLLOW_ALERT = 'watering_followed'

export interface FollowChange {
  from: PumpPresetId
  to: PumpPresetId
  days: number
  /** What the notice says: the new cycles and why. */
  detail: string
}

const EVERY_DAY = 127
const fmt = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

/**
 * The preset these cycles are, by the ids the preset gave them, if every one
 * is still on, runs every day and keeps the preset's length. By id rather than
 * by run times, so a preset clipped to the light hours (fruiting) is still
 * recognised after the light schedule changes.
 */
export function followedPreset(cycles: ReadonlyArray<Schedule & { spec: PumpSpec }>): PumpPreset | null {
  if (!cycles.length) return null
  const preset = PUMP_PRESETS.find(p => cycles.every(c => c.id.startsWith(`water-${p.slug}-`)))
  if (!preset) return null
  return cycles.every(c => c.enabled && c.days === EVERY_DAY && c.spec.durationS === preset.durationS) ? preset : null
}

/** Move the pump cycles to the preset for the plants' age, if they follow a preset and it changed. Writes only on a change. */
export function followGrowCycle(store: Store, now: Date): FollowChange | null {
  const settings = store.settings.get()
  if (!settings.followGrowCycle) return null
  // Planted as the Water page and pump_presets count it, so all three agree.
  const planted = store.pods.list().filter(p => p.status !== 'empty')
  if (!planted.length) return null
  const days = daysSinceSowing(store.grow.current()?.startedAt, planted.map(p => p.plantedAt), now)
  // The soak holds for every crop, fruiting ones too.
  if (days === null || days <= SOAK_DAYS) return null
  const rec = recommendedPreset(days, plantCategories(planted.map(p => p.plant)))
  if (!rec) return null

  const schedules = store.schedules.list()
  const cycles = schedules.filter((s): s is Schedule & { spec: PumpSpec } => s.kind === 'pump')
  const current = followedPreset(cycles)
  // No cycles, or cycles that aren't a preset as written: leave them be.
  if (!current || current.id === rec.id) return null
  const preset = PUMP_PRESETS.find(p => p.id === rec.id)
  if (!preset) return null

  const weekday = localTime(now, settings.timezone).weekday
  const lights = schedules.filter((s): s is Schedule & { spec: LightSpec } => s.kind === 'light' && s.enabled && dayEnabled(s.days, weekday))
  const next = presetSchedules(preset, { enabled: true, light: lightWindow(lights.map(s => s.spec)) })
  for (const s of next) store.schedules.upsert(s)
  for (const c of cycles) if (!next.some(s => s.id === c.id)) store.schedules.remove(c.id)
  const runs = next.map(s => fmt(s.spec.minute)).join(', ')
  const min = Math.round((next[0]?.spec.durationS ?? 0) / 60)
  return { from: current.id, to: rec.id, days, detail: `Watering moved to ${preset.name}: ${next.length} × ${min} min (${runs}), day ${days} since sowing. Turn off "Follow the grow cycle" on Water to keep a schedule as it is.` }
}
