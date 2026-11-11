// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LightCurve } from '@/src/components/Light/curves'
import type { PumpCycle } from '@/src/components/Water/pumpCycles'
import { lightSegments, nextLight, nextWater, ScheduleTimeline } from '../ScheduleTimeline'

// Tuesday 10 November 2026, 14:00 on a unit set to UTC: weekday 1 in the schedules' mask.
const NOW = new Date('2026-11-10T14:00:00Z')
const TUESDAY = 1
const NOT_TUESDAY = 127 & ~(1 << TUESDAY)

const curve = (id: string, setpoints: { minute: number, level: number }[], over: Partial<LightCurve> = {}): LightCurve => ({ id, kind: 'light', name: id, enabled: true, days: 127, spec: { setpoints }, ...over })
const cycle = (id: string, minute: number, durationS: number, over: Partial<PumpCycle> = {}): PumpCycle => ({ id, kind: 'pump', name: id, enabled: true, days: 127, spec: { minute, durationS }, ...over })
// Gardyn's 15-hour day: up over half an hour from 05:30, full 06:00–21:00, down by 21:30.
const day = curve('Gardyn day', [{ minute: 330, level: 0 }, { minute: 360, level: 100 }, { minute: 1260, level: 100 }, { minute: 1290, level: 0 }])

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('lightSegments', () => {
  it('splits a day into dark and full steps with the ramps between them', () => {
    expect(lightSegments([day])).toEqual([
      { start: 0, end: 331, from: 0, to: 0 },
      { start: 331, end: 360, from: 0, to: 100 },
      { start: 360, end: 1261, from: 100, to: 100 },
      { start: 1261, end: 1290, from: 100, to: 0 },
      { start: 1290, end: 1440, from: 0, to: 0 },
    ])
  })

  it('reads a slow ramp, whose rounded levels repeat for a few minutes, as one ramp', () => {
    const slow = curve('slow', [{ minute: 0, level: 80 }, { minute: 600, level: 80 }, { minute: 660, level: 100 }, { minute: 1439, level: 100 }])
    const ramps = lightSegments([slow]).filter(s => s.from !== s.to)
    expect(ramps).toHaveLength(1)
    expect(ramps[0]).toMatchObject({ from: 80, to: 100 })
  })

  it('takes the brighter curve where two overlap, and nothing from none', () => {
    const noon = curve('noon', [{ minute: 0, level: 50 }, { minute: 1439, level: 50 }])
    expect(lightSegments([day, noon]).filter(s => s.from === s.to).map(s => s.from)).toEqual([50, 100, 50])
    expect(lightSegments([])).toEqual([])
  })
})

describe('nextLight', () => {
  const segs = lightSegments([day])
  it('finds the next step that changes the level today', () => {
    expect(nextLight(segs, segs, 840)).toEqual({ minute: 1290, level: 0, tomorrow: false })
    expect(nextLight(segs, segs, 180)).toEqual({ minute: 360, level: 100, tomorrow: false })
  })

  it('looks to tomorrow\'s first lit step once today is done, and gives up with none', () => {
    expect(nextLight(segs, segs, 1320)).toEqual({ minute: 360, level: 100, tomorrow: true })
    expect(nextLight(segs, [], 1320)).toBeNull()
  })
})

describe('nextWater', () => {
  it('finds the next enabled run today, else tomorrow\'s first, with the minutes until it', () => {
    const cycles = [cycle('a', 480, 600), cycle('b', 960, 600), cycle('off', 900, 60, { enabled: false })]
    expect(nextWater(cycles, TUESDAY, 840)).toEqual({ minute: 960, durationS: 600, inMin: 120 })
    expect(nextWater(cycles, TUESDAY, 1000)).toEqual({ minute: 480, durationS: 600, inMin: 920 })
    expect(nextWater([cycle('tue', 480, 60, { days: 1 << TUESDAY })], TUESDAY, 1000)).toBeNull()
  })
})

