import { describe, expect, it } from 'vitest'
import { backtestLine, byDay, lightLine, matchesFilter, modePatch, ruleMode, statusLine } from '../autopilotLogic'

describe('autopilot logic', () => {
  it('maps modes both ways', () => {
    expect(ruleMode({ enabled: false, dryRun: false })).toBe('off')
    expect(ruleMode({ enabled: true, dryRun: true })).toBe('dryrun')
    expect(ruleMode({ enabled: true, dryRun: false })).toBe('active')
    expect(modePatch('off')).toEqual({ enabled: false })
    expect(modePatch('dryrun')).toEqual({ enabled: true, dryRun: true })
    expect(modePatch('active')).toEqual({ enabled: true, dryRun: false })
  })

  it('writes the status line without zero parts', () => {
    expect(statusLine([])).toBe('no rules')
    expect(statusLine([{ enabled: true, dryRun: false }])).toBe('1 rule · 1 active')
    expect(statusLine([{ enabled: true, dryRun: true }, { enabled: false, dryRun: false }])).toBe('2 rules · 1 dry-run')
  })

  it('writes the backtest line with the peak or low against the threshold', () => {
    const s = { days: 7, wouldFire: 2, suppressed: 0, disabledAt: null, spark: [], fireAt: [], liveOnly: [] }
    expect(backtestLine(undefined)).toBe('backtesting…')
    expect(backtestLine({ ...s, watch: { label: 'air', unit: '°C', op: '>', threshold: 29, extreme: 31.24 } })).toBe('7-day backtest · 2 would fire · peak 31.2 of 29 °C')
    expect(backtestLine({ ...s, watch: { label: 'tank', unit: '%', op: '<=', threshold: 30, extreme: 120.4 } })).toBe('7-day backtest · 2 would fire · low 120 of 30 %')
    expect(backtestLine({ ...s, watch: { label: 'pod', unit: '1/0', op: '==', threshold: 1, extreme: 1 } })).toBe('7-day backtest · 2 would fire · peak 1 of 1')
    expect(backtestLine({ ...s, watch: null, disabledAt: '2026-10-31T00:00:00Z' })).toBe('7-day backtest · 2 would fire · runaway guard would stop it')
  })

  it('says who holds the light', () => {
    const names = new Map([[4, 'Dim when hot']])
    expect(lightLine({ source: 'autopilot', level: 60, leaseId: 'rule:4:1', manualUntil: null }, names)).toBe('Light: set by Dim when hot · 60 %')
    expect(lightLine({ source: 'autopilot', level: null, leaseId: null, manualUntil: null }, names)).toBe('Light: set by a rule')
    expect(lightLine({ source: 'schedule', level: 30, leaseId: null, manualUntil: null }, names)).toBe('Light: following the schedule · 30 %')
    expect(lightLine({ source: null, level: null, leaseId: null, manualUntil: null }, names)).toBe('Light: idle')
    expect(lightLine({ source: 'manual', level: 90, leaseId: null, manualUntil: '2026-10-31T12:30:00Z' }, names)).toMatch(/^Light: held by hand until .+ · 90 %$/)
  })

  it('filters the log and groups it by day', () => {
    expect(['fired', 'clamped', 'dry_run', 'refused', 'error'].every(o => matchesFilter(o, 'actions'))).toBe(true)
    expect(matchesFilter('skipped', 'actions')).toBe(false)
    expect(matchesFilter('skipped', 'all')).toBe(true)
    expect(matchesFilter('clamped', 'fired')).toBe(true)
    expect(matchesFilter('error', 'problems')).toBe(true)
    expect(matchesFilter('dry_run', 'would')).toBe(true)
    const days = byDay([{ firedAt: '2026-10-31T12:00:00' }, { firedAt: '2026-10-31T08:00:00' }, { firedAt: '2026-10-30T23:00:00' }])
    expect(days.map(d => d.runs.length)).toEqual([2, 1])
  })
})
