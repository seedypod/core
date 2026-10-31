import type { SensorId } from '../hardware/contract'
import type { AlertRow, Automation, AutomationRun, AnalysisPoint, AnalysisRow, AnalyzerStats, Capture, DeviceSettings, FlashSample, GrowCycle, GrowStage, Pod, Schedule, ScheduleRun, Store, TelemetryPoint } from './types'
import type { AutomationRule } from '../autopilot/types'
import { DEFAULT_SETTINGS } from './types'

/** In-memory Store for tests and the browser demo. Same semantics as SqliteStore. */
export class MemoryStore implements Store {
  private settingsRow: DeviceSettings = { ...DEFAULT_SETTINGS, updatedAt: new Date(0).toISOString() }
  private readonly scheduleRows = new Map<string, Schedule>()
  private readonly runs: ScheduleRun[] = []
  private readonly runKeys = new Set<string>()
  private readonly alertRows: AlertRow[] = []
  private nextAlertId = 1
  private readonly cycles: GrowCycle[] = []
  private readonly podRows = new Map<number, Pod>()
  private readonly captureRows: Capture[] = []
  private readonly points: TelemetryPoint[] = []
  private readonly counterRows = new Map<string, number>()
  private flashRows: FlashSample[] = []
  private readonly analysisRows: AnalysisRow[] = []
  private automationRows: Automation[] = []
  private runRows: AutomationRun[] = []
  private nextAutomationId = 1
  private nextRunId = 1

  constructor(podCount = 30) {
    const ts = new Date(0).toISOString()
    for (let slot = 1; slot <= podCount; slot++) {
      this.podRows.set(slot, { slot, plant: null, plantedAt: null, status: 'empty', notes: '', updatedAt: ts })
    }
  }

  settings = {
    get: (): DeviceSettings => ({ ...this.settingsRow }),
    update: (patch: Partial<Omit<DeviceSettings, 'updatedAt'>>): DeviceSettings => {
      this.settingsRow = { ...this.settingsRow, ...patch, updatedAt: new Date().toISOString() }
      return { ...this.settingsRow }
    },
  }

  schedules = {
    list: (): Schedule[] => [...this.scheduleRows.values()].sort((a, b) => a.name.localeCompare(b.name)),
    get: (id: string): Schedule | null => this.scheduleRows.get(id) ?? null,
    upsert: (s: Omit<Schedule, 'createdAt' | 'updatedAt'> & Partial<Pick<Schedule, 'createdAt'>>): Schedule => {
      const now = new Date().toISOString()
      const prev = this.scheduleRows.get(s.id)
      const row: Schedule = { ...s, createdAt: prev?.createdAt ?? s.createdAt ?? now, updatedAt: now }
      this.scheduleRows.set(s.id, row)
      return row
    },
    remove: (id: string): boolean => this.scheduleRows.delete(id),
    recordRun: (run: ScheduleRun): boolean => {
      if (this.runKeys.has(run.key)) return false
      this.runKeys.add(run.key)
      this.runs.push(run)
      return true
    },
    recentRuns: (limit = 50): ScheduleRun[] => this.runs.slice(-limit).reverse(),
  }

  alerts = {
    list: (opts?: { activeOnly?: boolean }): AlertRow[] =>
      this.alertRows.filter(a => !opts?.activeOnly || a.active).slice().sort((a, b) => b.raisedAt.localeCompare(a.raisedAt)),
    raise: (kind: string, detail: string, ts: string): AlertRow => {
      const existing = this.alertRows.find(a => a.kind === kind && a.active)
      if (existing) {
        existing.detail = detail
        return existing
      }
      const row: AlertRow = { id: this.nextAlertId++, kind, active: true, detail, raisedAt: ts, clearedAt: null, acknowledgedAt: null, dismissedAt: null }
      this.alertRows.push(row)
      return row
    },
    clear: (kind: string, ts: string): AlertRow | null => {
      const existing = this.alertRows.find(a => a.kind === kind && a.active)
      if (!existing) return null
      existing.active = false
      existing.clearedAt = ts
      return existing
    },
    acknowledge: (id: number, ts: string): AlertRow | null => {
      const a = this.alertRows.find(x => x.id === id)
      if (!a) return null
      a.acknowledgedAt = ts
      return a
    },
    dismiss: (id: number, ts: string): AlertRow | null => {
      const a = this.alertRows.find(x => x.id === id)
      if (!a) return null
      a.dismissedAt = ts
      a.active = false
      return a
    },
  }

