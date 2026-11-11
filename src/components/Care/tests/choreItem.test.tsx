// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChoreRow } from '@/src/components/Water/Chores'
import { ChoreItem, DueChores } from '../ChoreItem'

interface Alert { id: number, kind: string, active: boolean, detail: string, raisedAt: string, clearedAt: string | null, acknowledgedAt: string | null, dismissedAt: string | null }

const { data, calls, toasts, state } = vi.hoisted(() => ({
  data: {
    chores: undefined as unknown,
    open: [] as unknown[] | undefined,
    /** Each kind's last alert row, as alerts.list({ kind, limit: 1 }) answers. */
    last: new Map<string, unknown[]>(),
    setup: { issues: [] as unknown[] } as unknown,
    ack: null as unknown,
  },
  calls: { logAction: vi.fn(), removeAction: vi.fn(), acknowledge: vi.fn(), dismiss: vi.fn(), history: vi.fn(), invalidate: vi.fn() },
  toasts: [] as Array<{ id: string, title: string, action?: { label: string, onClick: () => void } }>,
  state: {
    error: null as null | { message: string },
    /** Holds a Done's mutation, or the refetch after it, until the test lets it go. */
    gate: null as Promise<void> | null,
    refetch: null as Promise<void> | null,
  },
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children: unknown, to: string }) => <a href={to} {...rest}>{children as string}</a>,
}))
vi.mock('@/src/components/Care/CareSummary', () => ({
  CareSummary: ({ chores }: { chores?: Array<{ title: string, state: string }> }) => <p>{`care summary: ${(chores ?? []).filter(c => c.state === 'due').map(c => c.title).join(', ') || 'nothing due'}`}</p>,
}))
vi.mock('@/src/components/ds/toast', () => {
  const show = (t: (typeof toasts)[number]) => toasts.push(t)
  return { useToast: () => ({ show }) }
})
vi.mock('@/src/utils/trpc', () => {
  /** A mutation that succeeds with `result`, at once or when the gate opens. */
  const mutation = (call: (i: unknown) => void, result: (i: unknown) => unknown = () => null) => ({
    useMutation: (o?: { onSuccess?: (r: unknown) => void }) => ({
      isPending: false,
      error: state.error,
      mutate: (i: unknown) => {
        call(i)
        o?.onSuccess?.(result(i))
      },
      mutateAsync: async (i: unknown) => {
        call(i)
        if (state.gate) await state.gate
        if (state.error) throw new Error(state.error.message)
        return result(i)
      },
    }),
  })
  const invalidate = (area: string) => () => {
    calls.invalidate(area)
    return state.refetch ?? Promise.resolve()
  }
  return {
    trpc: {
      useUtils: () => ({
        tank: { invalidate: invalidate('tank') },
        care: { invalidate: invalidate('care') },
        alerts: { invalidate: invalidate('alerts') },
        client: { tank: { removeAction: { mutate: (i: unknown) => calls.removeAction(i) } } },
      }),
      useQueries: (f: (t: unknown) => Array<{ kind: string }>) => f({ alerts: { list: (i: { kind: string }) => i } }).map((i) => {
        calls.history(i)
        return { data: data.last.get(i.kind) }
      }),
      care: { chores: { useQuery: () => ({ data: data.chores }) }, setup: { useQuery: () => ({ data: data.setup }) } },
      alerts: {
        list: { useQuery: () => ({ data: data.open }) },
        acknowledge: mutation(i => calls.acknowledge(i), () => data.ack),
        dismiss: mutation(i => calls.dismiss(i), i => ({ id: (i as { id: number }).id })),
      },
      tank: { logAction: mutation(i => calls.logAction(i), () => ({ id: 41 })) },
    },
  }
})

/** Lets a gate's promise go, from outside it. */
function gate(): { promise: Promise<void>, open: () => void } {
  let open = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}
/** A click whose async work (the mutation, the refetch) runs before the test goes on. */
const click = (el: HTMLElement) => act(async () => {
  fireEvent.click(el)
})

const chore = (id: ChoreRow['id'], st: ChoreRow['state'], extra: Partial<ChoreRow> = {}): ChoreRow => ({ id, title: `${id} title`, state: st, basis: 'timeline', reason: `${id} reason`, dueAt: null, lastDoneAt: null, readings: [], citations: [], doneKind: id, ...extra })
const alert = (id: number, kind: string, extra: Partial<Alert> = {}): Alert => ({ id, kind, active: true, detail: '', raisedAt: '2026-11-11T08:00:00Z', clearedAt: null, acknowledgedAt: null, dismissedAt: null, ...extra })
const rows = () => screen.queryAllByTestId(/^needs-chore-/).map(e => e.dataset.testid)
const button = (row: string, name: string) => within(screen.getByTestId(`needs-chore-${row}`)).getByRole('button', { name }) as HTMLButtonElement

beforeEach(() => {
  Object.assign(data, { chores: undefined, open: [], last: new Map(), setup: { issues: [] }, ack: null })
  for (const f of Object.values(calls)) f.mockReset()
  calls.removeAction.mockResolvedValue({ removed: true })
  toasts.length = 0
  Object.assign(state, { error: null, gate: null, refetch: null })
})
afterEach(cleanup)

