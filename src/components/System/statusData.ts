/**
 * Pure helpers behind System › Status: wording, the Today timeline's SVG
 * geometry (a 1000×100 box per lane, 00:00–24:00 across) and the events
 * lane's label rows.
 */
import { fmtClock } from '@/src/components/charts/format'
import type { SystemCheck } from './checkState'

const DAY_MIN = 1440

/** Minutes past local midnight. */
export const minuteOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())

/** Lane x for a minute of the day. */
export const laneX = (minute: number) => Math.round((minute / DAY_MIN) * 10_000) / 10

const laneY = (v: number, lo: number, hi: number) => Math.round((100 - ((v - lo) / (hi - lo || 1)) * 100) * 10) / 10

export interface Sample { minute: number, value: number }

/** `x,y x,y …` for a polyline in the lane's 1000×100 box. */
export function lanePoints(samples: Sample[], lo: number, hi: number): string {
  return samples.map(s => `${laneX(s.minute)},${laneY(s.value, lo, hi)}`).join(' ')
}

/** The filled area under a series, closed down to the baseline. */
export function laneArea(samples: Sample[], lo: number, hi: number): string {
  const first = samples[0]
  const last = samples.at(-1)
  if (!first || !last) return ''
  return `M${laneX(first.minute)},100 L${samples.map(s => `${laneX(s.minute)},${laneY(s.value, lo, hi)}`).join(' L')} L${laneX(last.minute)},100 Z`
}

/** Pump-run ticks: short bars up from the baseline. */
export const laneTicks = (minutes: number[]) => minutes.map(m => `M${laneX(m)} 100 V62`).join(' ')

/** Whether an ISO time falls between local midnight and `now`. */
export function isToday(iso: string, now: Date): boolean {
  const t = Date.parse(iso)
  return t >= startOfDay(now).getTime() && t <= now.getTime()
}

/** Telemetry points from today, as wall-clock minutes of the day (right across a DST change). */
export function todaySamples(points: ReadonlyArray<{ ts: string, value: number }>, now: Date): Sample[] {
  return points.filter(p => isToday(p.ts, now)).map(p => ({ minute: minuteOfDay(new Date(p.ts)), value: p.value }))
}

/** A whole-number range around the values with at least `minSpan` between the ends, clamped to [floor, ceil]. */
export function niceRange(values: number[], minSpan: number, pad: number, floor = -Infinity, ceil = Infinity): [number, number] {
  if (!values.length) return [Math.max(floor, 0), Math.min(ceil, minSpan)]
  let lo = Math.floor(Math.min(...values) - pad)
  let hi = Math.ceil(Math.max(...values) + pad)
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2
    lo = Math.floor(mid - minSpan / 2)
    hi = lo + minSpan
  }
  // Slide the window back inside the bounds rather than squash it.
  if (hi > ceil) [lo, hi] = [lo - (hi - ceil), ceil]
  if (lo < floor) [lo, hi] = [floor, hi + (floor - lo)]
  return [lo, Math.min(ceil, hi)]
}

/** The light lane: solid up to now, ending at the light's current level, dashed from now to midnight. */
export function lightSeries(curve: Array<{ minute: number, level: number | null }>, nowMin: number, current: number | null): { past: Sample[], future: Sample[] } {
  const pts = curve.map(c => ({ minute: c.minute, value: c.level ?? 0 }))
  if (!pts.length) return { past: current === null ? [] : [{ minute: nowMin, value: current }], future: [] }
  const at = (m: number) => {
    const i = pts.findIndex(p => p.minute > m)
    const b = i === -1 ? { minute: DAY_MIN, value: (pts[0] as Sample).value } : pts[i] as Sample
    const a = i <= 0 ? pts.at(-1) as Sample : pts[i - 1] as Sample
    return b.minute === a.minute ? a.value : a.value + (b.value - a.value) * ((m - a.minute) / (b.minute - a.minute))
  }
  const planned = at(nowMin)
  const past = [...pts.filter(p => p.minute < nowMin), { minute: nowMin, value: current ?? planned }]
  const future = [{ minute: nowMin, value: planned }, ...pts.filter(p => p.minute > nowMin), { minute: DAY_MIN, value: (pts[0] as Sample).value }]
  return { past, future }
}

/** Highest level of several 96-sample curves, sample by sample (as the scheduler picks). */
export function mergeCurves(curves: ReadonlyArray<ReadonlyArray<{ minute: number, level: number | null }>>): Array<{ minute: number, level: number | null }> {
  const first = curves[0]
  if (!first) return []
  return first.map((p, i) => ({ minute: p.minute, level: Math.max(...curves.map(c => c[i]?.level ?? 0)) }))
}