  grow = {
    current: (): GrowCycle | null => this.cycles.find(c => c.endedAt === null) ?? null,
    start: (ts: string, notes = ''): GrowCycle => {
      const open = this.grow.current()
      if (open) {
        open.endedAt = ts
        open.stage = 'ended'
      }
      const c: GrowCycle = { id: `cycle-${this.cycles.length + 1}`, startedAt: ts, endedAt: null, stage: 'germination', notes, issued: [] }
      this.cycles.push(c)
      return c
    },
    setStage: (stage: GrowStage): GrowCycle | null => {
      const c = this.grow.current()
      if (!c) return null
      c.stage = stage
      return c
    },
    markIssued: (reminder: string): void => {
      const c = this.grow.current()
      if (c && !c.issued.includes(reminder)) c.issued.push(reminder)
    },
    end: (ts: string): GrowCycle | null => {
      const c = this.grow.current()
      if (!c) return null
      c.endedAt = ts
      c.stage = 'ended'
      return c
    },
    history: (): GrowCycle[] => [...this.cycles].reverse(),
  }

  pods = {
    list: (): Pod[] => [...this.podRows.values()].sort((a, b) => a.slot - b.slot),
    update: (slot: number, patch: Partial<Omit<Pod, 'slot' | 'updatedAt'>>, ts: string): Pod => {
      const prev = this.podRows.get(slot)
      if (!prev) throw new Error(`no pod ${slot}`)
      const row = { ...prev, ...patch, updatedAt: ts }
      this.podRows.set(slot, row)
      return row
    },
  }