describe('ChoreItem', () => {
  it('logs a chore with no alert as done in the tank log, and offers to undo it', async () => {
    render(<ChoreItem chore={chore('refresh', 'due', { title: 'Refresh the tank' })} />)
    const row = within(screen.getByTestId('needs-chore-refresh'))
    expect(row.queryByRole('button', { name: 'Skip' })).toBeNull()
    expect(row.getByText('calendar')).toBeTruthy()
    expect(row.getByText('Refresh the tank').closest('a')?.getAttribute('href')).toBe('/care')
    await click(row.getByRole('button', { name: 'Done' }))
    expect(calls.logAction).toHaveBeenCalledWith({ kind: 'refresh', note: '' })
    expect(calls.acknowledge).not.toHaveBeenCalled()
    expect(calls.invalidate.mock.calls.flat()).toEqual(['tank', 'care', 'alerts'])
    expect(toasts.map(t => [t.id, t.title, t.action?.label])).toEqual([['chore-done:refresh', 'Marked done: Refresh the tank', 'Undo']])
    await act(async () => toasts[0]?.action?.onClick())
    expect(calls.removeAction).toHaveBeenCalledWith({ id: 41 })
    expect(calls.invalidate).toHaveBeenCalledTimes(6)
  })

  it('says when Undo failed, with a Retry that still works once the row is gone', async () => {
    render(<ChoreItem chore={chore('refresh', 'due', { title: 'Refresh the tank' })} />)
    await click(button('refresh', 'Done'))
    calls.removeAction.mockRejectedValueOnce(new Error('the unit said no'))
    await act(async () => toasts[0]?.action?.onClick())
    expect(toasts.at(-1)).toMatchObject({ id: 'chore-undo:refresh', title: 'Couldn\'t undo: Refresh the tank', detail: 'the unit said no', action: { label: 'Retry' } })
    cleanup()
    await act(async () => toasts.at(-1)?.action?.onClick())
    expect(calls.removeAction.mock.calls).toEqual([[{ id: 41 }], [{ id: 41 }]])
    expect(toasts).toHaveLength(2)
  })

  it('acknowledges the open alert for Done, as Alerts does, and says so once the server logged it', async () => {
    data.ack = alert(7, 'chore_top_off', { active: false, acknowledgedAt: '2026-11-11T09:00:00Z', clearedAt: '2026-11-11T09:00:00Z' })
    render(<ChoreItem chore={chore('top_off', 'due', { title: 'Top off the tank', basis: 'reading' })} alert={alert(7, 'chore_top_off')} />)
    expect(within(screen.getByTestId('needs-chore-top_off')).queryByText('calendar')).toBeNull()
    await click(button('top_off', 'Done'))
    expect(calls.acknowledge).toHaveBeenCalledWith({ id: 7 })
    expect(calls.logAction).not.toHaveBeenCalled()
    // Acknowledging logs it in the tank log server-side, which has nothing to undo from here.
    expect(toasts.map(t => [t.title, t.action])).toEqual([['Marked done: Top off the tank', undefined]])
  })

  it('says nothing when the alert had already cleared and nothing was logged, and refetches', async () => {
    data.ack = alert(7, 'chore_top_off', { active: false, clearedAt: '2026-11-11T08:30:00Z', acknowledgedAt: '2026-11-11T09:00:00Z' })
    render(<ChoreItem chore={chore('top_off', 'due', { basis: 'reading' })} alert={alert(7, 'chore_top_off')} />)
    await click(button('top_off', 'Done'))
    expect(toasts).toEqual([])
    expect(calls.invalidate.mock.calls.flat()).toEqual(['tank', 'care', 'alerts'])
    cleanup()
    // Gone altogether.
    data.ack = null
    render(<ChoreItem chore={chore('top_off', 'due', { basis: 'reading' })} alert={alert(7, 'chore_top_off')} />)
    await click(button('top_off', 'Done'))
    expect(toasts).toEqual([])
  })

  it('holds Done in every row for the chore until it is logged and the lists have refetched, so it logs once', async () => {
    const mutating = gate()
    const refetching = gate()
    state.gate = mutating.promise
    state.refetch = refetching.promise
    const feed = chore('feed', 'due')
    render(
      <>
        <div data-testid="sidebar"><ChoreItem chore={feed} compact /></div>
        <div data-testid="water"><ChoreItem chore={feed} /></div>
      </>,
    )
    const done = (where: string) => within(within(screen.getByTestId(where)).getByTestId('needs-chore-feed')).getByRole('button', { name: 'Done' }) as HTMLButtonElement
    await click(done('sidebar'))
    expect(done('sidebar').disabled).toBe(true)
    expect(done('water').disabled).toBe(true)
    await click(done('water'))
    await act(async () => mutating.open())
    // Logged; the refetch that would drop the row hasn't landed, so the rows are still up and still held.
    expect(done('water').disabled).toBe(true)
    await click(done('water'))
    await act(async () => refetching.open())
    expect(done('water').disabled).toBe(false)
    expect(calls.logAction).toHaveBeenCalledOnce()
  })

  it('lets Done go again after a failure, with the reason under the row', async () => {
    state.error = { message: 'offline' }
    render(<ChoreItem chore={chore('feed', 'due')} compact />)
    expect(screen.getByText('offline')).toBeTruthy()
    await click(button('feed', 'Done'))
    expect(toasts).toEqual([])
    expect(button('feed', 'Done').disabled).toBe(false)
  })

  it('goes once skipped, and comes back when the engine raises a new alert for it', () => {
    const top = chore('top_off', 'due', { basis: 'reading' })
    const { rerender } = render(<ChoreItem chore={top} alert={alert(7, 'chore_top_off')} />)
    fireEvent.click(button('top_off', 'Skip'))
    expect(calls.dismiss).toHaveBeenCalledWith({ id: 7 })
    expect(calls.invalidate.mock.calls.flat()).toContain('alerts')
    expect(rows()).toEqual([])
    // The list catches up: no open alert.
    rerender(<ChoreItem chore={top} />)
    expect(rows()).toEqual([])
    rerender(<ChoreItem chore={top} alert={alert(12, 'chore_top_off')} />)
    expect(rows()).toEqual(['needs-chore-top_off'])
  })

  it('holds its buttons while it isn\'t known whether the chore has an alert', () => {
    render(<ChoreItem chore={chore('feed', 'due')} disabled />)
    expect(button('feed', 'Done').disabled).toBe(true)
  })
})

