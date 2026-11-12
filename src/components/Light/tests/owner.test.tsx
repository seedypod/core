// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LightPage } from '../LightPage'
import { HOLD_MS } from '../useLightControl'

const { data, errors, calls, setLight } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  errors: new Map<string, Error>(),
  calls: { resume: vi.fn(), set: vi.fn(), upsert: vi.fn(), setAuto: vi.fn(), refetch: vi.fn() },
  setLight: { pending: undefined as unknown, setData: vi.fn(), hook: {} as { onMutate?: () => { command: number }, onSuccess?: (s: unknown, sent: unknown, context: { command: number }) => void, onError?: (e: Error, sent: { level?: number }) => void } },
}))

vi.mock('@tanstack/react-router', () => ({ Link: ({ children, to, hash }: { children: React.ReactNode, to: string, hash?: string }) => <a href={hash ? `${to}#${hash}` : to}>{children}</a> }))
vi.mock('../CurveEditor', () => ({ CurveEditor: ({ schedule }: { schedule: { name: string } }) => <div>{`editing ${schedule.name}`}</div> }))
vi.mock('@/src/utils/trpc', () => {
  const query = (name: string) => ({ useQuery: () => ({ data: data.get(name), error: errors.get(name) ?? null, refetch: () => calls.refetch(name) }) })
  const mutation = (name: keyof typeof calls) => ({ useMutation: () => ({ isPending: false, mutate: (i?: unknown) => calls[name](i) }) })
  const set = {
    useMutation: (hook: typeof setLight.hook) => {
      setLight.hook = hook
      return { isPending: setLight.pending !== undefined, variables: setLight.pending, mutate: (i?: unknown) => calls.set(i) }
    },
  }
  return {
    trpc: {
      useUtils: () => ({ light: { invalidate: vi.fn(), get: { setData: setLight.setData } }, schedules: { invalidate: vi.fn() } }),
      light: { get: query('light'), owner: query('owner'), set, resume: mutation('resume') },
      schedules: { list: query('schedules'), upsert: mutation('upsert'), setAuto: mutation('setAuto') },
      telemetry: { lightHours: query('hours') },
      settings: { get: query('settings') },
    },
  }
})

const spec = { setpoints: [{ minute: 360, level: 0 }, { minute: 450, level: 85 }, { minute: 1140, level: 85 }, { minute: 1260, level: 0 }] }
const daylight = { id: 'daylight', kind: 'light', name: 'Daylight curve', enabled: true, days: 127, spec, createdAt: '', updatedAt: '' }
const boost = { id: 'boost', kind: 'light', name: 'Weekend boost', enabled: false, days: 96, spec: { setpoints: [{ minute: 600, level: 100 }, { minute: 700, level: 0 }, { minute: 720, level: 0 }] }, createdAt: '', updatedAt: '' }
const pump = { id: 'p', kind: 'pump', name: 'Watering', enabled: true, days: 127, spec: { minute: 480, durationS: 300 }, createdAt: '', updatedAt: '' }

beforeEach(() => {
  data.clear()
  errors.clear()
  for (const f of Object.values(calls)) f.mockReset()
  setLight.pending = undefined
  setLight.setData.mockReset()
  data.set('light', { on: true, level: 80, since: '2026-10-31T10:00:00Z', fault: null, remainingS: null })
  data.set('schedules', [])
  data.set('hours', { hours: 1200, ratedHours: 25000, pctUsed: 4.8 })
})
afterEach(cleanup)

