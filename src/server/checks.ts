/**
 * System › Status: one line per part of the unit, each ok, idle (off or not
 * on this host), stalled (running but behind) or down. Read-only: it looks at
 * what the HAL, the store and the services already report.
 */
import { z } from 'zod'
import { bridgeStatus } from '../mqtt/bridge'
import type { Context } from './context'
import { HUB_ALERT, LINK_ALERT } from '../camera/linkHealth'
import { setupReport } from '../care/setup'

export const CheckState = z.enum(['ok', 'idle', 'stalled', 'down'])
export type CheckState = z.infer<typeof CheckState>

export const Check = z.object({
  id: z.string(),
  label: z.string(),
  state: CheckState,
  detail: z.string(),
  /** When the check entered this state, where that is known. */
  since: z.string().nullable(),
})
export type Check = z.infer<typeof Check>

const MIN = 60_000
/** A reading older than this counts as stale. */
export const SENSOR_STALE_MS = 15 * MIN
/** Autopilot ticks every minute; five missed ticks is behind. */
export const AUTOPILOT_STALE_MS = 5 * MIN
/** Free space below these fractions of the disk is stalled, then down. */
const DISK_LOW = 0.15
const DISK_FULL = 0.05

export function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

const ago = (iso: string, now: number) => {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / MIN))
  return min < 1 ? 'just now' : min < 120 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`
}

export async function systemChecks(ctx: Context): Promise<Check[]> {
  const now = (ctx.now?.() ?? new Date()).getTime()
  const snap = ctx.hal.snapshot()
  const settings = ctx.store.settings.get()
  const alerts = new Map(ctx.store.alerts.list({ activeOnly: true }).map(a => [a.kind, a]))
  const raised = (kind: string) => alerts.get(kind)?.raisedAt ?? null
  const caps = snap.system?.caps
  const checks: Check[] = []
  const add = (id: string, label: string, state: CheckState, detail: string, since: string | null = null) => checks.push({ id, label, state, detail, since })

  add('hal', 'Hardware daemon', snap.online ? 'ok' : 'down', snap.online ? (snap.system ? `${snap.system.model} · hald ${snap.system.halVersion}` : 'Online') : 'Not answering', snap.online ? null : raised('hal_offline'))

  const expected = caps?.sensors ?? []
  const stale = expected.filter((id) => {
    const r = snap.sensors[id]
    return !r || r.quality !== 'good' || now - Date.parse(r.ts) > SENSOR_STALE_MS
  })
  const oldest = expected.map(id => snap.sensors[id]?.ts).filter((t): t is string => !!t).sort()[0] ?? null
  if (!snap.online || !expected.length) add('sensors', 'Sensors', 'down', snap.online ? 'No sensors configured' : 'No readings while the daemon is offline')
  else if (stale.length === expected.length) add('sensors', 'Sensors', 'down', 'No fresh readings', oldest)
  else if (stale.length) add('sensors', 'Sensors', 'stalled', `${expected.length - stale.length} of ${expected.length} reporting · ${stale.join(', ')} stale`, oldest)
  else add('sensors', 'Sensors', 'ok', `${expected.length} of ${expected.length} reporting`)

  for (const [id, label] of [['light', 'Light'], ['pump', 'Pump']] as const) {
    const a = snap.actuators[id]
    if (!a) add(id, label, snap.online ? 'idle' : 'down', snap.online ? 'Not on this unit' : 'Unknown while the daemon is offline')
    else if (a.fault) add(id, label, 'down', a.fault, raised(`${id}_fault`))
    else if (id === 'light') add(id, label, 'ok', a.on ? `On · ${a.level}%` : 'Off', a.since)
    else add(id, label, 'ok', a.on ? `Running${a.remainingS ? ` · ${a.remainingS} s left` : ''}` : 'Resting', a.since)
  }

  // What a planted unit is missing (ADR-0029): schedules, and a tank sensor to trust.
  const setup = setupReport(ctx.store, snap)
  add('setup', 'Setup', setup.issues.length ? 'stalled' : 'ok', setup.summary)

  const cameras = caps?.cameras ?? []
  const last = ctx.store.captures.list(undefined, 1)[0]
  const link = [...Object.values(LINK_ALERT), HUB_ALERT].map(k => alerts.get(k)).find(a => a)
  if (raised('camera_missing')) add('cameras', 'Cameras', 'down', alerts.get('camera_missing')?.detail ?? 'Not capturing', raised('camera_missing'))
  else if (link) add('cameras', 'Cameras', 'stalled', link.detail, link.raisedAt)
  else if (!cameras.length) add('cameras', 'Cameras', 'idle', 'No cameras on this unit')
  else if (settings.captureIntervalMin <= 0) add('cameras', 'Cameras', 'idle', 'Periodic photos off', last?.ts ?? null)
  else if (!last) add('cameras', 'Cameras', 'stalled', 'No photos yet')
  else if (now - Date.parse(last.ts) > 2 * settings.captureIntervalMin * MIN) add('cameras', 'Cameras', 'stalled', `Last photo ${ago(last.ts, now)}`, last.ts)
  else add('cameras', 'Cameras', 'ok', `${cameras.length} camera${cameras.length === 1 ? '' : 's'} · last photo ${ago(last.ts, now)}`, last.ts)

  const ap = ctx.autopilot.status()
  if (!ap.enabled) add('autopilot', 'Autopilot', 'idle', 'Off')
  else if (!ap.lastTickAt) add('autopilot', 'Autopilot', 'stalled', 'Has not run yet')
  else if (now - Date.parse(ap.lastTickAt) > AUTOPILOT_STALE_MS) add('autopilot', 'Autopilot', 'stalled', `Last ran ${ago(ap.lastTickAt, now)}`, ap.lastTickAt)
  else add('autopilot', 'Autopilot', 'ok', `${ap.rules.length} rule${ap.rules.length === 1 ? '' : 's'} · ran ${ago(ap.lastTickAt, now)}`)

  const wifi = await ctx.wifi.status()
  if (!wifi.available) add('network', 'Wi-Fi', 'idle', 'Not managed on this host')
  else if (wifi.mode === 'setup') add('network', 'Wi-Fi', 'stalled', wifi.setup ? `Setup hotspot ${wifi.setup.ssid} up` : 'Setup hotspot up')
  else if (wifi.mode === 'offline') add('network', 'Wi-Fi', 'down', wifi.lastError ?? 'Not connected')
  else add('network', 'Wi-Fi', 'ok', [wifi.ssid, wifi.ip].filter(Boolean).join(' · ') || 'Connected')

  const flash = ctx.flash.status()
  if (flash.freeBytes === null || flash.usedBytes === null) add('storage', 'Storage', 'idle', 'Not measured on this host')
  else {
    const total = flash.freeBytes + flash.usedBytes
    const free = total > 0 ? flash.freeBytes / total : 0
    add('storage', 'Storage', free < DISK_FULL ? 'down' : free < DISK_LOW ? 'stalled' : 'ok', `${bytes(flash.freeBytes)} free of ${bytes(total)}`)
  }

  if (!ctx.backup) add('backup', 'Backups', 'idle', 'Not on this host')
  else {
    const b = ctx.backup.status()
    const at = b.lastSuccess?.ts ?? null
    if (!at) add('backup', 'Backups', 'stalled', 'No backup yet')
    else add('backup', 'Backups', b.stale ? 'stalled' : 'ok', `Last ${ago(at, now)}${b.nightly.enabled ? ' · nightly on' : ''}`, at)
  }

  const m = ctx.mirror?.status()
  if (!m?.enabled) add('mirror', 'Off-device copy', 'idle', m ? 'Off' : 'Not on this host')
  else if (raised('mirror_failed')) add('mirror', 'Off-device copy', 'down', m.lastError ?? 'Copy failed', raised('mirror_failed'))
  else add('mirror', 'Off-device copy', 'ok', `${m.uploaded} copied${m.pending ? ` · ${m.pending} pending` : ''}`, m.lastUploadAt)

  const hk = await ctx.homekit?.status()
  if (!hk?.enabled) add('homekit', 'HomeKit', 'idle', hk ? 'Off' : 'Not on this host')
  else if (hk.transitioning) add('homekit', 'HomeKit', 'stalled', 'Starting')
  else if (!hk.running) add('homekit', 'HomeKit', 'down', hk.error ?? 'Not running')
  else add('homekit', 'HomeKit', 'ok', `${hk.pairedControllers} paired`)

  const ha = ctx.bridge?.() ?? bridgeStatus(settings.mqttUrl, null, null)
  if (ha.state === 'off') add('bridge', 'Home Assistant', 'idle', 'No broker set')
  else if (ha.state === 'connected') add('bridge', 'Home Assistant', 'ok', ha.broker ?? 'Connected', ha.since)
  else add('bridge', 'Home Assistant', 'down', ha.error ?? `Not connected to ${ha.broker ?? 'the broker'}`, ha.since)

  return checks
}
