import { describe, expect, it } from 'vitest'
import { binRange, DAY_POINTS, DAY_TICKS, dayIndexAfter, interpAt, lightData, normalise, ownRange, podsData, resampleArray, RIDGE_POINTS, sensorsData, tankData, todayData } from '../shape'

const NaN_ = Number.NaN

describe('resampling and ranges', () => {
  it('resamples linearly and keeps gaps', () => {
    expect(resampleArray([0, 10], 3)).toEqual([0, 5, 10])
    expect(resampleArray([], 2)).toEqual([NaN_, NaN_])
    expect(resampleArray([4], 3)).toEqual([4, 4, 4])
    expect(resampleArray([1, 2, 3], 0)).toEqual([])
    expect(resampleArray([1, 2], 1)).toEqual([1])
    // Next to a gap, a point takes its nearer neighbour; half way, the later one.
    expect(resampleArray([0, NaN_, 10], 5)).toEqual([0, NaN_, NaN_, 10, 10])
    expect(resampleArray([0, NaN_], 4)).toEqual([0, 0, NaN_, NaN_])
    expect(resampleArray([NaN_, 4], 3)).toEqual([NaN_, 4, 4])
  })

  it('bins points onto a fixed window, averaging, bridging short gaps and leaving long ones', () => {
    const pts = [{ x: 0, y: 2 }, { x: 0.2, y: 4 }, { x: 10, y: 10 }, { x: 99, y: 1 }]
    const out = binRange(pts, 0, 10, 11, 2)
    expect(out[0]).toBe(3)
    expect(out[10]).toBe(10)
    expect(out[5]).toBeNaN()
    expect(binRange([{ x: 0, y: 0 }, { x: 3, y: 3 }], 0, 10, 11, 2)).toEqual([0, 1, 2, 3, NaN_, NaN_, NaN_, NaN_, NaN_, NaN_, NaN_])
    expect(binRange([{ x: 5, y: Number.POSITIVE_INFINITY }, { x: NaN_, y: 1 }], 0, 10, 3)).toEqual([NaN_, NaN_, NaN_])
    expect(binRange([{ x: 5, y: 7 }], 0, 10, 1)).toEqual([7])
  })

  it('normalises into 0..1, clamped, a flat range to the middle', () => {
    expect(normalise([0, 5, 10, 20, NaN_], 0, 10)).toEqual([0, 0.5, 1, 1, NaN_])
    expect(normalise([3], 3, 3)).toEqual([0.5])
  })

  it('pads a series\' own range and gives a flat one room', () => {
    expect(ownRange([0, 10])).toEqual([-1, 11])
    expect(ownRange([4, 4])).toEqual([3, 5])
    expect(ownRange([NaN_])).toEqual([0, 1])
  })

  it('reads minute samples between neighbours and nothing outside them', () => {
    const s = [{ minute: 0, value: 0 }, { minute: 60, value: 60 }, { minute: 60, value: 80 }]
    expect(interpAt(s, 30)).toBe(30)
    expect(interpAt(s, 60)).toBe(60)
    expect(interpAt(s, 61)).toBeNaN()
    expect(interpAt([], 1)).toBeNaN()
    expect(interpAt([{ minute: 5, value: 1 }], 5)).toBe(1)
  })

  it('finds the first sample after now', () => {
    expect(dayIndexAfter(0)).toBe(1)
    expect(dayIndexAfter(720)).toBe(49)
    expect(dayIndexAfter(1440)).toBe(DAY_POINTS)
  })
})

describe('todayData', () => {
  const day = todayData({
    nowMin: 720,
    light: { past: [{ minute: 0, value: 0 }, { minute: 360, value: 100 }, { minute: 720, value: 40 }], future: [{ minute: 720, value: 100 }, { minute: 1440, value: 0 }] },
    tank: [{ minute: 0, value: 50 }, { minute: 700, value: 40 }],
    tankRange: [20, 60],
    air: [{ minute: 600, value: 22 }],
    airRange: [20, 28],
    events: [{ minute: 300, label: 'Backup', tone: 'muted' }, { minute: 100, label: 'Water low', tone: 'down' }, { minute: 200, label: 'Dim', tone: 'light' }],
    pumpPast: [480],
    pumpFuture: [1000],
  })

  it('has the light solid to now at the level now, and its plan after, dimmed', () => {
    const light = day.lanes[0]
    expect(light?.values[0]).toBe(0)
    expect(light?.values[24]).toBe(1)
    expect(light?.values[48]).toBeCloseTo(0.4)
    expect(light?.values[49]).toBeCloseTo((100 - (735 - 720) / 720 * 100) / 100)
    expect(light?.dimFrom).toBe(49)
    expect(light?.sub).toBe('0–100%')
  })

  it('has the tank and air up to now in their ranges, and nothing after', () => {
    const [, water, air] = day.lanes
    expect(water?.values[0]).toBeCloseTo(0.75)
    expect(water?.values[47]).toBeCloseTo(0.5)
    expect(water?.values[60]).toBeNaN()
    expect(water?.sub).toBe('tank 20–60%')
    expect(air?.values[40]).toBeCloseTo(0.25)
    expect(air?.sub).toBe('20–28°C')
  })

  it('puts events in time order, pump runs green and runs still to come unlabelled', () => {
    expect(day.events.map(e => [Math.round(e.at * 1440), e.tone, e.label])).toEqual([
      [100, 'orange', 'Water low'], [200, 'amber', 'Dim'], [300, 'muted', 'Backup'], [480, 'green', 'Pump'], [1000, 'muted', ''],
    ])
    expect(day.now).toBe(0.5)
    expect(day.ticks).toBe(DAY_TICKS)
  })
})

