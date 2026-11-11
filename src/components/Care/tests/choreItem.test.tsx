// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChoreRow } from '@/src/components/Water/Chores'
import { ChoreItem, DueChores } from '../ChoreItem'

interface Alert { id: number, kind: string, active: boolean, detail: string, raisedAt: string, clearedAt: string | null, acknowledgedAt: string | null, dismissedAt: string | null }

const { data, calls, toasts, state } = vi.hoisted(() => ({
  data: { chores: undefined as unknown, open: [] as unknown[], history: undefined as unknown },
  calls: { logAction: vi.fn(), removeAction: vi.fn(), acknowledge: vi.fn(), dismiss: vi.fn(), historyEnabled: vi.fn(), invalidate: vi.fn() },
  toasts: [] as Array<{ id: string, title: string, action?: { label: string, onClick: () => void } }>,
  state: { error: null as null | { message: string }, skipped: false },
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children: unknown, to: string }) => <a href={to} {...rest}>{children as string}</a>,
}))
vi.mock('@/src/components/Care/CareSummary', () => ({ CareSummary: () => <p>care summary</p> }))
vi.mock('@/src/components/ds/toast', () => {
  const show = (t: (typeof toasts)[number]) => toasts.push(t)
  return { useToast: () => ({ show }) }
})
vi.mock('@/src/utils/trpc', () => {
  /** A mutation that succeeds at once with `result`, as its hook's onSuccess sees it. */
  const mutation = (call: (i: unknown) => void, result: (i: unknown) => unknown = () => null) => ({
    useMutation: (o: { onSuccess: (r: unknown) => void }) => ({
      isPending: false,
      isSuccess: state.skipped,
      error: state.error,
      mutate: (i: unknown) => {
        call(i)
        o.onSuccess(result(i))
      },
    }),
  })
  return {
    trpc: {
      useUtils: () => ({ tank: { invalidate: () => calls.invalidate('tank') }, care: { invalidate: () => calls.invalidate('care') }, alerts: { invalidate: () => calls.invalidate('alerts') } }),
      care: { chores: { useQuery: () => ({ data: data.chores }) } },
      alerts: {
        list: {
          useQuery: (i: { activeOnly: boolean }, o?: { enabled: boolean }) => {
            if (i.activeOnly) return { data: data.open }
            calls.historyEnabled(o?.enabled)
            return { data: o?.enabled ? data.history : undefined }
          },
        },
        acknowledge: mutation(i => calls.acknowledge(i)),
        dismiss: mutation(i => calls.dismiss(i)),
      },
      tank: {
        logAction: mutation(i => calls.logAction(i), () => ({ id: 41 })),
        removeAction: mutation(i => calls.removeAction(i)),
      },
    },
  }
})

const chore = (id: ChoreRow['id'], st: ChoreRow['state'], extra: Partial<ChoreRow> = {}): ChoreRow => ({ id, title: `${id} title`, state: st, basis: 'timeline', reason: `${id} reason`, dueAt: null, lastDoneAt: null, readings: [], citations: [], doneKind: id, ...extra })
const alert = (id: number, kind: string, extra: Partial<Alert> = {}): Alert => ({ id, kind, active: true, detail: '', raisedAt: '2026-11-11T08:00:00Z', clearedAt: null, acknowledgedAt: null, dismissedAt: null, ...extra })

beforeEach(() => {
  Object.assign(data, { chores: undefined, open: [], history: undefined })
  for (const f of Object.values(calls)) f.mockReset()
  toasts.length = 0
  state.error = null
  state.skipped = false
})
afterEach(cleanup)

