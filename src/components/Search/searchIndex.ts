/**
 * What ⌘K searches (after sleepypod's searchIndex): every page, the Settings
 * cards, and the unit's own pods and Autopilot rules, ranked with BM25.
 */
import type { LucideIcon } from 'lucide-react'
import { Archive, CloudUpload, Code, HardDrive, Info, KeyRound, Monitor, Radio, Ruler, Settings, Sprout, Timer, Camera, Wand2, Wifi } from 'lucide-react'
import { navItems } from '@/src/components/AppShell/navItems'
import { createBm25Index, tokenize } from '@/src/lib/bm25'

export interface SearchEntry {
  id: string
  title: string
  /** Parent pages, outermost first: ['Settings']. Empty for top-level pages. */
  crumbs: string[]
  description: string
  /** Space-separated synonyms. Searched, never shown. */
  keywords: string
  /** In-app path, with any query or hash. */
  href: string
  icon: LucideIcon
  /** Static rank multiplier. */
  boost?: number
}

/** Title outranks synonyms, which outrank prose. Breadcrumbs aren't indexed. */
export const SEARCH_FIELDS = {
  title: { weight: 3, b: 0.3 },
  keywords: { weight: 1.5, b: 0.5 },
  description: { weight: 1, b: 0.75 },
} as const

const PAGES: Record<string, { description: string, keywords: string }> = {
  '/': { description: 'The tower at a glance: light, water, air and alerts', keywords: 'dashboard overview status home tower 3d' },
  '/light': { description: 'Brightness, on and off, and the manual hold', keywords: 'grow light led lamp brightness dim hold' },
  '/water': { description: 'Tank level, pump runs and pump power', keywords: 'water tank reservoir pump level refill watering' },
  '/schedule': { description: 'Light curves and pump cycles', keywords: 'schedule timer curve sunrise sunset watering cycle program' },
  '/autopilot': { description: 'Rules that react to readings, with backtests', keywords: 'automation automations rules backtest dry run kill switch' },
  '/grow': { description: 'Grow cycle, stages, reminders and the 30 pods', keywords: 'grow cycle pods plants harvest seedling stage tower' },
  '/cameras': { description: 'Stills from both cameras and the timelapse', keywords: 'camera photo picture still timelapse capture' },
  '/analysis': { description: 'Growth per pod from the photos, analysers and dataset export', keywords: 'analysis vision green growth dataset export analyser analyzer' },
  '/alerts': { description: 'Faults and reminders, and acknowledging them', keywords: 'alerts faults warnings reminders acknowledge latch' },
  '/sensors': { description: 'Every sensor, adding probes and calibration', keywords: 'sensors probes ph ec temperature calibrate i2c ezo' },
  '/settings': { description: 'The unit, calibration, integrations and backups', keywords: 'settings preferences configuration options' },
}

/** The Settings cards, linked by their anchor on the page. */
const SETTINGS: ReadonlyArray<Omit<SearchEntry, 'crumbs' | 'href'> & { anchor: string }> = [
  { id: 'unit', anchor: 'unit', title: 'Unit', description: 'Name, timezone and temperature unit', keywords: 'name timezone time zone celsius fahrenheit degrees units', icon: Settings },
  { id: 'tank', anchor: 'tank', title: 'Tank calibration', description: 'Distance to the water when full and when empty, and the capacity', keywords: 'tank calibration full empty capacity litres liters distance ultrasonic water level', icon: Ruler },
  { id: 'reminders', anchor: 'reminders', title: 'Grow reminders', description: 'Days to thinning, root check, harvest and nutrients', keywords: 'reminders thinning root check harvest nutrients feed days', icon: Timer },
  { id: 'cameras', anchor: 'cameras', title: 'Capture interval', description: 'How often the cameras take a still, and analysis masks', keywords: 'camera capture interval timelapse masks artifacts photos', icon: Camera },
  { id: 'storage', anchor: 'storage', title: 'Storage', description: 'How much the unit writes to its SD card each day', keywords: 'sd card flash writes wear storage disk endurance', icon: HardDrive },
  { id: 'backup', anchor: 'backup', title: 'Backup', description: 'Download a backup, nightly backups to the bucket, restore and undo', keywords: 'backup restore download nightly bucket undo archive recovery card', icon: Archive },
  { id: 'ha', anchor: 'home-assistant', title: 'Home Assistant bridge', description: 'MQTT broker for grow events and services', keywords: 'home assistant hass mqtt broker tls integration', icon: Radio },
  { id: 'api', anchor: 'api', title: 'API key', description: 'A key for REST and MCP clients off the unit', keywords: 'api key token rest mcp auth authentication security', icon: KeyRound },
  { id: 'mirror', anchor: 'off-device', title: 'Off-device storage', description: 'Copy photos to an S3 bucket, and accept results from other machines', keywords: 'mirror s3 r2 minio bucket off-device cloud ingest token', icon: CloudUpload },
  { id: 'about', anchor: 'about', title: 'About', description: 'Core and hardware daemon versions, unit id', keywords: 'version core hald daemon unit id about', icon: Info },
]