describe('LightPage: who controls the light', () => {
  it('reads now and today on the unit\'s clock, so the strip and the timeline agree', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // 20:00 UTC: still last night in UTC, but 05:00 the next morning in Tokyo.
    vi.setSystemTime(new Date('2026-11-10T20:00:00Z'))
    data.set('light', { on: false, level: 0, since: '2026-11-10T12:00:00Z', fault: null, remainingS: null })
    data.set('schedules', [daylight])
    try {
      data.set('settings', { timezone: 'Asia/Tokyo' })
      render(<LightPage />)
      expect(within(screen.getByTestId('light-strip')).getByText('Next on 06:01 (Daylight curve)')).toBeTruthy()
      expect(screen.getByTestId('timeline-next').textContent).toBe('next · Lights on at 06:01')
      cleanup()
      data.set('settings', { timezone: 'UTC' })
      render(<LightPage />)
      expect(within(screen.getByTestId('light-strip')).getByText('Next on tomorrow 06:01 (Daylight curve)')).toBeTruthy()
      // In UTC the curve is still ramping down from 19:00, though the lamp was switched off.
      expect(screen.getByTestId('timeline-next').textContent).toBe('next · Lights dim at 20:01')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('outlines the hand\'s hold on today\'s timeline, light row first', () => {
    const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString()
    data.set('light', { on: true, level: 60, since: minutes(-1), fault: null, remainingS: null })
    data.set('owner', { source: 'manual', level: 60, leaseId: null, manualUntil: minutes(30), schedule: 40 })
    data.set('schedules', [daylight, pump])
    render(<LightPage />)
    expect(screen.getAllByTestId(/^lane-/).map(l => l.dataset.testid)).toEqual(['lane-light', 'lane-water'])
    expect(screen.getAllByTestId('mark-light').find(m => m.dataset.kind === 'hold')?.getAttribute('aria-label')).toMatch(/^Held by hand at 60% · /)
  })

  it('says in the strip when a hand holds the light and what takes over, with Resume schedule', () => {
    data.set('owner', { source: 'manual', level: 80, leaseId: null, manualUntil: '2026-10-31T10:30:00Z', schedule: 40 })
    render(<LightPage />)
    const strip = within(screen.getByTestId('light-strip'))
    expect(strip.getByText(/^Held by hand until /)).toBeTruthy()
    expect(strip.getByText('then the curve (40% at this hour)')).toBeTruthy()
    expect(screen.getByText(/held by hand until/)).toBeTruthy()
    fireEvent.click(strip.getByText('Resume schedule'))
    expect(calls.resume).toHaveBeenCalled()
    expect(screen.getByTestId('led-hours').textContent).toBe('LED life 95% · 1,200 / 25,000 h')
  })

  it('says the curve or Autopilot takes over when no curve is running', () => {
    data.set('owner', { source: 'manual', level: 80, leaseId: null, manualUntil: '2026-10-31T10:30:00Z', schedule: null })
    render(<LightPage />)
    expect(screen.getByText('then the curve or Autopilot')).toBeTruthy()
  })

  it('says when Autopilot or the curve is in charge, and when the light next dims or comes on', () => {
    data.set('owner', { source: 'autopilot', level: 60, leaseId: 'rule:1:0', manualUntil: null, schedule: 40 })
    render(<LightPage />)
    expect(screen.getByText('Autopilot is setting the light')).toBeTruthy()
    expect(screen.getByText(/Autopilot is in charge/)).toBeTruthy()
    expect(screen.queryByText('Resume schedule')).toBeNull()
    cleanup()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 31, 12, 0))
    data.set('owner', { source: 'schedule', level: 85, leaseId: null, manualUntil: null, schedule: 85 })
    data.set('schedules', [daylight])
    render(<LightPage />)
    const strip = within(screen.getByTestId('light-strip'))
    expect(strip.getByText('Light on')).toBeTruthy()
    expect(strip.getByText('following Daylight curve · dims at 19:01')).toBeTruthy()
    expect(screen.getByTestId('light-strip').getAttribute('data-state')).toBe('on')
    cleanup()
    data.set('light', { on: false, level: 0, since: '2026-10-31T10:00:00Z', fault: null, remainingS: null })
    vi.setSystemTime(new Date(2026, 9, 31, 22, 0))
    render(<LightPage />)
    expect(within(screen.getByTestId('light-strip')).getByText('Light off')).toBeTruthy()
    expect(screen.getByText('Next on tomorrow 06:01 (Daylight curve)')).toBeTruthy()
    cleanup()
    data.set('schedules', [])
    render(<LightPage />)
    expect(screen.getByText('no curve to turn it on')).toBeTruthy()
    vi.useRealTimers()
  })

  it('puts the slider at 0 and reads Off while turning off is in flight, and keeps the level for a brightness change', () => {
    setLight.pending = { on: false }
    render(<LightPage />)
    expect((screen.getByLabelText('Brightness') as HTMLInputElement).value).toBe('0')
    expect(screen.getByTestId('strip-level').textContent).toBe('Off')
    expect(screen.getByText('Light off')).toBeTruthy()
    cleanup()
    setLight.pending = { level: 10 }
    render(<LightPage />)
    expect((screen.getByLabelText('Brightness') as HTMLInputElement).value).toBe('80')
    expect(screen.getByTestId('strip-level').textContent).toBe('80%')
  })

  const adjust = (slider: HTMLElement, value: string) => {
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    fireEvent.input(slider, { target: { value } })
    fireEvent.keyUp(slider, { key: 'ArrowLeft' })
  }

  it('shows the requested level on the slider and the readout straight away, and goes back when refused', () => {
    render(<LightPage />)
    const slider = screen.getByLabelText('Brightness') as HTMLInputElement
    adjust(slider, '30')
    expect(slider.value).toBe('30')
    expect(screen.getByTestId('light-level').textContent).toBe('30%')
    expect(screen.getByTestId('strip-level').textContent).toBe('30%')
    act(() => setLight.hook.onError?.(new Error('refused'), { level: 30 }))
    expect(slider.value).toBe('80')
  })

  it('keeps a newer request when an older command is refused', () => {
    render(<LightPage />)
    const slider = screen.getByLabelText('Brightness') as HTMLInputElement
    adjust(slider, '30')
    adjust(slider, '60')
    act(() => setLight.hook.onError?.(new Error('refused'), { level: 30 }))
    expect(slider.value).toBe('60')
  })

  it('follows the light again once it reports the requested level', () => {
    const { rerender } = render(<LightPage />)
    const slider = screen.getByLabelText('Brightness') as HTMLInputElement
    adjust(slider, '30')
    data.set('light', { ...(data.get('light') as object), level: 30 })
    rerender(<LightPage />)
    data.set('light', { ...(data.get('light') as object), level: 55 })
    rerender(<LightPage />)
    expect(slider.value).toBe('55')
  })

  it('gives up on a level the light never reports', () => {
    vi.useFakeTimers()
    render(<LightPage />)
    const slider = screen.getByLabelText('Brightness') as HTMLInputElement
    adjust(slider, '30')
    act(() => void vi.advanceTimersByTime(HOLD_MS - 1))
    expect(slider.value).toBe('30')
    act(() => void vi.advanceTimersByTime(1))
    expect(slider.value).toBe('80')
    vi.useRealTimers()
  })

  it('turns the light off when the slider goes all the way down, letting go of the level it asked for', () => {
    render(<LightPage />)
    const slider = screen.getByLabelText('Brightness') as HTMLInputElement
    adjust(slider, '30')
    adjust(slider, '0')
    expect(calls.set).toHaveBeenCalledTimes(2)
    expect(calls.set).toHaveBeenLastCalledWith({ on: false })
    expect(slider.value).toBe('80')
  })

  it('marks the quarters on the slider and moves it in fives', () => {
    render(<LightPage />)
    const slider = screen.getByLabelText('Brightness') as HTMLInputElement
    expect(slider.step).toBe('5')
    expect(within(screen.getByTestId('light-strip')).getAllByTestId('slider-mark').map(m => m.style.left)).toEqual(['25%', '50%', '75%'])
  })

  it('writes the state a command returns into the cache instead of fetching it again', () => {
    render(<LightPage />)
    const state = { on: true, level: 30, since: '2026-10-31T10:00:00Z', fault: null, remainingS: null }
    setLight.hook.onSuccess?.(state, { level: 30 }, setLight.hook.onMutate?.() as { command: number })
    expect(setLight.setData).toHaveBeenCalledWith(undefined, state)
  })

  it('drives power and brightness from the one slider', () => {
    render(<LightPage />)
    expect(screen.getByText('Light on')).toBeTruthy()
    expect(screen.queryByRole('switch', { name: 'Light power' })).toBeNull()
    adjust(screen.getByLabelText('Brightness'), '0')
    expect(calls.set).toHaveBeenCalledWith({ on: false })
    adjust(screen.getByLabelText('Brightness'), '30')
    expect(calls.set).toHaveBeenCalledWith({ level: 30 })
    cleanup()
    // Off, the slider sits at 0 though the light keeps its last level.
    data.set('light', { on: false, level: 60, since: '2026-10-31T10:00:00Z', fault: null, remainingS: null })
    render(<LightPage />)
    expect(screen.getByText('Light off')).toBeTruthy()
    expect(screen.getByTestId('light-level').textContent).toBe('Off')
    expect((screen.getByLabelText('Brightness') as HTMLInputElement).value).toBe('0')
  })
})

