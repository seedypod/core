/**
 * Watering starting points by growth stage, shared by the Water page and MCP
 * so both offer and name them the same way. They are community guidance from
 * r/Gardyn owners, not Gardyn's: Gardyn doesn't publish a cadence (its Smart
 * Watering adjusts the pump), only its first-watering soak. The notes and
 * sources are in knowledge/watering/schedules.md; a test checks each preset's
 * section exists there. Minutes are the unit's local time.
 */
import { cite, type Citation } from '../care/knowledge'
import { findPlant, type Category } from '../plants/catalog'
import type { LightSpec } from '../store/types'
import { lightLevelAt } from './scheduler'

export const GARDYN_WATERING_GUIDE = 'https://help.mygardyn.com/en/articles/4435265'
const NOTE = 'knowledge/watering/schedules.md'

export type PumpPresetId = 'seedlings' | 'young' | 'mature' | 'fruiting'

export interface PumpPreset {
  id: PumpPresetId
  /** The word in its cycles' ids, `water-<slug>-HHMM`. */
  slug: string
  name: string
  /** The stage's word in a cycle's name: "Mature · 3× 6 min (14:00)". */
  short: string
  minutes: number[]
  durationS: number
  /** The run lengths owners use at this stage, in seconds. */
  range: { minS: number, maxS: number }
  note: string
  /** Fit the runs to the light window, dropping those outside it. */
  inLight?: boolean
  citation: Citation
}

export const PUMP_PRESETS: readonly PumpPreset[] = [
  { id: 'seedlings', slug: 'seedlings', name: 'Seedlings · week 1', short: 'Seedlings', minutes: [480], durationS: 600, range: { minS: 300, maxS: 900 }, note: 'Germination mode is a 15 min cycle on day 1, then another around day 7; after the soak, once a day.', citation: cite(NOTE, 'Seedlings') },
  { id: 'young', slug: 'young', name: 'Young plants · weeks 2–3', short: 'Young', minutes: [480, 960], durationS: 360, range: { minS: 300, maxS: 480 }, note: 'Start once a day for 5 min and move to two or three times as the roots grow.', citation: cite(NOTE, 'Young plants') },
  { id: 'mature', slug: 'mature', name: 'Mature greens & herbs · 3+ weeks', short: 'Mature', minutes: [480, 840, 1200], durationS: 360, range: { minS: 300, maxS: 480 }, note: 'Spread across the light hours.', citation: cite(NOTE, 'Mature greens and herbs') },
  { id: 'fruiting', slug: 'fruiting', name: 'Large or fruiting (tomatoes, cucumbers, peppers)', short: 'Fruiting', minutes: [360, 600, 840, 1080, 1320], durationS: 300, range: { minS: 300, maxS: 300 }, note: 'Every 4 hours while the lights are on.', inLight: true, citation: cite(NOTE, 'Large or fruiting plants') },
]

/** What to check whatever the preset, from the same note. */
export const WATERING_TIPS: readonly string[] = [
  'Check the roots: dry, brittle roots want another cycle or a longer one; roots sitting in pooled water just before the next cycle want less.',
  'Space the cycles across the light hours, so pods don’t dry out under the LEDs.',
  'Many growers switch Gardyn’s smart watering off after germination, for a schedule they can predict.',
]
export const TIPS_CITATION = cite(NOTE, 'Judging a schedule')

const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

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

export interface PumpSchedule { id: string, kind: 'pump', name: string, enabled: boolean, days: number, spec: { minute: number, durationS: number } }

/** The pump schedules a preset makes, one per run, every day: `water-mature-1400`, "Mature · 3× 6 min (14:00)"; `water-seedlings-0800`, "Seedlings · once a day 10 min (08:00)". */
export function presetSchedules(preset: PumpPreset, opts: { enabled: boolean, light?: { on: number, off: number } | null }): PumpSchedule[] {
  const runs = presetRuns(preset, opts.light ?? null)
  const per = `${runs.length === 1 ? 'once a day' : `${runs.length}×`} ${Math.round(preset.durationS / 60)} min`
  return runs.map(minute => ({
    id: `water-${preset.slug}-${hhmm(minute).replace(':', '')}`,
    kind: 'pump',
    name: `${preset.short} · ${per} (${hhmm(minute)})`,
    enabled: opts.enabled,
    days: 127,
    spec: { minute, durationS: preset.durationS },
  }))
}

/** Whole days since the tower was sown: the grow cycle's start, else the earliest pod planted; null with neither. */
export function daysSinceSowing(cycleStart: string | null | undefined, plantedAt: ReadonlyArray<string | null>, now: Date): number | null {
  const dates = [cycleStart, ...(cycleStart ? [] : plantedAt)].filter((d): d is string => !!d).map(d => Date.parse(d)).filter(Number.isFinite)
  if (!dates.length) return null
  return Math.max(0, Math.floor((now.getTime() - Math.min(...dates)) / 86_400_000))
}

/** The catalog categories of the plants named, skipping names it doesn't know. */
export function plantCategories(plants: ReadonlyArray<string | null>): Category[] {
  return plants.flatMap(p => (p ? findPlant(p)?.category ?? [] : []))
}

/** Days 0 to this after sowing are Gardyn's soak: no second watering yet. */
export const SOAK_DAYS = 2
export const SOAK_NOTE = 'Gardyn waits a few days to a week after sowing before the second watering.'

/**
 * The preset for this tower and why: fruiting if any planted plant is a
 * fruiting crop, else by days since sowing (0–7 seedlings, 8–21 young, 22+
 * mature); null with no sowing date. In the soak (days 0–2) it's Seedlings
 * with `soak` set: nothing new to run yet.
 */
export function recommendedPreset(days: number | null, categories: readonly Category[]): { id: PumpPresetId, why: string, soak?: boolean } | null {
  if (categories.includes('fruiting')) return { id: 'fruiting', why: 'a fruiting crop is planted' }
  if (days === null) return null
  if (days <= SOAK_DAYS) return { id: 'seedlings', why: `day ${days} since sowing, the soak: ${SOAK_NOTE}`, soak: true }
  return { id: days <= 7 ? 'seedlings' : days <= 21 ? 'young' : 'mature', why: `day ${days} since sowing` }
}

/** The preset the pump cycles are now, if they're exactly one preset's schedules: its times and lengths, each under its id or its name. */
export function appliedPreset(cycles: ReadonlyArray<{ id: string, name?: string, spec: { minute: number, durationS: number } }>, light: { on: number, off: number } | null): PumpPresetId | null {
  for (const p of PUMP_PRESETS) {
    const want = presetSchedules(p, { enabled: true, light })
    const same = (c: typeof cycles[number], w: PumpSchedule) => (c.id === w.id || c.name === w.name) && c.spec.minute === w.spec.minute && c.spec.durationS === w.spec.durationS
    if (want.length === cycles.length && want.every(w => cycles.some(c => same(c, w)))) return p.id
  }
  return null
}