export interface LiveData {
  pods?: ReadonlyArray<{ slot: number, plant: string | null, status: string, notes: string }>
  rules?: ReadonlyArray<{ id: number, name: string, enabled: boolean, dryRun: boolean }>
}

const STATUS: Record<string, string> = { seeded: 'Seeded', growing: 'Growing', harvest: 'Ready to harvest', attention: 'Needs attention', empty: 'Empty' }

export function buildSearchEntries(live: LiveData = {}): SearchEntry[] {
  const pages: SearchEntry[] = navItems.map(n => ({
    id: `page:${n.to}`,
    title: n.label,
    crumbs: [],
    description: PAGES[n.to]?.description ?? '',
    keywords: PAGES[n.to]?.keywords ?? '',
    href: n.to,
    icon: n.icon,
  }))
  const sub: SearchEntry[] = [
    { id: 'page:/wifi', title: 'Wi-Fi', crumbs: ['Settings'], description: 'Join a network, or open the setup hotspot', keywords: 'wifi wireless network hotspot ssid password join', href: '/wifi', icon: Wifi },
    { id: 'page:/kiosk', title: 'Kiosk', crumbs: [], description: 'Big numbers for a wall display', keywords: 'kiosk wall display fullscreen tablet', href: '/kiosk', icon: Monitor, boost: 0.8 },
    { id: 'page:/api/openapi.json', title: 'REST API', crumbs: ['Settings', 'API key'], description: 'The OpenAPI description of every endpoint', keywords: 'openapi swagger rest api endpoints docs', href: '/settings#api', icon: Code, boost: 0.7 },
  ]
  const settings: SearchEntry[] = SETTINGS.map(({ anchor, ...e }) => ({ ...e, id: `setting:${e.id}`, crumbs: ['Settings'], href: `/settings#${anchor}` }))
  const pods: SearchEntry[] = (live.pods ?? []).filter(p => p.plant).map(p => ({
    id: `pod:${p.slot}`,
    title: p.plant as string,
    crumbs: ['Grow', `Pod ${p.slot}`],
    description: `${STATUS[p.status] ?? p.status}${p.notes ? ` · ${p.notes}` : ''}`,
    keywords: `pod ${p.slot} plant ${p.status}`,
    href: `/grow?pod=${p.slot}`,
    icon: Sprout,
  }))
  const rules: SearchEntry[] = (live.rules ?? []).map(r => ({
    id: `rule:${r.id}`,
    title: r.name,
    crumbs: ['Autopilot'],
    description: !r.enabled ? 'Off' : r.dryRun ? 'Dry run' : 'Armed',
    keywords: 'rule automation',
    href: '/autopilot',
    icon: Wand2,
  }))
  return [...pages, ...sub, ...settings, ...pods, ...rules]
}

/** A search function over the entries; the empty query returns nothing. */
export function createSearch(entries: SearchEntry[]) {
  const index = createBm25Index(entries, SEARCH_FIELDS)
  return (query: string, limit?: number): SearchEntry[] =>
    tokenize(query).length === 0 ? [] : index.search(query, limit).map(h => entries[h.index] as SearchEntry)
}
