// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Chart3DModule from '@/src/components/charts/viz3d/Chart3D'
import { START_WAIT_MS, WaterPage } from '../WaterPage'

const { data, calls, state, pumpSuccess } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: { runOnce: vi.fn(), stop: vi.fn(), ack: vi.fn(), upsert: vi.fn(), remove: vi.fn(), history: vi.fn(), invalidatePump: vi.fn(), setPump: vi.fn() },
  pumpSuccess: new Map<string, (s: unknown) => void>(),
  state: { ackError: null as null | { message: string }, runError: null as null | { message: string }, historyLoading: false, historyError: null as null | { message: string } },
}))

// The hero's 3D tank as a stub showing what it was handed, or giving up as a browser without WebGL would.
const hero = vi.hoisted(() => ({ fail: false }))
vi.mock('@/src/components/charts/viz3d/Chart3D', async (orig) => {
  const real = await orig<typeof Chart3DModule>()
  const { useEffect } = await import('react')
  return {
    ...real,
    Chart3D: ({ status, data, label, onUnavailable }: { status: string, label: string, data: { marks: { now: string, cutoff: string | null }, pumping: boolean, topUps: number[], runs: number[], upcoming: number[] } | null, onUnavailable?: () => void }) => {
      useEffect(() => {
        if (hero.fail) onUnavailable?.()
      }, [onUnavailable])
      return <div data-testid="tank-3d" data-state={status} aria-label={label}>{data && `${data.marks.now} · ${data.marks.cutoff} · ${data.topUps.length} top-up · ${data.pumping ? 'pumping' : 'still'} · ran ${data.runs.map(r => r.toFixed(2)).join(',')} · later ${data.upcoming.map(r => r.toFixed(2)).join(',')}`}</div>
    },
  }
})

// Care has its own tests; the Water page only points at it.
vi.mock('@/src/components/Care/CareSummary', () => ({ CareSummary: () => null }))

vi.mock('@/src/utils/trpc', () => {
  const query = (name: string) => ({ useQuery: () => ({ data: data.get(name) }) })
  const mutation = (name: 'runOnce' | 'stop' | 'upsert' | 'remove') => ({
    useMutation: (o: { onSuccess: (s: unknown) => void }) => {
      pumpSuccess.set(name, o.onSuccess)
      return { isPending: false, error: name === 'runOnce' ? state.runError : null, mutate: (i?: unknown) => calls[name](i) }
    },
  })
  return {
    trpc: {
      useUtils: () => ({ pump: { invalidate: calls.invalidatePump, get: { setData: calls.setPump } }, schedules: { invalidate: vi.fn() }, tank: { invalidate: vi.fn() }, care: { invalidate: vi.fn() }, alerts: { invalidate: vi.fn() } }),
      alerts: { list: query('alerts'), acknowledge: { useMutation: (o: { onSuccess: () => void }) => ({ isPending: false, error: state.ackError, mutate: (i: unknown) => {
        calls.ack(i)
        o.onSuccess()
      } }) } },
      pump: { get: query('pump'), runOnce: mutation('runOnce'), stop: mutation('stop') },
      sensors: { latest: query('sensors') },
      care: { chores: query('chores') },
      tank: { actions: query('tankActions'), logAction: { useMutation: () => ({ mutate: vi.fn(), error: null }) }, removeAction: { useMutation: () => ({ mutate: vi.fn(), error: null }) } },
      system: { info: query('system') },
      settings: { get: query('settings') },
      schedules: { list: query('schedules'), recentRuns: query('runs'), upsert: mutation('upsert'), remove: mutation('remove') },
      telemetry: {
        history: {
          useQuery: (input: unknown) => {
            calls.history(input)
            return { data: state.historyLoading ? undefined : data.get('history'), isLoading: state.historyLoading, error: state.historyError }
          },
        },
      },
    },
  }
})

