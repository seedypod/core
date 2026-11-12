// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editorLengths, LIVE, ScheduleEditor, type EditorMode, type Entry } from '../ScheduleEditor'

const { calls, state } = vi.hoisted(() => ({
  calls: { create: vi.fn(), update: vi.fn(), activate: vi.fn(), setThen: vi.fn(), upsert: vi.fn(), remove: vi.fn(), invalidate: vi.fn() },
  state: { fail: null as null | string },
}))

vi.mock('@/src/utils/trpc', () => {
  const mutation = (name: 'create' | 'update' | 'activate' | 'setThen' | 'upsert' | 'remove') => ({
    useMutation: () => ({
      mutateAsync: async (i: { id?: string, name?: string }) => {
        calls[name](i)
        if (state.fail === name) throw new Error('the unit said no')
        return { id: i.id ?? (i.name ?? '').toLowerCase() }
      },
    }),
  })
  return {
    trpc: {
      useUtils: () => ({ schedules: { invalidate: calls.invalidate }, protocol: { invalidate: calls.invalidate } }),
      schedules: { library: { create: mutation('create'), update: mutation('update'), activate: mutation('activate') }, upsert: mutation('upsert'), remove: mutation('remove') },
      protocol: { setThen: mutation('setThen') },
    },
  }
})

const daily = (minute: number, min: number) => ({ minute, durationS: min * 60, days: 127 })
const entry = (o: Partial<Entry> & Pick<Entry, 'id' | 'name' | 'cycles'>): Entry => ({ kind: 'own', lightPresetId: null, lastUsedAt: null, active: false, readOnly: false, ...o })
const mature = entry({ id: 'preset:mature', name: 'Mature greens & herbs', kind: 'preset', readOnly: true, cycles: [daily(480, 6), daily(840, 6), daily(1200, 6)] })
const summer = entry({ id: 'summer', name: 'Summer', cycles: [daily(420, 5), daily(660, 5), daily(900, 5), daily(1140, 5)] })
const away = entry({ id: 'away', name: 'Away', active: true, cycles: [daily(540, 8), daily(1080, 8)] })
const pump = (id: string, minute: number, durationS: number, days = 127) => ({ id, kind: 'pump' as const, name: id, enabled: true, days, spec: { minute, durationS } })
const live = [pump('water-mature-0800', 480, 360), pump('water-mature-1400', 840, 360), pump('water-mature-2000', 1200, 360)]
const light = { on: 360, off: 1260 }
const limits = { pumpMaxRunS: 900, pumpMaxDuty: 30 }

function show(mode: EditorMode, o: { during?: boolean, light?: typeof light | null, live?: typeof live, entries?: Entry[], limits?: typeof limits | null } = {}) {
  const onClose = vi.fn()
  render(<ScheduleEditor mode={mode} entries={o.entries ?? [summer, away, mature]} live={o.live ?? live} light={o.light === undefined ? light : o.light} limits={o.limits === undefined ? limits : o.limits} duringProtocol={o.during ?? false} onClose={onClose} />)
  return onClose
}
const preview = () => within(screen.getByTestId('editor-preview'))
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
const settle = () => act(async () => {})

beforeEach(() => {
  for (const f of Object.values(calls)) f.mockReset()
  state.fail = null
})
afterEach(cleanup)

