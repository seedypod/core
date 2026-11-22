/**
 * Outbound notifications (ADR-0032): which group an event is in, the request
 * each target expects, and the rules a target URL must pass.
 */
import { ALERT_LABEL } from '../lib/alertLabels'
import { UNREADABLE } from '../lib/waterLow'

export const NOTIFY_GROUPS = ['alerts', 'reminders', 'autopilot', 'watering', 'lights'] as const
export type NotifyGroup = typeof NOTIFY_GROUPS[number]
/** What a new unit sends: anything that needs the owner, nothing routine. */
export const DEFAULT_GROUPS: readonly NotifyGroup[] = ['alerts', 'reminders', 'autopilot']

export interface NotifyEvent {
  group: NotifyGroup | 'test'
  /** `raised`/`cleared` for alerts, `ran` for a pump run, `changed` for the light, `test` for Send test. */
  type: 'raised' | 'cleared' | 'ran' | 'changed' | 'test'
  title: string
  message: string
  priority: 'high' | 'default' | 'low'
  at: string
  data: Record<string, unknown>
}

export type NotifyConfig
  = | { target: 'ntfy', server: string, topic: string, unitName: string }
    | { target: 'webhook', url: string, format: 'json' | 'discord' | 'slack', secret: string | null, unitName: string }

export function groupOf(kind: string): NotifyGroup {
  if (kind.startsWith('reminder_') || kind.startsWith('chore_')) return 'reminders'
  if (kind.startsWith('autopilot_')) return 'autopilot'
  return 'alerts'
}

export function alertTitle(kind: string): string {
  const t = ALERT_LABEL[kind] ?? kind.replace(/_/g, ' ')
  return t.charAt(0).toUpperCase() + t.slice(1)
}

export function enabledGroups(saved: string[] | null): Set<NotifyGroup> {
  return new Set((saved ?? DEFAULT_GROUPS).filter((g): g is NotifyGroup => (NOTIFY_GROUPS as readonly string[]).includes(g)))
}

// Lowercase letters and digits without the ones people misread when typing it (0/o, 1/l/i).
const TOPIC_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'

/** A topic nobody guesses: ntfy.sh lets anyone who knows a topic read it. 12 characters ≈ 59 bits. */
export function newTopic(random: (n: number) => Uint8Array = n => crypto.getRandomValues(new Uint8Array(n))): string {
  return `seedypod-${Array.from(random(12), b => TOPIC_CHARS[b % TOPIC_CHARS.length]).join('')}`
}

function isLanHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true
  if (h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith('fe80:')) return true
  const m = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** Why a target URL is refused, or null: https anywhere, plain http only on the LAN. */
export function urlProblem(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  }
  catch {
    return 'That isn\'t a URL.'
  }
  if (u.protocol === 'https:') return null
  if (u.protocol !== 'http:') return 'The URL must start with https://.'
  return isLanHost(u.hostname) ? null : 'Use https:// for a server off your network, so the notifications are encrypted on the way.'
}

const FORMAT_NAME = { discord: 'Discord', slack: 'Slack' } as const

/** The format a Discord or Slack webhook URL only accepts, or null for any other server. Discord's `/slack` endpoint takes Slack's. */
export function formatFor(raw: string): 'discord' | 'slack' | null {
  let u: URL
  try {
    u = new URL(raw)
  }
  catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  if (/(^|\.)discord(app)?\.com$/.test(host) && u.pathname.startsWith('/api/webhooks/')) return /\/slack\/?$/.test(u.pathname) ? 'slack' : 'discord'
  if (host === 'hooks.slack.com') return 'slack'
  return null
}

/** Why a URL and format don't go together, or null. */
export function formatProblem(raw: string, format: 'json' | 'discord' | 'slack'): string | null {
  const want = formatFor(raw)
  return want && want !== format ? `That URL only takes ${FORMAT_NAME[want]} messages: pick ${FORMAT_NAME[want]} as the format.` : null
}

/** Enough of a webhook URL to recognise it; the rest is the secret (Discord and Slack put the token in the path). */
export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw)
    const rest = `${u.pathname}${u.search}`
    return rest.length <= 1 ? u.origin : `${u.origin}/…${rest.slice(-4)}`
  }
  catch {
    return '…'
  }
}

