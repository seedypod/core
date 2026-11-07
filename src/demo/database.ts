/**
 * Sample data for the Database view in the browser demo, which has no SQLite
 * to scan: a 19-day-old unit like the seeded one, writing at a unit's real
 * rates. Deterministic for a given time.
 */
import type { DatabaseInspector, DatabaseReport, IntegrityRun, TableReport, WriteBasis } from '../db/inspect'
import type { FlashSource } from '../telemetry/flash'

const HOUR = 3_600_000
const DAYS = 19
/** Rows a table writes in a clock hour. */
type Rate = (hour: number) => number

const DAYTIME: Rate = hour => (hour >= 7 && hour < 21 ? 1 : 0)

const TABLES: ReadonlyArray<{ name: string, column: string, basis: WriteBasis, rate: Rate, rowBytes: number, rows?: number, /** How long ago a table that writes rarely last did. */ idleHours?: number }> = [
  { name: 'telemetry', column: 'ts', basis: 'inserted', rate: () => 480, rowBytes: 93 },
  { name: 'analysis_results', column: 'ts', basis: 'inserted', rate: h => 60 * DAYTIME(h), rowBytes: 138 },
  { name: 'automation_runs', column: 'firedAt', basis: 'inserted', rate: () => 14, rowBytes: 74 },
  { name: 'captures', column: 'ts', basis: 'inserted', rate: h => 2 * DAYTIME(h), rowBytes: 118 },
  { name: 'flash_samples', column: 'ts', basis: 'inserted', rate: () => 1, rowBytes: 56 },
  { name: 'schedule_runs', column: 'firedAt', basis: 'inserted', rate: h => (h === 8 || h === 20 ? 1 : h === 6 || h === 21 ? 2 : 0), rowBytes: 96 },
  { name: 'counters', column: 'updatedAt', basis: 'changed', rate: h => (h === 21 ? 1 : 0), rowBytes: 64, rows: 2 },
  { name: 'pods', column: 'updatedAt', basis: 'changed', rate: () => 0, rowBytes: 140, rows: 30, idleHours: 52 },
  { name: 'alerts', column: 'raisedAt', basis: 'inserted', rate: () => 0, rowBytes: 120, rows: 6, idleHours: 31 },
  { name: 'backups', column: 'ts', basis: 'inserted', rate: h => (h === 3 ? 1 : 0), rowBytes: 110 },
  { name: 'automations', column: 'updatedAt', basis: 'changed', rate: () => 0, rowBytes: 620, rows: 3, idleHours: 96 },
  { name: 'schedules', column: 'updatedAt', basis: 'changed', rate: () => 0, rowBytes: 240, rows: 4, idleHours: 200 },
  { name: 'plans', column: 'updatedAt', basis: 'changed', rate: () => 0, rowBytes: 1800, rows: 1, idleHours: 120 },
  { name: 'plant_profiles', column: 'updatedAt', basis: 'changed', rate: () => 0, rowBytes: 180, rows: 5, idleHours: 300 },
  { name: 'grow_cycles', column: 'startedAt', basis: 'inserted', rate: () => 0, rowBytes: 120, rows: 1, idleHours: DAYS * 24 },
  { name: 'device_settings', column: 'updatedAt', basis: 'changed', rate: () => 0, rowBytes: 900, rows: 1, idleHours: 80 },
]

function table(t: typeof TABLES[number], now: Date): TableReport {
  const thisHour = Math.floor(now.getTime() / HOUR) * HOUR
  const hourly = Array.from({ length: 24 }, (_, i) => t.rate(new Date(thisHour - (23 - i) * HOUR).getHours()))
  const writes24h = hourly.reduce((a, b) => a + b, 0)
  const rows = t.rows ?? writes24h * DAYS
  const hoursAgo = t.idleHours ?? 23 - hourly.findLastIndex(n => n > 0)
  return {
    name: t.name,
    rows,
    bytes: Math.ceil(rows * t.rowBytes / 4096) * 4096,
    timeColumn: t.column,
    basis: t.basis,
    lastWriteAt: new Date(now.getTime() - hoursAgo * HOUR - 60_000).toISOString(),
    hourly,
    writes24h,
  }
}

export function demoDatabase(now: () => Date = () => new Date()): DatabaseInspector {
  let integrity: IntegrityRun | null = null
  const report = (): DatabaseReport => {
    const tables = TABLES.map(t => table(t, now()))
    return {
      at: now().toISOString(),
      scanMs: 1800,
      path: 'data/seedypod.db',
      fileBytes: tables.reduce((n, t) => n + (t.bytes as number), 0) + 53 * 4096,
      walBytes: 1_236_000,
      journalMode: 'wal',
      pageSize: 4096,
      freePages: 53,
      migrations: { applied: 11, known: 11, latestTag: '0010_furry_power_pack', appliedTag: '0010_furry_power_pack' },
      tables,
      integrity,
    }
  }
  return {
    inspect: async () => report(),
    checkIntegrity: async () => {
      integrity = { ok: true, detail: 'ok', checkedAt: now().toISOString(), ms: 6200 }
      return integrity
    },
  }
}

/** A stand-in SD card, so the demo's write meter has a number to show: about 300 MB a day on a 32 GB card. */
export const demoFlashSource: FlashSource = {
  statPath: '/sys/block/mmcblk0/stat',
  read: path => (path.endsWith('/size') ? '62500000\n' : '5021 1544 412366 8133 2210 3122 1757813 14880 0 11440 23010\n'),
  uptimeS: () => 3 * 86_400,
}
