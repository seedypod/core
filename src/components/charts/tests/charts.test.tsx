// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fmtClock, fmtDate } from '../format'
import { bin, bridge, TimeChart } from '../TimeChart'
import { TrendCard } from '../TrendCard'

const { history, asked } = vi.hoisted(() => ({ history: { current: {} as Record<string, unknown> }, asked: [] as unknown[] }))
vi.mock('@/src/utils/trpc', () => ({
  trpc: { telemetry: { history: { useQuery: (input: unknown) => {
    asked.push(input)
    return history.current
  } } } },
}))

afterEach(cleanup)

describe('bridge', () => {
  it('draws across short gaps and leaves long ones', () => {
    expect(bridge([1, Number.NaN, 3], 2)).toEqual([1, 2, 3])
    expect(bridge([0, Number.NaN, Number.NaN, 3], 2)).toEqual([0, 1, 2, 3])
    expect(bridge([0, Number.NaN, Number.NaN, Number.NaN, 4], 2).slice(1, 4).every(Number.isNaN)).toBe(true)
    expect(bridge([Number.NaN, 1, Number.NaN], 2).map(Number.isNaN)).toEqual([true, false, true])
  })
})

describe('bin', () => {
  it('averages irregular points onto an even grid, bridging short gaps but not before a series starts', () => {
    const { xs, data } = bin([
      { name: 'a', points: [{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 10, y: 5 }] },
      { name: 'b', points: [{ x: 10, y: 7 }] },
    ], 3)
    expect(xs).toEqual([0, 5, 10])
    expect(data[0]).toEqual([2, 3.5, 5])
    expect(data[1]).toEqual([Number.NaN, Number.NaN, 7])
  })

  it('handles no points and a single x', () => {
    expect(bin([{ name: 'a', points: [] }], 10)).toEqual({ xs: [], data: [[]] })
    expect(bin([{ name: 'a', points: [{ x: 4, y: 2 }, { x: 4, y: 4 }] }], 10)).toEqual({ xs: [4], data: [[3]] })
  })
})

describe('TimeChart', () => {
  it('names itself, labels both axes, shows a legend for several series, and says when empty', () => {
    const { unmount } = render(<TimeChart series={[{ name: 'Tank', points: [{ x: 0, y: 10 }, { x: 60, y: 30 }] }, { name: 'Pump', points: [{ x: 0, y: 1 }, { x: 60, y: 2 }] }]} formatX={fmtClock} formatY={v => `${v}%`} />)
    expect(screen.getByRole('img', { name: 'Tank, Pump' })).toBeTruthy()
    expect(screen.getByLabelText('Legend').textContent).toBe('TankPump')
    expect(screen.getByText('00:00')).toBeTruthy()
    expect(screen.getByText('01:00')).toBeTruthy()
    expect(screen.getByText('30%')).toBeTruthy()
    unmount()
    render(<TimeChart series={[{ name: 'x', points: [] }]} empty="Nothing here." />)
    expect(screen.getByText('Nothing here.')).toBeTruthy()
  })

  it('labels a flat series once', () => {
    render(<TimeChart series={[{ name: 'Pump', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }]} formatY={v => `${v} W`} />)
    expect(screen.getAllByText('0 W')).toHaveLength(1)
  })

  it('puts a marker only where its x is inside the range', () => {
    render(<TimeChart series={[{ name: 'Curve', points: [{ x: 0, y: 0 }, { x: 1440, y: 50 }] }]} markers={[{ x: 720, label: 'now' }, { x: 5000, label: 'later' }]} />)
    expect(screen.getAllByTestId('chart-marker').map(m => m.textContent)).toEqual(['now'])
  })
})

describe('TrendCard', () => {
  beforeEach(() => {
    asked.length = 0
  })
  const latest = { value: 64, unit: '%', ts: new Date().toISOString(), quality: 'good' as const }

  it('shows the live value, the chart and min / avg / max, and changes range', () => {
    history.current = { data: [{ ts: '2026-10-31T10:00:00Z', value: 60 }, { ts: '2026-10-31T11:00:00Z', value: 70 }], isLoading: false, error: null }
    render(<TrendCard sensor="water_level_pct" title="Tank level" color="red" latest={latest} />)
    expect(screen.getByTestId('trend-water_level_pct-value').textContent).toBe('64%')
    expect(screen.getByText('0s ago')).toBeTruthy()
    expect(screen.getByTestId('trend-water_level_pct-stats').textContent).toBe('min 60%avg 65%max 70%')
    expect(asked.at(-1)).toEqual({ sensor: 'water_level_pct', hours: 24, maxPoints: 144 })
    fireEvent.click(screen.getByRole('tab', { name: '7d' }))
    expect(asked.at(-1)).toEqual({ sensor: 'water_level_pct', hours: 168, maxPoints: 336 })
  })

  it('has loading, error and empty states', () => {
    history.current = { data: undefined, isLoading: true, error: null }
    const a = render(<TrendCard sensor="ph" title="pH" color="red" />)
    expect(screen.getByTestId('trend-ph-value').textContent).toBe('—')
    expect(screen.queryByRole('img')).toBeNull()
    a.unmount()
    history.current = { data: undefined, isLoading: false, error: new Error('timeout') }
    const b = render(<TrendCard sensor="ph" title="pH" color="red" />)
    expect(screen.getByText('Couldn\'t load the ph history: timeout')).toBeTruthy()
    b.unmount()
    history.current = { data: [], isLoading: false, error: null }
    render(<TrendCard sensor="ph" title="pH" color="red" latest={{ value: 6.1, unit: 'pH', ts: '2026-10-31T00:00:00Z', quality: 'good' }} />)
    expect(screen.getByText('No ph recorded in this window.')).toBeTruthy()
    expect(screen.getByTestId('trend-ph-value').textContent).toBe('6.1')
  })
})

it('formats dates', () => {
  expect(fmtDate(Date.UTC(2026, 9, 31, 12))).toMatch(/Oct/)
})
