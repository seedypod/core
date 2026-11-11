/**
 * Watering starting points by growth stage, shared by the Water page and MCP
 * so both offer and name them the same way. They are community guidance from
 * r/Gardyn owners, not Gardyn's: Gardyn doesn't publish a cadence (its Smart
 * Watering adjusts the pump), only its germination mode. The notes and
 * sources are in knowledge/watering/schedules.md; a test checks each preset's
 * section exists there. Minutes are the unit's local time.
 */
import { cite, type Citation } from '../care/knowledge'
import { findPlant, type Category } from '../plants/catalog'
import type { LightSpec } from '../store/types'
import { lightLevelAt } from './scheduler'
import { localTime } from './time'

export const GARDYN_WATERING_GUIDE = 'https://help.mygardyn.com/en/articles/4435265'
const NOTE = 'knowledge/watering/schedules.md'

export type PumpPresetId = 'germination' | 'seedlings' | 'young' | 'mature' | 'fruiting'

export interface PumpPreset {
  id: PumpPresetId
  /** The word in its cycles' ids, `water-<slug>-HHMM`. */
  slug: string
  name: string
  /** When it's for, under the name: "Days 8–13". */
  stage: string
  /** The stage's word in a cycle's name: "Mature · 3× 6 min (14:00)". */
  short: string
  minutes: number[]
  durationS: number
  /** The run lengths owners use at this stage, in seconds. */
  range: { minS: number, maxS: number }
  note: string
  /** Fit the runs to the light window, dropping those outside it. */
  inLight?: boolean
  /** Runs once a week, on the sowing weekday, rather than every day. */
  weekly?: boolean
  /** The day since sowing this stage starts; fruiting's is when fruiting crops leave germination. */
  from: number
  citation: Citation
}

export const PUMP_PRESETS: readonly PumpPreset[] = [
  { id: 'germination', slug: 'germination', name: 'Germination', stage: 'Days 0–7', short: 'Germination', minutes: [480], durationS: 900, range: { minS: 900, maxS: 900 }, note: 'Gardyn’s germination mode: one 15 min cycle on the sowing day and the next a week later, day 7, so it runs once a week on the sowing weekday.', weekly: true, from: 0, citation: cite(NOTE, 'Germination') },
  { id: 'seedlings', slug: 'seedlings', name: 'Seedlings', stage: 'Days 8–13', short: 'Seedlings', minutes: [480], durationS: 600, range: { minS: 300, maxS: 900 }, note: 'Once a day after the second germination cycle, while the first leaves open.', from: 8, citation: cite(NOTE, 'Seedlings') },
  { id: 'young', slug: 'young', name: 'Young plants', stage: 'Days 14–21', short: 'Young', minutes: [480, 960], durationS: 360, range: { minS: 300, maxS: 480 }, note: 'Start once a day for 5 min and move to two or three times as the roots grow.', from: 14, citation: cite(NOTE, 'Young plants') },
  { id: 'mature', slug: 'mature', name: 'Mature greens & herbs', stage: 'Day 22 on', short: 'Mature', minutes: [480, 840, 1200], durationS: 360, range: { minS: 300, maxS: 480 }, note: 'Spread across the light hours.', from: 22, citation: cite(NOTE, 'Mature greens and herbs') },
  { id: 'fruiting', slug: 'fruiting', name: 'Large or fruiting', stage: 'Tomatoes, cucumbers, peppers · from day 8', short: 'Fruiting', minutes: [360, 600, 840, 1080, 1320], durationS: 300, range: { minS: 300, maxS: 300 }, note: 'Every 4 hours while the lights are on.', inLight: true, from: 8, citation: cite(NOTE, 'Large or fruiting plants') },
]

/** What to check whatever the preset, from the same note. */
export const WATERING_TIPS: readonly string[] = [
  'Check the roots: dry, brittle roots want another cycle or a longer one; roots sitting in pooled water just before the next cycle want less.',
  'Space the cycles across the light hours, so pods don’t dry out under the LEDs.',
  'Many growers switch Gardyn’s smart watering off after germination, for a schedule they can predict.',
]
export const TIPS_CITATION = cite(NOTE, 'Judging a schedule')

/** "08:00" for minute 480. */
export const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

/** When the light is on today, from the first lit minute to the last, across the running curves; null if it never is. */
export function lightWindow(specs: readonly LightSpec[]): { on: number, off: number } | null {
  let on: number | null = null
  let off: number | null = null
  for (let m = 0; m < 1440; m++) {
    if (specs.some(s => (lightLevelAt(s, m) ?? 0) > 0)) {
      on ??= m
      off = m + 1
    }
  }
  return on === null || off === null ? null : { on, off }
}

/** A preset's run times, kept inside the light window when it asks to be (and some runs fit). */
export function presetRuns(preset: PumpPreset, light: { on: number, off: number } | null): number[] {
  if (!preset.inLight || !light) return preset.minutes
  const inside = preset.minutes.filter(m => m >= light.on && m < light.off)
  return inside.length ? inside : preset.minutes
}

/** Minutes of watering a day. */
export const dailyMinutes = (runs: number, durationS: number) => runs * Math.round(durationS / 60)

/** The day mask a preset's cycles run on: every day, or a weekly one's `weekday` (0 = Monday). */
export const presetDays = (preset: PumpPreset, weekday: number) => (preset.weekly ? 1 << weekday : 127)

export interface PumpSchedule { id: string, kind: 'pump', name: string, enabled: boolean, days: number, spec: { minute: number, durationS: number } }