export type EventTone = 'muted' | 'light' | 'down' | 'pump' | 'planned'
/** Something that happened today: at `minute`, or from `minute` to `until` (an alert while it was raised). */
export interface LaneEvent { minute: number, until?: number, label: string, tone: EventTone }
export interface EventRow { label: string, tone: EventTone, marks: LaneEvent[] }

/**
 * The day's events as rows, one per label in the order each first happened,
 * so a kind that repeats all day is one row of marks rather than a label for
 * each. Past `max` rows the rest share an Other row.
 */
export function eventRows(events: LaneEvent[], max = 6): EventRow[] {
  const rows = new Map<string, EventRow>()
  for (const e of [...events].sort((a, b) => a.minute - b.minute)) {
    const row = rows.get(e.label) ?? { label: e.label, tone: e.tone, marks: [] }
    row.marks.push(e)
    rows.set(e.label, row)
  }
  const all = [...rows.values()]
  if (all.length <= max) return all
  const rest = all.slice(max - 1)
  return [...all.slice(0, max - 1), { label: 'Other', tone: 'muted', marks: rest.flatMap(r => r.marks).sort((a, b) => a.minute - b.minute) }]
}

/** Collapse runs of the same rule closer than `gapMin` into the first of each burst. */
export function burstStarts<T extends { key: string | number, minute: number }>(items: T[], gapMin = 30): T[] {
  const last = new Map<string | number, number>()
  return [...items].sort((a, b) => a.minute - b.minute).filter((it) => {
    const prev = last.get(it.key)
    last.set(it.key, it.minute)
    return prev === undefined || it.minute - prev > gapMin
  })
}

/** `main@1a2b3c4` → channel `main`, build `1a2b3c4`; a checkout without `.git-info` reads `dev`. */
export function coreBuild(version: string): { build: string, channel: string } {
  const at = version.indexOf('@')
  return at === -1 ? { build: 'local', channel: version } : { build: version.slice(at + 1, at + 8), channel: version.slice(0, at) }
}

/** `4d 6h`, `3h 12m`, `8m`. */
export function fmtUptime(s: number): string {
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d ${h % 24}h`
  if (h > 0) return `${h}h ${m % 60}m`
  return `${m}m`
}

/** `just now`, `12m ago`, `2h 5m ago`, `3d ago`. */
export function fmtAgo(iso: string, now: number): string {
  const m = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ${m % 60}m ago`
  return `${Math.floor(m / 1440)}d ago`
}

/** `in 2h 14m`, `in 25m`. */
export function fmtIn(minutes: number): string {
  const m = Math.max(1, Math.round(minutes))
  return m < 60 ? `in ${m}m` : `in ${Math.floor(m / 60)}h ${m % 60}m`
}

/** Wi-Fi bars lit out of four for a 0–100 signal. */
export const wifiBars = (signal: number) => Math.max(0, Math.min(4, Math.ceil(signal / 25)))

/** "Kitchen Gardyn is healthy", "… has one issue", "… has 3 issues", and the worst check under it. */
export function healthHeadline(unit: string, checks: ReadonlyArray<SystemCheck>, worst: SystemCheck | null): { title: string, sub: string } {
  const issues = checks.filter(c => c.state === 'down' || c.state === 'stalled').length
  if (!issues || !worst) return { title: `${unit} is healthy`, sub: checks.length ? `All ${checks.length} checks passing` : 'Checking…' }
  return { title: `${unit} has ${issues === 1 ? 'one issue' : `${issues} issues`}`, sub: `${worst.label}: ${worst.detail}` }
}

/** The next thing on today's schedule after `nowMin`: a light setpoint or a pump run. */
export function nextJob(setpoints: Array<{ minute: number, level: number }>, pumpMinutes: number[], nowMin: number): { minute: number, label: string } | null {
  const light = setpoints.filter(s => s.minute > nowMin).sort((a, b) => a.minute - b.minute)[0]
  const pump = pumpMinutes.filter(m => m > nowMin).sort((a, b) => a - b)[0]
  if (light && (pump === undefined || light.minute <= pump)) return { minute: light.minute, label: `light → ${light.level}% at ${fmtClock(light.minute)}` }
  if (pump !== undefined) return { minute: pump, label: `pump at ${fmtClock(pump)}` }
  return null
}

/** Polyline points for a 200×40 sparkline over [from, to] ms. */
export function sparkline(points: ReadonlyArray<{ t: number, value: number }>, from: number, to: number, lo: number, hi: number): string {
  return points
    .filter(p => p.t >= from && p.t <= to)
    .map(p => `${Math.round(((p.t - from) / (to - from)) * 2000) / 10},${Math.round((40 - ((p.value - lo) / (hi - lo || 1)) * 40) * 10) / 10}`)
    .join(' ')
}