  captures = {
    add: (c: Capture): void => {
      this.captureRows.push(c)
    },
    list: (camera?: 'upper' | 'lower', limit = 100): Capture[] =>
      this.captureRows.filter(c => !camera || c.camera === camera).slice().sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit),
    get: (id: string): Capture | null => this.captureRows.find(c => c.id === id) ?? null,
    prune: (camera: 'upper' | 'lower', keep: number): Capture[] => {
      const rows = this.captures.list(camera, Number.MAX_SAFE_INTEGER)
      const drop = rows.slice(keep)
      for (const d of drop) this.captureRows.splice(this.captureRows.indexOf(d), 1)
      return drop
    },
  }

  telemetry = {
    add: (pts: TelemetryPoint[]): void => {
      this.points.push(...pts)
    },
    range: (sensor: SensorId, fromTs: string, toTs: string, maxPoints = 500): TelemetryPoint[] => {
      const rows = this.points.filter(p => p.sensor === sensor && p.ts >= fromTs && p.ts <= toTs)
      return downsample(rows, maxPoints)
    },
  }

  counters = {
    add: (key: string, delta: number): number => {
      const v = (this.counterRows.get(key) ?? 0) + delta
      this.counterRows.set(key, v)
      return v
    },
    get: (key: string): number => this.counterRows.get(key) ?? 0,
  }

  flash = {
    add: (sample: FlashSample): void => {
      this.flashRows = [...this.flashRows.filter(r => r.ts !== sample.ts), sample].sort((a, b) => a.ts.localeCompare(b.ts))
    },
    last: (): FlashSample | null => this.flashRows.at(-1) ?? null,
    since: (fromTs: string): FlashSample[] => this.flashRows.filter(r => r.ts >= fromTs),
    prune: (beforeTs: string): number => {
      const before = this.flashRows.length
      this.flashRows = this.flashRows.filter(r => r.ts >= beforeTs)
      return before - this.flashRows.length
    },
  }

  analyses = {
    add: (rows: AnalysisRow[]): void => {
      for (const r of rows) {
        const i = this.analysisRows.findIndex(x => x.captureId === r.captureId && x.analyzer === r.analyzer && x.version === r.version && x.slot === r.slot && x.metric === r.metric)
        if (i >= 0) this.analysisRows[i] = { ...r }
        else this.analysisRows.push({ ...r })
      }
    },
    series: (q: { analyzer: string, version?: number, slot: number, metric: string, limit?: number }): AnalysisPoint[] => {
      const versions = this.analysisRows.filter(r => r.analyzer === q.analyzer).map(r => r.version)
      const version = q.version ?? (versions.length ? Math.max(...versions) : undefined)
      if (version === undefined) return []
      return this.analysisRows
        .filter(r => r.analyzer === q.analyzer && r.version === version && r.slot === q.slot && r.metric === q.metric)
        .sort((a, b) => a.ts.localeCompare(b.ts))
        .slice(-(q.limit ?? 200))
        .map(r => ({ ts: r.ts, value: r.value, captureId: r.captureId }))
    },
    forCapture: (captureId: string): AnalysisRow[] =>
      this.analysisRows.filter(r => r.captureId === captureId)
        .sort((a, b) => a.analyzer.localeCompare(b.analyzer) || a.version - b.version || a.slot - b.slot || a.metric.localeCompare(b.metric)),
    range: (fromTs: string, toTs: string): AnalysisRow[] =>
      this.analysisRows.filter(r => r.ts >= fromTs && r.ts <= toTs).sort((a, b) => a.ts.localeCompare(b.ts)),
    stats: (): AnalyzerStats[] => {
      const m = new Map<string, AnalyzerStats & { ids: Set<string> }>()
      for (const r of this.analysisRows) {
        const k = `${r.analyzer}@${r.version}@${r.source}`
        const s = m.get(k) ?? { analyzer: r.analyzer, version: r.version, source: r.source, rows: 0, captures: 0, firstTs: r.ts, lastTs: r.ts, ids: new Set<string>() }
        s.rows++
        s.ids.add(r.captureId)
        if (r.ts < s.firstTs) s.firstTs = r.ts
        if (r.ts > s.lastTs) s.lastTs = r.ts
        m.set(k, s)
      }
      return [...m.values()].map(({ ids, ...s }) => ({ ...s, captures: ids.size })).sort((a, b) => a.analyzer.localeCompare(b.analyzer) || a.version - b.version)
    },
  }

  automations = {
    list: (): Automation[] => this.automationRows.map(clone),
    get: (id: number): Automation | null => {
      const r = this.automationRows.find(a => a.id === id)
      return r ? clone(r) : null
    },
    create: (rule: Omit<AutomationRule, 'id'>, ts: string): Automation => {
      const r: Automation = { ...clone(rule), id: this.nextAutomationId++, createdAt: ts, updatedAt: ts }
      this.automationRows.push(r)
      return clone(r)
    },
    update: (id: number, patch: Partial<Omit<AutomationRule, 'id'>>, ts: string): Automation | null => {
      const i = this.automationRows.findIndex(a => a.id === id)
      const cur = this.automationRows[i]
      if (!cur) return null
      const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
      const next: Automation = { ...cur, ...clone(defined), updatedAt: ts }
      this.automationRows[i] = next
      return clone(next)
    },
    remove: (id: number): boolean => {
      this.runRows = this.runRows.filter(r => r.automationId !== id)
      const before = this.automationRows.length
      this.automationRows = this.automationRows.filter(a => a.id !== id)
      return this.automationRows.length < before
    },
    addRun: (run: Omit<AutomationRun, 'id'>): void => {
      this.runRows.push({ ...run, id: this.nextRunId++ })
    },
    runs: (q?: { automationId?: number, limit?: number }): AutomationRun[] =>
      this.runRows.filter(r => q?.automationId === undefined || r.automationId === q.automationId).slice().reverse().slice(0, q?.limit ?? 100),
    pruneRuns: (beforeTs: string): number => {
      const before = this.runRows.length
      this.runRows = this.runRows.filter(r => r.firedAt >= beforeTs)
      return before - this.runRows.length
    },
  }

  close(): void {
    // nothing to release
  }
}

/** Keep at most `max` points by uniform stride (good enough for charts). */
export function downsample<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows
  const stride = rows.length / max
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(rows[Math.floor(i * stride)] as T)
  return out
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}
