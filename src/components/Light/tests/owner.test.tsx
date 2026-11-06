// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LightPage } from '../LightPage'

const { data, calls, setLight } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: { resume: vi.fn(), set: vi.fn(), upsert: vi.fn() },
  setLight: { pending: undefined as unknown, setData: vi.fn(), hook: {} as { onSuccess?: (s: unknown) => void, onSettled?: () => void } },
}))

vi.mock('../CurveEditor', () => ({ CurveEditor: ({ schedule }: { schedule: { name: string } }) => <div>{`editing ${schedule.name}`}</div> }))
vi.mock('@/src/utils/trpc', () => {
  const query = (name: string) => ({ useQuery: () => ({ data: data.get(name) }) })
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
      schedules: { list: query('schedules'), upsert: mutation('upsert') },
      telemetry: { lightHours: query('hours') },
    },
  }
})

const spec = { setpoints: [{ minute: 360, level: 0 }, { minute: 450, level: 85 }, { minute: 1140, level: 85 }, { minute: 1260, level: 0 }] }
const daylight = { id: 'daylight', kind: 'light', name: 'Daylight curve', enabled: true, days: 127, spec, createdAt: '', updatedAt: '' }
const boost = { id: 'boost', kind: 'light', name: 'Weekend boost', enabled: false, days: 96, spec: { setpoints: [{ minute: 600, level: 100 }, { minute: 700, level: 0 }, { minute: 720, level: 0 }] }, createdAt: '', updatedAt: '' }
const pump = { id: 'p', kind: 'pump', name: 'Watering', enabled: true, days: 127, spec: { minute: 480, durationS: 300 }, createdAt: '', updatedAt: '' }

beforeEach(() => {
  data.clear()
  for (const f of Object.values(calls)) f.mockReset()
  setLight.pending = undefined
  setLight.setData.mockReset()
  data.set('light', { on: true, level: 80, since: '2026-10-31T10:00:00Z', fault: null, remainingS: null })
  data.set('schedules', [])
  data.set('hours', { hours: 1200, ratedHours: 25000, pctUsed: 4.8 })
})
afterEach(cleanup)

