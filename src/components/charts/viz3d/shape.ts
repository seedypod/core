/**
 * What each 3D chart draws, built from the API's shapes: every series
 * resampled onto an even grid and normalised to 0..1 (NaN is a gap), every
 * position along the x axis a fraction 0..1, and labels as ready strings, so
 * the scenes only place things.
 */
import { fmtClock } from '@/src/components/charts/format'
import { bridge } from '@/src/components/charts/TimeChart'
import { podPlaces } from '@/src/components/Grow/towerLayout'
import { BOOST_LEVEL } from '@/src/scheduler/lightPlan'
import type { SensorMeta } from '@/src/lib/sensorMeta'

/** The chart colours by role; each scene resolves them from the theme's tokens. */
export type Tone = 'cream' | 'amber' | 'blue' | 'green' | 'orange' | 'muted'

export interface Tick { at: number, label: string }

export interface Lane { key: string, label: string, sub: string, tone: Tone, values: number[], /** From this index on the lane is a plan, drawn dimmer. */ dimFrom?: number }
export interface DayEvent { at: number, tone: Tone, label: string }
export interface TodayData { now: number, lanes: Lane[], events: DayEvent[], ticks: Tick[] }

/** The words on the tank's scale: full, the level now, the pump cutoff and empty, each with its depth; `short` for a narrow card. */
export interface TankMarks { full: string, now: string, cutoff: string | null, empty: string, short?: Omit<TankMarks, 'short'> }
export interface TankData {
  levels: number[]
  topUps: number[]
  cutoff: number | null
  current: number | null
  ticks: Tick[]
  marks: TankMarks
  /** The water is down in the reserve under the cutoff, so the pump won't start. */
  low: boolean
  /** The pump is running now. */
  pumping: boolean
  /** Where along the window this run began (0..1): from there the line is the water this run drew down. */
  runFrom: number | null
  /** Scheduled runs in the window, as fractions along it. */
  runs: number[]
  /** Runs still to come today, as fractions of the rest of the day (0 now, 1 midnight). */
  upcoming: number[]
}

export interface LightData {
  planned: number[]
  actual: number[]
  hold: { from: number, until: number } | null
  now: number
  nowLevel: number
  /** The time now, for the lamp's "now" tick. */
  nowTime: string
  /** Gardyn's Boost level (0..1), the one reference line across the chart and the lamp. */
  boost: number
  ticks: Tick[]
}

export interface PodsData { towers: Array<{ label: string, pods: Array<number | null> }> }

export type SensorGroup = 'environment' | 'water' | 'pump'
export interface Ridge { key: string, label: string, group: SensorGroup, values: number[], current: string }
export interface SensorsData { series: Ridge[], ticks: Tick[] }

const DAY_MIN = 1440
/** Today and Light sample every 15 minutes, midnight to midnight. */
export const DAY_POINTS = 97
const dayMinute = (i: number) => (i / (DAY_POINTS - 1)) * DAY_MIN

export const DAY_TICKS: Tick[] = [0, 6, 12, 18, 24].map(h => ({ at: h / 24, label: `${String(h).padStart(2, '0')}:00` }))

/** Linear resample of an array to `n` points; gaps (NaN) stay gaps. */
export function resampleArray(values: number[], n: number): number[] {
  if (n <= 0) return []
  if (values.length === 0) return new Array<number>(n).fill(Number.NaN)
  if (values.length === 1 || n === 1) return new Array<number>(n).fill(values[0] as number)
  return Array.from({ length: n }, (_, i) => {
    const x = (i / (n - 1)) * (values.length - 1)
    const a = Math.floor(x)
    const b = Math.min(values.length - 1, a + 1)
    const va = values[a] as number
    const vb = values[b] as number
    if (!Number.isFinite(va)) return x - a < 0.5 || !Number.isFinite(vb) ? va : vb
    if (!Number.isFinite(vb)) return x - a < 0.5 ? va : vb
    return va + (vb - va) * (x - a)
  })
}

/** The mean of the points in each of `n` even bins over [x0, x1]; empty bins are NaN, short runs bridged. */
export function binRange(points: ReadonlyArray<{ x: number, y: number }>, x0: number, x1: number, n: number, maxGap = Math.max(2, Math.round(n / 24))): number[] {
  const sum = new Array<number>(n).fill(0)
  const count = new Array<number>(n).fill(0)
  const width = n > 1 ? (x1 - x0) / (n - 1) : 1
  for (const p of points) {
    if (!Number.isFinite(p.y) || !Number.isFinite(p.x) || p.x < x0 - width / 2 || p.x > x1 + width / 2) continue
    const i = Math.min(n - 1, Math.max(0, Math.round((p.x - x0) / width)))
    sum[i] = (sum[i] as number) + p.y
    count[i] = (count[i] as number) + 1
  }
  return bridge(sum.map((v, i) => ((count[i] as number) > 0 ? v / (count[i] as number) : Number.NaN)), maxGap)
}

