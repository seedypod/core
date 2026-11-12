/**
 * What the Database view shows about seedypod.db (after sleepypod's System →
 * Databases): metadata only. Nothing here carries a row's values, because rows
 * hold Wi-Fi details and bucket credentials. Shared by the node inspector
 * (`inspector.ts`) and the browser demo, so it stays free of node imports.
 */

/** `inserted`: the column dates a new row. `changed`: it moves on update, so a row changed twice in an hour counts once. */
export type WriteBasis = 'inserted' | 'changed'

export interface TableReport {
  name: string
  rows: number
  /** Table plus its indexes; null when this SQLite has no dbstat. */
  bytes: number | null
  /** The column that dates a row; null when the table has none, so its writes can't be known. */
  timeColumn: string | null
  basis: WriteBasis | null
  lastWriteAt: string | null
  /** Rows dated in each of the last 24 hours, oldest first; null without a time column. */
  hourly: number[] | null
  writes24h: number | null
}

export interface MigrationReport {
  applied: number
  /** Migrations this build ships. */
  known: number
  latestTag: string | null
  /** The newest applied migration, when this build knows it. */
  appliedTag: string | null
}

export interface IntegrityRun {
  ok: boolean
  /** `ok`, or the first problem `quick_check` found. */
  detail: string
  checkedAt: string
  ms: number
}

export interface DatabaseReport {
  at: string
  scanMs: number
  path: string
  fileBytes: number
  walBytes: number
  journalMode: string
  pageSize: number
  freePages: number
  migrations: MigrationReport
  tables: TableReport[]
  /** The last on-demand check since core started; kept in memory, so the view writes nothing. */
  integrity: IntegrityRun | null
}

export interface DatabaseInspector {
  inspect(): Promise<DatabaseReport>
  checkIntegrity(): Promise<IntegrityRun>
}
