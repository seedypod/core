/**
 * Your schedules (ADR-0030): named sets of pump cycles, with a light preset if
 * they set the light, beside the built-in water presets, read-only, so going
 * back to what the protocol did is one click. Activating one is a person's
 * choice, so unlike the protocol it replaces whatever pump cycles are there.
 * Which one is active isn't stored: it's the one the live cycles still are.
 */
import { LIGHT_PRESETS } from '../scheduler/lightPlan'
import { presetSchedules, PUMP_PRESETS, sowWeekday, type PumpPreset, type PumpPresetId, type PumpSchedule } from '../scheduler/pumpPlan'
import type { PumpSpec, SavedCycle, SavedSchedule, Schedule, Store } from '../store/types'
import { followedPreset, todaysLight } from './follow'

export interface LibraryEntry {
  /** A saved schedule's id, or `preset:<id>` for a built-in water preset. */
  id: string
  name: string
  kind: 'own' | 'preset'
  cycles: SavedCycle[]
  lightPresetId: string | null
  lastUsedAt: string | null
}

const PRESET = 'preset:'
const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
const ownPrefix = (id: string) => `water-own-${id}-`
/** The saved schedule a cycle id was written for: `water-own-summer-2-0700` is summer-2's, not summer's. */
const ownOf = (cycleId: string) => /^water-own-(.+)-\d{4}$/.exec(cycleId)?.[1] ?? null
const pumps = (store: Store) => store.schedules.list().filter((s): s is Schedule & { spec: PumpSpec } => s.kind === 'pump')

export const presetEntryId = (id: PumpPresetId) => `${PRESET}${id}`

/** A preset's pump schedules as they'd be written now: fitted to today's light, a weekly run on the sowing weekday. */
function presetNow(store: Store, preset: PumpPreset, now: Date): PumpSchedule[] {
  const tz = store.settings.get().timezone
  const planted = store.pods.list().filter(p => p.status !== 'empty')
  const weekday = sowWeekday(store.grow.current()?.startedAt, planted.map(p => p.plantedAt), tz, now)
  return presetSchedules(preset, { enabled: true, light: todaysLight(store.schedules.list(), now, tz), weekday })
}

function presetEntry(store: Store, id: PumpPresetId, now: Date): LibraryEntry | null {
  const preset = PUMP_PRESETS.find(p => p.id === id)
  if (!preset) return null
  const cycles = presetNow(store, preset, now).map(s => ({ minute: s.spec.minute, durationS: s.spec.durationS, days: s.days }))
  return { id: presetEntryId(id), name: preset.name, kind: 'preset', cycles, lightPresetId: null, lastUsedAt: null }
}

const ownEntry = (s: SavedSchedule): LibraryEntry => ({ id: s.id, name: s.name, kind: 'own', cycles: s.cycles, lightPresetId: s.lightPresetId, lastUsedAt: s.lastUsedAt })

/** Your schedules, oldest first, then the built-in presets. */
export function libraryEntries(store: Store, now: Date): LibraryEntry[] {
  return [...store.scheduleLibrary.list().map(ownEntry), ...PUMP_PRESETS.flatMap(p => presetEntry(store, p.id, now) ?? [])]
}

export function libraryEntry(store: Store, id: string, now: Date): LibraryEntry | null {
  if (id.startsWith(PRESET)) return presetEntry(store, id.slice(PRESET.length) as PumpPresetId, now)
  const s = store.scheduleLibrary.get(id)
  return s ? ownEntry(s) : null
}

const sameCycle = (a: SavedCycle, b: SavedCycle) => a.minute === b.minute && a.durationS === b.durationS && a.days === b.days

/** The saved schedule the live pump cycles are, as activating it wrote them; null if they aren't one. */
export function activeOwn(store: Store): SavedSchedule | null {
  const live = pumps(store)
  const first = live[0]
  if (!first) return null
  const id = ownOf(first.id)
  const own = id ? store.scheduleLibrary.get(id) : null
  if (!own || own.cycles.length !== live.length) return null
  const asWritten = live.every(c => c.enabled && ownOf(c.id) === own.id && own.cycles.some(w => sameCycle(w, { minute: c.spec.minute, durationS: c.spec.durationS, days: c.days })))
  return asWritten ? own : null
}

/** The library entry the live pump cycles are: a saved schedule, else a preset as written; null if edited or none. */
export function activeEntryId(store: Store): string | null {
  const own = activeOwn(store)
  if (own) return own.id
  const preset = followedPreset(pumps(store))
  return preset ? presetEntryId(preset.id) : null
}

/**
 * Put an entry's cycles on the pump, removing the other pump cycles, and its
 * light preset on the light, turning the other curves off (not deleting them).
 */
export function activateEntry(store: Store, entry: LibraryEntry, now: Date): void {
  const ts = now.toISOString()
  const before = pumps(store)
  const preset = entry.kind === 'preset' ? PUMP_PRESETS.find(p => presetEntryId(p.id) === entry.id) : undefined
  const next: PumpSchedule[] = preset
    ? presetNow(store, preset, now)
    : entry.cycles.map(c => ({ id: `${ownPrefix(entry.id)}${hhmm(c.minute).replace(':', '')}`, kind: 'pump', name: `${entry.name} · ${Math.round(c.durationS / 60)} min (${hhmm(c.minute)})`, enabled: true, days: c.days, spec: { minute: c.minute, durationS: c.durationS } }))
  for (const s of next) store.schedules.upsert(s)
  for (const c of before) if (!next.some(s => s.id === c.id)) store.schedules.remove(c.id)
  const light = entry.lightPresetId ? LIGHT_PRESETS.find(p => p.id === entry.lightPresetId) : undefined
  if (light) {
    const id = `light-own-${entry.id}`
    for (const s of store.schedules.list()) {
      if (s.kind !== 'light' || s.id === id) continue
      if (s.id.startsWith('light-own-')) store.schedules.remove(s.id)
      else if (s.enabled) store.schedules.upsert({ ...s, enabled: false })
    }
    store.schedules.upsert({ id, kind: 'light', name: light.name, enabled: true, days: 127, spec: { setpoints: light.setpoints } })
  }
  if (entry.kind === 'own') store.scheduleLibrary.markUsed(entry.id, ts)
}
