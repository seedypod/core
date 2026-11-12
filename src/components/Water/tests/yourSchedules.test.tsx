// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProtocolReport } from '@/src/components/Grow/protocolWords'
import type * as EditorModule from '../ScheduleEditor'
import type { Entry } from '../ScheduleEditor'
import { YourSchedules } from '../YourSchedules'

const { calls, hooks, state } = vi.hoisted(() => ({
  calls: { activate: vi.fn(), delete: vi.fn(), invalidate: vi.fn() },
  hooks: new Map<string, { onSuccess?: () => void, onError?: (e: { message: string }) => void }>(),
  state: { fail: null as null | string },
}))

vi.mock('@/src/utils/trpc', () => {
  const mutation = (name: 'activate' | 'delete') => ({
    useMutation: (o: { onSuccess?: () => void, onError?: (e: { message: string }) => void }) => {
      hooks.set(name, o)
      return {
        isPending: false,
        mutate: (i: unknown) => {
          calls[name](i)
          if (state.fail === name) o.onError?.({ message: `${name}: the unit said no` })
        },
      }
    },
  })
  return {
    trpc: {
      useUtils: () => ({ schedules: { invalidate: calls.invalidate }, protocol: { invalidate: calls.invalidate } }),
      schedules: { library: { activate: mutation('activate'), delete: mutation('delete') } },
    },
  }
})
vi.mock('@tanstack/react-router', () => ({ Link: ({ to, children, className }: { to: string, children: ReactNode, className?: string }) => <a href={to} className={className}>{children}</a> }))
// The editor has its own tests; here, what it was opened with.
vi.mock('../ScheduleEditor', async orig => ({
  ...(await orig<typeof EditorModule>()),
  ScheduleEditor: ({ mode, duringProtocol, onClose }: { mode: unknown, duringProtocol: boolean, onClose: () => void }) => (
    <div data-testid="editor" data-mode={JSON.stringify(mode)} data-during={String(duringProtocol)}>
      <button type="button" onClick={onClose}>Close editor</button>
    </div>
  ),
}))

const daily = (minute: number, min: number) => ({ minute, durationS: min * 60, days: 127 })
const entry = (o: Partial<Entry> & Pick<Entry, 'id' | 'name' | 'cycles'>): Entry => ({ kind: 'own', lightPresetId: null, lastUsedAt: null, active: false, readOnly: false, ...o })
const summer = entry({ id: 'summer', name: 'Summer', cycles: [daily(420, 5), daily(660, 5), daily(900, 5), daily(1140, 5)] })
const away = entry({ id: 'away', name: 'Away', lastUsedAt: '2026-10-12T09:00:00Z', cycles: [daily(540, 8), daily(1080, 8)] })
const preset = (id: string, name: string, cycles: Entry['cycles'], active = false) => entry({ id: `preset:${id}`, name, kind: 'preset', readOnly: true, active, cycles })
const presets = [preset('germination', 'Germination', [{ minute: 480, durationS: 900, days: 1 }], true), preset('seedlings', 'Seedlings', [daily(480, 10)]), preset('mature', 'Mature greens & herbs', [daily(480, 6), daily(840, 6), daily(1200, 6)])]
const stage = (id: string, name: string, from: number, to: number | null, presetId: string, state: string) => ({ id, name, from, to, state, startsOn: null, water: { presetId } })
/** The protocol as Water reads it: Greens & herbs, in germination unless said otherwise. */
const report = (o: Partial<Record<string, unknown>> = {}) => ({
  protocol: { id: 'greens-herbs', name: 'Greens & herbs' },
  cycleId: 'c1',
  following: true,
  water: 'preset',
  stage: 'germination',
  daysSinceSowing: 2,
  then: { kind: 'stay', scheduleId: null },
  stages: [stage('germination', 'Germination', 0, 7, 'germination', 'current'), stage('seedlings', 'Seedlings', 8, 13, 'seedlings', 'next'), stage('young', 'Young plants', 14, 21, 'young', 'next'), stage('maintenance', 'Maintenance', 22, null, 'mature', 'next')],
  ...o,
}) as unknown as ProtocolReport
const pump = (id: string, minute: number) => ({ id, kind: 'pump' as const, name: id, enabled: true, days: 127, spec: { minute, durationS: 300 } })
const light = { on: 360, off: 1260 }