describe('tankData', () => {
  it('normalises the level, places top-ups along it and labels now and the cutoff', () => {
    const t = tankData({ levels: [80, 60, 90, 70, NaN_], topUps: [2, 9], cutoffPct: 25, currentPct: 41.6, ticks: [] })
    expect(t.levels.slice(0, 4)).toEqual([0.8, 0.6, 0.9, 0.7])
    expect(t.topUps).toEqual([0.5])
    expect(t.cutoff).toBe(0.25)
    expect(t.current).toBeCloseTo(0.416)
    expect(t.currentLabel).toBe('42%')
    expect(t.cutoffLabel).toBe('cutoff 25%')
    expect(t.pumping).toBe(false)
    expect(tankData({ levels: [1, 2], topUps: [], cutoffPct: null, currentPct: null, ticks: [], pumping: true }).pumping).toBe(true)
  })

  it('falls back to the last level for now, and says so when there is none', () => {
    expect(tankData({ levels: [10, 30], topUps: [], cutoffPct: null, currentPct: null, ticks: [] })).toMatchObject({ current: 0.3, currentLabel: '30%', cutoff: null, cutoffLabel: null })
    expect(tankData({ levels: [], topUps: [], cutoffPct: null, currentPct: null, ticks: [] })).toMatchObject({ current: null, currentLabel: '—' })
    expect(tankData({ levels: [5], topUps: [0], cutoffPct: null, currentPct: 120, ticks: [] })).toMatchObject({ current: 1, topUps: [0] })
  })
})

describe('lightData', () => {
  const planned = Array.from({ length: 97 }, (_, i) => (i >= 24 && i < 84 ? 100 : 0))

  it('follows the plan up to now and ends at the level now', () => {
    const l = lightData({ planned, nowMin: 720, level: 80, hold: null })
    expect(l.actual[30]).toBe(1)
    expect(l.actual[48]).toBe(0.8)
    expect(l.actual[49]).toBeNaN()
    expect(l.planned[49]).toBe(1)
    expect(l.hold).toBeNull()
    expect(l.now).toBe(0.5)
    expect(l.nowLevel).toBe(0.8)
    expect(l.nowLabel).toBe('80%')
  })

  it('holds at the level now from the hold\'s start, and drops a hold that has ended', () => {
    const l = lightData({ planned, nowMin: 720, level: 30, hold: { fromMin: 600, untilMin: 2000 } })
    expect(l.hold).toEqual({ from: 600 / 1440, until: 1 })
    expect(l.actual[39]).toBe(1)
    expect(l.actual[40]).toBe(0.3)
    expect(lightData({ planned, nowMin: 720, level: 30, hold: { fromMin: 600, untilMin: 500 } }).hold).toBeNull()
    expect(lightData({ planned: [0, 100], nowMin: 0, level: 0, hold: null }).planned).toHaveLength(97)
  })
})

describe('podsData', () => {
  it('splits pods into towers top to bottom, empty and unmeasured as null, cover clamped', () => {
    const pods = Array.from({ length: 30 }, (_, i) => ({ slot: 30 - i, empty: (30 - i) % 7 === 0, cover: (30 - i) === 5 ? null : (30 - i) === 6 ? 1.4 : 0.1 }))
    const d = podsData(pods, 3)
    expect(d.towers.map(t => t.label)).toEqual(['Tower A', 'Tower B', 'Tower C'])
    expect(d.towers.map(t => t.pods.length)).toEqual([10, 10, 10])
    expect(d.towers[0]?.pods[4]).toBeNull()
    expect(d.towers[0]?.pods[5]).toBe(1)
    expect(d.towers[0]?.pods[6]).toBeNull()
    expect(d.towers[1]?.pods[0]).toBe(0.1)
    expect(podsData([], 3).towers).toEqual([])
    expect(podsData([{ slot: 1, empty: false, cover: 0.2 }], 0).towers).toHaveLength(1)
  })
})

describe('sensorsData', () => {
  it('bins each history over the window in its own range, grouping pump and water quality', () => {
    const from = Date.parse('2026-11-10T00:00:00Z')
    const to = from + 3_600_000
    const at = (min: number) => new Date(from + min * 60_000).toISOString()
    const d = sensorsData([
      { key: 'air_temp', label: 'Air', group: 'environment', current: '22 °C', samples: [{ ts: at(0), value: 20 }, { ts: at(60), value: 24 }] },
      { key: 'ph', label: 'pH', group: 'water-quality', current: '6', samples: [] },
      { key: 'pump_w', label: 'Pump power', group: 'power', current: '0 W', samples: [{ ts: at(30), value: 5 }] },
    ], from, to, [])
    const air = d.series[0]
    expect(air?.values).toHaveLength(RIDGE_POINTS)
    // 20–24 padded by a tenth each side: 19.6–24.4.
    expect(air?.values[0]).toBeCloseTo(0.4 / 4.8)
    expect(air?.values.at(-1)).toBeCloseTo(4.4 / 4.8)
    expect(d.series.map(s => s.group)).toEqual(['environment', 'water', 'pump'])
    expect(d.series[1]?.values.every(Number.isNaN)).toBe(true)
    expect(d.series[2]?.values.filter(Number.isFinite)).toEqual([0.5])
    expect(d.series[2]?.current).toBe('0 W')
  })
})
