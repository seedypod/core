// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Chart3DModule from '@/src/components/charts/viz3d/Chart3D'
import { editorLengths, START_WAIT_MS, WaterPage } from '../WaterPage'

const { data, calls, state, pumpSuccess } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: { updateSettings: vi.fn(), runOnce: vi.fn(), stop: vi.fn(), ack: vi.fn(), upsert: vi.fn(), remove: vi.fn(), history: vi.fn(), invalidatePump: vi.fn(), setPump: vi.fn() },
  pumpSuccess: new Map<string, (s: unknown) => void>(),
  state: { ackError: null as null | { message: string }, runError: null as null | { message: string }, historyLoading: false, historyError: null as null | { message: string }, failOn: null as null | string, order: [] as string[] },
}))

// The hero's 3D tank as a stub showing what it was handed, or giving up as a browser without WebGL would.
const hero = vi.hoisted(() => ({ fail: false }))
vi.mock('@/src/components/charts/viz3d/Chart3D', async (orig) => {
  const real = await orig<typeof Chart3DModule>()
  const { useEffect } = await import('react')
  return {
    ...real,
    Chart3D: ({ status, data, label, onUnavailable }: { status: string, label: string, data: { marks: { now: string, cutoff: string | null }, low: boolean, pumping: boolean, topUps: number[], runs: number[], upcoming: number[], preview: number[] } | null, onUnavailable?: () => void }) => {
      useEffect(() => {
        if (hero.fail) onUnavailable?.()
      }, [onUnavailable])
      return <div data-testid="tank-3d" data-state={status} data-low={data ? String(data.low) : undefined} aria-label={label}>{data && `${data.marks.now} · ${data.marks.cutoff} · ${data.topUps.length} top-up · ${data.pumping ? 'pumping' : 'still'} · ran ${data.runs.map(r => r.toFixed(2)).join(',')} · later ${data.upcoming.map(r => r.toFixed(2)).join(',')} · preview ${data.preview.map(r => r.toFixed(2)).join(',')}`}</div>
    },
  }
})

// Care has its own tests; the Water page only points at it, and shows the due chores' rows the sidebar shares.
vi.mock('@/src/components/Care/CareSummary', () => ({ CareSummary: () => null }))
vi.mock('@/src/components/Care/ChoreItem', () => ({ DueChores: () => <div data-testid="due-chores" /> }))
// The protocol's line has its own tests; here it only has its place.
vi.mock('../ProtocolLine', () => ({ ProtocolLine: () => <div data-testid="protocol-line" /> }))