/** The `ntfy://` link the Android app subscribes from; iOS has no such link, so its owners type the topic. */
export function ntfyLink(server: string, topic: string, unitName: string): string {
  const u = new URL(server)
  const insecure = u.protocol === 'http:' ? '&secure=false' : ''
  return `ntfy://${u.host}${u.pathname.replace(/\/$/, '')}/${topic}?display=${encodeURIComponent(unitName)}${insecure}`
}

const NTFY_PRIORITY = { high: 4, default: 3, low: 2 } as const

type Emoji = readonly [char: string, shortcode: string]
const WARNING: Emoji = ['⚠️', 'warning']
const SEEDLING: Emoji = ['🌱', 'seedling']
const HARVEST: Emoji = ['🧺', 'basket']
const THIN: Emoji = ['✂️', 'scissors']
const FEED: Emoji = ['🥄', 'spoon']
const CAMERA: Emoji = ['📷', 'camera']
const SETUP: Emoji = ['🛠️', 'hammer_and_wrench']
const KIND_EMOJI: Record<string, Emoji> = {
  water_low: ['🚱', 'non-potable_water'], pump_fault: WARNING, dose_fault: ['🧪', 'test_tube'], over_temp: ['🌡️', 'thermometer'], hal_offline: ['🔌', 'electric_plug'], mirror_failed: ['☁️', 'cloud'],
  camera_missing: CAMERA, camera_link_upper: CAMERA, camera_link_lower: CAMERA, camera_hub_flaky: CAMERA,
  pump_schedule_missed: ['⏰', 'alarm_clock'], watering_followed: ['💧', 'droplet'], setup_light_schedule: SETUP, setup_pump_schedule: SETUP, setup_water_sensor: SETUP,
  reminder_thinning: THIN, chore_thin: THIN, reminder_harvest: HARVEST, reminder_first_harvest: HARVEST, reminder_nutrients: FEED, chore_feed: FEED,
  reminder_root_check: ['🔍', 'mag'], reminder_sow: SEEDLING, reminder_schedule_switch: ['🗓️', 'spiral_calendar'], chore_top_off: ['🚰', 'potable_water'],
}

/** The one emoji that leads an event's line: the character for Discord, Slack and JSON, the shortcode for ntfy's `tags`, which ntfy shows as that emoji. */
export function emojiFor(e: NotifyEvent): Emoji {
  if (e.type === 'cleared') return ['✅', 'white_check_mark']
  if (e.group === 'test') return ['🔔', 'bell']
  if (e.group === 'autopilot') return ['🤖', 'robot']
  if (e.group === 'watering') return e.data.endedBy === 'fault' ? WARNING : ['💧', 'droplet']
  if (e.data.kind === 'water_low' && e.data.detail === UNREADABLE) return ['📡', 'satellite']
  if (e.group === 'lights') return e.data.to === 0 ? ['🌙', 'crescent_moon'] : Number(e.data.to) < Number(e.data.from) ? ['🔅', 'low_brightness'] : ['💡', 'bulb']
  return KIND_EMOJI[String(e.data.kind)] ?? (e.group === 'reminders' ? SEEDLING : WARNING)
}

export interface OutboundRequest {
  url: string
  headers: Record<string, string>
  body: string
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('')
}

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return `sha256=${hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))}`
}

export async function buildRequest(c: NotifyConfig, e: NotifyEvent): Promise<OutboundRequest> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const [emoji, shortcode] = emojiFor(e)
  if (c.target === 'ntfy') {
    const body = JSON.stringify({ topic: c.topic, title: `${c.unitName}: ${e.title}`, message: e.message || e.title, priority: NTFY_PRIORITY[e.priority], tags: [shortcode] })
    return { url: `${c.server.replace(/\/$/, '')}/`, headers, body }
  }
  const line = `${emoji} ${e.message ? `${e.title}: ${e.message}` : e.title}`
  const body = c.format === 'discord'
    ? JSON.stringify({ username: c.unitName, content: `**${c.unitName}** · ${line}` })
    : c.format === 'slack'
      ? JSON.stringify({ text: `*${c.unitName}* · ${line}` })
      : JSON.stringify({ event: e.group === 'test' ? 'test' : `${e.group}.${e.type}`, at: e.at, unit: c.unitName, title: e.title, emoji, message: e.message, priority: e.priority, data: e.data })
  if (c.secret) headers['x-seedypod-signature'] = await sign(c.secret, body)
  return { url: c.url, headers, body }
}
