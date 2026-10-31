/**
 * Production wiring for the Autopilot engine: signals from the HAL snapshot and
 * the store, actions through the light arbiter and hald, runs into the store.
 * Kept apart from the engine so the engine stays free of I/O.
 */
import type { LightArbiter } from '../control/light'
import type { ActuatorCommand, ActuatorId } from '../hardware/contract'
import type { HalClient } from '../hardware/types'
import type { EventBus } from '../lib/eventBus'
import { localTime } from '../scheduler/time'
import type { Store } from '../store/types'
import { ActionRefused, AutopilotEngine } from './engine'
import { liveSignals } from './signals'
import type { DayOfWeek } from './types'

const DAYS: DayOfWeek[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
/** Runs older than this are pruned (checked hourly). */
const RUN_RETENTION_DAYS = 30

export function noticeKind(ruleId: number): string {
  return `autopilot_${ruleId}`
}

export function createAutopilot(o: { hal: HalClient, store: Store, events: EventBus, light: LightArbiter, now?: () => Date, log?: (m: string) => void }): AutopilotEngine {
  const now = () => o.now?.() ?? new Date()
  let lastPrune = 0

  /** hald reports a refusal as a state that stayed off; surface its reason. */
  async function command(id: ActuatorId, cmd: ActuatorCommand): Promise<void> {
    let state
    try {
      state = await o.hal.setActuator(id, cmd)
    }
    catch (e) {
      throw new ActionRefused((e as Error).message)
    }
    if (cmd.on && !state.on) throw new ActionRefused(state.fault ?? `${id} stayed off (refused by the hardware guard)`)
    o.events.emit({ kind: 'mutation', path: `actuators.${id}` })
  }

  return new AutopilotEngine({
    now: () => now().getTime(),
    clock: () => {
      const lt = localTime(now(), o.store.settings.get().timezone)
      return { nowMinutes: lt.minute, dayOfWeek: DAYS[lt.weekday] ?? 'monday', dateKey: lt.date }
    },
    signals: slots => liveSignals(o.hal.snapshot(), o.store, now(), slots),
    loadRules: () => o.store.automations.list(),
    recordRun: (automationId, outcome, detail) => {
      const ts = now()
      o.store.automations.addRun({ automationId, firedAt: ts.toISOString(), outcome, detail })
      if (ts.getTime() - lastPrune > 3_600_000) {
        lastPrune = ts.getTime()
        o.store.automations.pruneRuns(new Date(ts.getTime() - RUN_RETENTION_DAYS * 86_400_000).toISOString())
      }
    },
    disableRule: id => o.store.automations.update(id, { enabled: false }, now().toISOString()),
    enabled: () => o.store.settings.get().autopilotEnabled,
    changed: () => o.events.emit({ kind: 'mutation', path: 'automations' }),
    log: o.log,
    act: {
      notify: (rule, message) => {
        o.store.alerts.raise(noticeKind(rule.id), `${rule.name}: ${message}`, now().toISOString())
        o.events.emit({ kind: 'mutation', path: 'alerts' })
      },
      clearNotice: (rule) => {
        if (o.store.alerts.clear(noticeKind(rule.id), now().toISOString())) o.events.emit({ kind: 'mutation', path: 'alerts' })
      },
      setLightLeases: leases => o.light.setLeases(leases),
      runPump: (durationS, level) => command('pump', { on: true, durationS, ...(level !== undefined ? { level } : {}) }),
      stopPump: () => command('pump', { on: false }),
      dose: (doser, durationS) => command(doser, { on: true, durationS }),
      setPodStatus: (slot, status) => {
        o.store.pods.update(slot, { status }, now().toISOString())
        o.events.emit({ kind: 'mutation', path: 'grow' })
      },
    },
  })
}