describe('ScheduleEditor: a new schedule', () => {
  it('starts from the protocol\'s last stage, and adds a cycle, says it\'s after lights off and moves it to the last free lit hour', async () => {
    const onClose = show({ kind: 'new', from: 'preset:mature' })
    expect(screen.getByRole('heading', { name: 'New schedule' })).toBeTruthy()
    expect((screen.getByLabelText('Start from') as HTMLSelectElement).value).toBe('preset:mature')
    expect(preview().getByText('18 min')).toBeTruthy()
    expect(preview().getByText('a day · 3 × 6 min')).toBeTruthy()
    expect(screen.getByTestId('editor-compare').textContent).toBe('Same as Mature greens & herbs: 18 min a day.')
    fireEvent.click(button('Add cycle'))
    expect(screen.getAllByLabelText(/^Cycle \d time$/)).toHaveLength(4)
    for (let i = 1; i <= 4; i++) fireEvent.change(screen.getByLabelText(`Cycle ${i} length`), { target: { value: '300' } })
    fireEvent.change(screen.getByLabelText('Cycle 4 time'), { target: { value: '22:30' } })
    expect(preview().getByText('20 min')).toBeTruthy()
    expect(screen.getByTestId('editor-compare').textContent).toBe('Mature greens & herbs was 18 min a day, so this is +2 min.')
    const dark = within(screen.getByTestId('editor-dark'))
    expect(dark.getByText('22:30 is after lights off')).toBeTruthy()
    expect(screen.getByTestId('schedule-strip').querySelector('[data-minute="1350"]')?.className).toContain('bg-pod-ready')
    expect(screen.getByTestId('schedule-strip').textContent).toBe('light 06–21')
    // 20:00 is taken by a cycle already: the hour before it.
    fireEvent.click(dark.getByRole('button', { name: 'Move to 19:00' }))
    expect(screen.queryByTestId('editor-dark')).toBeNull()
    expect((screen.getByLabelText('Cycle 4 time') as HTMLInputElement).value).toBe('19:00')
    expect(screen.getByTestId('editor-limit').textContent).toBe('pump limit 15 min/run · 30% duty ✓')
    // Nothing saves without a name.
    expect(button('Save & use now').disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Summer' } })
    expect(screen.getByTestId('editor-note').textContent).toBe('Saved to Your schedules.')
    fireEvent.click(button('Save & use now'))
    await settle()
    expect(calls.create).toHaveBeenCalledWith({ name: 'Summer', cycles: [daily(480, 5), daily(840, 5), daily(1140, 5), daily(1200, 5)] })
    expect(calls.activate).toHaveBeenCalledWith({ id: 'summer' })
    expect(calls.invalidate).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('queues it for after the protocol while one is watering, and only saves on Save', async () => {
    show({ kind: 'new', from: 'summer', name: 'Summer copy' }, { during: true })
    expect(screen.getByTestId('editor-note').textContent).toBe('Saved to Your schedules. Using it now ends the protocol early.')
    fireEvent.click(button('Save & use after protocol'))
    await settle()
    expect(calls.create).toHaveBeenCalledWith({ name: 'Summer copy', cycles: summer.cycles })
    expect(calls.setThen).toHaveBeenCalledWith({ kind: 'schedule', scheduleId: 'summer copy', when: 'maintenance' })
    expect(calls.activate).not.toHaveBeenCalled()
    cleanup()
    calls.create.mockReset()
    show({ kind: 'new', from: 'summer', name: 'Spring' })
    fireEvent.click(button('Save'))
    await settle()
    expect(calls.create).toHaveBeenCalledTimes(1)
    expect(calls.activate).not.toHaveBeenCalled()
  })

  it('starts again from whatever is picked: an entry or the pump cycles now', () => {
    show({ kind: 'new', from: 'preset:mature' })
    const from = screen.getByLabelText('Start from') as HTMLSelectElement
    expect([...from.options].map(o => o.textContent)).toEqual(['The pump cycles now · 3 × 6 min', 'Summer · 4 × 5 min', 'Away · 2 × 8 min', 'Mature greens & herbs · 3 × 6 min'])
    fireEvent.change(from, { target: { value: 'away' } })
    expect(screen.getAllByLabelText(/^Cycle \d time$/).map(i => (i as HTMLInputElement).value)).toEqual(['09:00', '18:00'])
    expect(screen.getByTestId('editor-compare').textContent).toBe('Same as Away: 16 min a day.')
    fireEvent.change(from, { target: { value: LIVE } })
    expect(screen.getByTestId('editor-compare').textContent).toBe('Same as The pump cycles now: 18 min a day.')
    // Something no longer listed starts with nothing to compare to.
    fireEvent.change(from, { target: { value: 'gone' } })
    expect(screen.getAllByLabelText(/^Cycle \d time$/)).toHaveLength(3)
  })

  it('says what stops it saving: no cycles, two at one time, no days', () => {
    show({ kind: 'new', from: 'summer', name: 'Summer 2' })
    fireEvent.change(screen.getByLabelText('Cycle 2 time'), { target: { value: '07:00' } })
    expect(screen.getByTestId('editor-note').textContent).toBe('Two cycles start at 07:00.')
    expect(button('Save').disabled).toBe(true)
    // A cleared time keeps the last one.
    fireEvent.change(screen.getByLabelText('Cycle 2 time'), { target: { value: '' } })
    expect((screen.getByLabelText('Cycle 2 time') as HTMLInputElement).value).toBe('07:00')
    fireEvent.change(screen.getByLabelText('Cycle 2 time'), { target: { value: '12:00' } })
    for (const d of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']) fireEvent.click(screen.getByRole('button', { name: d }))
    expect(screen.getByTestId('editor-days').textContent).toBe('')
    expect(preview().getByText('on Sundays · 4 × 5 min')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sunday' }))
    expect(screen.getByTestId('editor-note').textContent).toBe('Pick at least one day.')
    for (const t of ['07:00', '12:00', '15:00', '19:00']) fireEvent.click(screen.getByRole('button', { name: `Remove the ${t} cycle` }))
    expect(screen.getByTestId('editor-note').textContent).toBe('Add a cycle.')
    expect(screen.queryByTestId('editor-compare')).toBeNull()
    // Added with no cycles and no light, the first one is at 08:00.
    cleanup()
    show({ kind: 'new', from: 'summer', name: 'x' }, { light: null })
    for (const t of ['07:00', '11:00', '15:00', '19:00']) fireEvent.click(screen.getByRole('button', { name: `Remove the ${t} cycle` }))
    fireEvent.click(button('Add cycle'))
    expect((screen.getByLabelText('Cycle 1 time') as HTMLInputElement).value).toBe('08:00')
    expect(screen.getByText('No light curve runs today, so there’s no light to check the cycles against.')).toBeTruthy()
  })

  it('says a run longer than the pump\'s limit stops at it, and leaves the limit out when it isn\'t known', () => {
    const long = entry({ id: 'long', name: 'Long', cycles: [daily(480, 20)] })
    show({ kind: 'new', from: 'long' }, { entries: [long] })
    expect(screen.getByTestId('editor-limit').textContent).toBe('pump limit 15 min/run · 30% duty · 20 min is over: it stops at 15 min')
    expect([...(screen.getByLabelText('Cycle 1 length') as HTMLSelectElement).options].map(o => o.value)).toEqual(['60', '180', '300', '360', '480', '600', '900', '1200'])
    cleanup()
    show({ kind: 'new', from: 'long' }, { entries: [long], limits: null })
    expect(screen.queryByTestId('editor-limit')).toBeNull()
  })

  it('says why it couldn\'t save, stays open, and cancels without saving', async () => {
    state.fail = 'activate'
    const onClose = show({ kind: 'new', from: 'summer', name: 'Summer 2' })
    fireEvent.click(button('Save & use now'))
    await settle()
    expect(screen.getByText('Couldn’t save it: the unit said no')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(button('Cancel'))
    expect(onClose).toHaveBeenCalled()
  })

  it('offers the presets\' run lengths and the cycle\'s own, none past the pump\'s limit', () => {
    expect(editorLengths(420)).toEqual([60, 180, 300, 360, 420, 480, 600, 900])
    expect(editorLengths(300)).toEqual([60, 180, 300, 360, 480, 600, 900])
    expect(editorLengths(300, 600)).toEqual([60, 180, 300, 360, 480, 600])
  })
})

describe('ScheduleEditor: one of yours', () => {
  it('changes a schedule, and uses it now if asked', async () => {
    show({ kind: 'edit', id: 'summer' })
    expect(screen.getByRole('heading', { name: 'Edit Summer' })).toBeTruthy()
    expect(screen.queryByLabelText('Start from')).toBeNull()
    fireEvent.change(screen.getByLabelText('Cycle 1 length'), { target: { value: '600' } })
    expect(screen.getByTestId('editor-compare').textContent).toBe('Summer was 20 min a day, so this is +5 min.')
    fireEvent.click(button('Save & use now'))
    await settle()
    expect(calls.update).toHaveBeenCalledWith({ id: 'summer', name: 'Summer', cycles: [daily(420, 10), daily(660, 5), daily(900, 5), daily(1140, 5)] })
    expect(calls.activate).toHaveBeenCalledWith({ id: 'summer' })
  })

  it('saves the one in use with a single Save, saying the pump cycles change with it', async () => {
    show({ kind: 'edit', id: 'away' })
    expect(screen.getByTestId('editor-note').textContent).toBe('It’s in use: the pump cycles change with it.')
    expect(screen.queryByRole('button', { name: /Save & use/ })).toBeNull()
    fireEvent.click(button('Save'))
    await settle()
    expect(calls.update).toHaveBeenCalledWith({ id: 'away', name: 'Away', cycles: away.cycles })
    expect(calls.activate).not.toHaveBeenCalled()
    cleanup()
    // Gone from the list meanwhile: an empty draft, named for nothing.
    show({ kind: 'edit', id: 'gone' })
    expect(screen.getByRole('heading', { name: 'Edit schedule' })).toBeTruthy()
  })
})

describe('ScheduleEditor: the pump cycles themselves', () => {
  it('changes them in place: kept under their ids, new ones added, the ones taken out removed', async () => {
    const onClose = show({ kind: 'live' })
    expect(screen.getByRole('heading', { name: 'Adjust the pump cycles' })).toBeTruthy()
    expect(screen.getByTestId('editor-note').textContent).toMatch(/^Changes the pump cycles now, outside Your schedules/)
    fireEvent.click(screen.getByRole('button', { name: 'Remove the 14:00 cycle' }))
    fireEvent.click(button('Add cycle'))
    fireEvent.change(screen.getByLabelText('Cycle 3 time'), { target: { value: '12:00' } })
    fireEvent.click(button('Apply'))
    await settle()
    expect(calls.upsert.mock.calls.map(c => c[0])).toEqual([
      { id: 'water-mature-0800', kind: 'pump', name: 'water-mature-0800', enabled: true, days: 127, spec: { minute: 480, durationS: 360 } },
      { id: 'pump-1200', kind: 'pump', name: 'Watering · 6 min (12:00)', enabled: true, days: 127, spec: { minute: 720, durationS: 360 } },
      { id: 'water-mature-2000', kind: 'pump', name: 'water-mature-2000', enabled: true, days: 127, spec: { minute: 1200, durationS: 360 } },
    ])
    expect(calls.remove).toHaveBeenCalledWith({ id: 'water-mature-1400' })
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps a cycle\'s level and a new id clear of the old ones, and keeps each cycle\'s days until one is picked for all', async () => {
    const mine = [{ ...pump('pump-0900', 600, 300, 1), spec: { minute: 600, durationS: 300, level: 50 } }, pump('evening', 1080, 300)]
    show({ kind: 'live' }, { live: mine })
    expect(screen.getByTestId('editor-days').textContent).toBe('as each cycle has it')
    expect(preview().getByText('40 min')).toBeTruthy()
    expect(preview().getByText('a week · 2 × 5 min')).toBeTruthy()
    fireEvent.click(button('Add cycle'))
    fireEvent.change(screen.getByLabelText('Cycle 3 time'), { target: { value: '09:00' } })
    fireEvent.click(button('Apply'))
    await settle()
    expect(calls.upsert.mock.calls.map(c => [c[0].id, c[0].days, c[0].spec])).toEqual([
      ['pump-0900-2', 127, { minute: 540, durationS: 300 }],
      ['pump-0900', 1, { minute: 600, durationS: 300, level: 50 }],
      ['evening', 127, { minute: 1080, durationS: 300 }],
    ])
    cleanup()
    calls.upsert.mockReset()
    show({ kind: 'live' }, { live: mine })
    fireEvent.click(screen.getByRole('button', { name: 'Saturday' }))
    expect(screen.getByTestId('editor-days').textContent).toBe('')
    fireEvent.click(button('Apply'))
    await settle()
    expect(calls.upsert.mock.calls.map(c => c[0].days)).toEqual([127 & ~32, 127 & ~32])
  })

  it('saves them as a schedule and uses it, once named', async () => {
    show({ kind: 'live' })
    expect(button('Save as schedule').disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Spring' } })
    fireEvent.click(button('Save as schedule'))
    await settle()
    expect(calls.create).toHaveBeenCalledWith({ name: 'Spring', cycles: mature.cycles })
    expect(calls.activate).toHaveBeenCalledWith({ id: 'spring' })
  })
})
