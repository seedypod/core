// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LightCurve } from '@/src/components/Light/curves'
import type { PumpCycle } from '@/src/components/Water/pumpCycles'
import { lightSegments, ScheduleTimeline } from '../ScheduleTimeline'

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

describe('ScheduleTimeline', () => {
  const water = [cycle('Morning', 480, 600), cycle('Afternoon', 960, 600), cycle('Paused', 1200, 300, { enabled: false }), cycle('Weekend', 600, 300, { days: NOT_TUESDAY })]

  it('draws the light as steps with their level and ramps, and the pump runs with their length', () => {
    render(<ScheduleTimeline lead="light" curves={[day]} cycles={water} timezone="UTC" />)
    const lights = screen.getAllByTestId('mark-light')
    // The labels are a layer of their own, over the forecast; the ramps have none.
    expect(screen.getAllByTestId('label-light').map(l => l.textContent)).toEqual(['100%'])
    expect(lights[0]?.getAttribute('aria-label')).toBe('Light 0% → 100% · 05:31–06:00')
    expect(lights[1]?.getAttribute('aria-label')).toBe('Light 100% · 06:00–21:01')
    expect(lights[0]?.getAttribute('style')).toContain('linear-gradient')
    const runs = screen.getAllByTestId('mark-water')
    expect(screen.getAllByTestId('label-water').map(l => l.textContent)).toEqual(['10 min', '5 min', '10 min', '5 min'])
    expect(runs[0]?.getAttribute('aria-label')).toBe('Morning · 08:00–08:10 · 10 min')
  })

  it('puts the page\'s own row first and says what it does next', () => {
    const { unmount } = render(<ScheduleTimeline lead="light" curves={[day]} cycles={water} timezone="UTC" />)
    expect(screen.getAllByTestId(/^lane-/).map(l => l.dataset.testid)).toEqual(['lane-light', 'lane-water'])
    expect(screen.getByTestId('timeline-next').textContent).toBe('next · Lights dim at 21:01')
    unmount()
    render(<ScheduleTimeline lead="water" curves={[day]} cycles={water} timezone="UTC" />)
    expect(screen.getAllByTestId(/^lane-/).map(l => l.dataset.testid)).toEqual(['lane-water', 'lane-light'])
    expect(screen.getByTestId('timeline-next').textContent).toBe('next · Watering 10 min in 2h 0m')
  })

  it('dates a run more than a day off', () => {
    // Germination sown on a Monday: its run is next Monday, 16 November.
    const germ = cycle('Germination', 480, 900, { days: 1 })
    render(<ScheduleTimeline lead="water" curves={[]} cycles={[germ]} timezone="UTC" />)
    expect(screen.getByTestId('timeline-next').textContent).toBe('next · Watering 15 min Mon 08:00')
  })

  it('says when the lights come on tomorrow, and nothing with nothing next', () => {
    vi.setSystemTime(new Date('2026-11-10T22:00:00Z'))
    const { unmount } = render(<ScheduleTimeline lead="light" curves={[day]} cycles={[]} timezone="UTC" />)
    expect(screen.getByTestId('timeline-next').textContent).toBe('next · Lights on tomorrow 05:31')
    unmount()
    render(<ScheduleTimeline lead="water" curves={[]} cycles={[]} timezone="UTC" />)
    expect(screen.queryByTestId('timeline-next')).toBeNull()
    expect(screen.getByRole('group').getAttribute('aria-label')).toBe('Today on the unit\'s clock, now 22:00 UTC. Water: no pump runs. Light: no light scheduled.')
  })

  it('draws the now line in the unit\'s zone, not the browser\'s, and names the zone', () => {
    render(<ScheduleTimeline lead="light" curves={[day]} cycles={[]} timezone="America/New_York" />)
    // 14:00 UTC is 09:00 in New York in November.
    expect(screen.getByTestId('timeline-now-label').textContent).toBe('now 09:00 EST')
    expect(screen.getByTestId('timeline-now').style.left).toBe(`${(540 / 1440) * 100}%`)
  })

  it('shows the sun\'s day across the rows, and brackets how far the light runs past it at each end', () => {
    render(<ScheduleTimeline lead="light" curves={[day]} cycles={[]} timezone="UTC" sun={{ sunrise: 408, sunset: 1021 }} />)
    expect(screen.getByTestId('legend-daylight').textContent).toBe('daylight 10h 13m · extended to 15h 30m')
    expect(screen.getByTestId('sun-sunrise').textContent).toBe('sunrise 06:48')
    expect(screen.getByTestId('sun-sunset').textContent).toBe('sunset 17:01')
    expect(screen.getByTestId('sun-daylight').style.left).toBe(`${(408 / 1440) * 100}%`)
    expect(Number.parseFloat(screen.getByTestId('sun-daylight').style.width)).toBeCloseTo(((1021 - 408) / 1440) * 100)
    // Halfway up each ramp, 05:45 and 21:15, is where the light comes on and goes off.
    expect(screen.getByTestId('sun-extend-before').textContent).toBe('+1h 3m')
    expect(screen.getByTestId('sun-extend-after').textContent).toBe('+4h 14m')
    expect(within(screen.getByTestId('schedule-timeline')).getByText('Auto')).toBeTruthy()
    expect(screen.getByRole('group').getAttribute('aria-label')).toContain('The light follows the sun: sunrise 06:48 · sunset 17:01, daylight 10h 13m · extended to 15h 30m.')
    cleanup()
    // A summer's day longer than the light: no brackets, and the light trims it.
    render(<ScheduleTimeline lead="light" curves={[day]} cycles={[]} timezone="UTC" sun={{ sunrise: 300, sunset: 1320 }} />)
    expect(screen.getByTestId('legend-daylight').textContent).toBe('daylight 17h · trimmed to 15h 30m')
    expect(screen.queryByTestId('sun-extend-before')).toBeNull()
    cleanup()
    render(<ScheduleTimeline lead="light" curves={[day]} cycles={[]} timezone="UTC" />)
    expect(screen.queryByTestId('legend-daylight')).toBeNull()
    expect(screen.queryByTestId('sun-sunrise')).toBeNull()
    expect(screen.queryByTestId('sun-daylight')).toBeNull()
  })

  it('says a hold until someone resumes runs to the end of today, and words a hold off', () => {
    render(<ScheduleTimeline lead="light" curves={[day]} cycles={[]} timezone="UTC" hold={{ since: new Date(NOW.getTime() - 60_000).toISOString(), until: null, level: 0 }} />)
    expect(screen.getByTestId('timeline-next').textContent).toBe('next · Held off until you resume')
    const mark = screen.getAllByTestId('mark-light').find(m => m.dataset.kind === 'hold')
    expect(mark?.getAttribute('aria-label')).toMatch(/^Held by hand off · \d\d:\d\d–24:00$/)
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
    expect(screen.getByTestId('timeline-next').textContent).toBe('next · Lights on tomorrow 05:31')
    unmount()
    render(<ScheduleTimeline lead="light" curves={[day]} cycles={[cycle('Morning', 480, 600)]} timezone="UTC" />)
    expect(screen.queryByTestId('legend-muted')).toBeNull()
  })

  it('outlines a manual hold over the light, clipped to today', () => {
    render(<ScheduleTimeline lead="light" curves={[day]} cycles={[]} timezone="UTC" hold={{ since: '2026-11-10T13:30:00Z', until: '2026-11-10T14:30:00Z', level: 40 }} />)
    const hold = screen.getAllByTestId('mark-light').find(m => m.dataset.kind === 'hold')
    expect(screen.getAllByTestId('label-light').map(l => l.textContent)).toContain('hold 40%')
    expect(hold?.getAttribute('aria-label')).toBe('Held by hand at 40% · 13:30–14:30')
    expect(screen.getByText('manual hold')).toBeTruthy()
    // The hold, not the curve it overrides, is what changes next.
    expect(screen.getByTestId('timeline-next').textContent).toBe('next · Held at 40% until 14:30')
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

  it('shows a mark\'s exact times on focus, a mouse over it or a tap, until blur, Escape or the mouse leaves', () => {
    render(<ScheduleTimeline lead="water" curves={[]} cycles={[cycle('Morning', 480, 600), cycle('Evening', 1200, 600)]} timezone="UTC" />)
    const [morning, evening] = screen.getAllByTestId('mark-water')
    if (!morning || !evening) throw new Error('no marks')
    fireEvent.focus(morning)
    expect(screen.getByRole('tooltip').textContent).toMatch(/^Morning · 08:00–08:10 · 10 min/)
    expect(morning.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id)
    fireEvent.keyDown(morning, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.click(evening)
    expect(screen.getByRole('tooltip').textContent).toMatch(/^Evening · 20:00–20:10 · 10 min/)
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
    expect(container.querySelector('[aria-hidden].relative.h-5')?.textContent).toBe('00:0003:0006:0009:0012:0015:0018:0021:00now 23:10 UTC')
  })

  const phone = () => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: () => void) {}
      observe() {
        this.cb()
      }

      disconnect() {}
    })
    return vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300)
  }

  it('thins the hours to every six on a phone, and hides a run\'s label it has no room for', () => {
    const width = phone()
    const { container } = render(<ScheduleTimeline lead="water" curves={[]} cycles={[cycle('a', 480, 600), cycle('b', 490, 600)]} timezone="UTC" />)
    const axis = container.querySelector('[aria-hidden].relative.h-5')
    // 12:00 and 18:00 sit under the now pill at 14:00.
    expect(axis?.textContent).toBe('00:0006:0024:00now 14:00 UTC')
    const [a, b] = screen.getAllByTestId('label-water')
    // Ten minutes apart on 300 px: the first run's label would run into the second.
    expect(a?.className).toContain('invisible')
    expect(b?.className).not.toContain('invisible')
    width.mockRestore()
  })

  it('keeps the now pill and a tooltip inside the card on a phone, at either end of the day', () => {
    const width = phone()
    vi.setSystemTime(new Date('2026-11-10T23:58:00Z'))
    render(<ScheduleTimeline lead="water" curves={[]} cycles={[cycle('A long-named late watering cycle', 1430, 600)]} timezone="UTC" />)
    const pill = screen.getByTestId('timeline-now-label')
    // 300 px of lane, a 98 px pill for "now 23:58 UTC": no further right than 202 px.
    expect(pill.style.left).toBe('202px')
    fireEvent.click(screen.getAllByTestId('mark-water')[0] as HTMLElement)
    const tip = screen.getByRole('tooltip')
    const left = Number.parseFloat(tip.style.left)
    const w = Number.parseFloat(tip.style.width)
    // It may reach over the row labels, never past the lane's right edge or the card's left.
    expect(left).toBeGreaterThanOrEqual(-72)
    expect(left + w).toBeLessThanOrEqual(300)
    cleanup()
    vi.setSystemTime(new Date('2026-11-10T00:02:00Z'))
    render(<ScheduleTimeline lead="water" curves={[]} cycles={[]} timezone="UTC" />)
    expect(screen.getByTestId('timeline-now-label').style.left).toBe('0px')
    width.mockRestore()
  })

  it('draws a run past midnight to 24:00 and its tail from 00:00, both with its true times', () => {
    render(<ScheduleTimeline lead="water" curves={[]} cycles={[cycle('Late', 1435, 900)]} timezone="UTC" />)
    const marks = screen.getAllByTestId('mark-water')
    expect(marks.map(m => m.getAttribute('aria-label'))).toEqual(['Late · 23:55–00:10 · 15 min', 'Late · 23:55–00:10 · 15 min'])
    expect(marks[0]?.style.left).toBe('0%')
    expect(Number.parseFloat(marks[1]?.style.left ?? '') + Number.parseFloat(marks[1]?.style.width ?? '')).toBeCloseTo(100)
  })

  it('paints today\'s run over a muted one at the same minute, label and all', () => {
    render(<ScheduleTimeline lead="water" curves={[]} cycles={[cycle('On', 480, 600), cycle('Off', 480, 300, { enabled: false })]} timezone="UTC" />)
    const [under, over] = screen.getAllByTestId('mark-water')
    expect(under?.dataset.muted).toBe('true')
    expect(over?.dataset.muted).toBeUndefined()
    expect(over?.className).toContain('z-[1]')
    // Only the run on top shows its label; the one under it would show through the label layer.
    const [hid, shown] = screen.getAllByTestId('label-water')
    expect(hid?.className).toContain('invisible')
    expect(shown?.className).not.toContain('invisible')
    expect(shown?.textContent).toBe('10 min')
  })

  it('says a run\'s days under its times in the tooltip', () => {
    render(<ScheduleTimeline lead="water" curves={[]} cycles={[cycle('Germination', 480, 900, { days: 1 << TUESDAY }), cycle('Daily', 1200, 300)]} timezone="UTC" />)
    const [germ, daily] = screen.getAllByTestId('mark-water')
    fireEvent.focus(germ as HTMLElement)
    expect(screen.getByTestId('timeline-tip-days').textContent).toBe('Tuesdays')
    fireEvent.focus(daily as HTMLElement)
    expect(screen.getByTestId('timeline-tip-days').textContent).toBe('Every day')
  })

  it('closes a tapped tooltip on a tap anywhere else, not on another mark', () => {
    render(<ScheduleTimeline lead="water" curves={[]} cycles={[cycle('Morning', 480, 600), cycle('Evening', 1200, 600)]} timezone="UTC" />)
    const [morning, evening] = screen.getAllByTestId('mark-water')
    if (!morning || !evening) throw new Error('no marks')
    fireEvent.click(morning)
    // Pressing another mark leaves it to that mark's click.
    fireEvent.pointerDown(evening)
    expect(screen.getByRole('tooltip').textContent).toMatch(/^Morning · 08:00–08:10 · 10 min/)
    fireEvent.click(evening)
    expect(screen.getByRole('tooltip').textContent).toMatch(/^Evening · 20:00–20:10 · 10 min/)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('says when the light starts coming on, where its ramp begins, and a weekly run by its day', () => {
    vi.setSystemTime(new Date('2026-11-10T03:00:00Z'))
    const { unmount } = render(<ScheduleTimeline lead="light" curves={[day]} cycles={[]} timezone="UTC" />)
    expect(screen.getByTestId('timeline-next').textContent).toBe('next · Lights on at 05:31')
    unmount()
    // A light on all day doesn't dim, so there's nothing next.
    const always = curve('always', [{ minute: 0, level: 80 }])
    const { unmount: gone } = render(<ScheduleTimeline lead="light" curves={[always]} cycles={[]} timezone="UTC" />)
    expect(screen.queryByTestId('timeline-next')).toBeNull()
    gone()
    // Germination's run on Mondays, seen on a Tuesday.
    render(<ScheduleTimeline lead="water" curves={[]} cycles={[cycle('Germination', 480, 900, { days: 1 })]} timezone="UTC" />)
    expect(screen.getByTestId('timeline-next').textContent).toBe('next · Watering 15 min Mon 08:00')
  })

  it('hatches and dims the rest of the day as forecast in every lane, with the legend saying so', () => {
    render(<ScheduleTimeline lead="water" curves={[day]} cycles={[cycle('Morning', 480, 600)]} timezone="UTC" />)
    // 14:00: everything from 58.3% across is ahead.
    for (const lane of ['water', 'light']) {
      const ahead = screen.getByTestId(`ahead-${lane}`)
      expect(ahead.style.left).toBe(`${(840 / 1440) * 100}%`)
      expect(ahead.style.backgroundImage).toContain('var(--forecast-hatch)')
      expect(ahead.style.backgroundImage).toContain('var(--forecast-dim)')
      expect(ahead.getAttribute('aria-hidden')).toBe('true')
    }
    expect(screen.getByTestId('legend-ahead').textContent).toBe('ahead')
  })

  it('keeps the labels above the forecast, undimmed, and out of the way of the pointer and screen readers', () => {
    render(<ScheduleTimeline lead="water" curves={[day]} cycles={[cycle('Evening', 1200, 600)]} timezone="UTC" />)
    for (const lane of ['water', 'light']) {
      const ahead = screen.getByTestId(`ahead-${lane}`)
      for (const label of screen.getAllByTestId(`label-${lane}`)) {
        // Drawn after the forecast, a layer up.
        expect(ahead.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(label.className).toContain('z-[2]')
        expect(ahead.className).toContain('z-[1]')
        expect(label.className).toContain('pointer-events-none')
        expect(label.getAttribute('aria-hidden')).toBe('true')
      }
    }
    // The 20:00 run is ahead of now, its label still full strength.
    const evening = screen.getAllByTestId('label-water')[0] as HTMLElement
    expect(evening.textContent).toBe('10 min')
    expect(evening.className).toContain('text-fg')
    expect(evening.className).not.toMatch(/opacity|text-fg-3/)
  })

  it('lays the forecast over a run going now, so it reads solid up to now and hatched after', () => {
    render(<ScheduleTimeline lead="water" curves={[]} cycles={[]} timezone="UTC" pumpRun={{ since: '2026-11-10T13:55:00Z', remainingS: 600 }} />)
    const run = screen.getByTestId('mark-water')
    const ahead = screen.getByTestId('ahead-water')
    // The run starts before now and ends after; the forecast starts at now and is drawn over it.
    expect(Number.parseFloat(run.style.left)).toBeLessThan(Number.parseFloat(ahead.style.left))
    expect(run.compareDocumentPosition(ahead) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(ahead.className).toContain('z-[1]')
    expect(ahead.className).toContain('pointer-events-none')
  })
})

describe('forecast tokens', () => {
  it('defines the hatch and the dim for the dark and the light theme', () => {
    // Under jsdom the module's URL isn't a file one; vitest runs from the repo root.
    const css = readFileSync(join(process.cwd(), 'web/src/globals.css'), 'utf8')
    const blocks = [...css.matchAll(/(:root|\[data-theme="light"\]) \{([^}]*)\}/g)].filter(m => m[2]?.includes('--forecast-hatch'))
    expect(blocks.map(m => m[1])).toEqual([':root', '[data-theme="light"]'])
    for (const m of blocks) expect(m[2]).toContain('--forecast-dim')
  })
})
