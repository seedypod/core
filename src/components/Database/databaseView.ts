import type { MigrationReport, TableReport } from '@/src/db/inspect'

export const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(b < 1e10 ? 2 : 1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB` : `${Math.round(b / 1e3)} kB`)

/** Busiest writers first; tables whose writes can't be known last, then by size. */
export function byWrites(tables: TableReport[]): TableReport[] {
  return [...tables].sort((a, b) => (b.writes24h ?? -1) - (a.writes24h ?? -1) || (b.bytes ?? 0) - (a.bytes ?? 0) || a.name.localeCompare(b.name))
}

export function totalWrites(tables: TableReport[]): number {
  return tables.reduce((n, t) => n + (t.writes24h ?? 0), 0)
}

/**
 * Row data added in 24 h, at each table's average row size: what the rows
 * weigh, not what reached the card. Tables that only update rows in place
 * don't grow, so they aren't counted.
 */
export function rowBytes24h(tables: TableReport[]): number | null {
  if (tables.some(t => t.bytes === null)) return null
  return tables.reduce((n, t) => n + (t.basis === 'inserted' && t.rows > 0 ? (t.writes24h as number) * (t.bytes as number) / t.rows : 0), 0)
}

/** The table behind most of the writes, in a sentence; null when nothing wrote. */
export function topWriter(tables: TableReport[]): string | null {
  const total = totalWrites(tables)
  if (total === 0) return null
  const top = byWrites(tables)[0] as TableReport
  return `${top.name} wrote ${Math.round((top.writes24h as number) / total * 100)}% of them.`
}

export function migrationNote(m: MigrationReport): { text: string, warn: boolean } {
  if (m.applied > m.known) return { text: `${m.applied - m.known} applied by a newer build`, warn: true }
  if (m.applied < m.known) return { text: `${m.known - m.applied} pending`, warn: true }
  return { text: m.appliedTag ?? m.latestTag ?? 'none', warn: false }
}

/** How tall each hour's bar is, 0–1 of the table's own busiest hour. */
export function barHeights(hourly: number[]): number[] {
  const peak = Math.max(...hourly, 1)
  return hourly.map(n => n / peak)
}
