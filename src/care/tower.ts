/**
 * What the grow protocol and Your schedules read from the store (ADR-0030),
 * read once per request or tick and passed down, so one answer comes from one
 * reading.
 */
import type { Catalog } from '../plants/catalog'
import { catalogFor } from '../plants/custom'
import { sowWeekday } from '../scheduler/pumpPlan'
import type { DeviceSettings, GrowCycle, Pod, SavedSchedule, Schedule, Store } from '../store/types'

export interface Tower {
  settings: DeviceSettings
  /** Pods with something in them, as the Water page and pump_presets count them. */
  planted: Pod[]
  cycle: GrowCycle | null
  schedules: Schedule[]
  saved: SavedSchedule[]
  catalog: Catalog
}

export function readTower(store: Store): Tower {
  return {
    settings: store.settings.get(),
    planted: store.pods.list().filter(p => p.status !== 'empty'),
    cycle: store.grow.current(),
    schedules: store.schedules.list(),
    saved: store.scheduleLibrary.list(),
    catalog: catalogFor(store),
  }
}

/** The sowing weekday (0 = Monday) a weekly run keeps to. */
export const towerSowWeekday = (t: Tower, now: Date) => sowWeekday(t.cycle?.startedAt, t.planted.map(p => p.plantedAt), t.settings.timezone, now)
