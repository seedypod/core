import { describe, expect, it } from 'vitest'
import type { CoreEvent } from '@/src/lib/eventBus'
import { alertSnack, followSnack, newAlertSnacks, pumpWatch } from '../snacks'

const T0 = Date.parse('2026-11-11T08:00:00Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const pump = (on: boolean, since: number, remainingS: number | null, fault: string | null = null): CoreEvent => ({ kind: 'hal', event: { type: 'actuator', id: 'pump', state: { on, level: 30, since: at(since), fault, remainingS } } })
const command: CoreEvent = { kind: 'mutation', path: 'actuators.pump.on' }

/** A watch on a clock the test moves, fed events in order; the snacks it returned. */
function watch() {
  let clock = T0
  const w = pumpWatch(() => clock)
  return (t: number, e: CoreEvent) => {
    clock = T0 + t * 1000
    return w(e)
  }
}

describe('followSnack', () => {
  it('says watering moved on to the next stage, with a View into Water', () => {
    const s = followSnack({ kind: 'schedule', action: 'changed', id: 'follow:seedlings' })
    expect(s).toMatchObject({ id: 'follow', title: 'Watering moved to Seedlings', detail: 'Days 8–13', view: { to: '/water', label: 'View' } })
    expect(s?.urgent).toBeFalsy()
  })

  it('says germination was re-dated when it stays on germination', () => {
    expect(followSnack({ kind: 'schedule', action: 'changed', id: 'follow:germination' })?.title).toBe('Germination watering moved to the sowing weekday')
  })

  it('says nothing for a schedule someone changed, one that fired, or a preset it doesn\'t know', () => {
    expect(followSnack({ kind: 'schedule', action: 'changed', id: 'water-mature-0800' })).toBeNull()
    expect(followSnack({ kind: 'schedule', action: 'fired', id: 'follow:seedlings' })).toBeNull()
    expect(followSnack({ kind: 'schedule', action: 'changed', id: 'follow:nope' })).toBeNull()
    expect(followSnack(command)).toBeNull()
  })
})

describe('alertSnack', () => {
  it('says why the pump stopped, urgently, quiet on Water where the strip shows it', () => {
    expect(alertSnack({ id: 1, kind: 'pump_fault', detail: 'pump: dry-run' })).toMatchObject({ id: 'pump', title: 'Pump stopped: dry-run', urgent: true, tone: 'danger', view: { to: '/water' }, shownOn: '/water' })
    expect(alertSnack({ id: 1, kind: 'pump_fault', detail: 'pump stopped: tank ran dry' })?.title).toBe('Pump stopped: tank ran dry')
    expect(alertSnack({ id: 1, kind: 'pump_fault', detail: '' })?.title).toBe('Pump stopped: fault')
    expect(alertSnack({ id: 1, kind: 'water_low', detail: 'tank low' })).toMatchObject({ id: 'pump', title: 'Pump off: water low', urgent: true, shownOn: '/water' })
  })

  it('says the outputs are off on an over-temperature trip', () => {
    expect(alertSnack({ id: 1, kind: 'over_temp', detail: 'pcb 71.2 °C' })).toMatchObject({ title: 'Outputs off: board over temperature', detail: 'pcb 71.2 °C', urgent: true, view: { to: '/sensors' } })
    expect(alertSnack({ id: 1, kind: 'over_temp', detail: '' })?.detail).toBeUndefined()
  })

  it('names other alerts as Alerts does, quiet on Alerts', () => {
    expect(alertSnack({ id: 1, kind: 'light_fault', detail: 'driver open' })).toMatchObject({ id: 'alert:light_fault:1', title: 'Light fault', detail: 'driver open', urgent: true, view: { to: '/light' }, shownOn: '/alerts' })
    expect(alertSnack({ id: 1, kind: 'setup_pump_schedule', detail: 'Pods planted, no pump schedule on.' })).toMatchObject({ title: 'No pump schedule', urgent: false, tone: 'warn' })
    expect(alertSnack({ id: 1, kind: 'mirror_failed', detail: '' })).toMatchObject({ title: 'Off-device copy failed', detail: undefined })
    // An Autopilot notice has no label: its detail names the rule.
    expect(alertSnack({ id: 1, kind: 'autopilot_7', detail: 'Tank under half: notify' })).toMatchObject({ title: 'Tank under half: notify', detail: undefined, view: undefined })
    expect(alertSnack({ id: 1, kind: 'autopilot_7', detail: '' })?.title).toBe('autopilot_7')
  })

  it('leaves reminders and chores to Needs you, and Follow to its event', () => {
    expect(alertSnack({ id: 1, kind: 'chore_top_off', detail: 'Tank at 40%' })).toBeNull()
    expect(alertSnack({ id: 1, kind: 'reminder_thinning', detail: '' })).toBeNull()
    expect(alertSnack({ id: 1, kind: 'watering_followed', detail: 'Watering moved to Seedlings' })).toBeNull()
  })
})

describe('newAlertSnacks', () => {
  const a = (id: number, kind: string, detail = '') => ({ id, kind, detail })

  it('says nothing about what was open when the app opened', () => {
    expect(newAlertSnacks(undefined, [a(1, 'light_fault')])).toEqual([])
  })

  it('says each alert opened since the last list, once', () => {
    const before = [a(1, 'light_fault')]
    const after = [a(1, 'light_fault'), a(2, 'over_temp')]
    expect(newAlertSnacks(before, after).map(s => s.title)).toEqual(['Outputs off: board over temperature'])
    expect(newAlertSnacks(after, after)).toEqual([])
  })

  it('gives each alert its own toast, so two of a kind both get said, and the pump\'s one', () => {
    expect(newAlertSnacks([], [a(5, 'autopilot_1', 'Tank low: notify'), a(6, 'autopilot_1', 'Tank low: notify')]).map(s => s.id)).toEqual(['alert:autopilot_1:5', 'alert:autopilot_1:6'])
    expect(newAlertSnacks([], [a(7, 'pump_fault', 'pump: dry-run')]).map(s => s.id)).toEqual(['pump'])
  })

  it('says the pump fault alone when a dry run raises water low with it', () => {
    expect(newAlertSnacks([], [a(3, 'water_low'), a(4, 'pump_fault', 'pump: dry-run')]).map(s => s.title)).toEqual(['Pump stopped: dry-run'])
    expect(newAlertSnacks([], [a(3, 'water_low')]).map(s => s.title)).toEqual(['Pump off: water low'])
  })
})

describe('pumpWatch', () => {
  it('says a manual run finished once it runs its course', () => {
    const w = watch()
    expect(w(0, pump(true, 0, 300))).toBeNull()
    expect(w(0.1, command)).toBeNull()
    expect(w(300, pump(false, 300, null))).toMatchObject({ id: 'pump-run', title: 'Watering finished', detail: '5 min run', tone: 'ok', view: { to: '/water' } })
  })

  it('counts the command when it arrives before the run starts', () => {
    const w = watch()
    w(0, command)
    w(1, pump(true, 1, 20))
    expect(w(21, pump(false, 21, null))).toMatchObject({ title: 'Watering finished', detail: '20 s run' })
  })

  it('keeps a run\'s start through re-sent states', () => {
    const w = watch()
    w(0, pump(true, 0, 120))
    w(0, command)
    w(60, pump(true, 0, 60))
    expect(w(120, pump(false, 120, null))?.title).toBe('Watering finished')
  })

  it('says nothing when a scheduled run finishes', () => {
    const w = watch()
    w(0, pump(true, 0, 300))
    expect(w(300, pump(false, 300, null))).toBeNull()
    // A command long before the run doesn't make it manual, nor one long after it started.
    w(400, command)
    w(500, pump(true, 500, 300))
    w(520, command)
    expect(w(800, pump(false, 800, null))).toBeNull()
  })

  it('says nothing when the run was stopped early or by a fault', () => {
    const w = watch()
    w(0, command)
    w(0, pump(true, 0, 300))
    expect(w(120, pump(false, 120, null))).toBeNull()
    w(200, command)
    w(200, pump(true, 200, 300))
    expect(w(500, pump(false, 500, null, 'dry-run'))).toBeNull()
  })

  it('takes an on-state with another start for a new run, so a missed off leaves nothing behind', () => {
    const w = watch()
    w(0, command)
    w(0, pump(true, 0, 300))
    // Its off went missing (the stream dropped); a scheduled run starts much later.
    w(1000, pump(true, 1000, 300))
    expect(w(1300, pump(false, 1300, null))).toBeNull()
  })

  it('takes Run again while watering for an extension: same start, the new end, not stopped early', () => {
    const w = watch()
    w(0, command)
    w(0, pump(true, 0, 60))
    w(30, command)
    w(30, pump(true, 30, 300))
    // Past the first run's end, short of the second's: still running, nothing said.
    expect(w(90, pump(true, 30, 240))).toBeNull()
    expect(w(330, pump(false, 330, null))).toMatchObject({ title: 'Watering finished', detail: '6 min run' })
  })

  it('takes an extension commanded after its state arrives as manual too', () => {
    const w = watch()
    w(0, pump(true, 0, 60))
    w(30, pump(true, 30, 120))
    w(30.5, command)
    expect(w(150, pump(false, 150, null))?.title).toBe('Watering finished')
  })

  it('counts a start command once, and never a Stop', () => {
    const w = watch()
    w(0, command)
    w(0, pump(true, 0, 60))
    expect(w(60, pump(false, 60, null))?.title).toBe('Watering finished')
    // A scheduled run right after: the command was spent on the last one.
    w(62, pump(true, 62, 60))
    expect(w(122, pump(false, 122, null))).toBeNull()
    // A Stop's mutation, late after its off, doesn't make the next scheduled run manual.
    w(200, { kind: 'mutation', path: 'actuators.pump' })
    w(201, pump(true, 201, 30))
    expect(w(231, pump(false, 231, null))).toBeNull()
  })

  it('says nothing for an unbounded run, an off with no run seen, or anything not the pump', () => {
    const w = watch()
    w(0, command)
    w(0, pump(true, 0, null))
    expect(w(300, pump(false, 300, null))).toBeNull()
    expect(w(400, pump(false, 400, null))).toBeNull()
    expect(w(401, { kind: 'hal', event: { type: 'actuator', id: 'light', state: { on: false, level: 0, since: at(401), fault: null, remainingS: null } } })).toBeNull()
    expect(w(402, { kind: 'mutation', path: 'tank' })).toBeNull()
  })
})
