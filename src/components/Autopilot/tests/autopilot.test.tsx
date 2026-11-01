// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { catalog } from '@/src/autopilot/signals'
import { AutopilotPage } from '../AutopilotPage'

const { data, calls } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: { update: vi.fn(), remove: vi.fn(), setGlobal: vi.fn(), create: vi.fn(), backtest: vi.fn() },
}))

vi.mock('@/src/utils/trpc', () => {
  const query = (name: string) => ({ useQuery: () => ({ data: data.get(name) }) })
  const mutation = (name: keyof typeof calls) => ({ useMutation: (o?: { onSuccess?: () => void }) => ({
    isPending: false,
    data: data.get(`${name}Result`),
    error: data.get(`${name}Error`) ?? null,
    mutate: (input: unknown, local?: { onSuccess?: () => void }) => {
      calls[name](input)
      o?.onSuccess?.()
      local?.onSuccess?.()
    },
  }) })
  return {
    trpc: {
      useUtils: () => ({ automations: { invalidate: vi.fn() } }),
      automations: {
        list: query('list'), status: query('status'), runs: query('runs'), catalog: query('catalog'), backtests: query('backtests'),
        update: mutation('update'), remove: mutation('remove'), setGlobal: mutation('setGlobal'), create: mutation('create'), backtest: mutation('backtest'),
      },
    },
  }
})

const lit = (value: number) => ({ kind: 'literal' as const, value })
const base = { enabled: true, dryRun: false, priority: 50, cooldownMin: 60, createdAt: 't', updatedAt: 't', trigger: { kind: 'tick' as const, everyMin: 5 } }
const rules = [
  { ...base, id: 1, name: 'Tank low', conditions: { kind: 'and' as const, conditions: [{ kind: 'compare' as const, op: '<' as const, left: { kind: 'signal' as const, signal: 'sensor.water_level_pct' }, right: lit(30) }] }, actions: [{ kind: 'notify' as const, message: 'top up' }], lastRun: { id: 9, automationId: 1, firedAt: '2026-10-31T10:00:00Z', outcome: 'fired' as const, detail: {} } },
  { ...base, id: 2, name: 'Odd one', dryRun: true, conditions: { kind: 'not' as const, condition: { kind: 'and' as const, conditions: [] } }, actions: [{ kind: 'stopPump' as const }], lastRun: null },
  { ...base, id: 3, name: 'Off rule', enabled: false, conditions: { kind: 'and' as const, conditions: [] }, actions: [{ kind: 'setLight' as const, level: lit(40) }], lastRun: { id: 8, automationId: 3, firedAt: '2026-10-31T09:00:00Z', outcome: 'error' as const, detail: { reason: 'runaway-disabled' } } },
]

beforeEach(() => {
  data.clear()
  for (const f of Object.values(calls)) f.mockReset()
  data.set('list', rules)
  data.set('catalog', catalog())
  data.set('status', { enabled: true, lastTickAt: null, leases: [], rules: [{ id: 1, condition: true, lastFiredAt: null, actionsLastHour: 2, cooldownUntil: '2026-10-31T11:00:00Z' }], light: { source: 'autopilot', level: 40, leaseId: 'rule:1:0', manualUntil: null, schedule: 0 } })
  data.set('runs', [
    { id: 3, automationId: 1, firedAt: '2026-10-31T10:00:00Z', outcome: 'fired', detail: { actions: [{ kind: 'notify' }] } },
    { id: 2, automationId: 1, firedAt: '2026-10-31T09:55:00Z', outcome: 'refused', detail: { actions: [{ kind: 'runPump', refused: 'dry-run: water below 16 cm' }, { kind: 'setLight', skipped: 'value-unknown' }, { kind: 'setLight', value: 40 }] } },
    { id: 1, automationId: 7, firedAt: '2026-10-31T09:50:00Z', outcome: 'skipped', detail: { reason: 'condition-false' } },
  ])
})
afterEach(cleanup)