/** Values mapped from [lo, hi] onto 0..1 and clamped; gaps stay gaps. */
export function normalise(values: number[], lo: number, hi: number): number[] {
  const span = hi - lo
  return values.map(v => (Number.isFinite(v) ? (span > 0 ? Math.max(0, Math.min(1, (v - lo) / span)) : 0.5) : Number.NaN))
}

/** A series' own range with a margin, so its line sits off the floor and the top; a flat series sits mid-height. */
export function ownRange(values: number[], pad = 0.1): [number, number] {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0) return [0, 1]
  const lo = Math.min(...finite)
  const hi = Math.max(...finite)
  if (hi === lo) return [lo - 1, hi + 1]
  const m = (hi - lo) * pad
  return [lo - m, hi + m]
}

/** The value of minute-of-day samples at `minute`, linear between neighbours; NaN outside them. */
export function interpAt(samples: ReadonlyArray<{ minute: number, value: number }>, minute: number): number {
  const first = samples[0]
  const last = samples.at(-1)
  if (!first || !last || minute < first.minute || minute > last.minute) return Number.NaN
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1] as { minute: number, value: number }
    const b = samples[i] as { minute: number, value: number }
    if (minute <= b.minute) return b.minute === a.minute ? b.value : a.value + (b.value - a.value) * ((minute - a.minute) / (b.minute - a.minute))
  }
  return last.value
}

/** Index of the first day sample after `nowMin`. */
export const dayIndexAfter = (nowMin: number) => Math.min(DAY_POINTS, Math.floor((nowMin / DAY_MIN) * (DAY_POINTS - 1)) + 1)

interface MinuteSample { minute: number, value: number }

/**
 * Today's lanes: the light solid to now and its plan after (0–100%), the tank
 * and the air to now in their own ranges, and the day's events with pump runs
 * (done and still to come) among them.
 */
export function todayData(input: {
  nowMin: number
  light: { past: MinuteSample[], future: MinuteSample[] }
  tank: MinuteSample[]
  tankRange: [number, number]
  air: MinuteSample[]
  airRange: [number, number]
  events: Array<{ minute: number, label: string, tone: 'muted' | 'light' | 'down' }>
  pumpPast: number[]
  pumpFuture: number[]
}): TodayData {
  const after = dayIndexAfter(input.nowMin)
  const grid = Array.from({ length: DAY_POINTS }, (_, i) => dayMinute(i))
  const light = grid.map((m, i) => (i < after ? interpAt(input.light.past, Math.min(m, input.nowMin)) : interpAt(input.light.future, m)) / 100)
  const toNow = (s: MinuteSample[]) => binRange(s.map(p => ({ x: p.minute, y: p.value })), 0, DAY_MIN, DAY_POINTS, 4).map((v, i) => (i < after ? v : Number.NaN))
  const TONE = { muted: 'muted', light: 'amber', down: 'orange' } as const
  const events: DayEvent[] = [
    ...input.pumpPast.map(m => ({ at: m / DAY_MIN, tone: 'green' as const, label: 'Pump' })),
    ...input.pumpFuture.map(m => ({ at: m / DAY_MIN, tone: 'muted' as const, label: '' })),
    ...input.events.map(e => ({ at: e.minute / DAY_MIN, tone: TONE[e.tone], label: e.label })),
  ].sort((a, b) => a.at - b.at)
  return {
    now: input.nowMin / DAY_MIN,
    lanes: [
      { key: 'light', label: 'Light', sub: '0–100%', tone: 'amber', values: light, dimFrom: after },
      { key: 'water', label: 'Water', sub: `tank ${input.tankRange[0]}–${input.tankRange[1]}%`, tone: 'blue', values: normalise(toNow(input.tank), ...input.tankRange) },
      { key: 'air', label: 'Air', sub: `${input.airRange[0]}–${input.airRange[1]}°C`, tone: 'cream', values: normalise(toNow(input.air), ...input.airRange) },
    ],
    events,
    ticks: DAY_TICKS,
  }
}