describe('LightPage: who controls the light', () => {
  it('offers Resume curve while a manual change holds, naming the curve level it returns to', () => {
    data.set('owner', { source: 'manual', level: 80, leaseId: null, manualUntil: '2026-10-31T10:30:00Z', schedule: 40 })
    render(<LightPage />)
    expect(screen.getByText(/Your change holds until .*\. Then the curve \(40% at this hour\) takes over again\./)).toBeTruthy()
    expect(screen.getByText(/held by hand until/)).toBeTruthy()
    fireEvent.click(screen.getByText('Resume curve'))
    expect(calls.resume).toHaveBeenCalled()
    expect(screen.getByTestId('led-hours').textContent).toBe('LED life 95% · 1,200 / 25,000 h')
  })

  it('says the curve or Autopilot takes over when no curve is running', () => {
    data.set('owner', { source: 'manual', level: 80, leaseId: null, manualUntil: '2026-10-31T10:30:00Z', schedule: null })
    render(<LightPage />)
    expect(screen.getByText(/Then the curve or Autopilot takes over again/)).toBeTruthy()
  })

  it('says when Autopilot or the curve is in charge', () => {
    data.set('owner', { source: 'autopilot', level: 60, leaseId: 'rule:1:0', manualUntil: null, schedule: 40 })
    render(<LightPage />)
    expect(screen.getByText(/Autopilot is setting the light/)).toBeTruthy()
    expect(screen.getByText(/Autopilot is in charge/)).toBeTruthy()
    expect(screen.queryByText('Resume curve')).toBeNull()
    cleanup()
    data.set('owner', { source: 'schedule', level: 40, leaseId: null, manualUntil: null, schedule: 40 })
    render(<LightPage />)
    expect(screen.getByText(/Following the curve\./)).toBeTruthy()
  })

  it('flips the switch with the tap while the command is in flight, and stays put for a brightness change', () => {
    setLight.pending = { on: false }
    render(<LightPage />)
    expect(screen.getByRole('switch', { name: 'Light power' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('Lights off')).toBeTruthy()
    cleanup()
    setLight.pending = { level: 10 }
    render(<LightPage />)
    expect(screen.getByRole('switch', { name: 'Light power' }).getAttribute('aria-checked')).toBe('true')
  })

  it('holds a released level until the Pi has answered, then shows what the server says', () => {
    render(<LightPage />)
    const slider = screen.getByLabelText('Brightness') as HTMLInputElement
    fireEvent.change(slider, { target: { value: '30' } })
    fireEvent.pointerUp(slider)
    expect(slider.value).toBe('30')
    act(() => setLight.hook.onSettled?.())
    expect(slider.value).toBe('80')
  })

  it('lets go of the draft even when a power tap replaced the brightness command in flight', () => {
    render(<LightPage />)
    const slider = screen.getByLabelText('Brightness') as HTMLInputElement
    fireEvent.change(slider, { target: { value: '30' } })
    fireEvent.pointerUp(slider)
    fireEvent.click(screen.getByRole('switch', { name: 'Light power' }))
    expect(calls.set).toHaveBeenCalledTimes(2)
    act(() => setLight.hook.onSettled?.())
    expect(slider.value).toBe('80')
  })

  it('writes the state a command returns into the cache instead of fetching it again', () => {
    render(<LightPage />)
    const state = { on: true, level: 30, since: '2026-10-31T10:00:00Z', fault: null, remainingS: null }
    setLight.hook.onSuccess?.(state)
    expect(setLight.setData).toHaveBeenCalledWith(undefined, state)
  })

  it('drives power and brightness', () => {
    render(<LightPage />)
    expect(screen.getByText('Lights on')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Light power' }))
    expect(calls.set).toHaveBeenCalledWith({ on: false })
    const slider = screen.getByLabelText('Brightness')
    fireEvent.change(slider, { target: { value: '30' } })
    fireEvent.pointerUp(slider)
    expect(calls.set).toHaveBeenCalledWith({ level: 30 })
    cleanup()
    data.set('light', { on: false, level: 0, since: '2026-10-31T10:00:00Z', fault: null, remainingS: null })
    render(<LightPage />)
    expect(screen.getByText('Lights off')).toBeTruthy()
    expect(screen.getByText('Off')).toBeTruthy()
  })
})

describe('LightPage: curves', () => {
  it('shows today’s curve, and says so when none runs', () => {
    data.set('schedules', [daylight, pump])
    render(<LightPage />)
    expect(screen.getByText('Following Daylight curve')).toBeTruthy()
    expect(screen.getByText('24:00')).toBeTruthy()
    cleanup()
    data.set('schedules', [boost])
    render(<LightPage />)
    expect(screen.getByText('No curve today')).toBeTruthy()
    expect(screen.getByText(/No curve runs today/)).toBeTruthy()
    cleanup()
    data.set('schedules', [daylight, { ...daylight, id: 'second', name: 'Second' }])
    render(<LightPage />)
    expect(screen.getByText('Following 2 curves')).toBeTruthy()
  })

  it('lists each curve, opens the running one, and toggles one on at once', () => {
    data.set('schedules', [daylight, boost])
    render(<LightPage />)
    const day = screen.getByText('Daylight curve').closest('button') as HTMLElement
    expect(within(day).getByText('ACTIVE')).toBeTruthy()
    expect(within(day).getByText('4 setpoints · Every day · 15 h of light')).toBeTruthy()
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

  it('adds a curve and opens it', () => {
    render(<LightPage />)
    expect(screen.getByText(/No curves yet/)).toBeTruthy()
    fireEvent.click(screen.getByText('Add curve'))
    expect(calls.upsert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'light', name: 'New curve', enabled: false }))
  })
})
