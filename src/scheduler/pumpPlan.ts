/**
 * Starting points for watering, shared by the Water page and MCP. They are
 * ours: Gardyn doesn't publish its watering cadence (its Smart Watering adjusts
 * it to the plants), and after sowing Gardyn waits a few days to a week before
 * the second watering (see GARDYN_WATERING_GUIDE). Each preset becomes one
 * pump schedule per run time; minutes are the unit's local time.
 */

export const GARDYN_WATERING_GUIDE = 'https://help.mygardyn.com/en/articles/4435265'

export interface PumpPreset { id: string, name: string, description: string, minutes: number[], durationS: number }

export const PUMP_PRESETS: PumpPreset[] = [
  { id: 'twice-10', name: 'Twice a day · 10 min', description: '08:00 and 17:00, every day.', minutes: [480, 1020], durationS: 600 },
  { id: 'thrice-5', name: 'Three times a day · 5 min', description: '08:00, 13:00 and 18:00, every day.', minutes: [480, 780, 1080], durationS: 300 },
  { id: 'once-15', name: 'Once a day · 15 min', description: '08:00 every day.', minutes: [480], durationS: 900 },
]

const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

export interface PumpSchedule { id: string, kind: 'pump', name: string, enabled: boolean, days: number, spec: { minute: number, durationS: number } }

/** The pump schedules a preset makes, one per run time, every day: "Twice a day · 10 min (08:00)". */
export function presetSchedules(preset: PumpPreset, opts: { enabled: boolean, idPrefix: string }): PumpSchedule[] {
  return preset.minutes.map(minute => ({
    id: `${opts.idPrefix}-${minute}`,
    kind: 'pump',
    name: `${preset.name} (${hhmm(minute)})`,
    enabled: opts.enabled,
    days: 127,
    spec: { minute, durationS: preset.durationS },
  }))
}
