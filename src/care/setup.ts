/**
 * Setup check (ADR-0029): what a unit with plants in it is missing. Pods
 * planted with no light or pump schedule on, and a tank sensor that's absent
 * or reading `suspect`. Each problem is its own alert kind, so the app, MCP
 * `status` and Home Assistant see it, and it clears when the setup is fixed.
 */
import type { HalSnapshot } from '../hardware/types'
import type { LightSpec, Schedule, Store } from '../store/types'

export type SetupIssueId = 'no_light_schedule' | 'no_pump_schedule' | 'water_sensor_absent' | 'water_sensor_suspect'

/** Alert kinds the check raises; the two water-sensor problems share one. */
export const SETUP_ALERTS = ['setup_light_schedule', 'setup_pump_schedule', 'setup_water_sensor'] as const
export type SetupAlert = typeof SETUP_ALERTS[number]

export interface SetupIssue {
  id: SetupIssueId
  alert: SetupAlert
  /** A few words for the Status page. */
  title: string
  detail: string
  /** Where in the app it is fixed. */
  fix: string
}

export interface SetupReport {
  /** Pods with something in them (any status but empty). */
  planted: number
  issues: SetupIssue[]
  /** One line for the Status page. */
  summary: string
}

/** On, on at least one day, and, for a light, bright at some point of the day. */
function runs(s: Schedule): boolean {
  if (!s.enabled || (s.days & 127) === 0) return false
  return s.kind === 'pump' || (s.spec as LightSpec).setpoints.some(p => p.level > 0)
}

const pods = (n: number) => `${n} pod${n === 1 ? '' : 's'}`

export function setupReport(store: Store, snap: HalSnapshot): SetupReport {
  const planted = store.pods.list().filter(p => p.status !== 'empty').length
  const schedules = store.schedules.list().filter(runs)
  const issues: SetupIssue[] = []
  if (planted > 0 && !schedules.some(s => s.kind === 'light')) {
    issues.push({ id: 'no_light_schedule', alert: 'setup_light_schedule', title: 'No light schedule', detail: `${pods(planted)} planted but no light schedule is on, so the light stays wherever it was last set.`, fix: 'Add or turn on a light schedule on Light.' })
  }
  if (planted > 0 && !schedules.some(s => s.kind === 'pump')) {
    issues.push({ id: 'no_pump_schedule', alert: 'setup_pump_schedule', title: 'No pump schedule', detail: `${pods(planted)} planted but no pump schedule is on, so the roots get water only when someone runs the pump.`, fix: 'Add or turn on a pump cycle on Water.' })
  }
  // Offline, hal_offline says it; before hald reports what it has, absence can't be told apart.
  if (snap.online && snap.system) {
    const device = snap.devices?.sensors.find(d => d.ids.includes('water_level_pct'))
    const reading = snap.sensors.water_level_pct
    if (!snap.system.caps.sensors.includes('water_level_pct') || device?.status === 'absent') {
      issues.push({ id: 'water_sensor_absent', alert: 'setup_water_sensor', title: 'Tank sensor not answering', detail: `No tank level sensor is answering${device?.detail ? ` (${device.detail})` : ''}, so the unit can't tell when the tank runs low.`, fix: 'Check the level sensor\'s cable; Sensors lists it.' })
    }
    else if (reading?.quality === 'suspect') {
      issues.push({ id: 'water_sensor_suspect', alert: 'setup_water_sensor', title: 'Tank level suspect', detail: 'The tank level reads suspect: fewer than half its samples answered, so top-offs aren\'t advised from it.', fix: 'Check nothing blocks the level sensor and its cable is seated; Sensors shows the reading.' })
    }
  }
  const summary = issues.length
    ? issues.map(i => i.title).join(' · ')
    : planted ? `${pods(planted)} planted · light and pump schedules on` : 'Nothing planted yet'
  return { planted, issues, summary }
}
