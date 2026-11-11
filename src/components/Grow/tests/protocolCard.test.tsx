// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { protocolReport } from '@/src/care/protocol'
import { PUMP_PRESETS, presetSchedules } from '@/src/scheduler/pumpPlan'
import { MemoryStore } from '@/src/store/memory'
import { ProtocolLine } from '@/src/components/Water/ProtocolLine'
import { ProtocolCard } from '../ProtocolCard'

const { data, calls, state, success } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: { hold: vi.fn(), release: vi.fn(), advance: vi.fn(), setThen: vi.fn(), activate: vi.fn(), setStart: vi.fn(), startGermination: vi.fn() },
  state: { startPending: false, startError: null as null | { message: string } },
  success: new Map<string, () => void>(),
}))

vi.mock('@/src/utils/trpc', () => {
  const query = (name: string) => ({ useQuery: () => ({ data: data.get(name) }) })
  const mutation = (name: keyof typeof calls) => ({ useMutation: (o?: { onSuccess?: () => void }) => {
    if (o?.onSuccess) success.set(name, o.onSuccess)
    return {
      isPending: name === 'startGermination' && state.startPending,
      error: name === 'startGermination' ? state.startError : null,
      reset: vi.fn(),
      mutate: (i?: unknown) => calls[name](i),
      mutateAsync: async (i?: unknown) => calls[name](i),
    }
  } })
  return {
    trpc: {
      useUtils: () => ({ protocol: { invalidate: vi.fn() }, schedules: { invalidate: vi.fn() }, grow: { invalidate: vi.fn() } }),
      grow: { setStart: mutation('setStart'), startGermination: mutation('startGermination') },
      protocol: { current: query('protocol'), hold: mutation('hold'), release: mutation('release'), advance: mutation('advance'), setThen: mutation('setThen') },
      schedules: { list: query('schedules'), library: { list: query('library'), activate: mutation('activate') } },
      settings: { get: query('settings') },
    },
  }
})
vi.mock('@tanstack/react-router', () => ({ Link: ({ to, children, className, ...rest }: { to: string, children: ReactNode, className?: string }) => <a href={to} className={className} {...rest}>{children}</a> }))

const DAY = 86_400_000
const day = (n: number) => new Date(Date.parse('2026-11-09T12:00:00Z') + n * DAY)
const light = { id: 'gardyn', kind: 'light' as const, name: 'Gardyn day', enabled: true, days: 127, spec: { setpoints: [{ minute: 330, level: 0 }, { minute: 360, level: 100 }, { minute: 1260, level: 100 }, { minute: 1290, level: 0 }] } }
const summer = { id: 'summer', name: 'Summer', cycles: [{ minute: 420, durationS: 300, days: 127 }, { minute: 1020, durationS: 300, days: 127 }], lightPresetId: null }

/** A Basil tower sown Monday 9 November, on a preset's cycles, as the server would report it on `at`. */
function report(o: { cycles?: string, at?: number, cycle?: boolean, follow?: boolean, then?: Parameters<MemoryStore['grow']['setProtocol']>[0] } = {}) {
  const store = new MemoryStore(30)
  store.schedules.upsert(light)
  store.pods.update(1, { plant: 'Basil', plantedAt: '2026-11-09', status: 'seeded' }, '2026-11-09T12:00:00Z')
  if (o.cycle ?? true) store.grow.start('2026-11-09T00:00:00.000Z')
  if (o.follow === false) store.settings.update({ followGrowCycle: false })
  if (o.then) store.grow.setProtocol(o.then)
  store.scheduleLibrary.upsert(summer, 't')
  const preset = PUMP_PRESETS.find(p => p.id === (o.cycles ?? 'germination'))
  if (preset) for (const s of presetSchedules(preset, { enabled: true, light: { on: 360, off: 1260 }, weekday: 0 })) store.schedules.upsert(s)
  else if (o.cycles === 'hand') store.schedules.upsert({ id: 'mine', kind: 'pump', name: 'Mine', enabled: true, days: 127, spec: { minute: 450, durationS: 420 } })
  else if (o.cycles === 'summer') for (const c of summer.cycles) store.schedules.upsert({ id: `water-own-summer-${String(c.minute / 60).padStart(2, '0')}00`, kind: 'pump', name: 'Summer', enabled: true, days: 127, spec: { minute: c.minute, durationS: c.durationS } })
  return { r: protocolReport(store, day(o.at ?? 2)), store }
}