const summary = (id: number, o: Record<string, unknown> = {}) => ({
  id, days: 7, wouldFire: 3, suppressed: 0, disabledAt: null, liveOnly: [],
  watch: { key: 'sensor.water_level_pct', label: 'Tank level', unit: '%', op: '<', threshold: 30, extreme: 22 },
  spark: [60, 45, 28, null, 22, 40], fireAt: [2, 4], ...o,
})

describe('AutopilotPage', () => {
  beforeEach(() => {
    data.set('backtests', [summary(1), summary(3, { wouldFire: 0, watch: { key: 'x', label: 'pH', unit: '', op: '>', threshold: 6.5, extreme: null }, spark: [], fireAt: [] })])
  })

  it('shows the status line, who owns the light, every rule in words with its mode', () => {
    render(<AutopilotPage />)
    expect(screen.getByTestId('automations-status').textContent).toBe('3 rules · 1 active · 1 dry-run')
    expect(screen.getByText('Light: set by Tank low · 40 %')).toBeTruthy()
    expect(screen.getByText('Every 5 minutes, if tank level is below 30 %, notify “top up”. At most once every 60 min.')).toBeTruthy()
    const mode = (name: string) => within(screen.getByRole('radiogroup', { name: `${name} mode` })).getAllByRole('radio').find(r => r.getAttribute('aria-checked') === 'true')?.textContent
    expect(mode('Tank low')).toBe('Active')
    expect(mode('Odd one')).toBe('Dry-run')
    expect(mode('Off rule')).toBe('Off')
    expect(screen.getByText('2 actions this hour')).toBeTruthy()
    expect(screen.getByText(/cooling down until/)).toBeTruthy()
    expect(screen.getByText('last run failed')).toBeTruthy()
  })

  it('puts each rule\'s 7-day backtest on the list, with a sparkline of the watched signal', () => {
    render(<AutopilotPage />)
    expect(screen.getByTestId('backtest-1').textContent).toBe('7-day backtest · 3 would fire · low 22 of 30 %')
    expect(screen.getByRole('img', { name: 'Tank level over 7 days against 30 %; 3 would fire' })).toBeTruthy()
    expect(screen.getByTestId('backtest-2').textContent).toBe('backtesting…')
    expect(screen.getByTestId('backtest-3').textContent).toBe('7-day backtest · 0 would fire · no recorded pH')
  })

  it('sets a rule Off, Dry-run or Active, and flips the kill switch', () => {
    render(<AutopilotPage />)
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Tank low mode' })).getByRole('radio', { name: 'Dry-run' }))
    expect(calls.update).toHaveBeenLastCalledWith({ id: 1, enabled: true, dryRun: true })
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Odd one mode' })).getByRole('radio', { name: 'Active' }))
    expect(calls.update).toHaveBeenLastCalledWith({ id: 2, enabled: true, dryRun: false })
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Tank low mode' })).getByRole('radio', { name: 'Off' }))
    expect(calls.update).toHaveBeenLastCalledWith({ id: 1, enabled: false })
    fireEvent.click(screen.getByLabelText('Autopilot enabled'))
    expect(calls.setGlobal).toHaveBeenCalledWith({ enabled: false })
  })

  it('opens a rule in the editor; one the form can\'t show opens its backtest instead', () => {
    render(<AutopilotPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Tank low' }))
    expect(screen.getByRole('dialog', { name: 'Edit rule' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Open Odd one' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('Run backtest')).toBeTruthy()
  })

  it('deletes after confirmation', () => {
    render(<AutopilotPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Tank low' }))
    const dlg = within(screen.getByRole('dialog', { name: 'Delete Tank low?' }))
    fireEvent.click(dlg.getByText('Delete'))
    expect(calls.remove).toHaveBeenCalledWith({ id: 1 })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('expands the full backtest from the summary and summarises the replay', () => {
    data.set('backtestResult', {
      from: '', to: '', stepMin: 5, liveOnly: ['light.level'],
      times: ['2026-10-31T09:00:00Z', '2026-10-31T09:05:00Z'],
      traces: [{ key: 'sensor.water_level_pct', label: 'Tank level', unit: '%', values: [40, 25] }],
      fires: [{ at: '2026-10-31T09:05:00Z', outcome: 'clamped', actions: [{ kind: 'setLight', value: 70, clamped: true }] }],
      suppressed: [{ at: '2026-10-31T09:10:00Z', reason: 'cooldown' }],
      summary: { fires: 1, suppressed: 1, unknownSteps: 1, disabledAt: '2026-10-31T09:20:00Z' },
    })
    render(<AutopilotPage />)
    fireEvent.click(screen.getAllByText('Replay it over any window')[0] as HTMLElement)
    fireEvent.click(screen.getByRole('tab', { name: '7 days' }))
    fireEvent.click(screen.getByText('Run backtest'))
    expect(calls.backtest).toHaveBeenCalledWith({ id: 1, rule: undefined, hours: 168, stepMin: 15 })
    expect(screen.getByText('Would have fired 1 time. 1 more held back by the cooldown or the runaway guard. Missing data on 1 of 2 steps.')).toBeTruthy()
    expect(screen.getByText(/runaway guard would have disabled it/)).toBeTruthy()
    expect(screen.getByText('Not recorded, so unknown here: light.level.')).toBeTruthy()
    expect(screen.getByRole('list', { name: 'Backtest fires' }).textContent).toContain('setLight 70 (clamped)')
    fireEvent.click(screen.getByText('Hide the replay'))
    expect(screen.queryByText('Run backtest')).toBeNull()
  })

  it('logs what rules did by default, and every check under All checks', () => {
    render(<AutopilotPage />)
    const log = () => within(screen.getByRole('list', { name: 'Run log' }))
    expect(log().getByText('dry-run: water below 16 cm, setLight: value-unknown, setLight 40')).toBeTruthy()
    expect(log().queryByText('condition false')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'All checks' }))
    expect(log().getByText('condition false')).toBeTruthy()
    expect(log().getByText('rule 7')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Refused' }))
    expect(log().getAllByRole('listitem')).toHaveLength(1)
    fireEvent.click(screen.getByRole('tab', { name: 'Would fire' }))
    expect(screen.getByText('Nothing matches this filter.')).toBeTruthy()
  })

  it('marks today\'s fires on each rule\'s lane', () => {
    data.set('runs', [{ id: 5, automationId: 1, firedAt: new Date(Date.now() - 3_600_000).toISOString(), outcome: 'fired', detail: {} }])
    render(<AutopilotPage />)
    expect(screen.getByTestId('lane-1').children).toHaveLength(1)
    expect(screen.getByTestId('lane-2').children).toHaveLength(0)
  })

  it('offers templates when there are no rules, and says when Autopilot is off', () => {
    data.set('list', [])
    data.set('runs', [])
    data.set('status', { enabled: false, lastTickAt: null, leases: [], rules: [], light: { source: 'manual', level: 90, leaseId: null, manualUntil: '2026-10-31T12:30:00Z', schedule: 40 } })
    render(<AutopilotPage />)
    expect(screen.getByText(/No rules yet/)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toMatch(/^Autopilot is off/)
    expect(screen.getByText(/held by hand until/)).toBeTruthy()
    expect(screen.getByText(/Nothing yet/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Dim when hot/ }))
    expect(screen.getByRole('dialog', { name: 'New rule' })).toBeTruthy()
    expect((screen.getByPlaceholderText('Dim when hot') as HTMLInputElement).value).toBe('Dim when hot')
  })
})

describe('RuleEditor', () => {
  it('builds a rule from the form, previews it in words, and saves it', () => {
    render(<AutopilotPage />)
    fireEvent.click(screen.getByText('New rule'))
    const dlg = within(screen.getByRole('dialog', { name: 'New rule' }))
    expect((dlg.getByText('Save') as HTMLButtonElement).disabled).toBe(true)
    expect(dlg.getByText('Give the rule a name.')).toBeTruthy()
    fireEvent.change(dlg.getByPlaceholderText('Dim when hot'), { target: { value: 'Hot and dry' } })
    fireEvent.click(dlg.getByText('Condition'))
    const rows = dlg.getAllByTestId('condition-row')
    fireEvent.change(within(rows[1] as HTMLElement).getByLabelText('Aggregate'), { target: { value: 'avg' } })
    fireEvent.change(within(rows[1] as HTMLElement).getByLabelText('Over minutes'), { target: { value: '20' } })
    fireEvent.click(dlg.getByRole('tab', { name: 'any' }))
    fireEvent.change(dlg.getByLabelText('Held for minutes'), { target: { value: '10' } })
    fireEvent.click(dlg.getByLabelText('Only between'))
    fireEvent.click(dlg.getByText('Action'))
    fireEvent.change(dlg.getAllByLabelText('Action')[1] as HTMLElement, { target: { value: 'dose' } })
    fireEvent.change(dlg.getByLabelText('Seconds'), { target: { value: '4' } })
    expect(dlg.getByLabelText('Rule preview').textContent).toBe('Every 5 minutes, if pH is above 6.5 or the average air temperature over 20 min is above 30 °C for 10 min and it\'s between 08:00 and 20:00, notify “pH is high”, then run doser 1 for 4 s. At most once every 30 min.')
    fireEvent.click(dlg.getByText('Save'))
    expect(calls.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Hot and dry', conditions: expect.objectContaining({ kind: 'and' }) }))
  })

  it('switches triggers and action kinds, and backtests the draft', () => {
    render(<AutopilotPage />)
    fireEvent.click(screen.getByText('New rule'))
    const dlg = within(screen.getByRole('dialog', { name: 'New rule' }))
    fireEvent.click(dlg.getByRole('tab', { name: 'At a time' }))
    fireEvent.change(dlg.getByLabelText('Time'), { target: { value: '07:30' } })
    fireEvent.click(dlg.getByRole('button', { name: 'sa' }))
    fireEvent.click(dlg.getByRole('button', { name: 'su' }))
    expect(dlg.getByLabelText('Rule preview').textContent).toMatch(/^At 07:30 on Mon, Tue, Wed, Thu, Fri, if pH/)
    fireEvent.click(dlg.getByRole('tab', { name: 'On change' }))
    expect(dlg.getByLabelText('Rule preview').textContent).toMatch(/^When pH changes/)
    for (const kind of ['setLight', 'runPump', 'stopPump', 'setPodStatus']) fireEvent.change(dlg.getByLabelText('Action'), { target: { value: kind } })
    fireEvent.change(dlg.getByLabelText('Pod'), { target: { value: '7' } })
    expect(dlg.getByLabelText('Rule preview').textContent).toMatch(/mark pod 7 as attention/)
    fireEvent.change(dlg.getByLabelText('Action'), { target: { value: 'setLight' } })
    fireEvent.change(dlg.getByLabelText('Hold minutes'), { target: { value: '45' } })
    expect(dlg.getByLabelText('Rule preview').textContent).toMatch(/set the light to 50 %, holding 45 min/)
    fireEvent.click(dlg.getByRole('button', { name: 'Remove condition' }))
    fireEvent.click(dlg.getByText('Backtest'))
    fireEvent.click(dlg.getByText('Run backtest'))
    expect(calls.backtest).toHaveBeenCalledWith(expect.objectContaining({ id: undefined, rule: expect.objectContaining({ name: 'draft', dryRun: true }) }))
    fireEvent.click(dlg.getByRole('button', { name: 'Remove action' }))
    expect(dlg.getByText('Add at least one action.')).toBeTruthy()
    expect(dlg.getByText('Fix the rule above to backtest it.')).toBeTruthy()
    fireEvent.click(dlg.getByText('Cancel'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('edits an existing rule and shows server errors', () => {
    data.set('updateError', new Error('no automation 1'))
    render(<AutopilotPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Tank low' }))
    const dlg = within(screen.getByRole('dialog', { name: 'Edit rule' }))
    expect((dlg.getByPlaceholderText('Dim when hot') as HTMLInputElement).value).toBe('Tank low')
    fireEvent.click(dlg.getByText('Save'))
    expect(calls.update).toHaveBeenCalledWith(expect.objectContaining({ id: 1, name: 'Tank low' }))
    expect(screen.getAllByText('no automation 1').length).toBeGreaterThan(0)
  })
})
