// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LightPage } from '../LightPage'

const { data, calls } = vi.hoisted(() => ({ data: new Map<string, unknown>(), calls: { resume: vi.fn(), set: vi.fn(), upsert: vi.fn() } }))

vi.mock('@/src/components/Schedule/CurveEditor', () => ({ CurveEditor: () => null }))
vi.mock('@/src/utils/trpc', () => {
  const query = (name: string) => ({ useQuery: () => ({ data: data.get(name) }) })
  const mutation = (name: keyof typeof calls) => ({ useMutation: () => ({ isPending: false, mutate: (i?: unknown) => calls[name](i) }) })
  return {
    trpc: {
      useUtils: () => ({ light: { invalidate: vi.fn() }, schedules: { invalidate: vi.fn() } }),
      light: { get: query('light'), owner: query('owner'), set: mutation('set'), resume: mutation('resume') },
      schedules: { list: query('schedules'), upsert: mutation('upsert') },
      telemetry: { lightHours: query('hours') },
    },
  }
})

beforeEach(() => {
  data.clear()
  for (const f of Object.values(calls)) f.mockReset()
  data.set('light', { on: true, level: 80, since: '2026-10-31T10:00:00Z', fault: null, remainingS: null })
  data.set('schedules', [])
  data.set('hours', { hours: 1200, ratedHours: 25000, pctUsed: 4.8 })
})
afterEach(cleanup)

describe('LightPage: who controls the light', () => {
  it('offers Resume while a manual change holds', () => {
    data.set('owner', { source: 'manual', level: 80, leaseId: null, manualUntil: '2026-10-31T10:30:00Z', schedule: 40 })
    render(<LightPage />)
    expect(screen.getByText(/Your change holds until/)).toBeTruthy()
    fireEvent.click(screen.getByText('Resume'))
    expect(calls.resume).toHaveBeenCalled()
    expect(screen.getByTestId('led-hours').textContent).toBe('1,200 of 25,000 rated hours')
    expect(screen.getByText('95%')).toBeTruthy()
  })

  it('says when Autopilot or the schedule is in charge', () => {
    data.set('owner', { source: 'autopilot', level: 60, leaseId: 'rule:1:0', manualUntil: null, schedule: 40 })
    render(<LightPage />)
    expect(screen.getByText(/Autopilot is setting the light/)).toBeTruthy()
    expect(screen.queryByText('Resume')).toBeNull()
    cleanup()
    data.set('owner', { source: 'schedule', level: 40, leaseId: null, manualUntil: null, schedule: 40 })
    render(<LightPage />)
    expect(screen.getByText(/Following the schedule/)).toBeTruthy()
  })
})