function show(o: Parameters<typeof report>[0] = {}) {
  const { r, store } = report(o)
  data.set('protocol', r)
  data.set('schedules', store.schedules.list())
  data.set('library', [{ ...summer, kind: 'own', lastUsedAt: null, active: false, readOnly: false }, { id: 'preset:mature', name: 'Mature greens & herbs', kind: 'preset', cycles: [], lightPresetId: null, lastUsedAt: null, active: false, readOnly: true }])
  return render(<ProtocolCard />)
}

beforeEach(() => {
  data.clear()
  data.set('settings', { timezone: 'UTC' })
  for (const f of Object.values(calls)) f.mockReset()
  Object.assign(state, { startPending: false, startError: null })
})
afterEach(cleanup)

describe('ProtocolCard', () => {
  it('lays the stages out as one track from the sowing day, with the Then slot at its end', () => {
    show()
    expect(screen.getByRole('heading', { name: 'Greens & herbs protocol' })).toBeTruthy()
    expect(screen.getByTestId('protocol-where').textContent).toBe('Germination, day 3 of 8 · Seedlings starts Tue 17 Nov')
    const track = within(screen.getByRole('group', { name: 'Stages' }))
    expect(track.getAllByRole('button').map(b => b.textContent)).toEqual(['Germination0–7 · 1×15 min wk', 'Seedlings8–13 · 1×10 min', 'Young plants14–21 · 2×6 min', 'Maintenance22 on · 3×6 min', 'Thenstay in maintenance'])
    expect(track.getAllByRole('button').map(b => b.dataset.state)).toEqual(['current', 'next', 'next', 'next', undefined])
    expect(screen.getByTestId('track-line').textContent).toBe('Sown Mon 9 NovChangeongoing')
  })

  it('opens on the current stage: water with its days, runs and sum, light, feed and checks, each with its source', () => {
    show()
    const panel = within(screen.getByTestId('stage-panel'))
    expect(panel.getByTestId('stage-head').textContent).toBe('Germination · day 3 of 8')
    expect(panel.getByText('1 × 15 min, Mondays')).toBeTruthy()
    expect(panel.getByTestId('weekday-dots').getAttribute('aria-label')).toBe('Runs on Mondays')
    expect(panel.getByTestId('stage-runs').textContent).toBe('08:00 · once a week')
    expect(panel.getByText('15 h · 06:00–21:00')).toBeTruthy()
    expect(panel.getByText('Plain water: no plant food until the sprouts come up.')).toBeTruthy()
    expect(panel.getByText('Check the yCubes daily for sprouts; some take up to 21 days.')).toBeTruthy()
    const links = panel.getAllByRole('link').map(a => a.getAttribute('href'))
    expect(links).toContain('https://github.com/seedypod/core/blob/dev/knowledge/plants/germination.md#sprouting')
    expect(links).toContain('https://github.com/seedypod/core/blob/dev/knowledge/nutrients/gardyn-feeding-guidance.md#plant-food')
    expect(panel.getAllByRole('link').every(a => a.getAttribute('target') === '_blank')).toBe(true)
  })

  it('says when a later stage starts and what changes; hovering only highlights and says it in a line', () => {
    show()
    const seedlings = within(screen.getByRole('group', { name: 'Stages' })).getByRole('button', { name: /^Seedlings/ })
    fireEvent.mouseEnter(seedlings)
    expect(screen.getByTestId('track-hover').textContent).toBe('Seedlings · days 8–13 · 1 × 10 min daily · starts Tue 17 Nov')
    expect(screen.getByTestId('stage-head').textContent).toBe('Germination · day 3 of 8')
    fireEvent.mouseLeave(seedlings)
    expect(screen.getByTestId('track-hover').textContent).toBe('')
    fireEvent.click(seedlings)
    expect(seedlings.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('stage-head').textContent).toBe('Starts Tue 17 Nov · Watering goes from once a week to once a day, 15 → 10 min.')
    expect(screen.getByTestId('stage-runs').textContent).toBe('08:00 · = 10 min a day')
  })

  it('holds and releases, and advances only after saying what changes', () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Hold at this stage' }))
    expect(calls.hold).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Advance now' }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText('Advance to Seedlings now?')).toBeTruthy()
    expect(dialog.getByText(/^Watering goes from once a week to once a day, 15 → 10 min\. Later stages move up/)).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: 'Advance' }))
    expect(calls.advance).toHaveBeenCalled()
    cleanup()
    show({ then: { holdStageId: 'germination', holdSince: day(1).toISOString() } })
    expect(screen.getByTestId('protocol-where').textContent).toBe('Germination, day 2 of 8 · held 1 d')
    fireEvent.click(screen.getByRole('button', { name: 'Release hold' }))
    expect(calls.release).toHaveBeenCalled()
  })

  it('offers no Advance in maintenance or without a cycle, and says why the protocol isn\'t moving water', () => {
    show({ cycles: 'mature', at: 30 })
    expect((screen.getByRole('button', { name: 'Advance now' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('stage-head').textContent).toBe('Maintenance · day 9, ongoing')
    cleanup()
    show({ cycle: false, follow: false, cycles: 'hand' })
    const notes = screen.getByTestId('protocol-notes').textContent
    expect(notes).toMatch(/Follow the grow cycle is off/)
    expect(notes).toMatch(/Start a cycle to hold, advance/)
    expect(notes).toMatch(/changed by hand/)
    expect((screen.getByRole('button', { name: 'Hold at this stage' }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    show({ cycles: 'summer', at: 10 })
    expect(screen.getByTestId('protocol-notes').textContent).toMatch(/On your schedule Summer/)
    fireEvent.click(screen.getByRole('button', { name: 'Back to Seedlings' }))
    expect(calls.activate).toHaveBeenCalledWith({ id: 'preset:seedlings' })
  })

  it('chooses what comes after in the Then slot: stay, a schedule when maintenance begins or now, or a reminder', () => {
    show()
    fireEvent.click(screen.getByRole('button', { name: /^Then/ }))
    const panel = within(screen.getByTestId('then-panel'))
    expect((panel.getByRole('radio', { name: /Stay in maintenance/ }) as HTMLInputElement).checked).toBe(true)
    expect(panel.getByText(/In Needs you on Fri 8 Jan/)).toBeTruthy()
    fireEvent.click(panel.getByRole('radio', { name: /Remind me at first harvest/ }))
    expect(calls.setThen).toHaveBeenLastCalledWith({ kind: 'remind', when: 'maintenance' })
    fireEvent.click(panel.getByRole('radio', { name: /Switch to my schedule/ }))
    expect(calls.setThen).toHaveBeenLastCalledWith({ kind: 'schedule', scheduleId: 'summer', when: 'maintenance' })
    fireEvent.click(panel.getByRole('button', { name: 'Switch now' }))
    expect(calls.setThen).toHaveBeenLastCalledWith({ kind: 'schedule', scheduleId: 'summer', when: 'now' })
    cleanup()
    // Chosen, the slot names it and the panel shows its watering.
    show({ then: { thenKind: 'schedule', thenScheduleId: 'summer' } })
    expect(within(screen.getByRole('group', { name: 'Stages' })).getByRole('button', { name: /^Then/ }).textContent).toBe('ThenSummer · 2×5 min')
    fireEvent.click(screen.getByRole('button', { name: /^Then/ }))
    const chosen = within(screen.getByTestId('then-schedule'))
    expect(chosen.getByText('07:00, 17:00')).toBeTruthy()
    expect(chosen.getByText('Water · Summer')).toBeTruthy()
  })

  it('can\'t remind with no catalog crop, or switch with no schedule of your own', () => {
    const { r, store } = report()
    data.set('protocol', { ...r, then: { ...r.then, harvestDay: null, harvestOn: null } })
    data.set('schedules', store.schedules.list())
    data.set('library', [])
    render(<ProtocolCard />)
    fireEvent.click(screen.getByRole('button', { name: /^Then/ }))
    const panel = within(screen.getByTestId('then-panel'))
    expect((panel.getByRole('radio', { name: /Remind me at first harvest/ }) as HTMLInputElement).disabled).toBe(true)
    expect((panel.getByRole('radio', { name: /Switch to my schedule/ }) as HTMLInputElement).disabled).toBe(true)
    expect(panel.getByText('Save a schedule of your own first.')).toBeTruthy()
  })
})

describe('ProtocolCard: the sowing day at the track\'s left end', () => {
  it('says when the tower was sown, and moves the start to another day', () => {
    show({ at: 2 })
    const sown = within(screen.getByTestId('sown'))
    expect(sown.getByTestId('sown-on').textContent).toBe('Sown Mon 9 Nov')
    fireEvent.click(sown.getByText('Change'))
    const input = sown.getByLabelText(/Sown on/) as HTMLInputElement
    // It opens on the sowing day, and goes no later than today on the unit's calendar.
    expect(input.value).toBe('2026-11-09')
    expect(input.max).toBe(new Date().toISOString().slice(0, 10))
    fireEvent.change(input, { target: { value: '2026-11-08' } })
    fireEvent.click(sown.getByRole('button', { name: 'Save' }))
    expect(calls.setStart).toHaveBeenCalledWith({ startedAt: '2026-11-08' })
  })

  it('says the weekly run stays put when Follow is off and the sowing day isn\'t its day', () => {
    // Sown on Monday the 9th; the germination cycle runs on Thursdays.
    const { r, store } = report({ follow: false })
    data.set('protocol', r)
    data.set('schedules', store.schedules.list().map(s => (s.kind === 'pump' ? { ...s, days: 1 << 3 } : s)))
    data.set('library', [])
    render(<ProtocolCard />)
    expect(screen.getByTestId('sown-note').textContent).toBe('Follow is off: your weekly run stays on Thursdays')
    cleanup()
    // With Follow on, the unit moves it, so nothing to say.
    data.set('protocol', report().r)
    render(<ProtocolCard />)
    expect(screen.queryByTestId('sown-note')).toBeNull()
  })

  it('starts germination today in one go on the unit when there is no grow cycle, after a confirmation', () => {
    show({ cycle: false })
    fireEvent.click(within(screen.getByTestId('sown')).getByRole('button', { name: 'Start germination today' }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByTestId('start-germination').textContent).toMatch(/^A grow cycle starts today, .+, and watering moves to Germination: 15 min at 08:00, once a week on \w+\.These go:08:00 · Germination/)
    fireEvent.click(dialog.getByRole('button', { name: 'Start' }))
    // One call: the unit starts the cycle and writes the cycles together.
    expect(calls.startGermination).toHaveBeenCalledTimes(1)
    act(() => success.get('startGermination')?.())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('holds the start dialog open while the unit is starting, and says there why it couldn\'t', () => {
    state.startPending = true
    show({ cycle: false })
    fireEvent.click(within(screen.getByTestId('sown')).getByRole('button', { name: 'Start germination today' }))
    const dialog = within(screen.getByRole('dialog'))
    expect((dialog.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true)
    expect((dialog.getByRole('button', { name: 'Starting…' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    cleanup()
    Object.assign(state, { startPending: false, startError: { message: 'the unit said no' } })
    show({ cycle: false })
    fireEvent.click(within(screen.getByTestId('sown')).getByRole('button', { name: 'Start germination today' }))
    expect(within(screen.getByRole('dialog')).getByText('Couldn\'t start germination: the unit said no')).toBeTruthy()
    expect(screen.getAllByText(/the unit said no/)).toHaveLength(1)
  })
})

describe('ProtocolLine', () => {
  it('says the protocol, stage and day, and the next change, leading to Grow', () => {
    data.set('protocol', report().r)
    render(<ProtocolLine />)
    const line = screen.getByTestId('protocol-line')
    expect(line.textContent).toBe('Following Greens & herbs · Germination, day 3 · next change Tue 17 Nov')
    expect(line.getAttribute('href')).toBe('/grow')
  })

  it('says when it isn\'t moving the water, and nothing before the report comes', () => {
    const cases: Array<[Parameters<typeof report>[0], string]> = [
      [{ follow: false }, 'Not following Greens & herbs · the cycles stay as they are'],
      [{ cycles: 'hand' }, 'Following Greens & herbs · Germination, day 3 · cycles changed by hand, left as they are'],
      [{ cycles: 'summer', at: 10 }, 'Following Greens & herbs · Seedlings, day 3 · on your schedule'],
      [{ cycles: 'mature', at: 30 }, 'Following Greens & herbs · Maintenance, day 9 · ongoing'],
      [{ then: { holdStageId: 'germination', holdSince: day(1).toISOString() } }, 'Following Greens & herbs · Germination, day 2 · held'],
    ]
    for (const [o, words] of cases) {
      data.set('protocol', report(o).r)
      render(<ProtocolLine />)
      expect(screen.getByTestId('protocol-line').textContent).toBe(words)
      cleanup()
    }
    const empty = new MemoryStore(30)
    data.set('protocol', protocolReport(empty, day(2)))
    render(<ProtocolLine />)
    expect(screen.getByTestId('protocol-line').textContent).toBe('Greens & herbs protocol · starts when pods are planted')
    cleanup()
    data.delete('protocol')
    const { container } = render(<ProtocolLine />)
    expect(container.textContent).toBe('')
  })
})