function show(o: { r?: ProtocolReport, entries?: Entry[], live?: ReturnType<typeof pump>[] } = {}) {
  return render(<YourSchedules protocol={o.r ?? report()} entries={o.entries ?? [summer, away, ...presets]} live={o.live ?? [pump('water-germination-0800', 480)]} light={light} limits={{ pumpMaxRunS: 900, pumpMaxDuty: 30 }} zone="UTC" />)
}
const rows = () => screen.getAllByTestId('schedule-row')
const editorMode = () => JSON.parse(screen.getByTestId('editor').dataset.mode ?? '')

beforeEach(() => {
  for (const f of Object.values(calls)) f.mockReset()
  hooks.clear()
  state.fail = null
})
afterEach(cleanup)

describe('YourSchedules', () => {
  it('lists yours, the protocol\'s last stage and the preset on, each with its day on the light and what it is now', () => {
    show()
    expect(rows().map(r => r.textContent)).toEqual([
      'Summer4 × 5 min · every daynot used yetUse',
      'Away2 × 8 min · every daylast used 12 OctUse',
      'GerminationACTIVE1 × 15 min · from the protocolpreset · read-only',
      'Mature greens & herbs3 × 6 min · from the protocolpreset · read-onlyUse',
    ])
    // Seedlings is neither the last stage nor on, so it isn't listed.
    expect(screen.queryByText('Seedlings')).toBeNull()
    const ticks = rows()[2]?.querySelectorAll('[data-minute]')
    expect([...ticks ?? []].map(t => t.className.includes('bg-tank'))).toEqual([true])
    expect(screen.getByTestId('strip-axis').textContent).toBe('0006 lights onlights off 2124')
    fireEvent.click(within(rows()[0] as HTMLElement).getByRole('button', { name: 'Use' }))
    expect(calls.activate).toHaveBeenCalledWith({ id: 'summer' })
    act(() => hooks.get('activate')?.onSuccess?.())
    expect(calls.invalidate).toHaveBeenCalled()
  })

  it('opens the editor for a new one from the last stage, queued for after the protocol while it waters', () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: 'New schedule' }))
    expect(editorMode()).toEqual({ kind: 'new', from: 'preset:mature' })
    expect(screen.getByTestId('editor').dataset.during).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Close editor' }))
    expect(screen.queryByTestId('editor')).toBeNull()
    cleanup()
    // In maintenance, or with nothing to go on, it's for now.
    show({ r: report({ stage: 'maintenance' }) })
    fireEvent.click(screen.getByRole('button', { name: 'New schedule' }))
    expect(screen.getByTestId('editor').dataset.during).toBe('false')
    cleanup()
    render(<YourSchedules protocol={undefined} entries={[]} live={[]} light={null} limits={null} zone="UTC" />)
    fireEvent.click(screen.getByRole('button', { name: 'New schedule' }))
    expect(editorMode()).toEqual({ kind: 'new', from: 'live' })
    expect(screen.queryByTestId('strip-axis')).toBeNull()
  })

  it('edits, duplicates and deletes one of yours from its menu, deleting only once it\'s confirmed', () => {
    show()
    const more = screen.getByRole('button', { name: 'More for Summer' })
    fireEvent.click(more)
    expect(more.getAttribute('aria-expanded')).toBe('true')
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Edit', 'Duplicate', 'Delete'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(editorMode()).toEqual({ kind: 'edit', id: 'summer' })
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }))
    expect(editorMode()).toEqual({ kind: 'new', from: 'summer', name: 'Summer copy' })
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText('Delete Summer?')).toBeTruthy()
    expect(dialog.getByText('It goes from Your schedules; the pump cycles don’t change.')).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls.delete).not.toHaveBeenCalled()
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    expect(calls.delete).toHaveBeenCalledWith({ id: 'summer' })
    act(() => hooks.get('delete')?.onSuccess?.())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('duplicates a preset, which can\'t be changed or deleted, and closes its menu on Escape or a click elsewhere', () => {
    show()
    const more = screen.getByRole('button', { name: 'More for Mature greens & herbs' })
    fireEvent.click(more)
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Duplicate'])
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(more)
    fireEvent.pointerDown(screen.getByRole('menu'))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(more)
    fireEvent.click(more)
    expect(screen.queryByRole('menu')).toBeNull()
    // The preset on adjusts the pump cycles in place.
    fireEvent.click(screen.getByRole('button', { name: 'More for Germination' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Adjust the cycles' }))
    expect(editorMode()).toEqual({ kind: 'live' })
  })

  it('heads the list with cycles changed by hand as Edited, to save as a schedule or adjust', () => {
    show({ entries: [summer, ...presets.map(p => ({ ...p, active: false }))], live: [pump('mine', 450), pump('later', 1020)] })
    const edited = screen.getByTestId('schedule-edited')
    expect(edited.textContent).toBe('Your cyclesEDITED2 × 5 min · every daychanged by handSave as schedule')
    fireEvent.click(within(edited).getByRole('button', { name: 'Save as schedule' }))
    expect(editorMode()).toEqual({ kind: 'new', from: 'live' })
    fireEvent.click(within(edited).getByRole('button', { name: 'More for Your cycles' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Adjust the cycles' }))
    expect(editorMode()).toEqual({ kind: 'live' })
    cleanup()
    // Until the library says which is on, it doesn't guess.
    show({ entries: [], live: [pump('mine', 450)] })
    expect(screen.queryByTestId('schedule-edited')).toBeNull()
  })

  it('opens on your schedule once one of yours is on, with the stages behind it and the way back to the protocol', () => {
    const on = { ...summer, active: true, lastUsedAt: '2026-12-21T08:00:00Z' }
    show({ r: report({ water: 'schedule', stage: 'seedlings', daysSinceSowing: 51 }), entries: [on, away, ...presets.map(p => ({ ...p, active: false }))] })
    const head = within(screen.getByTestId('on-your-schedule'))
    expect(head.getByRole('heading', { name: 'On your schedule · Summer' })).toBeTruthy()
    expect(head.getByText('Off the Greens & herbs protocol since Mon 21 Dec · now day 51')).toBeTruthy()
    expect(head.getByText('Germination → Seedlings → Young plants → Maintenance')).toBeTruthy()
    expect(head.getByRole('link', { name: 'Start a new grow' }).getAttribute('href')).toBe('/grow')
    fireEvent.click(head.getByRole('button', { name: 'Back to the protocol' }))
    expect(calls.activate).toHaveBeenCalledWith({ id: 'preset:seedlings' })
    const summerRow = rows()[0] as HTMLElement
    expect(summerRow.textContent).toBe('SummerACTIVE4 × 5 min · every daysince 21 DecEdit')
    fireEvent.click(within(summerRow).getByRole('button', { name: 'Edit' }))
    expect(editorMode()).toEqual({ kind: 'edit', id: 'summer' })
    expect(screen.getByTestId('editor').dataset.during).toBe('false')
    fireEvent.click(within(summerRow).getByRole('button', { name: 'More for Summer' }))
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Adjust the cycles', 'Duplicate', 'Delete'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(within(screen.getByRole('dialog')).getByText('Its cycles stay on the pump until you use another schedule.')).toBeTruthy()
    cleanup()
    // Not yet used under this name, and no stage or day to speak of.
    show({ r: report({ water: 'schedule', stage: null, daysSinceSowing: null }), entries: [{ ...summer, active: true }] })
    expect(screen.getByText('Off the Greens & herbs protocol')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Back to the protocol' })).toBeNull()
    expect((rows()[0] as HTMLElement).textContent).toBe('SummerACTIVE4 × 5 min · every dayin useEdit')
  })

  it('says deleting what comes after the stages goes back to keeping the last stage, and says why an action failed', () => {
    show({ r: report({ then: { kind: 'schedule', scheduleId: 'away' } }) })
    fireEvent.click(screen.getByRole('button', { name: 'More for Away' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(within(screen.getByRole('dialog')).getByText('It’s what comes after the stages, so that goes back to keeping the last stage.')).toBeTruthy()
    state.fail = 'delete'
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    expect(screen.getByText('delete: the unit said no')).toBeTruthy()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    state.fail = 'activate'
    fireEvent.click(within(rows()[0] as HTMLElement).getByRole('button', { name: 'Use' }))
    expect(screen.getByText('activate: the unit said no')).toBeTruthy()
    // The next action clears it.
    state.fail = null
    fireEvent.click(screen.getByRole('button', { name: 'New schedule' }))
    expect(screen.queryByText(/the unit said no/)).toBeNull()
  })
})
