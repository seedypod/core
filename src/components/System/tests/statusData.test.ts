import { describe, expect, it } from 'vitest'
import type { SystemCheck } from '../checkState'
import {
  burstStarts, coreBuild, fmtAgo, fmtIn, fmtUptime, healthHeadline, laneArea, lanePoints, laneTicks, laneX, layoutEvents, lightSeries, mergeCurves, minuteOfDay, nextJob,
  niceRange, sparkline, todaySamples, wifiBars,
} from '../statusData'

const check = (state: SystemCheck['state'], label = 'Cameras', detail = 'lower camera returned 0 bytes'): SystemCheck => ({ id: label, label, state, detail, since: null })

describe('lane geometry', () => {
  it('maps minutes across 1000 and values down 100', () => {
    expect(laneX(720)).toBe(500)
    expect(lanePoints([{ minute: 0, value: 0 }, { minute: 1440, value: 100 }], 0, 100)).toBe('0,100 1000,0')
    expect(lanePoints([{ minute: 360, value: 5 }], 5, 5)).toBe('250,100')
    expect(laneArea([{ minute: 0, value: 50 }, { minute: 720, value: 100 }], 0, 100)).toBe('M0,100 L0,50 L500,0 L500,100 Z')
    expect(laneArea([], 0, 100)).toBe('')
    expect(laneTicks([360, 720])).toBe('M250 100 V62 M500 100 V62')
  })

  it('keeps only today up to now, as minutes past midnight', () => {
    const now = new Date(2026, 10, 1, 12, 0)
    const at = (h: number) => new Date(2026, 10, 1, h).toISOString()
    expect(todaySamples([{ ts: new Date(2026, 9, 31, 23).toISOString(), value: 1 }, { ts: at(6), value: 2 }, { ts: at(13), value: 3 }], now)).toEqual([{ minute: 360, value: 2 }])
    expect(minuteOfDay(new Date(2026, 10, 1, 6, 30, 30))).toBe(390.5)
  })

  it('pads a range to whole numbers with a minimum span, clamped', () => {
    expect(niceRange([70, 90], 20, 5, 0, 100)).toEqual([65, 95])
    expect(niceRange([22, 22.5], 6, 1)).toEqual([19, 25])
    expect(niceRange([97], 20, 5, 0, 100)).toEqual([80, 100])
    expect(niceRange([1], 20, 5, 0, 100)).toEqual([0, 20])
    expect(niceRange([], 20, 5, 0, 100)).toEqual([0, 20])
  })

  it('draws the light solid to now ending at the real level, dashed from the plan onward', () => {
    const curve = [{ minute: 0, level: 0 }, { minute: 360, level: 80 }, { minute: 720, level: 80 }, { minute: 1080, level: null }]
    const { past, future } = lightSeries(curve, 540, 49)
    expect(past).toEqual([{ minute: 0, value: 0 }, { minute: 360, value: 80 }, { minute: 540, value: 49 }])
    expect(future).toEqual([{ minute: 540, value: 80 }, { minute: 720, value: 80 }, { minute: 1080, value: 0 }, { minute: 1440, value: 0 }])
    expect(lightSeries(curve, 1200, null).future[0]).toEqual({ minute: 1200, value: 0 })
    expect(lightSeries(curve, 1200, null).past.at(-1)).toEqual({ minute: 1200, value: 0 })
    expect(lightSeries([{ minute: 0, level: 30 }], 600, null).future[0]).toEqual({ minute: 600, value: 30 })
    expect(lightSeries([], 600, 20)).toEqual({ past: [{ minute: 600, value: 20 }], future: [] })
    expect(lightSeries([], 600, null)).toEqual({ past: [], future: [] })
  })

  it('takes the highest curve sample by sample', () => {
    expect(mergeCurves([[{ minute: 0, level: 10 }, { minute: 15, level: null }], [{ minute: 0, level: 5 }, { minute: 15, level: 40 }]])).toEqual([{ minute: 0, level: 10 }, { minute: 15, level: 40 }])
    expect(mergeCurves([])).toEqual([])
  })

  it('scales a sparkline into 200×40 over its window', () => {
    expect(sparkline([{ t: 0, value: 0 }, { t: 50, value: 10 }, { t: 100, value: 5 }, { t: 200, value: 1 }], 0, 100, 0, 10)).toBe('0,40 100,0 200,20')
  })
})