describe('ChoreItem', () => {
  it('logs a chore with no alert as done in the tank log, and offers to undo it', () => {
    render(<ChoreItem chore={chore('refresh', 'due', { title: 'Refresh the tank' })} />)
    const row = within(screen.getByTestId('needs-chore-refresh'))
    expect(row.queryByRole('button', { name: 'Skip' })).toBeNull()
    expect(row.getByText('calendar')).toBeTruthy()
    expect(row.getByText('Refresh the tank').closest('a')?.getAttribute('href')).toBe('/care')
    fireEvent.click(row.getByRole('button', { name: 'Done' }))
    expect(calls.logAction).toHaveBeenCalledWith({ kind: 'refresh', note: '' })
    expect(calls.acknowledge).not.toHaveBeenCalled()
    expect(calls.invalidate.mock.calls.flat()).toEqual(['tank', 'care'])
    expect(toasts.map(t => [t.id, t.title, t.action?.label])).toEqual([['chore-done:refresh', 'Marked done: Refresh the tank', 'Undo']])
    toasts[0]?.action?.onClick()
    expect(calls.removeAction).toHaveBeenCalledWith({ id: 41 })
  })

  it('does Done and Skip as Alerts does when a reading raised an alert', () => {
    const top = chore('top_off', 'due', { title: 'Top off the tank', basis: 'reading' })
    render(<ChoreItem chore={top} alert={alert(7, 'chore_top_off')} />)
    const row = within(screen.getByTestId('needs-chore-top_off'))
    expect(row.queryByText('calendar')).toBeNull()
    fireEvent.click(row.getByRole('button', { name: 'Done' }))
    expect(calls.acknowledge).toHaveBeenCalledWith({ id: 7 })
    expect(calls.logAction).not.toHaveBeenCalled()
    // Acknowledging logs it in the tank log server-side, which has nothing to undo from here.
    expect(toasts.map(t => [t.title, t.action])).toEqual([['Marked done: Top off the tank', undefined]])
    fireEvent.click(row.getByRole('button', { name: 'Skip' }))
    expect(calls.dismiss).toHaveBeenCalledWith({ id: 7 })
    expect(calls.invalidate.mock.calls.flat()).toContain('alerts')
  })

  it('goes once skipped, before the list catches up', () => {
    state.skipped = true
    render(<ChoreItem chore={chore('top_off', 'due')} alert={alert(7, 'chore_top_off')} />)
    expect(screen.queryByTestId('needs-chore-top_off')).toBeNull()
  })

  it('shows why an action failed', () => {
    state.error = { message: 'offline' }
    render(<ChoreItem chore={chore('feed', 'due')} compact />)
    expect(screen.getByText('offline')).toBeTruthy()
  })
})

describe('DueChores', () => {
  it('lists the due chores to act on, each with its open alert', () => {
    data.chores = [chore('feed', 'soon'), chore('top_off', 'due', { basis: 'reading' }), chore('clean', 'due')]
    data.open = [alert(7, 'chore_top_off')]
    render(<DueChores />)
    expect(screen.getByText('Needs you')).toBeTruthy()
    expect(screen.getAllByTestId(/^needs-chore-/).map(e => e.dataset.testid)).toEqual(['needs-chore-top_off', 'needs-chore-clean'])
    expect(within(screen.getByTestId('needs-chore-top_off')).getByRole('button', { name: 'Skip' })).toBeTruthy()
    // Every due reading has its alert open, so nothing could have been skipped.
    expect(calls.historyEnabled).toHaveBeenLastCalledWith(false)
  })

  it('keeps a skipped chore off until the engine raises it again', () => {
    data.chores = [chore('top_off', 'due', { basis: 'reading' }), chore('feed', 'due', { basis: 'reading' })]
    data.history = [alert(9, 'chore_top_off', { active: false, dismissedAt: '2026-11-11T09:00:00Z' }), alert(8, 'chore_feed', { active: false, clearedAt: '2026-11-10T09:00:00Z' })]
    render(<DueChores />)
    expect(calls.historyEnabled).toHaveBeenLastCalledWith(true)
    expect(screen.getAllByTestId(/^needs-chore-/).map(e => e.dataset.testid)).toEqual(['needs-chore-feed'])
    cleanup()
    // Raised again: a new open alert, so it's back with its Skip.
    data.open = [alert(10, 'chore_top_off')]
    render(<DueChores />)
    expect(within(screen.getByTestId('needs-chore-top_off')).getByRole('button', { name: 'Skip' })).toBeTruthy()
  })

  it('falls back to Care\'s one line with nothing due', () => {
    data.chores = [chore('feed', 'soon')]
    render(<DueChores />)
    expect(screen.getByText('care summary')).toBeTruthy()
    expect(screen.queryByTestId('due-chores')).toBeNull()
  })
})
