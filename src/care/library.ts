/**
 * Your schedules (ADR-0030): named sets of pump cycles, with a light preset if
 * they set the light, beside the built-in water presets, read-only, so going
 * back to what the protocol did is one click. Activating one is a person's
 * choice, so unlike the protocol it replaces whatever pump cycles are there.
 * Which one is active isn't stored: it's the one the live cycles still are.
 * The light curves a schedule's light preset turned off are, so using one
 * without a light turns exactly those back on.
 */
import { LIGHT_PRESETS } from '../scheduler/lightPlan'
import { hhmm, presetSchedules, PUMP_PRESETS, type PumpPreset, type PumpPresetId, type PumpSchedule } from '../scheduler/pumpPlan'
import type { SavedCycle, SavedSchedule, Store } from '../store/types'
import { followedPreset, pumpCycles, todaysLight } from './follow'
import { readTower, towerSowWeekday, type Tower } from './tower'

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
const OWN_LIGHT = 'light-own-'
const ownPrefix = (id: string) => `water-own-${id}-`
/** The saved schedule a cycle id was written for: `water-own-summer-2-0700` is summer-2's, not summer's. */
const ownOf = (cycleId: string) => /^water-own-(.+)-\d{4}$/.exec(cycleId)?.[1] ?? null

export const presetEntryId = (id: PumpPresetId) => `${PRESET}${id}`

/** A preset's pump schedules as they'd be written now: fitted to today's light, a weekly run on the sowing weekday. */
function presetNow(t: Tower, preset: PumpPreset, now: Date): PumpSchedule[] {
  return presetSchedules(preset, { enabled: true, light: todaysLight(t.schedules, now, t.settings.timezone), weekday: towerSowWeekday(t, now) })
}

function presetEntry(t: Tower, id: PumpPresetId, now: Date): LibraryEntry | null {
  const preset = PUMP_PRESETS.find(p => p.id === id)
  if (!preset) return null
  const cycles = presetNow(t, preset, now).map(s => ({ minute: s.spec.minute, durationS: s.spec.durationS, days: s.days }))
  return { id: presetEntryId(id), name: preset.name, kind: 'preset', cycles, lightPresetId: null, lastUsedAt: null }
}

const ownEntry = (s: SavedSchedule): LibraryEntry => ({ id: s.id, name: s.name, kind: 'own', cycles: s.cycles, lightPresetId: s.lightPresetId, lastUsedAt: s.lastUsedAt })

/** Your schedules, oldest first, then the built-in presets. */
export function libraryEntries(t: Tower, now: Date): LibraryEntry[] {
  return [...t.saved.map(ownEntry), ...PUMP_PRESETS.flatMap(p => presetEntry(t, p.id, now) ?? [])]
}

export function libraryEntry(t: Tower, id: string, now: Date): LibraryEntry | null {
  if (id.startsWith(PRESET)) return presetEntry(t, id.slice(PRESET.length) as PumpPresetId, now)
  const s = t.saved.find(x => x.id === id)
  return s ? ownEntry(s) : null
}

const sameCycle = (a: SavedCycle, b: SavedCycle) => a.minute === b.minute && a.durationS === b.durationS && a.days === b.days

/** The saved schedule the live pump cycles are, as activating it wrote them; null if they aren't one. */
export function activeOwn(t: Tower): SavedSchedule | null {
  const live = pumpCycles(t.schedules)
  const first = live[0]
  if (!first) return null
  const id = ownOf(first.id)
  const own = t.saved.find(s => s.id === id)
  if (!own || own.cycles.length !== live.length) return null
  const asWritten = live.every(c => c.enabled && ownOf(c.id) === own.id && own.cycles.some(w => sameCycle(w, { minute: c.spec.minute, durationS: c.spec.durationS, days: c.days })))
  return asWritten ? own : null
}

/** The library entry the live pump cycles are: a saved schedule, else a preset as written; null if edited or none. */
export function activeEntryId(t: Tower): string | null {
  const own = activeOwn(t)
  if (own) return own.id
  const preset = followedPreset(pumpCycles(t.schedules))
  return preset ? presetEntryId(preset.id) : null
}

/**
 * Put an entry's cycles on the pump, removing the other pump cycles. An entry
 * with a light preset puts that curve on and turns the other curves off (not
 * deleting them); one without takes any schedule's curve off and turns back
 * on exactly the curves a schedule turned off.
 */
export function activateEntry(store: Store, entry: LibraryEntry, now: Date): void {
  const t = readTower(store)
  const before = pumpCycles(t.schedules)
  const preset = entry.kind === 'preset' ? PUMP_PRESETS.find(p => presetEntryId(p.id) === entry.id) : undefined
  const next: PumpSchedule[] = preset
    ? presetNow(t, preset, now)
    : entry.cycles.map(c => ({ id: `${ownPrefix(entry.id)}${hhmm(c.minute).replace(':', '')}`, kind: 'pump', name: `${entry.name} · ${Math.round(c.durationS / 60)} min (${hhmm(c.minute)})`, enabled: true, days: c.days, spec: { minute: c.minute, durationS: c.durationS } }))
  for (const s of next) store.schedules.upsert(s)
  for (const c of before) if (!next.some(s => s.id === c.id)) store.schedules.remove(c.id)

  const light = entry.lightPresetId ? LIGHT_PRESETS.find(p => p.id === entry.lightPresetId) : undefined
  const keep = light ? `${OWN_LIGHT}${entry.id}` : null
  const off = new Set(t.settings.libraryLightsOff ?? [])
  for (const s of t.schedules) {
    if (s.kind !== 'light' || s.id === keep) continue
    if (s.id.startsWith(OWN_LIGHT)) store.schedules.remove(s.id)
    else if (light && s.enabled) {
      store.schedules.upsert({ ...s, enabled: false })
      off.add(s.id)
    }
    else if (!light && off.has(s.id) && !s.enabled) store.schedules.upsert({ ...s, enabled: true })
  }
  if (light && keep) store.schedules.upsert({ id: keep, kind: 'light', name: light.name, enabled: true, days: 127, spec: { setpoints: light.setpoints } })
  const lightsOff = light && off.size ? [...off] : null
  if (JSON.stringify(lightsOff) !== JSON.stringify(t.settings.libraryLightsOff)) store.settings.update({ libraryLightsOff: lightsOff })
  if (entry.kind === 'own') store.scheduleLibrary.markUsed(entry.id, now.toISOString())
}