describe('events lane', () => {
  it('puts a label on the second row when it would hit its neighbour, and back on the first when there is room', () => {
    const placed = layoutEvents([
      { minute: 690, label: 'Autopilot +5%', tone: 'light' },
      { minute: 180, label: 'Backup', tone: 'muted' },
      { minute: 700, label: 'Lower cam lost', tone: 'down' },
      { minute: 710, label: 'Third', tone: 'muted' },
      { minute: 1200, label: 'Later', tone: 'muted' },
    ], 800)
    expect(placed.map(p => [p.label, p.row])).toEqual([['Backup', 0], ['Autopilot +5%', 0], ['Lower cam lost', 1], ['Third', 0], ['Later', 0]])
    expect(placed[0]?.leftPct).toBe(12.5)
  })

  it('keeps the first of each burst per rule', () => {
    const runs = [{ key: 1, minute: 600 }, { key: 1, minute: 610 }, { key: 2, minute: 615 }, { key: 1, minute: 700 }]
    expect(burstStarts(runs)).toEqual([{ key: 1, minute: 600 }, { key: 2, minute: 615 }, { key: 1, minute: 700 }])
  })
})

describe('wording', () => {
  it('splits the pinned build into channel and commit', () => {
    expect(coreBuild('main@1a2b3c4d5e')).toEqual({ build: '1a2b3c4', channel: 'main' })
    expect(coreBuild('dev')).toEqual({ build: 'local', channel: 'dev' })
  })

  it('formats uptime, ages and countdowns', () => {
    expect(fmtUptime(4 * 86400 + 6 * 3600 + 120)).toBe('4d 6h')
    expect(fmtUptime(3 * 3600 + 12 * 60)).toBe('3h 12m')
    expect(fmtUptime(480)).toBe('8m')
    const now = Date.parse('2026-11-01T12:00:00Z')
    expect(fmtAgo('2026-11-01T12:00:00Z', now)).toBe('just now')
    expect(fmtAgo('2026-11-01T11:48:00Z', now)).toBe('12m ago')
    expect(fmtAgo('2026-11-01T09:55:00Z', now)).toBe('2h 5m ago')
    expect(fmtAgo('2026-10-28T12:00:00Z', now)).toBe('4d ago')
    expect(fmtIn(25)).toBe('in 25m')
    expect(fmtIn(134)).toBe('in 2h 14m')
    expect(fmtIn(0.2)).toBe('in 1m')
  })

  it('lights Wi-Fi bars by quarter', () => {
    expect([0, 1, 25, 26, 72, 100, 140].map(wifiBars)).toEqual([0, 1, 1, 2, 3, 4, 4])
  })

  it('heads the strip with the unit and its issues, the worst check under it', () => {
    expect(healthHeadline('Kitchen Gardyn', [check('ok'), check('idle')], null)).toEqual({ title: 'Kitchen Gardyn is healthy', sub: 'All 2 checks passing' })
    expect(healthHeadline('Kitchen Gardyn', [], null).sub).toBe('Checking…')
    expect(healthHeadline('K', [check('ok'), check('down')], check('down'))).toEqual({ title: 'K has one issue', sub: 'Cameras: lower camera returned 0 bytes' })
    expect(healthHeadline('K', [check('stalled'), check('down')], check('down')).title).toBe('K has 2 issues')
  })

  it('names the next job: a light setpoint or a pump run, whichever is first', () => {
    expect(nextJob([{ minute: 1260, level: 30 }, { minute: 360, level: 80 }], [1200], 1100)).toEqual({ minute: 1200, label: 'pump at 20:00' })
    expect(nextJob([{ minute: 1260, level: 30 }], [1300], 1100)).toEqual({ minute: 1260, label: 'light → 30% at 21:00' })
    expect(nextJob([], [], 1100)).toBeNull()
  })
})
