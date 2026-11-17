// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Limits, PumpRun } from '@/src/hardware/contract'
import { DryGuardCard } from '../DryGuardCard'

const { calls, state } = vi.hoisted(() => ({
  calls: { setGuard: vi.fn(), invalidate: vi.fn() },
  state: { error: null as null | { message: string }, pending: false },
}))

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({ system: { invalidate: calls.invalidate } }),
    pump: {
      setGuard: {
        useMutation: (o: { onSuccess: () => void }) => ({
          error: state.error,
          isPending: state.pending,
          mutate: (i: unknown, m?: { onSuccess?: () => void }) => {
            calls.setGuard(i)
            o.onSuccess()
            m?.onSuccess?.()
          },
        }),
      },
    },
  },
}))

const limits: Limits = {
  pumpMaxRunS: 900, pumpMaxDuty: 100, waterLowCm: 16,
  pumpDryGuard: 'both', pumpDryGuardAsked: 'both', pumpDryGuardApp: true,
  pumpDryCurrentA: 0.45, pumpDryCurrentMinA: 0.3, pumpDryCurrentMaxA: 3,
  pumpDryGraceMs: 3000, pumpDryGraceMinMs: 300, pumpDryGraceMaxMs: 5000,
  waterLowMinCm: 8, waterLowMaxCm: 19, waterLowHoldMs: 0, waterLowHoldMinMs: 0, waterLowHoldMaxMs: 60_000,
  pumpBrownoutV: 10.8, pumpBrownoutMs: 300, pumpBrownoutPi: false,
}
const run: PumpRun = { startedAt: '2026-11-16T16:00:00Z', endedAt: '2026-11-16T16:10:00Z', everyMs: 100, samples: Array.from({ length: 121 }, (_, i) => [i * 100, i < 23 ? 0.02 * i : 0.53, 12.4]), wetA: 0.53, endedBy: 'deadline', fault: null, levelPct: 65, levelCm: 10.3 }
const props = { limits, run, levelPct: 65, distanceCm: 10.3, distances: [], fullCm: 5, emptyCm: 20 }

beforeEach(() => {
  for (const f of Object.values(calls)) f.mockReset()
  state.error = null
  state.pending = false
})
afterEach(cleanup)

describe('DryGuardCard', () => {
  it('shows both guards on their signals, and Save only after a change', () => {
    render(<DryGuardCard {...props} />)
    expect(screen.getByRole('radio', { name: /Both/ }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('img', { name: /Pump current over the last run's first 12 s: 0.53 A wet, cutoff 0.45 A/ })).toBeTruthy()
    expect(screen.getByText('85% of wet')).toBeTruthy()
    expect(screen.getByTestId('level-readout').textContent).toMatch(/now 65%.*cutoff 27%/)
    expect(screen.getByTestId('brownout-guard').textContent).toBe('Brown-out guard: stops below 10.8 V for 0.3 s (set on the unit)')
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('saves only what changed: the guard, the cutoff, the level cutoff in cm and the hold', () => {
    render(<DryGuardCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Increase Pump current cutoff' }))
    fireEvent.click(screen.getByRole('button', { name: 'Decrease Tank level cutoff' }))
    fireEvent.click(screen.getByRole('button', { name: 'Increase Must stay below' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.setGuard).toHaveBeenCalledWith({ guard: undefined, currentA: 0.5, graceMs: undefined, waterLowCm: 16.1, waterLowHoldMs: 1000 })
    expect(calls.invalidate).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('sets the cutoff from the last run at 85 % of wet, and Cancel drops a change', () => {
    render(<DryGuardCard {...props} limits={{ ...limits, pumpDryCurrentA: null, pumpDryGuard: 'level', pumpDryGuardWhy: 'tank level only: no pump current cutoff yet' }} />)
    expect(screen.getByTestId('guard-why').textContent).toBe('Tank level only: no pump current cutoff yet')
    expect(screen.getByText('not set')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Set from last run' }))
    expect(screen.getByText('0.45 A')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('not set')).toBeTruthy()
  })

  it('in current-only mode, the tank level shrinks to a warning; in level-only, the current to a reading', () => {
    render(<DryGuardCard {...props} />)
    fireEvent.click(screen.getByRole('radio', { name: /Pump current/ }))
    expect(screen.getByText('Tank level won\'t stop the pump')).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Warn at' })).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Must stay below' })).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: /Tank level/ }))
    expect(screen.getByText('Pump current won\'t stop the pump')).toBeTruthy()
    // The grace is the current check's: it goes with it.
    expect(screen.queryByRole('group', { name: 'Grace before the pump-current check' })).toBeNull()
    expect(within(screen.getByText('Pump current won\'t stop the pump').closest('div')?.parentElement as HTMLElement).getByText('last run 0.53 A')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(calls.setGuard).toHaveBeenCalledWith(expect.objectContaining({ guard: 'level' }))
  })

  it('warns when the cutoff would stop a healthy pump or never trip', () => {
    render(<DryGuardCard {...props} limits={{ ...limits, pumpDryCurrentA: 0.6 }} />)
    expect(screen.getByText(/At or above the wet draw/)).toBeTruthy()
    cleanup()
    render(<DryGuardCard {...props} limits={{ ...limits, pumpDryCurrentA: 0.3 }} run={{ ...run, fault: 'dry-run: pump drew 0.31 A, below 0.45 A for 0.3 s: it\'s pulling air' }} />)
    expect(screen.getByText(/at or under dry: it won't trip/)).toBeTruthy()
  })

  it('won\'t offer tank level alone when hal.toml has the tank interlock off', () => {
    render(<DryGuardCard {...props} limits={{ ...limits, waterLowCm: null }} />)
    expect((screen.getByRole('radio', { name: /Tank level/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('radio', { name: /Pump current/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('holds the guard when hal.toml locks it, and shows nothing for a hald with no guard', () => {
    render(<DryGuardCard {...props} limits={{ ...limits, pumpDryGuardApp: false }} />)
    expect(screen.getByTestId('guard-locked')).toBeTruthy()
    expect((screen.getByRole('radio', { name: /Pump current/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('radio', { name: /Both/ }) as HTMLButtonElement).disabled).toBe(false)
    cleanup()
    const { container } = render(<DryGuardCard {...props} limits={{ pumpMaxRunS: 900, pumpMaxDuty: 30, waterLowCm: 16 }} />)
    expect(container.innerHTML).toBe('')
  })

  it('on a hald that can only take the grace, shows the guard but no choice or cutoff to change', () => {
    render(<DryGuardCard {...props} limits={{ pumpMaxRunS: 900, pumpMaxDuty: 30, waterLowCm: 16, pumpDryGuard: 'level', pumpDryGraceMs: 1200, pumpDryGraceMinMs: 300, pumpDryGraceMaxMs: 5000 }} />)
    expect(screen.getByText(/can't change the guard from here; update it/)).toBeTruthy()
    expect((screen.getByRole('radio', { name: /Both/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('group', { name: 'Pump current cutoff' })).toBeNull()
  })

  it('says why a save failed and holds Save while one is on its way', () => {
    state.error = { message: 'the dry-run guard is locked in hal.toml on the unit' }
    state.pending = true
    render(<DryGuardCard {...props} />)
    expect(screen.getByText('the dry-run guard is locked in hal.toml on the unit')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Increase Pump current cutoff' }))
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
