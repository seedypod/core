/**
 * Watering that follows the grow cycle: as the plants age, the pump cycles
 * move to the next growth stage's preset (src/scheduler/pumpPlan.ts), so a
 * tower sown on germination's weekly cycle is on the seedlings' daily one on
 * day 8, after germination's day-7 run. It only moves forward (see
 * `advances`): a new grow cycle over grown plants leaves their cycles be. It
 * only ever replaces cycles that are still exactly as a preset wrote them —
 * all on, on the preset's days, the preset's length — and never creates
 * cycles where there are none: a schedule someone set, paused, trimmed or
 * deleted is theirs. While it's on, germination's weekly run keeps to the
 * sowing weekday. Off with Settings → followGrowCycle.
 */
import { daysLabel } from '../lib/days'
import { advances, daysSinceSowing, lightWindow, plantCategories, presetDays, presetSchedules, PUMP_PRESETS, recommendedPreset, sowWeekday, type PumpPreset, type PumpPresetId } from '../scheduler/pumpPlan'
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

/** A weekly preset's cycles run on one day; which one is the sowing day's, and isn't checked, so a later grow-cycle start doesn't strand them. */
const oneDay = (days: number) => days > 0 && (days & (days - 1)) === 0

/**
 * The preset these cycles are, by the ids the preset gave them, if every one
 * is still on, runs on the preset's days (every day, or one day a week for
 * germination) and keeps the preset's length. By id rather than by run times,
 * so a preset clipped to the light hours (fruiting) is still recognised after
 * the light schedule changes.
 */
export function followedPreset(cycles: ReadonlyArray<Schedule & { spec: PumpSpec }>): PumpPreset | null {
  if (!cycles.length) return null
  const preset = PUMP_PRESETS.find(p => cycles.every(c => c.id.startsWith(`water-${p.slug}-`)))
  if (!preset) return null
  const days = (d: number) => (preset.weekly ? oneDay(d) : d === EVERY_DAY)
  return cycles.every(c => c.enabled && days(c.days) && c.spec.durationS === preset.durationS) ? preset : null
}

/**
 * Move the pump cycles on to the preset for the plants' age, if they follow a
 * preset and that's a step forward; keep germination's run on the sowing
 * weekday. Writes only on a change.
 */
export function followGrowCycle(store: Store, now: Date): FollowChange | null {
  const settings = store.settings.get()
  if (!settings.followGrowCycle) return null
  // Planted as the Water page and pump_presets count it, so all three agree.
  const planted = store.pods.list().filter(p => p.status !== 'empty')
  if (!planted.length) return null
  const started = store.grow.current()?.startedAt
  const days = daysSinceSowing(started, planted.map(p => p.plantedAt), now, settings.timezone)
  if (days === null) return null
  const rec = recommendedPreset(days, plantCategories(planted.map(p => p.plant)))
  if (!rec) return null

  const schedules = store.schedules.list()
  const cycles = schedules.filter((s): s is Schedule & { spec: PumpSpec } => s.kind === 'pump')
  const current = followedPreset(cycles)
  // No cycles, or cycles that aren't a preset as written: leave them be.
  if (!current) return null
  const sowDay = sowWeekday(started, planted.map(p => p.plantedAt), settings.timezone, now)
  if (current.id === 'germination' && rec.id === 'germination') {
    // A grow cycle (re)started on another day: the weekly run moves to its weekday.
    const want = presetDays(current, sowDay)
    if (cycles.every(c => c.days === want)) return null
    for (const c of cycles) store.schedules.upsert({ ...c, days: want })
    return { from: 'germination', to: 'germination', days, detail: `Germination's weekly run moved to ${daysLabel(want)}, the sowing weekday: day ${days} since sowing. Turn off "Follow the grow cycle" on Water to keep a schedule as it is.` }
  }
  // Only ever forward: grown plants never go back to a seedling's watering.
  if (!advances(current.id, rec.id)) return null
  const preset = PUMP_PRESETS.find(p => p.id === rec.id)
  if (!preset) return null

  const weekday = localTime(now, settings.timezone).weekday
  const lights = schedules.filter((s): s is Schedule & { spec: LightSpec } => s.kind === 'light' && s.enabled && dayEnabled(s.days, weekday))
  const next = presetSchedules(preset, { enabled: true, light: lightWindow(lights.map(s => s.spec)), weekday: sowDay })
  for (const s of next) store.schedules.upsert(s)
  for (const c of cycles) if (!next.some(s => s.id === c.id)) store.schedules.remove(c.id)
  const runs = next.map(s => fmt(s.spec.minute)).join(', ')
  const min = Math.round((next[0]?.spec.durationS ?? 0) / 60)
  const when = preset.weekly ? `, ${daysLabel(next[0]?.days ?? 0)} each week` : ''
  return { from: current.id, to: rec.id, days, detail: `Watering moved to ${preset.name}: ${next.length} × ${min} min (${runs}${when}), day ${days} since sowing. Turn off "Follow the grow cycle" on Water to keep a schedule as it is.` }
}