describe('DueChores', () => {
  it('lists the due chores to act on, each with its open alert, asking no history when every reading has one', () => {
    data.chores = [chore('feed', 'soon'), chore('top_off', 'due', { basis: 'reading' }), chore('clean', 'due')]
    data.open = [alert(7, 'chore_top_off')]
    render(<DueChores />)
    expect(screen.getByText('Needs you')).toBeTruthy()
    expect(rows()).toEqual(['needs-chore-top_off', 'needs-chore-clean'])
    expect(button('top_off', 'Skip')).toBeTruthy()
    expect(button('clean', 'Done').disabled).toBe(false)
    expect(calls.history).not.toHaveBeenCalled()
  })

  it('renders the rows held while the open alerts load, so Done can\'t go the wrong way', () => {
    data.chores = [chore('top_off', 'due', { basis: 'reading' })]
    data.open = undefined
    render(<DueChores />)
    expect(button('top_off', 'Done').disabled).toBe(true)
    expect(calls.history).not.toHaveBeenCalled()
  })

  it('keeps a skipped reading chore off until raised again, asking only its own last alert', () => {
    data.chores = [chore('top_off', 'due', { basis: 'reading' }), chore('feed', 'due', { basis: 'reading' }), chore('thin', 'due')]
    data.last.set('chore_top_off', [alert(9, 'chore_top_off', { active: false, dismissedAt: '2026-11-11T09:00:00Z' })])
    data.last.set('chore_feed', [alert(8, 'chore_feed', { active: false, clearedAt: '2026-11-10T09:00:00Z' })])
    render(<DueChores />)
    expect(calls.history.mock.calls.map(c => c[0])).toEqual([{ activeOnly: false, kind: 'chore_top_off', limit: 1 }, { activeOnly: false, kind: 'chore_feed', limit: 1 }])
    // The calendar chore has no alert to have skipped, whatever the history says.
    expect(rows()).toEqual(['needs-chore-feed', 'needs-chore-thin'])
    cleanup()
    // Raised again: a new open alert, so it's back with its Skip.
    data.open = [alert(10, 'chore_top_off')]
    render(<DueChores />)
    expect(button('top_off', 'Skip')).toBeTruthy()
  })

  it('holds the rows until a maybe-skipped chore\'s last alert is in', () => {
    data.chores = [chore('top_off', 'due', { basis: 'reading' }), chore('clean', 'due')]
    render(<DueChores />)
    expect(button('clean', 'Done').disabled).toBe(true)
  })

  it('keeps pointing at setup issues beside the due chores', () => {
    data.chores = [chore('clean', 'due')]
    data.setup = { issues: [{ id: 'no_light_schedule' }, { id: 'no_pump_schedule' }] }
    render(<DueChores />)
    const setup = screen.getByTestId('due-chores-setup')
    expect(setup.textContent).toBe('2 setup issues')
    expect(setup.getAttribute('href')).toBe('/care')
  })

  it('falls back to Care\'s one line with nothing due, not counting a skipped chore as due', () => {
    data.chores = [chore('feed', 'soon')]
    render(<DueChores />)
    expect(screen.getByText('care summary: nothing due')).toBeTruthy()
    expect(screen.queryByTestId('due-chores')).toBeNull()
    cleanup()
    data.chores = [chore('top_off', 'due', { title: 'Top off the tank', basis: 'reading' })]
    data.last.set('chore_top_off', [alert(9, 'chore_top_off', { active: false, dismissedAt: '2026-11-11T09:00:00Z' })])
    render(<DueChores />)
    expect(screen.getByText('care summary: nothing due')).toBeTruthy()
  })
})