describe('LightPage: when the light can\'t be read', () => {
  it('says so instead of loading forever, and Retry asks for the light and the curves again', () => {
    data.delete('light')
    errors.set('light', new Error('hald offline'))
    render(<LightPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(calls.refetch).toHaveBeenCalledWith('light')
    expect(calls.refetch).toHaveBeenCalledWith('schedules')
  })
})

describe('LightPage: curves', () => {
  it('shows today’s curve with its hours of full light and rating, and says so when none runs', () => {
    data.set('schedules', [daylight, pump])
    render(<LightPage />)
    expect(screen.getByText('Following Daylight curve')).toBeTruthy()
    expect(screen.getAllByText('24:00').filter(e => !e.closest('[data-testid="schedule-timeline"]'))).toHaveLength(1)
    // 85% for most of 15 hours counts as 11.5 of full light.
    expect(screen.getByTestId('light-summary').textContent).toBe('11.5 h of full light today · Low')
    cleanup()
    data.set('schedules', [boost])
    render(<LightPage />)
    expect(screen.getByText('No curve today')).toBeTruthy()
    expect(screen.getByTestId('light-summary').textContent).toBe('Nothing scheduled today')
    expect(screen.getAllByText(/No curve runs today/).length).toBeGreaterThan(0)
    cleanup()
    data.set('schedules', [daylight, { ...daylight, id: 'second', name: 'Second' }])
    render(<LightPage />)
    expect(screen.getByText('Following 2 curves')).toBeTruthy()
    cleanup()
    data.delete('schedules')
    render(<LightPage />)
    expect(within(screen.getByTestId('light-summary')).getByTestId('loading-line')).toBeTruthy()
  })

  it('says when the light is on long enough to make lettuce and herbs bolt, however dim', () => {
    // 50% from 04:00 to 22:00: 9 hours of full light, but 18 on.
    data.set('schedules', [{ ...daylight, spec: { setpoints: [{ minute: 239, level: 0 }, { minute: 240, level: 50 }, { minute: 1320, level: 50 }, { minute: 1321, level: 0 }] } }])
    render(<LightPage />)
    expect(screen.getByTestId('light-summary').textContent).toBe('9 h of full light today · Low · on 18 h, long enough to make lettuce and herbs bolt')
    expect(screen.getByText('4 setpoints · Every day · on 18 h, 9 h of full light · long enough to make lettuce and herbs bolt')).toBeTruthy()
  })

  it('lists each curve, opens the running one, and toggles one on at once', () => {
    data.set('schedules', [daylight, boost])
    render(<LightPage />)
    const day = screen.getByText('Daylight curve').closest('button') as HTMLElement
    expect(within(day).getByText('ACTIVE')).toBeTruthy()
    // 85% for most of 15 hours is 11.5 of full light, short of Gardyn's 14.
    expect(within(day).getByText('4 setpoints · Every day · on 15 h, 11.5 h of full light')).toBeTruthy()
    expect(within(day).getByTestId('rating-daylight').textContent).toBe('low')
    expect(screen.getByText('3 setpoints · Weekends · off')).toBeTruthy()
    expect(screen.getByText('editing Daylight curve')).toBeTruthy()
    expect(screen.queryByText('editing Weekend boost')).toBeNull()

    fireEvent.click(screen.getByLabelText('Edit Weekend boost'))
    expect(screen.getByText('editing Weekend boost')).toBeTruthy()
    expect(screen.queryByText('editing Daylight curve')).toBeNull()
    fireEvent.click(screen.getByText('Weekend boost'))
    expect(screen.queryByText(/^editing/)).toBeNull()

    fireEvent.click(screen.getByRole('switch', { name: 'Enable Weekend boost' }))
    expect(calls.upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'boost', enabled: true, spec: boost.spec }))
  })

  it('offers Gardyn presets with no curve yet, and runs the first one picked', () => {
    render(<LightPage />)
    expect(screen.getByText(/Gardyn recommends 14–16 hours a day at full brightness/)).toBeTruthy()
    fireEvent.click(screen.getByTestId('preset-day-15h'))
    expect(calls.upsert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'light', name: 'Gardyn day · 15 h', enabled: true, days: 127 }))
  })

  it('adds a later curve switched off, since enabled curves stack, or a blank one', () => {
    data.set('schedules', [daylight])
    render(<LightPage />)
    expect(screen.queryByTestId('preset-day-16h')).toBeNull()
    fireEvent.click(screen.getByText('Add curve'))
    fireEvent.click(screen.getByTestId('preset-day-16h'))
    expect(calls.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Long day · 16 h', enabled: false }))
    fireEvent.click(screen.getByText('Add curve'))
    fireEvent.click(screen.getByTestId('preset-blank'))
    expect(calls.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'New curve', enabled: false }))
  })

  it('while Auto runs, locks the slider, shows a breathing sun, and says what sunrise and sunset make of today', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // 10:00 PST on 12 November.
    vi.setSystemTime(new Date('2026-11-12T18:00:00Z'))
    const sun = { minHours: 14, maxHours: 16, rampMin: 60, shiftMin: 0, auto: true }
    const autoSpec = { setpoints: [{ minute: 264, level: 0 }, { minute: 324, level: 100 }, { minute: 1134, level: 100 }, { minute: 1194, level: 0 }], sun }
    data.set('schedules', [{ ...daylight, id: 'auto', name: 'Auto', spec: autoSpec }])
    data.set('settings', { timezone: 'America/Los_Angeles', latitude: 37.7749, longitude: -122.4194 })
    render(<LightPage />)
    const strip = screen.getByTestId('light-strip')
    expect(strip.dataset.auto).toBe('true')
    expect(strip.className).toContain('light-auto')
    expect(within(strip).getByText('Auto · Light on')).toBeTruthy()
    expect((screen.getByLabelText('Brightness') as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByTestId('auto-sub').textContent).toMatch(/^sunrise 06:4\d · sunset 17:0\d · light 04:24–19:54$/)
    cleanup()
    data.set('settings', { timezone: 'America/Los_Angeles', latitude: null, longitude: null })
    render(<LightPage />)
    expect(screen.getByTestId('auto-sub').textContent).toBe('centred on 12:00 · set a location to follow the sun')
    expect(screen.getByRole('link', { name: 'set a location' }).getAttribute('href')).toBe('/settings#unit')
    vi.useRealTimers()
  })

  it('switches Auto from the strip, not the presets', () => {
    data.set('schedules', [daylight])
    render(<LightPage />)
    const auto = screen.getByRole('switch', { name: 'Auto' })
    expect(auto.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByText('Add curve'))
    expect(screen.queryByTestId('preset-auto')).toBeNull()
    fireEvent.click(auto)
    expect(calls.setAuto).toHaveBeenLastCalledWith({ on: true })
  })

  it('while Auto runs, lists its curve first and holds the others off, and its card\'s switch is Auto\'s', () => {
    const sun = { minHours: 14, maxHours: 16, rampMin: 60, shiftMin: 0, auto: true }
    data.set('schedules', [{ ...daylight, enabled: false }, { ...daylight, id: 'auto', name: 'Auto', spec: { ...spec, sun } }])
    render(<LightPage />)
    expect(screen.getByRole('switch', { name: 'Auto' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getAllByRole('switch', { name: /^Enable / }).map(t => t.getAttribute('aria-label'))).toEqual(['Enable Auto', 'Enable Daylight curve'])
    expect(screen.getByText(/^Auto · follows the sun · Every day · on 15 h/)).toBeTruthy()
    expect(screen.getByText('4 setpoints · Every day · off · waiting while Auto runs')).toBeTruthy()
    expect((screen.getByRole('switch', { name: 'Enable Daylight curve' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Auto' }))
    expect(calls.setAuto).toHaveBeenLastCalledWith({ on: false })
    expect(calls.upsert).not.toHaveBeenCalled()
  })

  it('warns while the unit keeps UTC, since curves run on its clock', () => {
    data.set('settings', { timezone: 'UTC' })
    render(<LightPage />)
    expect(screen.getByTestId('utc-warning').textContent).toMatch(/set to UTC/)
    expect(screen.getByRole('link', { name: 'Set your timezone' }).getAttribute('href')).toBe('/settings#unit')
    cleanup()
    data.set('settings', { timezone: 'America/Los_Angeles' })
    render(<LightPage />)
    expect(screen.queryByTestId('utc-warning')).toBeNull()
  })
})
