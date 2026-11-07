/**
 * The planner's view of a tower: every slot with its row, column and light
 * zone. The grid itself is core's (src/components/Grow/lightZones.ts, read off
 * Gardyn's diagrams; knowledge/plants/gardyn-light-zones.md re-measures it),
 * so the planner, the 3D tower and the placement advice can never disagree.
 * Slots count across then down from the top (towerLayout.ts).
 *
 * The nursery is the planner's own: a 10-pod sprouting tray with no zones.
 */
import { MODEL_NAME, podZone, type LightZone } from '../components/Grow/lightZones'
import { podPlaces, towerShape } from '../components/Grow/towerLayout'

export type Model = 'home' | 'studio' | 'nursery'

export interface ModelInfo {
  model: Model
  name: string
  cols: number
  rows: number
  pods: number
}

export const MODELS: Record<Model, ModelInfo> = {
  home: { model: 'home', name: MODEL_NAME.home, cols: towerShape(30).columns, rows: towerShape(30).rows, pods: 30 },
  studio: { model: 'studio', name: MODEL_NAME.studio, cols: towerShape(16).columns, rows: towerShape(16).rows, pods: 16 },
  nursery: { model: 'nursery', name: 'Sprout nursery', cols: 2, rows: 5, pods: 10 },
}

export interface Slot { slot: number, row: number, col: number, zone: LightZone | null }

export function slots(model: Model): Slot[] {
  const m = MODELS[model]
  if (model === 'nursery') {
    return Array.from({ length: m.pods }, (_, i) => ({ slot: i + 1, row: Math.floor(i / m.cols), col: i % m.cols, zone: null }))
  }
  return podPlaces(m.pods).map(p => ({ slot: p.slot, row: p.row, col: p.column, zone: podZone(m.pods, p.slot) }))
}

export function slotAt(model: Model, slot: number): Slot | undefined {
  return slots(model).find(s => s.slot === slot)
}

export function zoneCounts(model: Model): Record<LightZone, number> {
  const c: Record<LightZone, number> = { high: 0, medium: 0, low: 0 }
  for (const s of slots(model)) if (s.zone) c[s.zone]++
  return c
}