vi.mock('@/src/utils/trpc', () => {
  const query = (name: string) => ({ useQuery: () => ({ data: data.get(name) }) })
  const mutation = (name: 'runOnce' | 'stop' | 'upsert' | 'remove') => ({
    useMutation: (o: { onSuccess: (s: unknown) => void }) => {
      pumpSuccess.set(name, o.onSuccess)
      return {
        isPending: false,
        error: name === 'runOnce' ? state.runError : null,
        reset: vi.fn(),
        mutate: (i?: unknown) => calls[name](i),
        mutateAsync: async (i?: unknown) => {
          calls[name](i)
          const id = (i as { id?: string } | undefined)?.id ?? ''
          state.order.push(`${name}:${id}`)
          if (state.failOn === `${name}:${id}`) throw new Error('the unit said no')
        },
      }
    },
  })
  return {
    trpc: {
      useUtils: () => ({ pump: { invalidate: calls.invalidatePump, get: { setData: calls.setPump } }, schedules: { invalidate: vi.fn() }, tank: { invalidate: vi.fn() }, care: { invalidate: vi.fn() }, alerts: { invalidate: vi.fn() }, settings: { invalidate: vi.fn() }, grow: { invalidate: vi.fn() } }),
      alerts: { list: query('alerts'), acknowledge: { useMutation: (o: { onSuccess: () => void }) => ({ isPending: false, error: state.ackError, mutate: (i: unknown) => {
        calls.ack(i)
        o.onSuccess()
      } }) } },
      pump: { get: query('pump'), runOnce: mutation('runOnce'), stop: mutation('stop') },
      sensors: { latest: query('sensors') },
      care: { chores: query('chores') },
      tank: { actions: query('tankActions'), logAction: { useMutation: () => ({ mutate: vi.fn(), error: null }) }, removeAction: { useMutation: () => ({ mutate: vi.fn(), error: null }) } },
      system: { info: query('system') },
      settings: { get: query('settings'), update: { useMutation: (o?: { onSuccess?: () => void }) => ({ isPending: false, mutate: (i: unknown) => {
        calls.updateSettings(i)
        o?.onSuccess?.()
      } }) } },
      grow: { current: query('grow'), pods: query('pods') },
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
  Object.assign(state, { runError: null, historyLoading: false, historyError: null, failOn: null, order: [] })
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
    // Today's timeline, water first, says the same.
    expect(screen.getAllByTestId(/^lane-/).map(l => l.dataset.testid)).toEqual(['lane-water', 'lane-light'])
    expect(screen.getByTestId('timeline-next').textContent).toBe('next · Watering 5 min in 8h 0m')
    const strip = within(screen.getByTestId('pump-strip'))
    expect(strip.getByText('Pump idle')).toBeTruthy()
    expect(strip.getByText('Next run 20:00 (Evening watering) · supply 12.3 V')).toBeTruthy()
    expect(screen.getByText('≈ 13.5 of 19 L')).toBeTruthy()
    expect(screen.getByText('empty · 20 cm')).toBeTruthy()
    expect(screen.getByText('full · 5 cm')).toBeTruthy()
    // The scale's and the history's keys to the hatching.
    expect(screen.getAllByText('unusable · below pump cutoff 27%')).toHaveLength(2)
    expect(screen.getByText('9.4 cm')).toBeTruthy()
    // The pump's limits are Run's tooltip.
    expect(strip.getByRole('button', { name: 'Run' }).getAttribute('title')).toBe('Up to 15 min per run at 30% duty. Won\'t start below 16 cm of water.')
  })

  it('shows the due chores with the rows the sidebar\'s Needs you shares', () => {
    render(<WaterPage />)
    expect(screen.getByTestId('due-chores')).toBeTruthy()
  })

  it('finds the next run on the unit\'s clock, not the browser\'s', () => {
    // 12:00 UTC is 21:00 in Tokyo: the evening run there has gone, so the morning's is next.
    vi.setSystemTime(new Date('2026-11-01T12:00:00Z'))
    data.set('settings', { waterFullCm: 5, waterEmptyCm: 20, tankCapacityL: 19, timezone: 'Asia/Tokyo' })
    render(<WaterPage />)
    expect(screen.getByText('pump idle · next run 08:00')).toBeTruthy()
    expect(screen.getByTestId('timeline-next').textContent).toBe('next · Watering 5 min in 11h 0m')
    cleanup()
    data.set('settings', { waterFullCm: 5, waterEmptyCm: 20, tankCapacityL: 19, timezone: 'UTC' })
    render(<WaterPage />)
    expect(screen.getByText('pump idle · next run 20:00')).toBeTruthy()
    expect(screen.getByTestId('timeline-next').textContent).toBe('next · Watering 5 min in 8h 0m')
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
    // While the pump has its chance to start, the strip keeps its usual line.
    expect(within(screen.getByTestId('pump-strip')).getByText('Next run 20:00 (Evening watering) · supply 12.3 V')).toBeTruthy()
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
    expect(screen.queryByTestId('tank-reserve')).toBeNull()
    expect(screen.getByRole('meter', { name: 'Tank level' }).getAttribute('aria-description')).toBeNull()
  })

  it('hatches the water under the pump cutoff as unusable, on the meter and under the history\'s cutoff line', () => {
    render(<WaterPage />)
    // (20 − 16) / (20 − 5) of the tank.
    expect(screen.getByTestId('tank-reserve').style.width).toBe('27%')
    expect(screen.getByTestId('tank-reserve').className).toContain('tank-reserve')
    expect(screen.getByRole('meter', { name: 'Tank level' }).getAttribute('aria-description')).toBe('The bottom 27%, below the pump cutoff, is hatched: the pump won\'t draw it.')
    // From the cutoff line down to the floor of the 160 px plot (4 px padding each side).
    const band = screen.getByTestId('chart-band')
    expect(band.className).toContain('tank-reserve')
    expect(Number.parseFloat(band.style.top)).toBeCloseTo(4 + 0.73 * 152)
    expect(Number.parseFloat(band.style.height)).toBeCloseTo(0.27 * 152)
    // Above the cutoff the pump can still draw.
    expect(screen.queryByTestId('tank-in-reserve')).toBeNull()
  })

  it('says the pump won\'t start once the distance is past the HAL\'s waterLowCm, whatever the rounded level says', () => {
    // 28% rounds above the 27% cutoff, but the sensor reads 16 cm: the HAL refuses.
    data.set('sensors', { ...(data.get('sensors') as object), water_level_pct: { value: 28, unit: '%' }, water_distance: { value: 16, unit: 'cm' } })
    render(<WaterPage />)
    expect(screen.getByTestId('tank-in-reserve').textContent).toBe('Below the pump cutoff · the pump won\'t start')
    expect(screen.getByRole('meter', { name: 'Tank level' }).firstElementChild?.className).toContain('opacity-60')
    cleanup()
    // 27% equals the rounded cutoff, but 15.9 cm is short of 16: the pump still starts.
    data.set('sensors', { ...(data.get('sensors') as object), water_level_pct: { value: 27, unit: '%' }, water_distance: { value: 15.9, unit: 'cm' } })
    render(<WaterPage />)
    expect(screen.queryByTestId('tank-in-reserve')).toBeNull()
    expect(screen.getByRole('meter', { name: 'Tank level' }).firstElementChild?.className).not.toContain('opacity-60')
  })

  it('falls back to the unrounded level against the unrounded cutoff without a distance', () => {
    const rest = { ...(data.get('sensors') as Record<string, unknown>) }
    delete rest.water_distance
    // 26.8% rounds to the 27% cutoff, but is over the true 26.67%.
    data.set('sensors', { ...rest, water_level_pct: { value: 26.8, unit: '%' } })
    render(<WaterPage />)
    expect(screen.queryByTestId('tank-in-reserve')).toBeNull()
    cleanup()
    data.set('sensors', { ...rest, water_level_pct: { value: 26.5, unit: '%' } })
    render(<WaterPage />)
    expect(screen.getByTestId('tank-in-reserve')).toBeTruthy()
  })

  it('draws no reserve when the cutoff is at empty', () => {
    // waterLowCm at the empty mark: cutoff 0%, nothing under it to hatch, even with the sensor past it.
    data.set('settings', { waterFullCm: 5, waterEmptyCm: 16, tankCapacityL: 19 })
    data.set('sensors', { ...(data.get('sensors') as object), water_distance: { value: 17, unit: 'cm' } })
    render(<WaterPage />)
    expect(screen.queryByTestId('tank-reserve')).toBeNull()
    expect(screen.queryByTestId('chart-band')).toBeNull()
    expect(screen.queryByText(/unusable · below pump cutoff/)).toBeNull()
    expect(screen.queryByTestId('tank-in-reserve')).toBeNull()
    expect(screen.getByRole('meter', { name: 'Tank level' }).getAttribute('aria-description')).toBeNull()
  })
})

