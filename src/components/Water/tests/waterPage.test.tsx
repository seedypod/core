// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WaterPage } from '../WaterPage'

const { data, calls, state, pumpSuccess } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: { runOnce: vi.fn(), stop: vi.fn(), upsert: vi.fn(), remove: vi.fn(), history: vi.fn(), invalidatePump: vi.fn(), setPump: vi.fn() },
  pumpSuccess: new Map<string, (s: unknown) => void>(),
  state: { runError: null as null | { message: string }, historyLoading: false, historyError: null as null | { message: string } },
}))

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
      useUtils: () => ({ pump: { invalidate: calls.invalidatePump, get: { setData: calls.setPump } }, schedules: { invalidate: vi.fn() }, tank: { invalidate: vi.fn() }, care: { invalidate: vi.fn() } }),
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

  it('sums up the tank, the pump and the next run, against the calibration', () => {
    render(<WaterPage />)
    expect(screen.getByText('Tank 71% · pump idle · next run 20:00')).toBeTruthy()
    expect(screen.getByText('≈ 13.5 of 19 L')).toBeTruthy()
    expect(screen.getByText('empty · 20 cm')).toBeTruthy()
    expect(screen.getByText('full · 5 cm')).toBeTruthy()
    expect(screen.getByText('pump cutoff 27%')).toBeTruthy()
    expect(screen.getByText('9.4 cm')).toBeTruthy()
    expect(screen.getByText(/Up to 900 s per run at 30% duty\. Won't start below 16 cm of water\./)).toBeTruthy()
  })

  it('runs the pump for the chosen length, and swaps to Stop while it runs', () => {
    render(<WaterPage />)
    fireEvent.click(screen.getByRole('tab', { name: '10 min' }))
    fireEvent.click(screen.getByText('Run pump'))
    expect(calls.runOnce).toHaveBeenCalledWith({ durationS: 600 })
    cleanup()
    data.set('pump', { ...idle, on: true, level: 30, remainingS: 120 })
    render(<WaterPage />)
    expect(screen.getByText(/pump running at 30% · 120s left/)).toBeTruthy()
    expect(screen.queryByText('Run pump')).toBeNull()
    fireEvent.click(screen.getByText('Stop'))
    expect(calls.stop).toHaveBeenCalled()
  })

  it('reports a refused run and a latched fault', () => {
    state.runError = { message: 'tank too low' }
    data.set('pump', { ...idle, fault: 'dry run' })
    render(<WaterPage />)
    expect(screen.getByText('tank too low')).toBeTruthy()
    expect(screen.getByText(/pump fault: dry run/)).toBeTruthy()
    expect(screen.getByText('Run pump').closest('button')?.disabled).toBe(true)
  })

  it('waits for readings without guessing', () => {
    data.delete('sensors')
    data.delete('settings')
    data.delete('pump')
    data.delete('system')
    render(<WaterPage />)
    expect(screen.getByText('… · next run 20:00')).toBeTruthy()
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

  it('adds a cycle through the editor, with no Delete until it exists', () => {
    data.set('schedules', [])
    render(<WaterPage />)
    expect(screen.getByText(/No pump cycles/)).toBeTruthy()
    fireEvent.click(screen.getByText('Add cycle'))
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
