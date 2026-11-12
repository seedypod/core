import { describe, expect, it } from 'vitest'
import { asCurve, boostHoursToday, levelAt, litHours, mergedAt, nextDim, nextOn, runningToday, todayLevels, type LightCurve } from '../curves'

const day = { setpoints: [{ minute: 360, level: 0 }, { minute: 450, level: 85 }, { minute: 1140, level: 85 }, { minute: 1260, level: 0 }] }
const curve = (id: string, enabled: boolean, days: number, spec = day): LightCurve => ({ id, kind: 'light', name: id, enabled, days, spec })

describe('levelAt', () => {
  it('ramps between setpoints and wraps past midnight', () => {
    expect(levelAt(day, 405)).toBe(43)
    expect(levelAt(day, 600)).toBe(85)
    expect(levelAt(day, 0)).toBe(0)
    expect(levelAt({ setpoints: [{ minute: 1200, level: 40 }, { minute: 120, level: 0 }] }, 1320)).toBe(27)
  })

  it('holds a lone setpoint and reads an empty curve as off', () => {
    expect(levelAt({ setpoints: [{ minute: 600, level: 30 }] }, 0)).toBe(30)
    expect(levelAt({ setpoints: [] }, 0)).toBe(0)
  })
})

describe('litHours', () => {
  it('counts the hours the light is on at all, to the half hour', () => {
    expect(litHours(day)).toBe(15)
    expect(litHours({ setpoints: [{ minute: 0, level: 0 }] })).toBe(0)
  })
})

describe('today', () => {
  it('runs enabled curves on their days, the highest winning', () => {
    const boost = curve('boost', true, 0b1100000, { setpoints: [{ minute: 0, level: 100 }] })
    const curves = [curve('base', true, 127), curve('off', false, 127), boost]
    expect(runningToday(curves, 0).map(c => c.id)).toEqual(['base'])
    expect(runningToday(curves, 6).map(c => c.id)).toEqual(['base', 'boost'])
    const levels = todayLevels(runningToday(curves, 6))
    expect(levels).toHaveLength(97)
    expect(levels?.[0]).toBe(100)
    expect(todayLevels(runningToday(curves, 0))?.[40]).toBe(85)
    expect(todayLevels([])).toBeNull()
  })

  it('reads only light schedules as curves', () => {
    expect(asCurve({ id: 'a', kind: 'light', name: 'A', enabled: true, days: 127, spec: day })?.spec).toBe(day)
    expect(asCurve({ id: 'p', kind: 'pump', name: 'P', enabled: true, days: 127, spec: { minute: 0, durationS: 60 } })).toBeNull()
  })
})

describe('the day of the running curves', () => {
  const full = { setpoints: [{ minute: 330, level: 0 }, { minute: 360, level: 100 }, { minute: 1260, level: 100 }, { minute: 1290, level: 0 }] }
  const gardyn = curve('Gardyn day', true, 127, full)
  const dim = curve('Dim', true, 127)

  it('takes the highest curve at each minute, and counts Boost hours to the half hour', () => {
    expect(mergedAt([], 600)).toBe(0)
    expect(mergedAt([gardyn, dim], 600)).toBe(100)
    expect(mergedAt([dim], 600)).toBe(85)
    expect(boostHoursToday([gardyn], 95)).toBe(15)
    expect(boostHoursToday([dim], 95)).toBe(0)
  })

  it('finds when the light next comes on, today or tomorrow, and which curve brings it', () => {
    expect(nextOn([gardyn], [gardyn], 120)).toEqual({ minute: 331, name: 'Gardyn day', tomorrow: false })
    expect(nextOn([gardyn], [dim], 1300)).toEqual({ minute: 361, name: 'Dim', tomorrow: true })
    expect(nextOn([], [], 0)).toBeNull()
  })

  it('finds when the light next dims, and nothing while it is off or holds to midnight', () => {
    expect(nextDim([gardyn], 600)).toBe(1261)
    expect(nextDim([gardyn], 100)).toBeNull()
    expect(nextDim([curve('Always', true, 127, { setpoints: [{ minute: 0, level: 50 }] })], 600)).toBeNull()
  })
})