/** The tank over its window (0–100%), its top-ups, the pump cutoff, where it is now (and whether that's under the cutoff), scheduled runs done and to come, and, while the pump runs, where the run began. */
export function tankData(input: { levels: number[], topUps: number[], cutoffPct: number | null, currentPct: number | null, ticks: Tick[], marks: TankMarks, low?: boolean, pumping?: boolean, runFrom?: number | null, runs?: number[], upcoming?: number[] }): TankData {
  const finite = input.levels.filter(Number.isFinite)
  const current = input.currentPct ?? finite.at(-1) ?? null
  return {
    levels: normalise(input.levels, 0, 100),
    topUps: input.topUps.filter(i => i >= 0 && i < input.levels.length).map(i => (input.levels.length > 1 ? i / (input.levels.length - 1) : 0)),
    cutoff: input.cutoffPct === null ? null : input.cutoffPct / 100,
    current: current === null ? null : Math.max(0, Math.min(1, current / 100)),
    ticks: input.ticks,
    marks: input.marks,
    low: input.low ?? false,
    pumping: input.pumping ?? false,
    runFrom: input.pumping && input.runFrom != null ? Math.max(0, Math.min(1, input.runFrom)) : null,
    runs: (input.runs ?? []).filter(r => r >= 0 && r <= 1),
    upcoming: (input.upcoming ?? []).filter(r => r > 0 && r <= 1),
  }
}

/**
 * Today's planned light (0–100% every 15 min) and what the LED actually gave
 * up to now: the plan, except from a manual hold's start, where it's held at
 * the level now. core keeps no history of the light's level, so this is the
 * best record there is.
 */
export function lightData(input: { planned: number[], nowMin: number, level: number, hold: { fromMin: number, untilMin: number } | null }): LightData {
  const after = dayIndexAfter(input.nowMin)
  const planned = resampleArray(input.planned, DAY_POINTS)
  const hold = input.hold && input.hold.untilMin > input.hold.fromMin
    ? { from: Math.max(0, input.hold.fromMin) / DAY_MIN, until: Math.min(DAY_MIN, input.hold.untilMin) / DAY_MIN }
    : null
  const actual = planned.map((v, i) => {
    const m = dayMinute(i)
    if (i >= after) return Number.NaN
    return hold && m >= hold.from * DAY_MIN ? input.level : v
  })
  // The last point lands on now itself, at the level now.
  if (after > 0) actual[after - 1] = input.level
  return {
    planned: planned.map(v => v / 100),
    actual: actual.map(v => v / 100),
    hold,
    now: input.nowMin / DAY_MIN,
    nowLevel: input.level / 100,
    nowTime: fmtClock(Math.floor(input.nowMin)),
    boost: BOOST_LEVEL / 100,
    ticks: DAY_TICKS,
  }
}

/**
 * The pods down each of the tower's columns, top to bottom, as the tower
 * places them (towerLayout: slots count across the columns, then down): a
 * leaf-cover fraction, or null for an empty or unmeasured pod. A Home's 30
 * make three columns of 10, a Studio's 16 two of 8.
 */
export function podsData(pods: ReadonlyArray<{ slot: number, empty: boolean, cover: number | null }>): PodsData {
  // Sized for the highest slot, so a list with gaps still lands each pod where the tower has it.
  const places = podPlaces(Math.max(pods.length, ...pods.map(p => p.slot)))
  const columns = Math.max(0, ...places.map(p => p.column + 1))
  const towers: PodsData['towers'] = Array.from({ length: columns }, (_, c) => ({ label: `Tower ${c + 1}`, pods: places.filter(p => p.column === c).map(() => null) }))
  for (const p of pods) {
    const place = places.find(pl => pl.slot === p.slot)
    const tower = place && towers[place.column]
    if (tower && place) tower.pods[place.row] = p.empty || p.cover === null ? null : Math.max(0, Math.min(1, p.cover))
  }
  return { towers }
}

const GROUP: Record<SensorMeta['group'], SensorGroup> = { 'environment': 'environment', 'water': 'water', 'water-quality': 'water', 'power': 'pump' }
export const RIDGE_POINTS = 100

/** Each sensor's history over [from, to] as a ridge in its own range, with its reading now. */
export function sensorsData(series: ReadonlyArray<{ key: string, label: string, group: SensorMeta['group'], current: string, samples: ReadonlyArray<{ ts: string, value: number }> }>, from: number, to: number, ticks: Tick[]): SensorsData {
  return {
    series: series.map((s) => {
      const values = binRange(s.samples.map(p => ({ x: Date.parse(p.ts), y: p.value })), from, to, RIDGE_POINTS)
      return { key: s.key, label: s.label, group: GROUP[s.group], current: s.current, values: normalise(values, ...ownRange(values)) }
    }),
    ticks,
  }
}
