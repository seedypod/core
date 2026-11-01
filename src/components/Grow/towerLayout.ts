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

/**
 * Plant size in the scene. The analysers' green fraction (0–1) when there is one,
 * otherwise a size that follows the status, so a planted pod is never invisible.
 */
export function plantScale(status: PodStatus, green: number | null | undefined): number {
  if (status === 'empty') return 0
  if (status === 'seeded') return 0.25
  const fallback = status === 'harvest' ? 0.85 : 0.5
  const g = green ?? null
  if (g === null || !Number.isFinite(g)) return fallback
  return Math.max(0.3, Math.min(1, 0.3 + g * 0.9))
}