/**
 * The pump schedules a preset makes, one per run: `water-mature-1400`,
 * "Mature · 3× 6 min (14:00)" every day; `water-germination-0800`,
 * "Germination · once a week 15 min (08:00)" on `weekday`, the sowing
 * weekday (0 = Monday).
 */
export function presetSchedules(preset: PumpPreset, opts: { enabled: boolean, light?: { on: number, off: number } | null, weekday: number }): PumpSchedule[] {
  const runs = presetRuns(preset, opts.light ?? null)
  const per = `${runs.length === 1 ? (preset.weekly ? 'once a week' : 'once a day') : `${runs.length}×`} ${Math.round(preset.durationS / 60)} min`
  return runs.map(minute => ({
    id: `water-${preset.slug}-${hhmm(minute).replace(':', '')}`,
    kind: 'pump',
    name: `${preset.short} · ${per} (${hhmm(minute)})`,
    enabled: opts.enabled,
    days: presetDays(preset, opts.weekday),
    spec: { minute, durationS: preset.durationS },
  }))
}

/** A moment's date on the unit's calendar; a plain date ("2026-11-09") is that day wherever the unit is. */
function unitDate(d: string, timezone: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : localTime(new Date(d), timezone).date
}

/** The day the tower was sown on the unit's calendar: the grow cycle's start, else the earliest pod planted; null with neither. */
export function sowDate(cycleStart: string | null | undefined, plantedAt: ReadonlyArray<string | null>, timezone: string): string | null {
  const dates = [cycleStart, ...(cycleStart ? [] : plantedAt)].filter((d): d is string => !!d && Number.isFinite(Date.parse(d))).map(d => unitDate(d, timezone))
  return dates.sort()[0] ?? null
}

/** Days since 1970 for a plain date ("2026-11-09"), for counting whole days between two. */
export const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000

/** Whole days since the tower was sown, counted on the unit's calendar: day 0 is the sowing date, day 1 starts at the next local midnight. */
export function daysSinceSowing(cycleStart: string | null | undefined, plantedAt: ReadonlyArray<string | null>, now: Date, timezone: string): number | null {
  const sown = sowDate(cycleStart, plantedAt, timezone)
  return sown === null ? null : Math.max(0, dayNumber(localTime(now, timezone).date) - dayNumber(sown))
}

/** The weekday the tower was sown on (0 = Monday), from the same date daysSinceSowing counts from; today's with no sowing date. */
export function sowWeekday(cycleStart: string | null | undefined, plantedAt: ReadonlyArray<string | null>, timezone: string, now: Date): number {
  const sown = sowDate(cycleStart, plantedAt, timezone)
  return sown === null ? localTime(now, timezone).weekday : (new Date(`${sown}T00:00:00Z`).getUTCDay() + 6) % 7
}

/** The catalog categories of the plants named, skipping names it doesn't know. */
export function plantCategories(plants: ReadonlyArray<string | null>): Category[] {
  return plants.flatMap(p => (p ? findPlant(p)?.category ?? [] : []))
}

/**
 * The preset for this tower and why, by days since sowing and each stage's
 * `from`: germination for days 0–7 whatever is planted (its second run is
 * day 7), then fruiting if any planted plant is a fruiting crop, else
 * seedlings (8–13), young (14–21) or mature (22+); null with no sowing date
 * and no fruiting crop.
 */
export function recommendedPreset(days: number | null, categories: readonly Category[]): { id: PumpPresetId, why: string } | null {
  const fruiting = PUMP_PRESETS.find(p => p.id === 'fruiting') as PumpPreset
  if (categories.includes('fruiting') && (days === null || days >= fruiting.from)) return { id: 'fruiting', why: 'a fruiting crop is planted' }
  if (days === null) return null
  const stage = PUMP_PRESETS.filter(p => p.id !== 'fruiting' && p.from <= days).at(-1) as PumpPreset
  return { id: stage.id, why: `day ${days} since sowing` }
}

/** The stages in order; fruiting is a track of its own after germination. */
const STAGES: readonly PumpPresetId[] = ['germination', 'seedlings', 'young', 'mature']

/**
 * Whether moving the cycles from one preset to another is a step forward:
 * from germination to anything after it, then on through seedlings, young and
 * mature. Never back, never off the fruiting track, and never onto it except
 * from germination, so grown plants are never put on a seedling's watering.
 */
export function advances(from: PumpPresetId, to: PumpPresetId): boolean {
  if (from === 'germination') return to !== 'germination'
  if (from === 'fruiting' || to === 'fruiting') return false
  return STAGES.indexOf(to) > STAGES.indexOf(from)
}

/** The preset the pump cycles are now, if they're exactly one preset's schedules: its times and lengths, each under its id or its name. */
export function appliedPreset(cycles: ReadonlyArray<{ id: string, name?: string, spec: { minute: number, durationS: number } }>, light: { on: number, off: number } | null): PumpPresetId | null {
  for (const p of PUMP_PRESETS) {
    // By id or name, times and length; the days aren't compared, so any weekday does.
    const want = presetSchedules(p, { enabled: true, light, weekday: 0 })
    const same = (c: typeof cycles[number], w: PumpSchedule) => (c.id === w.id || c.name === w.name) && c.spec.minute === w.spec.minute && c.spec.durationS === w.spec.durationS
    if (want.length === cycles.length && want.every(w => cycles.some(c => same(c, w)))) return p.id
  }
  return null
}
