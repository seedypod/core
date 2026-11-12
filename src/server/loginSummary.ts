/**
 * The facts the SSH login screen shows beside the logo, in one flat object so
 * scripts/login-logo/login-stats can pick them out of the JSON with a regex. Ages
 * come pre-computed in seconds: the script has no date parser, and a Pi Zero W
 * can't afford to start one at every login.
 */
import { z } from 'zod'
import type { Context } from './context'
import { SENSOR_STALE_MS } from './checks'

export const LoginSummary = z.object({
  /** What core runs, which a web update changes without touching the version file scripts/install wrote. */
  coreVersion: z.string(),
  unitId: z.string().nullable(),
  model: z.string().nullable(),
  halOnline: z.boolean(),
  lightOn: z.boolean().nullable(),
  lightLevel: z.number().nullable(),
  lightFault: z.boolean(),
  pumpOn: z.boolean().nullable(),
  pumpRemainingS: z.number().nullable(),
  pumpFault: z.boolean(),
  tankPct: z.number().nullable(),
  airC: z.number().nullable(),
  humidityPct: z.number().nullable(),
  boardC: z.number().nullable(),
  /** Seconds since the newest sensor reading. */
  readingAgeS: z.number().nullable(),
  /** Expected sensors with no good reading in SENSOR_STALE_MS, as System › Status counts them. */
  staleSensors: z.number(),
  activeAlerts: z.number(),
  /** Seconds since the newest still from either camera. */
  captureAgeS: z.number().nullable(),
  /** Where the learned pod-state models run: natively in podvision (#191), or in TypeScript when it isn't installed. */
  visionRunner: z.enum(['podvision', 'typescript']),
  /** podvision failed on the last still it was given, which then ran in TypeScript. */
  visionFallback: z.boolean(),
  /** Enabled pod-state model revisions with weights to run; null where core keeps no registry. */
  podStateModels: z.number().nullable(),
  /** The last update check (ADR 0026), which only runs when someone asks; null where the update helper isn't installed. */
  updateState: z.enum(['unchecked', 'current', 'available']).nullable(),
  /** What the channel had at that check, when it's newer than core: a vX.Y.Z tag, or dev@commit for dev-latest. */
  updateTo: z.string().nullable(),
  /** Seconds since that check. */
  updateCheckedAgeS: z.number().nullable(),
})
export type LoginSummary = z.infer<typeof LoginSummary>

const round1 = (v: number | undefined) => v === undefined ? null : Math.round(v * 10) / 10
const ageS = (ms: number | undefined, now: number) => ms === undefined || Number.isNaN(ms) ? null : Math.max(0, Math.round((now - ms) / 1000))

export function loginSummary(ctx: Context): LoginSummary {
  const now = (ctx.now?.() ?? new Date()).getTime()
  const snap = ctx.hal.snapshot()
  const { light, pump } = snap.actuators
  const s = snap.sensors
  const times = Object.values(s).map(r => Date.parse(r.ts))
  const capture = ctx.store.captures.list(undefined, 1)[0]
  const stale = (snap.system?.caps.sensors ?? []).filter((id) => {
    const r = s[id]
    return !r || r.quality !== 'good' || now - Date.parse(r.ts) > SENSOR_STALE_MS
  })
  const check = ctx.update?.available ? ctx.update.lastCheck() : null
  return {
    coreVersion: ctx.version,
    unitId: snap.system?.unitId ?? null,
    model: snap.system?.model ?? null,
    halOnline: snap.online,
    lightOn: light?.on ?? null,
    lightLevel: light ? light.level : null,
    lightFault: !!light?.fault,
    pumpOn: pump?.on ?? null,
    pumpRemainingS: pump?.remainingS ?? null,
    pumpFault: !!pump?.fault,
    tankPct: round1(s.water_level_pct?.value),
    airC: round1(s.air_temp?.value),
    humidityPct: round1(s.humidity?.value),
    boardC: round1(s.pcb_temp?.value),
    readingAgeS: ageS(times.length ? Math.max(...times) : undefined, now),
    staleSensors: stale.length,
    activeAlerts: ctx.store.alerts.list({ activeOnly: true }).length,
    captureAgeS: ageS(capture && Date.parse(capture.ts), now),
    visionRunner: ctx.podvision ? 'podvision' : 'typescript',
    visionFallback: !!ctx.podvision?.lastError(),
    podStateModels: ctx.models ? ctx.models.specs().filter(s => s.text !== null).length : null,
    updateState: !ctx.update?.available ? null : !check ? 'unchecked' : check.updateAvailable ? 'available' : 'current',
    updateTo: check?.updateAvailable ? (check.available.tag === 'dev-latest' ? `dev@${check.available.commit.slice(0, 7)}` : check.available.tag) : null,
    updateCheckedAgeS: check ? ageS(Date.parse(check.at), now) : null,
  }
}
