/**
 * The watering moves the grow protocol makes (src/care/protocol.ts,
 * ADR-0030): recognising pump cycles that are still exactly as a preset
 * wrote them — all on, on the preset's days, the preset's length — moving
 * them to another preset, and keeping germination's weekly run on the sowing
 * weekday. A schedule someone set, paused, trimmed or deleted is theirs, and
 * nothing here touches it.
 */
import { daysLabel } from '../lib/days'
import { daysSinceSowing, hhmm, lightWindow, presetDays, presetSchedules, PUMP_PRESETS, sowWeekday, type PumpPreset, type PumpPresetId } from '../scheduler/pumpPlan'
import { dayEnabled, localTime } from '../scheduler/time'
import type { LightSpec, PumpSpec, Schedule, Store } from '../store/types'

export const FOLLOW_ALERT = 'watering_followed'

export interface FollowChange {
  from: PumpPresetId
  /** The preset the cycles moved to; null when a queued switch put one of Your schedules on instead. */
  to: PumpPresetId | null
  /** The schedule a queued switch put on. */
  schedule?: { id: string, name: string }
  days: number
  /** What the notice says: the new cycles and why. */
  detail: string
}

const EVERY_DAY = 127

/** The pump cycles among the schedules. */
export const pumpCycles = (schedules: readonly Schedule[]) => schedules.filter((s): s is Schedule & { spec: PumpSpec } => s.kind === 'pump')

/** A weekly preset's cycles run on one day; which one is the sowing day's, and isn't checked, so a later grow-cycle start doesn't strand them. */
const oneDay = (days: number) => days > 0 && (days & (days - 1)) === 0

/**
 * The preset these cycles are, by the ids the preset gave them, if every one
 * is still on, runs on the preset's days (every day, or one day a week for
 * germination) and keeps the preset's length. By id rather than by run times,
 * so a preset clipped to the light hours (fruiting) is still recognised after
 * the light schedule changes.
 */
export function followedPreset(cycles: ReadonlyArray<Pick<Schedule, 'id' | 'enabled' | 'days'> & { spec: Pick<PumpSpec, 'durationS' | 'minute'> }>): PumpPreset | null {
  if (!cycles.length) return null
  const preset = PUMP_PRESETS.find(p => cycles.every(c => c.id.startsWith(`water-${p.slug}-`)))
  if (!preset) return null
  const days = (d: number) => (preset.weekly ? oneDay(d) : d === EVERY_DAY)
  // Still at the time its id was written for (`water-young-1600` at 16:00): a run moved by hand is the person's.
  const atItsTime = (c: typeof cycles[number]) => c.id.endsWith(`-${hhmm(c.spec.minute).replace(':', '')}`)
  return cycles.every(c => c.enabled && days(c.days) && c.spec.durationS === preset.durationS && atItsTime(c)) ? preset : null
}

/** Today's light window, from the curves running today, for fitting a preset's runs to it. */
export function todaysLight(schedules: readonly Schedule[], now: Date, timezone: string): { on: number, off: number } | null {
  const weekday = localTime(now, timezone).weekday
  const lights = schedules.filter((s): s is Schedule & { spec: LightSpec } => s.kind === 'light' && s.enabled && dayEnabled(s.days, weekday))
  return lightWindow(lights.map(s => s.spec))
}

/** Keep germination's weekly run on the sowing weekday; null when it already runs then. Writes only on a change. */
export function keepSowingWeekday(store: Store, cycles: ReadonlyArray<Schedule & { spec: PumpSpec }>, sowDay: number, days: number): FollowChange | null {
  const want = presetDays(PUMP_PRESETS[0] as PumpPreset, sowDay)
  if (cycles.every(c => c.days === want)) return null
  for (const c of cycles) store.schedules.upsert({ ...c, days: want })
  return { from: 'germination', to: 'germination', days, detail: `Germination's weekly run moved to ${daysLabel(want)}, the sowing weekday: day ${days} since sowing. Turn off "Follow the grow cycle" on Water to keep a schedule as it is.` }
}

/**
 * After the open grow cycle's start moves: if the pump cycles are the
 * germination preset as written, its weekly run moves to the new sowing
 * weekday, read from the cycle's start alone, so it holds with no pods
 * planted yet. Nothing while Follow is off.
 */
export function redateGermination(store: Store, now: Date): FollowChange | null {
  const settings = store.settings.get()
  const cycle = store.grow.current()
  if (!settings.followGrowCycle || !cycle) return null
  const cycles = pumpCycles(store.schedules.list())
  if (followedPreset(cycles)?.id !== 'germination') return null
  return keepSowingWeekday(store, cycles, sowWeekday(cycle.startedAt, [], settings.timezone, now), daysSinceSowing(cycle.startedAt, [], now, settings.timezone) ?? 0)
}

/** Replace the pump cycles with `preset`'s, fitted to today's light, and say what changed. */
export function moveWatering(store: Store, o: { cycles: ReadonlyArray<Schedule & { spec: PumpSpec }>, from: PumpPresetId, to: PumpPreset, days: number, sowDay: number, light: { on: number, off: number } | null }): FollowChange {
  const preset = o.to
  const next = presetSchedules(preset, { enabled: true, light: o.light, weekday: o.sowDay })
  for (const s of next) store.schedules.upsert(s)
  for (const c of o.cycles) if (!next.some(s => s.id === c.id)) store.schedules.remove(c.id)
  const runs = next.map(s => hhmm(s.spec.minute)).join(', ')
  const min = Math.round((next[0]?.spec.durationS ?? 0) / 60)
  const when = preset.weekly ? `, ${daysLabel(next[0]?.days ?? 0)}` : ''
  return { from: o.from, to: preset.id, days: o.days, detail: `Watering moved to ${preset.name}: ${next.length} × ${min} min (${runs}${when}), day ${o.days} since sowing. Turn off "Follow the grow cycle" on Water to keep a schedule as it is.` }
}