describe('ScheduleTimeline', () => {
  const water = [cycle('Morning', 480, 600), cycle('Afternoon', 960, 600), cycle('Paused', 1200, 300, { enabled: false }), cycle('Weekend', 600, 300, { days: NOT_TUESDAY })]

  it('draws the light as steps with their level and ramps, and the pump runs with their length', () => {
    render(<ScheduleTimeline lead="light" curves={[day]} cycles={water} timezone="UTC" />)
    const lights = screen.getAllByTestId('mark-light')
    expect(lights.map(m => m.textContent)).toEqual(['', '100%', ''])
    expect(lights[0]?.getAttribute('aria-label')).toBe('Light 0% → 100% · 05:31–06:00')
    expect(lights[1]?.getAttribute('aria-label')).toBe('Light 100% · 06:00–21:01')
    expect(lights[0]?.getAttribute('style')).toContain('linear-gradient')
    const runs = screen.getAllByTestId('mark-water')
    expect(runs.map(m => m.textContent)).toEqual(['10 min', '5 min', '10 min', '5 min'])
    expect(runs[0]?.getAttribute('aria-label')).toBe('Morning · 08:00–08:10 · 10 min')
  })

  it('puts the page\'s own row first and says what it does next', () => {
    const { unmount } = render(<ScheduleTimeline lead="light" curves={[day]} cycles={water} timezone="UTC" />)
    expect(screen.getAllByTestId(/^lane-/).map(l => l.dataset.testid)).toEqual(['lane-light', 'lane-water'])
    expect(screen.getByTestId('timeline-next').textContent).toBe('next · Lights off at 21:30')
    unmount()
    render(<ScheduleTimeline lead="water" curves={[day]} cycles={water} timezone="UTC" />)
    expect(screen.getAllByTestId(/^lane-/).map(l => l.dataset.testid)).toEqual(['lane-water', 'lane-light'])
    expect(screen.getByTestId('timeline-next').textContent).toBe('next · Watering 10 min in 2h 0m')
  })

  it('says when the lights come on tomorrow, and nothing with nothing next', () => {
    vi.setSystemTime(new Date('2026-11-10T22:00:00Z'))
    const { unmount } = render(<ScheduleTimeline lead="light" curves={[day]} cycles={[]} timezone="UTC" />)
    expect(screen.getByTestId('timeline-next').textContent).toBe('next · Lights 100% tomorrow 06:00')
    unmount()
    render(<ScheduleTimeline lead="water" curves={[]} cycles={[]} timezone="UTC" />)
    expect(screen.queryByTestId('timeline-next')).toBeNull()
    expect(screen.getByRole('group').getAttribute('aria-label')).toBe('Today on the unit\'s clock, now 22:00. Water: no pump runs. Light: no light scheduled.')
  })

  it('draws the now line in the unit\'s zone, not the browser\'s', () => {
    render(<ScheduleTimeline lead="light" curves={[day]} cycles={[]} timezone="America/New_York" />)
    // 14:00 UTC is 09:00 in New York in November.
    expect(screen.getByTestId('timeline-now-label').textContent).toBe('now 09:00')
    expect(screen.getByTestId('timeline-now').style.left).toBe(`${(540 / 1440) * 100}%`)
  })

  it('mutes cycles that are off or not today, with the legend saying so', () => {
    render(<ScheduleTimeline lead="water" curves={[day]} cycles={water} timezone="UTC" />)
    const muted = screen.getAllByTestId('mark-water').filter(m => m.dataset.muted === 'true')
    expect(muted.map(m => m.getAttribute('aria-label'))).toEqual(['Weekend · not today · 10:00–10:05 · 5 min', 'Paused · off · 20:00–20:05 · 5 min'])
    expect(screen.getByTestId('legend-muted').textContent).toBe('off or not today')
  })

  it('shows the curves muted when none runs today, and no legend when all run', () => {
    const { unmount } = render(<ScheduleTimeline lead="light" curves={[{ ...day, days: NOT_TUESDAY }]} cycles={[]} timezone="UTC" />)
    expect(screen.getAllByTestId('mark-light').every(m => m.dataset.muted === 'true')).toBe(true)
    expect(screen.getAllByTestId('mark-light')[1]?.getAttribute('aria-label')).toBe('Light 100% · 06:00–21:01 · not running today')
    // Nothing runs today, so nothing's next until tomorrow, which this curve skips too.
    expect(screen.getByTestId('timeline-next').textContent).toBe('next · Lights 100% tomorrow 06:00')
    unmount()
    render(<ScheduleTimeline lead="light" curves={[day]} cycles={[cycle('Morning', 480, 600)]} timezone="UTC" />)
    expect(screen.queryByTestId('legend-muted')).toBeNull()
  })

  it('outlines a manual hold over the light, clipped to today', () => {
    render(<ScheduleTimeline lead="light" curves={[day]} cycles={[]} timezone="UTC" hold={{ since: '2026-11-10T13:30:00Z', until: '2026-11-10T14:30:00Z', level: 40 }} />)
    const hold = screen.getAllByTestId('mark-light').find(m => m.dataset.kind === 'hold')
    expect(hold?.textContent).toBe('hold 40%')
    expect(hold?.getAttribute('aria-label')).toBe('Held by hand at 40% · 13:30–14:30')
    expect(screen.getByText('manual hold')).toBeTruthy()
    cleanup()
    // A hold already over draws nothing.
    render(<ScheduleTimeline lead="light" curves={[day]} cycles={[]} timezone="UTC" hold={{ since: '2026-11-10T12:00:00Z', until: '2026-11-09T12:30:00Z', level: 40 }} />)
    expect(screen.getAllByTestId('mark-light').some(m => m.dataset.kind === 'hold')).toBe(false)
  })

  it('rings the run going now, with what\'s left or without', () => {
    const { unmount } = render(<ScheduleTimeline lead="water" curves={[]} cycles={[]} timezone="UTC" pumpRun={{ since: '2026-11-10T13:58:00Z', remainingS: 180 }} />)
    const run = screen.getByTestId('mark-water')
    expect(run.dataset.kind).toBe('run')
    expect(run.getAttribute('aria-label')).toBe('Watering now · since 13:58, 3 min left')
    unmount()
    render(<ScheduleTimeline lead="water" curves={[]} cycles={[]} timezone="UTC" pumpRun={{ since: '2026-11-10T13:58:00Z', remainingS: null }} />)
    expect(screen.getByTestId('mark-water').getAttribute('aria-label')).toBe('Watering now · since 13:58')
  })

  it('hatches a previewed preset\'s runs in a row under the real ones', () => {
    render(<ScheduleTimeline lead="light" curves={[day]} cycles={[cycle('Morning', 480, 600)]} timezone="UTC" preview={{ name: 'Young plants · weeks 2–3', short: 'Young', runs: [480, 960], durationS: 360 }} />)
    expect(screen.getAllByTestId(/^lane-/).map(l => l.dataset.testid)).toEqual(['lane-light', 'lane-water', 'lane-preview'])
    const marks = within(screen.getByTestId('lane-preview')).getAllByTestId('mark-preview')
    expect(marks.map(m => m.getAttribute('aria-label'))).toEqual(['Preview: Young plants · weeks 2–3 · 08:00–08:06 · 6 min', 'Preview: Young plants · weeks 2–3 · 16:00–16:06 · 6 min'])
    expect(marks[0]?.getAttribute('style')).toContain('repeating-linear-gradient')
    expect(screen.getByTitle('Preview: Young plants · weeks 2–3').textContent).toBe('PreviewYoung')
    expect(screen.getByText('preview')).toBeTruthy()
  })

  it('shows a mark\'s exact times on focus, a mouse over it or a tap, until blur, Escape or the mouse leaves', () => {
    render(<ScheduleTimeline lead="water" curves={[]} cycles={[cycle('Morning', 480, 600), cycle('Evening', 1200, 600)]} timezone="UTC" />)
    const [morning, evening] = screen.getAllByTestId('mark-water')
    if (!morning || !evening) throw new Error('no marks')
    fireEvent.focus(morning)
    expect(screen.getByRole('tooltip').textContent).toBe('Morning · 08:00–08:10 · 10 min')
    expect(morning.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id)
    fireEvent.keyDown(morning, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.click(evening)
    expect(screen.getByRole('tooltip').textContent).toBe('Evening · 20:00–20:10 · 10 min')
    fireEvent.blur(evening)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.pointerEnter(morning, { pointerType: 'mouse' })
    expect(screen.getByRole('tooltip')).toBeTruthy()
    // A touch's leave doesn't hide it; the mouse's does.
    fireEvent.pointerLeave(morning, { pointerType: 'touch' })
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.pointerLeave(morning, { pointerType: 'mouse' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('drops the end of the axis late in the evening, where the now pill sits over it', () => {
    vi.setSystemTime(new Date('2026-11-10T23:10:00Z'))
    const { container } = render(<ScheduleTimeline lead="water" curves={[]} cycles={[]} timezone="UTC" />)
    expect(container.querySelector('[aria-hidden].relative.h-5')?.textContent).toBe('00:0003:0006:0009:0012:0015:0018:0021:00now 23:10')
  })

  it('thins the hours to every six on a phone, and hides a run\'s label it has no room for', () => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: () => void) {}
      observe() {
        this.cb()
      }

      disconnect() {}
    })
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300)
    const { container } = render(<ScheduleTimeline lead="water" curves={[]} cycles={[cycle('a', 480, 600), cycle('b', 490, 600)]} timezone="UTC" />)
    const axis = container.querySelector('[aria-hidden].relative.h-5')
    // 12:00 and 18:00 sit under the now pill at 14:00.
    expect(axis?.textContent).toBe('00:0006:0024:00now 14:00')
    const [a, b] = screen.getAllByTestId('mark-water')
    // Ten minutes apart on 300 px: the first run's label would run into the second.
    expect(a?.querySelector('span')?.className).toContain('invisible')
    expect(b?.querySelector('span')?.className).not.toContain('invisible')
    width.mockRestore()
  })
})
