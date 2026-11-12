// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { byUrgency, Chores, type ChoreRow } from '../Chores'

const { data, calls, state } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: { logAction: vi.fn(), acknowledge: vi.fn(), invalidateTank: vi.fn(), invalidateCare: vi.fn() },
  state: { error: null as null | { message: string } },
}))

vi.mock('@/src/utils/trpc', () => {
  const mutation = (call: (i: unknown) => void) => ({
    useMutation: (o?: { onSuccess?: (r?: unknown) => void }) => ({
      isPending: false,
      error: state.error,
      mutate: (i: unknown) => {
        call(i)
        o?.onSuccess?.()
      },
      mutateAsync: async (i: unknown) => {
        call(i)
        if (state.error) throw new Error(state.error.message)
        return { id: 1 }
      },
    }),
  })
  return {
    trpc: {
      useUtils: () => ({ tank: { invalidate: calls.invalidateTank }, care: { invalidate: calls.invalidateCare }, alerts: { invalidate: vi.fn() }, client: {} }),
      care: { chores: { useQuery: () => ({ data: data.get('chores') }) } },
      alerts: { list: { useQuery: () => ({ data: data.get('alerts') }) }, acknowledge: mutation(i => calls.acknowledge(i)), dismiss: mutation(() => {}) },
      tank: { logAction: mutation(i => calls.logAction(i)), removeAction: mutation(() => {}) },
    },
  }
})

const cite = { note: 'knowledge/nutrients/gardyn-feeding-guidance.md', section: 'pH and EC', url: 'https://github.com/seedypod/core/blob/dev/knowledge/nutrients/gardyn-feeding-guidance.md#ph-and-ec' }
const chore = (id: ChoreRow['id'], state: ChoreRow['state'], extra: Partial<ChoreRow> = {}): ChoreRow => ({ id, title: id, state, basis: 'timeline', reason: `${id} reason`, dueAt: null, lastDoneAt: null, readings: [], citations: [], doneKind: id, ...extra })

beforeEach(() => {
  data.clear()
  data.set('alerts', [])
  for (const f of Object.values(calls)) f.mockReset()
  state.error = null
})
afterEach(cleanup)

describe('Chores', () => {
  it('puts due chores first, then soon, unknown and ok', () => {
    expect(byUrgency([chore('clean', 'ok'), chore('refresh', 'unknown'), chore('feed', 'soon'), chore('top_off', 'due'), chore('thin', 'ok')]).map(c => c.id)).toEqual(['top_off', 'feed', 'refresh', 'clean', 'thin'])
  })

  it('shows each chore with its state, basis, reason and the notes behind it', () => {
    data.set('chores', [chore('clean', 'ok'), chore('feed', 'due', { title: 'Feed', basis: 'reading', reason: 'EC 0.9 mS/cm, below the 1.2–2.0 mS/cm for leafy greens.', citations: [cite] })])
    render(<Chores />)
    const feed = within(screen.getByTestId('chore-feed'))
    expect(feed.getByText('due')).toBeTruthy()
    expect(feed.getByText('from a reading')).toBeTruthy()
    expect(feed.getByText(/EC 0.9 mS\/cm/)).toBeTruthy()
    expect(feed.getByRole('link', { name: 'pH and EC' }).getAttribute('href')).toBe(cite.url)
    const clean = within(screen.getByTestId('chore-clean'))
    expect(clean.getByText('calendar')).toBeTruthy()
    expect(clean.queryByRole('button', { name: 'Done' })).toBeNull()
    expect(screen.getAllByTestId(/^chore-/).map(e => e.dataset.testid)).toEqual(['chore-feed', 'chore-clean'])
  })

  it('logs a due or soon chore as done in the tank log', async () => {
    data.set('chores', [chore('top_off', 'soon'), chore('thin', 'due')])
    render(<Chores />)
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('chore-top_off')).getByRole('button', { name: 'Done' }))
    })
    expect(calls.logAction).toHaveBeenCalledWith({ kind: 'top_off', note: '' })
    expect(calls.invalidateTank).toHaveBeenCalled()
    expect(calls.invalidateCare).toHaveBeenCalled()
  })

  it('acknowledges a chore\'s open alert for Done, as Alerts and Needs you do, and waits for the alerts to load', async () => {
    data.set('chores', [chore('top_off', 'due', { basis: 'reading' })])
    data.delete('alerts')
    render(<Chores />)
    expect((within(screen.getByTestId('chore-top_off')).getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    data.set('alerts', [{ id: 7, kind: 'chore_top_off', active: true }])
    render(<Chores />)
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('chore-top_off')).getByRole('button', { name: 'Done' }))
    })
    expect(calls.acknowledge).toHaveBeenCalledWith({ id: 7 })
    expect(calls.logAction).not.toHaveBeenCalled()
  })

  it('says it is still working out with nothing yet, and shows why a log failed', () => {
    state.error = { message: 'offline' }
    render(<Chores />)
    expect(screen.getByText(/Working out what the tower needs/)).toBeTruthy()
    expect(screen.getByText('offline')).toBeTruthy()
  })
})