const idle = { on: false, level: 0, since: '2026-11-01T10:00:00Z', fault: null, remainingS: null }
const morning = { id: 'morning', kind: 'pump', name: 'Morning watering', enabled: true, days: 127, spec: { minute: 480, durationS: 300 }, createdAt: '', updatedAt: '' }
const evening = { id: 'evening', kind: 'pump', name: 'Evening watering', enabled: true, days: 127, spec: { minute: 1200, durationS: 300, level: 50 }, createdAt: '', updatedAt: '' }
const curve = { id: 'day', kind: 'light', name: 'Daylight', enabled: true, days: 127, spec: { setpoints: [] }, createdAt: '', updatedAt: '' }
const at = (h: number, m = 0, d = 1) => new Date(2026, 10, d, h, m)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(at(12))
  data.clear()
  for (const f of Object.values(calls)) f.mockReset()
  Object.assign(state, { runError: null, historyLoading: false, historyError: null })
  data.set('pump', idle)
  data.set('sensors', { water_level_pct: { value: 71, unit: '%' }, water_distance: { value: 9.4, unit: 'cm' }, pump_w: { value: 0, unit: 'W' }, pump_a: { value: 0, unit: 'A' }, pump_v: { value: 12.3, unit: 'V' } })
  data.set('system', { system: { limits: { pumpMaxRunS: 900, pumpMaxDuty: 30, waterLowCm: 16 } } })
  data.set('settings', { waterFullCm: 5, waterEmptyCm: 20, tankCapacityL: 19 })
  data.set('schedules', [evening, curve, morning])
  data.set('runs', [{ scheduleId: 'morning', key: 'm1', firedAt: at(8).toISOString(), result: 'pending' }, { scheduleId: 'gone', key: 'g1', firedAt: at(20, 0, 0).toISOString(), result: 'pending' }])
  data.set('history', [80, 70, 60, 92, 85].map((value, i) => ({ ts: new Date(at(0).getTime() + i * 12 * 3_600_000).toISOString(), value })))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('WaterPage: tank and pump', () => {
  it('asks the server for the pump after each command, since a late reply could be older than the cache', () => {
    render(<WaterPage />)
    pumpSuccess.get('runOnce')?.({ ...idle, on: true, level: 30, remainingS: 300 })
    expect(calls.invalidatePump).toHaveBeenCalledTimes(1)
    pumpSuccess.get('stop')?.({ ...idle, since: '2026-11-01T10:05:00Z' })
    expect(calls.invalidatePump).toHaveBeenCalledTimes(2)
    expect(calls.setPump).not.toHaveBeenCalled()
  })

  it('sums up the pump and the next run, and the tank against the calibration', () => {
    render(<WaterPage />)
    expect(screen.getByText('pump idle · next run 20:00')).toBeTruthy()
    const strip = within(screen.getByTestId('pump-strip'))
    expect(strip.getByText('Pump idle')).toBeTruthy()
    expect(strip.getByText('Next run 20:00 (Evening watering) · supply 12.3 V')).toBeTruthy()
    expect(screen.getByText('≈ 13.5 of 19 L')).toBeTruthy()
    expect(screen.getByText('empty · 20 cm')).toBeTruthy()
    expect(screen.getByText('full · 5 cm')).toBeTruthy()
    expect(screen.getByText('pump cutoff 27%')).toBeTruthy()
    expect(screen.getByText('9.4 cm')).toBeTruthy()
    // The pump's limits are Run's tooltip.
    expect(strip.getByRole('button', { name: 'Run' }).getAttribute('title')).toBe('Up to 15 min per run at 30% duty. Won\'t start below 16 cm of water.')
  })

  it('runs the pump for the chosen length, and turns the strip into the run with a countdown and Stop', () => {
    render(<WaterPage />)
    const chips = within(screen.getByRole('radiogroup', { name: 'Run length' }))
    expect(chips.getByRole('radio', { name: '5 min' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(chips.getByRole('radio', { name: '10 min' }))
    expect(chips.getByRole('radio', { name: '10 min' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(calls.runOnce).toHaveBeenCalledWith({ durationS: 600 })
    cleanup()
    // Started a minute ago with two left: a three-minute run, by hand.
    data.set('pump', { ...idle, on: true, level: 30, remainingS: 120, since: new Date(Date.now() - 60_000).toISOString() })
    render(<WaterPage />)
    const strip = screen.getByTestId('pump-strip')
    expect(strip.getAttribute('data-state')).toBe('running')
    expect(within(strip).getByText('Watering')).toBeTruthy()
    expect(within(strip).getByText('Manual · 30% duty · 0 W · 0 A · 12.3 V')).toBeTruthy()
    expect(within(strip).getByTestId('run-left').textContent).toBe('2:00')
    expect(within(strip).getByText('of 3 min')).toBeTruthy()
    expect(within(strip).getByRole('progressbar', { name: 'Watering' }).getAttribute('aria-valuenow')).toBe('33')
    expect(screen.queryByRole('radiogroup', { name: 'Run length' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull()
    const stopButton = screen.getByTestId('stop-pump')
    expect(stopButton.textContent).toBe('Stop')
    fireEvent.click(stopButton)
    expect(calls.stop).toHaveBeenCalled()
  })

  it('names the cycle that started a scheduled run', () => {
    data.set('pump', { ...idle, on: true, level: 30, remainingS: 200, since: new Date(at(8).getTime() + 20_000).toISOString() })
    render(<WaterPage />)
    expect(within(screen.getByTestId('pump-strip')).getByText(/^Morning watering · 30% duty/)).toBeTruthy()
  })

  it('waters with no known end without a clock', () => {
    data.set('pump', { ...idle, on: true, level: 30, remainingS: null })
    render(<WaterPage />)
    expect(screen.getByText(/watering at 30%/)).toBeTruthy()
    expect(screen.getByTestId('stop-pump').textContent).toBe('Stop')
    expect(screen.getByText('until stopped')).toBeTruthy()
    expect(screen.queryByTestId('run-left')).toBeNull()
  })

  it('says Starting… after Run, and why when the pump doesn\'t come on', () => {
    vi.useFakeTimers()
    data.set('alerts', [{ id: 188, kind: 'water_low', active: true, detail: 'water distance 86.9 cm ≥ 16.0 cm' }])
    render(<WaterPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(screen.getByText('Starting…').closest('button')?.disabled).toBe(true)
    expect(screen.queryByText(/Didn't start/)).toBeNull()
    act(() => {
      vi.advanceTimersByTime(START_WAIT_MS + 1000)
    })
    // The reason takes the strip's subtitle, so nothing below moves.
    const strip = within(screen.getByTestId('pump-strip'))
    expect(strip.getByText(/Didn't start: the tank reads low \(water distance 86\.9 cm ≥ 16\.0 cm\)/)).toBeTruthy()
    fireEvent.click(strip.getByText('Try again'))
    expect(screen.getByRole('button', { name: 'Run' })).toBeTruthy()
    expect(strip.getByText('Next run 20:00 (Evening watering) · supply 12.3 V')).toBeTruthy()
    vi.useRealTimers()
  })

  it('reports a refused run and a latched fault in the strip', () => {
    state.runError = { message: 'tank too low' }
    data.set('pump', { ...idle, fault: 'dry run' })
    render(<WaterPage />)
    const strip = within(screen.getByTestId('pump-strip'))
    expect(strip.getByText('tank too low')).toBeTruthy()
    expect(strip.getByText('Pump fault')).toBeTruthy()
    expect(screen.getByText(/pump fault: dry run/)).toBeTruthy()
    expect(strip.getByRole('button', { name: 'Run' }).hasAttribute('disabled')).toBe(true)
    cleanup()
    state.runError = null
    render(<WaterPage />)
    expect(within(screen.getByTestId('pump-strip')).getByText('dry run')).toBeTruthy()
  })

  it('clears a latched pump fault from the page, without going to Alerts', () => {
    data.set('pump', { ...idle, fault: 'dry-run' })
    data.set('alerts', [{ id: 174, kind: 'pump_fault', active: true, detail: 'pump: dry-run' }])
    render(<WaterPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear fault' }))
    expect(calls.ack).toHaveBeenCalledWith({ id: 174 })
    expect(calls.invalidatePump).toHaveBeenCalled()
    cleanup()
    // The fault's alert row hasn't arrived yet: nothing to clear from here.
    data.set('alerts', [])
    render(<WaterPage />)
    expect(screen.queryByRole('button', { name: 'Clear fault' })).toBeNull()
    cleanup()
    data.set('alerts', [{ id: 174, kind: 'pump_fault', active: true, detail: 'pump: dry-run' }])
    state.ackError = { message: 'the daemon is offline' }
    render(<WaterPage />)
    expect(screen.getByText('the daemon is offline')).toBeTruthy()
    state.ackError = null
  })

  it('waits for readings without guessing', () => {
    data.delete('sensors')
    data.delete('settings')
    data.delete('pump')
    data.delete('system')
    render(<WaterPage />)
    expect(screen.getByText('… · next run 20:00')).toBeTruthy()
    expect(within(screen.getByTestId('pump-strip')).getByText('Pump')).toBeTruthy()
    expect(screen.getByText('empty')).toBeTruthy()
    expect(screen.queryByText(/pump cutoff/)).toBeNull()
  })
})

describe('WaterPage: pump cycles', () => {
  it('lists cycles by time with their last or next run, and toggles one at once', () => {
    render(<WaterPage />)
    const rows = screen.getAllByRole('switch').map(s => s.getAttribute('aria-label'))
    expect(rows).toEqual(['Enable Morning watering', 'Enable Evening watering'])
    expect(screen.getByText('ran 4 h ago')).toBeTruthy()
    expect(screen.getByText('next in 8 h')).toBeTruthy()
    expect(screen.getByText('5 min at 50% · Every day')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Evening watering' }))
    expect(calls.upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'evening', enabled: false }))
  })

  it('offers starting points with no cycle yet, and turns on the one picked, one schedule per run', () => {
    data.set('schedules', [curve])
    render(<WaterPage />)
    expect(screen.getByText(/Gardyn doesn’t publish its watering cadence/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Gardyn’s guide' }).getAttribute('href')).toBe('https://help.mygardyn.com/en/articles/4435265')
    fireEvent.click(screen.getByTestId('pump-preset-twice-10'))
    expect(calls.upsert).toHaveBeenCalledTimes(2)
    expect(calls.upsert).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: 'pump', name: 'Twice a day · 10 min (08:00)', enabled: true, days: 127, spec: { minute: 480, durationS: 600 } }))
    expect(calls.upsert).toHaveBeenNthCalledWith(2, expect.objectContaining({ name: 'Twice a day · 10 min (17:00)', spec: { minute: 1020, durationS: 600 } }))
  })

  it('adds later presets switched off, since cycles add up, from Add cycle', () => {
    render(<WaterPage />)
    expect(screen.queryByTestId('pump-preset-once-15')).toBeNull()
    fireEvent.click(screen.getByText('Add cycle'))
    expect(screen.getByText(/These start switched off/)).toBeTruthy()
    fireEvent.click(screen.getByTestId('pump-preset-once-15'))
    expect(calls.upsert).toHaveBeenCalledWith(expect.objectContaining({ name: 'Once a day · 15 min (08:00)', enabled: false }))
    expect(screen.queryByTestId('pump-preset-once-15')).toBeNull()
  })

  it('names the next run\'s cycle once, without a preset\'s time in its name', () => {
    data.set('schedules', [{ ...morning, name: 'Once a day · 15 min (08:00)' }])
    render(<WaterPage />)
    expect(within(screen.getByTestId('pump-strip')).getByText(/^Next run 08:00 \(Once a day · 15 min\) · supply/)).toBeTruthy()
  })

  it('says when nothing will water, and leads from the strip to the pump cycles', () => {
    data.set('schedules', [curve])
    render(<WaterPage />)
    const strip = within(screen.getByTestId('pump-strip'))
    expect(strip.getByText('No watering schedule')).toBeTruthy()
    expect(screen.getByTestId('pump-strip').textContent).toContain('No watering schedule · supply 12.3 V')
    const into = vi.fn()
    const section = document.getElementById('pump-cycles') as HTMLElement
    section.scrollIntoView = into
    fireEvent.click(strip.getByText('No watering schedule'))
    expect(into).toHaveBeenCalled()
    cleanup()
    // While the schedules load, it doesn't guess.
    data.delete('schedules')
    render(<WaterPage />)
    expect(screen.queryByText('No watering schedule')).toBeNull()
  })

  it('adds a cycle through the editor, with no Delete until it exists', () => {
    data.set('schedules', [])
    render(<WaterPage />)
    fireEvent.click(screen.getByTestId('pump-preset-blank'))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByText('Delete')).toBeNull()
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Noon' } })
    fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: '12:30' } })
    fireEvent.click(within(dialog).getByRole('tab', { name: '3 min' }))
    fireEvent.click(within(dialog).getByText('S', { selector: 'button:last-child' }))
    fireEvent.click(within(dialog).getByText('Save'))
    expect(calls.upsert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pump', name: 'Noon', days: 63, spec: { minute: 750, durationS: 180 } }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('edits or deletes a cycle from its menu', () => {
    render(<WaterPage />)
    fireEvent.click(screen.getByLabelText('Edit Morning watering'))
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Delete'))
    expect(calls.remove).toHaveBeenCalledWith({ id: 'morning' })
    fireEvent.click(screen.getByText('Evening watering'))
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Cancel'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls.upsert).not.toHaveBeenCalled()
  })
})

describe('WaterPage: history', () => {
  it('lists recent runs by cycle name, falling back to the id of a deleted one', () => {
    render(<WaterPage />)
    expect(screen.getByText('Today 08:00')).toBeTruthy()
    expect(screen.getByText('gone')).toBeTruthy()
    cleanup()
    data.set('runs', [])
    render(<WaterPage />)
    expect(screen.getByText('No scheduled runs yet.')).toBeTruthy()
  })

  it('charts the tank over a week by default, with top-ups and the drain rate', () => {
    render(<WaterPage />)
    expect(calls.history).toHaveBeenLastCalledWith({ sensor: 'water_level_pct', hours: 168, maxPoints: 300 })
    expect(screen.getByTestId('tank-summary').textContent).toBe('One top-up this week. Drops about 14% a day.')
    expect(screen.getByTestId('tank-stats').textContent).toBe('min 60%avg 77%max 92%')
    fireEvent.click(screen.getByRole('tab', { name: '24h' }))
    expect(calls.history).toHaveBeenLastCalledWith({ sensor: 'water_level_pct', hours: 24, maxPoints: 300 })
    expect(screen.getByTestId('tank-summary').textContent).toMatch(/ today\./)
    fireEvent.click(screen.getByRole('tab', { name: '30d' }))
    expect(screen.getByTestId('tank-summary').textContent).toMatch(/ this month\./)
  })

  it('shows loading, error and empty states for the tank chart', () => {
    state.historyLoading = true
    render(<WaterPage />)
    expect(screen.queryByTestId('tank-stats')).toBeNull()
    cleanup()
    Object.assign(state, { historyLoading: false, historyError: { message: 'boom' } })
    render(<WaterPage />)
    expect(screen.getByText(/Couldn't load the tank history: boom/)).toBeTruthy()
    cleanup()
    state.historyError = null
    data.set('history', [])
    render(<WaterPage />)
    expect(screen.getByText('No tank level recorded in this window.')).toBeTruthy()
    cleanup()
    data.set('history', [{ ts: at(0).toISOString(), value: 50 }, { ts: at(1).toISOString(), value: 49 }, { ts: at(2).toISOString(), value: 70 }, { ts: at(3).toISOString(), value: 90 }])
    render(<WaterPage />)
    expect(screen.getByTestId('tank-summary').textContent).toMatch(/^2 top-ups/)
  })
})

describe('WaterPage with WebGL: the tank hero', () => {
  beforeEach(() => {
    vi.stubGlobal('WebGLRenderingContext', function WebGLRenderingContext() {})
    hero.fail = false
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('puts the level once in big type over one line, the range as plain tabs, and the history and glass on one scale', () => {
    render(<WaterPage />)
    expect(screen.getAllByText('71%')).toHaveLength(1)
    expect(screen.getByText('≈ 13.5 of 19 L')).toBeTruthy()
    expect(screen.getByTestId('tank-summary').textContent).toBe('One top-up this week · drops about 14% a day')
    expect(screen.getByTestId('tank-3d').textContent).toMatch(/^now · 9\.4 cm · cutoff 27% · 16 cm · 1 top-up · still · ran /)
    // The scale's words are on the glass now: no footer, no flat meter, no separate history card.
    expect(screen.queryByText('empty · 20 cm')).toBeNull()
    expect(screen.queryByRole('meter', { name: 'Tank level' })).toBeNull()
    expect(screen.queryByTestId('tank-stats')).toBeNull()
    const tabs = within(screen.getByRole('tablist', { name: 'Tank level range' }))
    expect(tabs.getByRole('tab', { name: '7d' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(tabs.getByRole('tab', { name: '24h' }))
    expect(calls.history).toHaveBeenLastCalledWith({ sensor: 'water_level_pct', hours: 24, maxPoints: 300 })
    expect(screen.getByTestId('tank-summary').textContent).toMatch(/ today/)
  })

  it('while the pump runs, says how far this run has drawn the tank down and draws the run into the glass', () => {
    // History: 85% at 12:00 on the 3rd; the run began after it; the tank reads 71% now.
    vi.setSystemTime(at(13, 0, 3))
    data.set('pump', { ...idle, on: true, level: 30, since: at(12, 30, 3).toISOString(), remainingS: 240 })
    render(<WaterPage />)
    expect(screen.getByTestId('tank-summary').textContent).toBe('Down 14% so far this run')
    expect(screen.getByTestId('tank-3d').textContent).toMatch(/pumping · ran /)
    expect(screen.getByTestId('tank-3d').getAttribute('aria-label')).toMatch(/with the pump running/)
    cleanup()
    data.set('history', [])
    render(<WaterPage />)
    expect(screen.getByTestId('tank-summary').textContent).toBe('Watering now')
  })

  it('ticks scheduled runs along the week, and today\'s still to come on the day\'s range', () => {
    // History runs from the 1st 00:00 to the 3rd 00:00; it's noon on the 3rd.
    vi.setSystemTime(at(12, 0, 3))
    data.set('runs', [{ scheduleId: 'morning', key: 'm1', firedAt: at(0, 0, 2).toISOString(), result: 'ok' }, { scheduleId: 'day', key: 'd1', firedAt: at(1, 0, 2).toISOString(), result: 'ok' }])
    render(<WaterPage />)
    // Only pump cycles' runs, about half way along (1 Nov has 25 h: the clocks go back); no "later" ticks off the day's range.
    expect(screen.getByTestId('tank-3d').textContent).toMatch(/ran 0\.52 · later $/)
    fireEvent.click(screen.getByRole('tab', { name: '24h' }))
    // The evening cycle at 20:00 is still to come: 8 h into the 12 h left of the day.
    expect(screen.getByTestId('tank-3d').textContent).toMatch(/later 0\.67$/)
  })

  it('holds the readout\'s place while loading and says the history is loading', () => {
    data.delete('sensors')
    state.historyLoading = true
    render(<WaterPage />)
    expect(screen.getByText('loading …')).toBeTruthy()
    expect(screen.getByText('100%').className).toContain('animate-pulse')
    expect(screen.getByTestId('tank-3d').getAttribute('data-state')).toBe('loading')
  })

  it('goes back to the flat meter and history chart when the 3D tank can\'t run', () => {
    hero.fail = true
    render(<WaterPage />)
    expect(screen.getByRole('meter', { name: 'Tank level' })).toBeTruthy()
    expect(screen.getByTestId('tank-stats').textContent).toBe('min 60%avg 77%max 92%')
    expect(screen.getByTestId('pump-strip')).toBeTruthy()
  })
})