describe('WaterPage: pump cycles', () => {
  it('lists cycles by time with their last or next run, and toggles one at once', () => {
    render(<WaterPage />)
    const rows = screen.getAllByRole('switch').map(s => s.getAttribute('aria-label')).filter(l => l?.startsWith('Enable '))
    expect(rows).toEqual(['Enable Morning watering', 'Enable Evening watering'])
    expect(screen.getByText('ran 4 h ago')).toBeTruthy()
    expect(screen.getByText('next in 8 h')).toBeTruthy()
    // Each row's length, and its week with the days lit.
    const evening = screen.getByText('5 min at 50%')
    expect(within(evening).getByTestId('weekday-dots').getAttribute('aria-label')).toBe('Runs every day')
    expect(within(evening).getByText('Every day')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Evening watering' }))
    expect(calls.upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'evening', enabled: false }))
  })

  it('marks the preset the cycles already are', () => {
    data.set('schedules', [curve, { ...morning, id: 'water-seedlings-0800', name: 'Seedlings · once a day 10 min (08:00)', spec: { minute: 480, durationS: 600 } }])
    render(<WaterPage />)
    // The section header names it.
    expect(screen.getByTestId('pump-running').textContent).toBe('·Seedlings running')
    cleanup()
    // Cycles of your own say so; none, nothing.
    data.set('schedules', [curve, morning])
    render(<WaterPage />)
    expect(screen.getByTestId('pump-running').textContent).toBe('·custom cycles')
    cleanup()
    data.set('schedules', [curve])
    render(<WaterPage />)
    expect(screen.queryByTestId('pump-running')).toBeNull()
  })

  it('counts a preset as running only as Follow does: paused, trimmed or re-timed, the cycles are your own', () => {
    const seedlings = { ...morning, id: 'water-seedlings-0800', name: 'Seedlings · once a day 10 min (08:00)', spec: { minute: 480, durationS: 600 } }
    for (const changed of [{ ...seedlings, enabled: false }, { ...seedlings, days: 31 }, { ...seedlings, spec: { minute: 480, durationS: 420 } }]) {
      data.set('schedules', [curve, changed])
      render(<WaterPage />)
      expect(screen.getByTestId('pump-running').textContent).toBe('·custom cycles')
      cleanup()
    }
    // Germination counts on any one weekday, as Follow keeps it.
    data.set('schedules', [curve, { ...morning, id: 'water-germination-0800', name: 'Germination · once a week 15 min (08:00)', days: 1 << 4, spec: { minute: 480, durationS: 900 } }])
    render(<WaterPage />)
    expect(screen.getByTestId('pump-running').textContent).toBe('·Germination running')
  })

  it('says plainly when the sowing day\'s germination run has gone by, and offers it by hand', () => {
    // Sown today at 09:00; it's noon, after germination's 08:00 run.
    data.set('grow', { cycle: { id: 'c', startedAt: at(9).toISOString(), endedAt: null, stage: 'germination', notes: '', issued: [] }, day: 0 })
    render(<WaterPage />)
    expect(screen.getByTestId('pump-missed').textContent).toMatch(/^Today’s 08:00 run has passed: water the pods now\?/)
    fireEvent.click(screen.getByRole('button', { name: 'Run 15 min now' }))
    // Nothing runs by itself: it asks once.
    expect(calls.runOnce).toHaveBeenCalledWith({ durationS: 900 })
    expect(screen.getAllByTestId('pump-missed')).toHaveLength(1)
    cleanup()
    // Today's 08:00 run came before this cycle began at 09:00: it was for the last sowing, so it still asks.
    data.set('runs', [{ scheduleId: 'water-germination-0800', key: 'g', firedAt: at(8).toISOString(), result: 'ok' }])
    render(<WaterPage />)
    expect(screen.getByTestId('pump-missed')).toBeTruthy()
    cleanup()
    // Once this cycle's run has happened today, or before 08:00, there's nothing to ask.
    data.set('grow', { cycle: { id: 'c', startedAt: at(0).toISOString(), endedAt: null, stage: 'germination', notes: '', issued: [] }, day: 0 })
    render(<WaterPage />)
    expect(screen.queryByTestId('pump-missed')).toBeNull()
    cleanup()
    // With no cycle open, any germination run today counts.
    data.set('grow', { cycle: null, day: null })
    data.set('pods', [{ slot: 1, plant: 'Basil', status: 'seeded', plantedAt: '2026-11-01' }])
    render(<WaterPage />)
    expect(screen.queryByTestId('pump-missed')).toBeNull()
    cleanup()
    data.set('runs', [])
    vi.setSystemTime(at(7))
    data.set('grow', { cycle: { id: 'c', startedAt: at(6).toISOString(), endedAt: null, stage: 'germination', notes: '', issued: [] }, day: 0 })
    render(<WaterPage />)
    expect(screen.queryByTestId('pump-missed')).toBeNull()
  })

  it('offers a preset\'s own run length in the editor, and keeps any other', () => {
    data.set('schedules', [{ ...morning, id: 'water-mature-0800', name: 'Mature · 3× 6 min (08:00)', spec: { minute: 480, durationS: 360 } }])
    render(<WaterPage />)
    fireEvent.click(screen.getByLabelText('Edit Mature · 3× 6 min (08:00)'))
    expect(within(screen.getByRole('dialog')).getByRole('tab', { name: '6 min' }).getAttribute('aria-selected')).toBe('true')
    expect(editorLengths(420)).toEqual([60, 180, 300, 360, 420, 600, 900])
    expect(editorLengths(300)).toEqual([60, 180, 300, 360, 600, 900])
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

  it('adds a custom cycle through the editor, with no Delete until it exists', () => {
    data.set('schedules', [])
    render(<WaterPage />)
    // No preset cards: the stages are the grow protocol's, on Grow, and the line here leads there.
    expect(screen.queryAllByTestId(/^pump-preset-/)).toHaveLength(0)
    expect(screen.getByTestId('protocol-line')).toBeTruthy()
    fireEvent.click(screen.getByText('Add custom cycle'))
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
    // The glass hatches the reserve; the key and the label say what it is.
    expect(screen.getByText('unusable · below pump cutoff 27%')).toBeTruthy()
    expect(screen.getByTestId('tank-3d').getAttribute('aria-label')).toBe('Tank at 71%, and its level over the last week. The bottom 27%, below the pump cutoff, is hatched: the pump won\'t draw it.')
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
    // Only pump cycles' runs; no "later" ticks off the day's range.
    // The history spans 48 h from its first sample; the run is the 2nd's local midnight, 24 or 25 h in.
    const along = ((at(0, 0, 2).getTime() - at(0).getTime()) / (48 * 3_600_000)).toFixed(2)
    expect(screen.getByTestId('tank-3d').textContent).toContain(`ran ${along} · later  · preview `)
    fireEvent.click(screen.getByRole('tab', { name: '24h' }))
    // The evening cycle at 20:00 is still to come: 8 h into the 12 h left of the day.
    expect(screen.getByTestId('tank-3d').textContent).toMatch(/later 0\.67 · preview $/)
  })

  it('holds the readout\'s place while loading and says the history is loading', () => {
    data.delete('sensors')
    state.historyLoading = true
    render(<WaterPage />)
    expect(screen.getByTestId('loading-line')).toBeTruthy()
    expect(screen.getByText('100%').className).toContain('animate-pulse')
    expect(screen.getByTestId('tank-3d').getAttribute('data-state')).toBe('loading')
    // No scene, so no hatching to describe yet.
    expect(screen.getByTestId('tank-3d').getAttribute('aria-label')).not.toMatch(/hatched/)
    expect(screen.queryByText(/unusable · below pump cutoff/)).toBeNull()
  })

  it('hands the scene the same "won\'t start" the readout shows', () => {
    expect(screen.queryByTestId('tank-3d')).toBeNull()
    render(<WaterPage />)
    expect(screen.getByTestId('tank-3d').getAttribute('data-low')).toBe('false')
    cleanup()
    data.set('sensors', { ...(data.get('sensors') as object), water_level_pct: { value: 28, unit: '%' }, water_distance: { value: 16.4, unit: 'cm' } })
    render(<WaterPage />)
    expect(screen.getByTestId('tank-3d').getAttribute('data-low')).toBe('true')
    expect(screen.getByTestId('tank-in-reserve')).toBeTruthy()
  })

  it('goes back to the flat meter and history chart when the 3D tank can\'t run', () => {
    hero.fail = true
    render(<WaterPage />)
    expect(screen.getByRole('meter', { name: 'Tank level' })).toBeTruthy()
    expect(screen.getByTestId('tank-stats').textContent).toBe('min 60%avg 77%max 92%')
    expect(screen.getByTestId('pump-strip')).toBeTruthy()
  })

  it('turns following the grow cycle on and off', () => {
    data.set('settings', { ...(data.get('settings') as object), followGrowCycle: true })
    render(<WaterPage />)
    const toggle = screen.getByRole('switch', { name: 'Follow the grow cycle' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(calls.updateSettings).toHaveBeenCalledWith({ followGrowCycle: false })
  })
})
