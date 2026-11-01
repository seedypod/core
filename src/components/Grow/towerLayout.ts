/**
 * Where each pod sits on the tower, for the 3D view. A Gardyn Home holds 30
 * pods on three vertical columns of 10; a Studio 16 on two columns of 8.
 * Slots count across then down from the top, so pods 1–15 are the upper half
 * (the upper camera's) and 16–30 the lower, as the analysis assumes. Pods
 * alternate left and right of their column's spine. The real numbering is
 * unverified until Phase 1 (docs/hardware/pin-map.md).
 */

export interface PodPlace {
  slot: number
  column: number
  /** 0 is the top row. */
  row: number
  /** Which side of the column's spine the pod leans out to. */
  side: -1 | 1
  x: number
  y: number
  z: number
}

export interface TowerShape {
  columns: number
  rows: number
  /** Metres, roughly to scale. */
  height: number
  width: number
  /** Top of the base, where the columns start. */
  baseTop: number
  /** Gap between rows. */
  pitch: number
  columnX: number[]
}

export function towerShape(podCount: number): TowerShape {
  const columns = podCount > 16 ? 3 : 2
  const rows = Math.ceil(podCount / columns)
  const baseTop = 0.3
  const pitch = 0.115
  const height = baseTop + 0.12 + rows * pitch
  const spacing = 0.2
  const columnX = Array.from({ length: columns }, (_, c) => (c - (columns - 1) / 2) * spacing)
  return { columns, rows, height, width: spacing * columns + 0.12, baseTop, pitch, columnX }
}

export function podPlaces(podCount: number): PodPlace[] {
  const shape = towerShape(podCount)
  return Array.from({ length: podCount }, (_, i) => {
    const row = Math.floor(i / shape.columns)
    const column = i % shape.columns
    const side: -1 | 1 = (row + column) % 2 === 0 ? -1 : 1
    return {
      slot: i + 1,
      column,
      row,
      side,
      x: (shape.columnX[column] ?? 0) + side * 0.035,
      y: shape.height - 0.12 - row * shape.pitch,
      z: 0.06,
    }
  })
}

export type PodStatus = 'empty' | 'seeded' | 'growing' | 'harvest' | 'attention'

/** What each pod status is called, and its colour token, wherever pods are drawn. */
export const STATUS_LABEL: Record<PodStatus, string> = { empty: 'Empty', seeded: 'Seeded', growing: 'Growing', harvest: 'Ready to harvest', attention: 'Needs attention' }
export const STATUS_TOKEN: Record<PodStatus, string> = {
  growing: 'var(--pod-ok)',
  harvest: 'var(--accent-light)',
  attention: 'var(--pod-attention)',
  seeded: 'var(--text-2)',
  empty: 'var(--text-3)',
}

/** Days a leafy green or herb takes from planting to its first harvest, roughly. */
const DAYS_TO_HARVEST = 35

/**
 * Plant size in the scene, 0 (nothing) to 1 (full). The analysers' green
 * fraction (0–1) when there is one; otherwise days since planting, so a young
 * pod reads smaller than an old one; otherwise a size by status.
 */
export function plantScale(status: PodStatus, green: number | null | undefined, ageDays?: number | null): number {
  if (status === 'empty') return 0
  if (status === 'seeded') return 0.25
  const g = green ?? null
  if (g !== null && Number.isFinite(g)) return Math.max(0.3, Math.min(1, 0.35 + g * 1.1))
  if (status === 'harvest') return 0.95
  if (typeof ageDays === 'number' && Number.isFinite(ageDays)) return Math.max(0.3, Math.min(1, 0.3 + (ageDays / DAYS_TO_HARVEST) * 0.65))
  return 0.55
}

export type PlantForm = 'none' | 'sprout' | 'young' | 'bush' | 'full'

/** The plant's shape by stage: two seed leaves, a few leaves, a bush, a full head ready to cut. */
export function plantForm(status: PodStatus, scale: number): PlantForm {
  if (status === 'empty') return 'none'
  if (status === 'seeded') return 'sprout'
  if (status === 'harvest') return 'full'
  return scale < 0.6 ? 'young' : 'bush'
}

/** Leaves shown for each form (the scene builds the most a full plant has). */
export const LEAF_COUNT: Record<PlantForm, number> = { none: 0, sprout: 0, young: 3, bush: 6, full: 8 }

export function ageDays(plantedAt: string | null | undefined, now: Date = new Date()): number | null {
  if (!plantedAt) return null
  const t = Date.parse(plantedAt)
  return Number.isNaN(t) ? null : Math.max(0, (now.getTime() - t) / 86_400_000)
}
