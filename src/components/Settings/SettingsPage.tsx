import { Link } from '@tanstack/react-router'
import type { LucideIcon } from 'lucide-react'
import { Archive, BellRing, Camera, ChevronDown, Cloud, CloudUpload, Download, Droplets, HardDrive, House, Info, KeyRound, Radio, Ruler, Settings2, Wifi } from 'lucide-react'
import { useEffect, useState } from 'react'
import { RestorePanel, RestoreProgress } from '@/src/components/Backup/RestorePanel'
import { Button, KeyValue } from '@/src/components/ds/core'
import { Alert } from '@/src/components/ds/feedback'
import { SegmentedControl, Stepper, TextField, Toggle } from '@/src/components/ds/forms'
import { SubNav } from '@/src/components/ds/layout'
import { HomeKitSection } from '@/src/components/Settings/HomeKitSection'
import { Row, Section } from '@/src/components/Settings/Section'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@/src/server/routers/app'
import { apiBase, trpc } from '@/src/utils/trpc'

type SettingsView = inferRouterOutputs<AppRouter>['settings']['get']
type GrowView = inferRouterOutputs<AppRouter>['grow']['current']

type SectionId = 'unit' | 'tank' | 'reminders' | 'cameras' | 'api' | 'off-device' | 'storage' | 'backup' | 'home-assistant' | 'homekit' | 'wifi' | 'about'

/** In-page nav, in page order. Anchors are what ⌘K search links to. */
const SECTIONS: ReadonlyArray<{ id: SectionId, label: string, icon: LucideIcon }> = [
  { id: 'unit', label: 'Unit', icon: Settings2 },
  { id: 'tank', label: 'Tank', icon: Droplets },
  { id: 'reminders', label: 'Reminders', icon: BellRing },
  { id: 'cameras', label: 'Cameras', icon: Camera },
  { id: 'api', label: 'API access', icon: KeyRound },
  { id: 'off-device', label: 'Storage', icon: Cloud },
  { id: 'storage', label: 'SD card', icon: HardDrive },
  { id: 'backup', label: 'Backup', icon: Archive },
  { id: 'home-assistant', label: 'Home Assistant', icon: Radio },
  { id: 'homekit', label: 'Apple Home', icon: House },
  { id: 'wifi', label: 'Wi-Fi', icon: Wifi },
  { id: 'about', label: 'About', icon: Info },
]

export function SettingsPage() {
  const utils = trpc.useUtils()
  const q = trpc.settings.get.useQuery()
  const info = trpc.system.info.useQuery()
  const update = trpc.settings.update.useMutation({ onSuccess: () => utils.settings.invalidate() })
  const loaded = !!q.data
  // `/settings#backup` (from ⌘K search) scrolls to that card once the page has drawn.
  useEffect(() => {
    if (!loaded || !window.location.hash) return
    const t = setTimeout(() => document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView({ block: 'start' }), 50)
    return () => clearTimeout(t)
  }, [loaded])
  if (!q.data) return null
  return <SettingsForm key={q.data.updatedAt} s={q.data} coreVersion={info.data?.coreVersion} coreHost={info.data?.coreHost ?? undefined} system={info.data?.system ?? null} onSave={patch => update.mutate(patch)} saving={update.isPending} />
}

/** The section nearest the top of the viewport, for the nav highlight. */
function useActiveSection(): [SectionId, (id: SectionId) => void] {
  const [active, setActive] = useState<SectionId>('unit')
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const visible = new Set<string>()
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target.id)
        else visible.delete(e.target.id)
      }
      const first = SECTIONS.find(s => visible.has(s.id))
      if (first) setActive(first.id)
    }, { rootMargin: '0px 0px -65% 0px' })
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id)
      if (el) io.observe(el)
    }
    return () => io.disconnect()
  }, [])
  const go = (id: SectionId) => {
    setActive(id)
    document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    history.replaceState(null, '', `#${id}`)
  }
  return [active, go]
}

const stepper = 'border-line bg-field [&>span]:min-w-16 [&>span]:font-medium [&>span]:text-[13px]'

function timezones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  return all.includes(current) ? all : [current, ...all]
}

function SettingsForm({ s, coreVersion, coreHost, system, onSave, saving }: {
  s: SettingsView
  coreVersion?: string
  coreHost?: { hostname: string, arch: string }
  system: { halVersion: string, model: string, unitId: string, board?: string } | null
  onSave: (patch: Record<string, unknown>) => void
  saving: boolean
}) {
  // Keyed on updatedAt by the parent, so a fresh server value resets the draft without an effect.
  const [d, setD] = useState<Record<string, unknown>>({ ...s })
  const num = (k: string, fallback: number) => Number(d[k] ?? fallback)
  const str = (k: string) => String(d[k] ?? '')
  const save = () => {
    const rest: Record<string, unknown> = { ...d }
    delete rest.hasApiKey
    delete rest.hasMqttPassword
    delete rest.hasAnalysisIngestToken
    delete rest.hasMirrorSecret
    delete rest.updatedAt
    onSave(rest)
  }
  const original = s as Record<string, unknown>
  const changed = Object.keys(d).filter(k => JSON.stringify(d[k]) !== JSON.stringify(original[k])).length
  const [generated, setGenerated] = useState<{ api: boolean, ingest: boolean }>({ api: false, ingest: false })
  const [active, go] = useActiveSection()
  const sensors = trpc.sensors.latest.useQuery(undefined, { refetchInterval: 30_000 })
  const grow = trpc.grow.current.useQuery()
  const distance = sensors.data?.water_distance?.value
  const level = sensors.data?.water_level_pct?.value
  const mirrorSaved = !!(s.mirrorEndpoint && s.mirrorBucket)
  const [bucketOpen, setBucketOpen] = useState(mirrorSaved)

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6 min-[900px]:pt-3">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-[240px] flex-1 flex-col gap-1">
          <h1 className="text-2xl font-semibold">Settings</h1>
          <span className="text-[13px] text-fg-2">{[s.unitName, system?.unitId].filter(Boolean).join(' · ')}</span>
        </div>
        {changed > 0 && <span className="text-xs text-fg-3" data-testid="unsaved">{`${changed} unsaved change${changed === 1 ? '' : 's'}`}</span>}
        <Button variant="primary" disabled={changed === 0 || saving} onClick={save}>Save</Button>
      </div>

      <div className="flex items-start gap-8">
        <SubNav items={SECTIONS} active={active} onSelect={go} className="sticky top-7 hidden text-[13px] min-[900px]:flex [&>button]:py-[7px] [&>button]:text-[13px]" />

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <Section id="unit" title="Unit">
            <Row label="Name"><TextField mono={false} className="w-60" value={str('unitName')} onChange={v => setD({ ...d, unitName: v })} /></Row>
            <Row label="Timezone" sub="Schedules run in this zone">
              <span className="relative inline-flex w-60">
                <select
                  aria-label="Timezone"
                  value={str('timezone')}
                  onChange={e => setD({ ...d, timezone: e.target.value })}
                  className="w-full cursor-pointer appearance-none rounded-ctl border border-line-2 bg-field py-[9px] pl-3 pr-8 font-mono text-xs text-fg outline-none focus:border-fg-3"
                >
                  {timezones(str('timezone')).map(z => <option key={z} value={z}>{z}</option>)}
                </select>
                <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-fg-2" />
              </span>
            </Row>
            <Row label="Temperature unit"><SegmentedControl size="sm" ariaLabel="Temperature unit" value={str('temperatureUnit') as 'C' | 'F'} options={[{ value: 'C', label: '°C' }, { value: 'F', label: '°F' }]} onChange={v => setD({ ...d, temperatureUnit: v })} /></Row>
          </Section>

          <Section id="tank" title="Tank" sub="Ultrasonic distance from the sensor to the water surface">
            <Row label="Full" sub="cm when just filled"><Stepper label="Full" className={stepper} value={num('waterFullCm', 5)} min={1} max={30} step={0.5} onChange={v => setD({ ...d, waterFullCm: v })} format={v => `${v} cm`} /></Row>
            <Row label="Empty" sub="cm when the pump would run dry"><Stepper label="Empty" className={stepper} value={num('waterEmptyCm', 20)} min={5} max={40} step={0.5} onChange={v => setD({ ...d, waterEmptyCm: v })} format={v => `${v} cm`} /></Row>
            <Row label="Capacity" sub="Used for litre estimates"><Stepper label="Capacity" className={stepper} value={num('tankCapacityL', 19)} min={1} max={60} step={1} onChange={v => setD({ ...d, tankCapacityL: v })} format={v => `${v} L`} /></Row>
            {distance !== undefined && (
              <div className="flex items-center gap-2.5 border-t border-line py-3 text-xs text-fg-2">
                <Ruler size={16} className="shrink-0" />
                <span className="flex-1" data-testid="tank-reading">{`Reading now: ${distance} cm${level !== undefined ? `, which is ${Math.round(level)}%` : ''}.`}</span>
                <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-xs text-fg hover:underline" onClick={() => setD({ ...d, waterFullCm: Math.min(30, Math.max(1, Math.round(distance * 2) / 2)) })}>Set as full</button>
              </div>
            )}
          </Section>

          <Reminders d={d} s={s} grow={grow.data} onChange={(k, v) => setD({ ...d, [k]: v })} />

          <Section id="cameras" title="Cameras">
            <Row label="Capture interval" sub="0 turns off timelapse"><Stepper label="Capture interval" className={stepper} value={num('captureIntervalMin', 60)} min={0} max={720} step={15} onChange={v => setD({ ...d, captureIntervalMin: v })} format={v => `${v} min`} /></Row>
            <Row label="Keep analysis masks" sub="About 115 kB per photo. Off saves SD card space."><Toggle label="Keep analysis masks" on={!!d.analysisArtifacts} onChange={v => setD({ ...d, analysisArtifacts: v })} /></Row>
          </Section>

          <Section id="api" title="API access" sub="Optional key for REST and MCP clients outside localhost">
            <Row
              label="API key"
              sub={generated.api ? 'Copy it now: it is hidden once saved' : s.hasApiKey ? 'Set. Clients off this network must send it.' : 'Not set. Only devices on your network can connect.'}
            >
              <TextField aria-label="API key" className="w-[180px]" type={generated.api ? 'text' : 'password'} value={str('apiKey')} onChange={v => setD({ ...d, apiKey: v })} placeholder={s.hasApiKey ? '••••••' : 'none'} />
              <Button
                aria-label="Generate API key"
                onClick={() => {
                  setGenerated({ ...generated, api: true })
                  setD({ ...d, apiKey: randomToken() })
                }}
              >
                Generate
              </Button>
            </Row>
            <Row
              label="Result ingest token"
              sub={generated.ingest ? 'Copy it now: it is hidden once saved' : s.hasAnalysisIngestToken ? 'set — remote workers can post results' : 'not set — POST /api/analyses/results is off'}
            >
              <TextField aria-label="Result ingest token" className="w-[180px]" type={generated.ingest ? 'text' : 'password'} value={str('analysisIngestToken')} onChange={v => setD({ ...d, analysisIngestToken: v })} placeholder="leave empty to disable" />
              <Button
                aria-label="Generate ingest token"
                onClick={() => {
                  setGenerated({ ...generated, ingest: true })
                  setD({ ...d, analysisIngestToken: randomToken() })
                }}
              >
                Generate
              </Button>
            </Row>
          </Section>

          <Section
            id="off-device"
            title="Off-device storage"
            sub={mirrorSaved ? `Copying photos to ${s.mirrorBucket}. Backups go there too.` : 'Off. Nothing leaves the unit until you connect an S3-compatible bucket (R2, MinIO, a NAS).'}
            right={!bucketOpen && <Button icon={CloudUpload} onClick={() => setBucketOpen(true)}>Connect bucket</Button>}
          >
            {bucketOpen && (
              <>
                <Row label="Mirror endpoint" sub="Any S3-compatible service: R2, MinIO, a NAS"><TextField className="w-60" value={str('mirrorEndpoint')} onChange={v => setD({ ...d, mirrorEndpoint: v || null })} placeholder="https://<account>.r2.cloudflarestorage.com" /></Row>
                <Row label="Bucket"><TextField className="w-60" value={str('mirrorBucket')} onChange={v => setD({ ...d, mirrorBucket: v || null })} placeholder="seedypod" /></Row>
                <Row label="Region"><TextField className="w-60" value={str('mirrorRegion')} onChange={v => setD({ ...d, mirrorRegion: v || 'auto' })} placeholder="auto" /></Row>
                <Row label="Key prefix" sub="Folder inside the bucket, e.g. kitchen/"><TextField className="w-60" value={str('mirrorPrefix')} onChange={v => setD({ ...d, mirrorPrefix: v })} /></Row>
                <Row label="Access key id"><TextField className="w-60" value={str('mirrorAccessKeyId')} onChange={v => setD({ ...d, mirrorAccessKeyId: v || null })} /></Row>
                <Row label="Secret access key" sub={s.hasMirrorSecret ? 'set' : 'not set'}><TextField className="w-60" type="password" value={str('mirrorSecretAccessKey')} onChange={v => setD({ ...d, mirrorSecretAccessKey: v || null })} placeholder="••••••" /></Row>
                <MirrorControls />
              </>
            )}
          </Section>

          <StorageCard />

          <BackupCard />

          <Section id="home-assistant" title="Home Assistant bridge" sub="Core-level MQTT bridge for grow events and services. The hardware daemon already publishes discovery for lights, pump and sensors.">
            <Row label="Broker URL"><TextField className="w-60" value={str('mqttUrl')} onChange={v => setD({ ...d, mqttUrl: v || null })} placeholder="mqtt://homeassistant.local:1883" /></Row>
            <Row label="Username"><TextField className="w-60" value={str('mqttUsername')} onChange={v => setD({ ...d, mqttUsername: v || null })} /></Row>
            <Row label="Password" sub={s.hasMqttPassword ? 'set' : 'not set'}><TextField className="w-60" type="password" value={str('mqttPassword')} onChange={v => setD({ ...d, mqttPassword: v || null })} placeholder="••••••" /></Row>
            <Row label="TLS"><Toggle label="TLS" on={!!d.mqttTlsEnabled} onChange={v => setD({ ...d, mqttTlsEnabled: v })} /></Row>
            <Row label="Allow self-signed" sub="Off by default (ADR-0013)"><Toggle label="Allow self-signed" on={!!d.mqttTlsInsecure} onChange={v => setD({ ...d, mqttTlsInsecure: v })} /></Row>
          </Section>

          <HomeKitSection />

          <Section id="wifi" title="Wi-Fi" sub="Hold the unit's button for 10 s to open a setup hotspot" right={<Link to="/wifi" className="text-[13px] text-fg underline-offset-2 hover:underline">Change network</Link>} />

          <section id="about" aria-label="About" className="grid scroll-mt-7 grid-cols-2 gap-4 min-[600px]:grid-cols-3 rounded-[14px] border border-line bg-surface px-5 py-[18px]">
            <About label="Core" value={coreVersion ?? '…'} />
            <About label="Hardware daemon" value={system ? `${system.halVersion} · ${system.model}` : 'offline'} />
            <About label="Unit id" value={system?.unitId ?? '—'} />
            <About label="Board" value={system?.board ?? '—'} />
            <About label="Core runs on" value={coreHost ? `${coreHost.hostname} (${coreHost.arch})` : '…'} />
          </section>
        </div>
      </div>
    </div>
  )
}

function About({ label, value }: { label: string, value: string }) {
  return <KeyValue label={label} value={value} size={13} className="flex flex-col gap-[3px] [&>div:first-child]:text-fg-3" valueClassName="whitespace-normal break-words font-medium" />
}

const REMINDERS = [
  { key: 'thinningReminderDays', kind: 'reminder_thinning', label: 'Thinning', max: 60, fallback: 14 },
  { key: 'rootCheckReminderDays', kind: 'reminder_root_check', label: 'Root check', max: 90, fallback: 21 },
  { key: 'harvestReminderDays', kind: 'reminder_harvest', label: 'Harvest', max: 120, fallback: 35 },
] as const

const DAY_MS = 86_400_000
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** Where a one-shot reminder stands in the current cycle. */
function reminderHint(days: number, savedDays: number, issued: boolean, day: number | null): string | undefined {
  if (issued) return `Sent · day ${savedDays}`
  if (days === 0) return 'Off'
  if (day === null) return undefined
  if (day >= days) return 'Due now'
  return `In ${plural(days - day, 'day')}`
}

/** Next day a recurring nutrient reminder fires, from the cycle start. */
function nextNutrients(startedAt: string, day: number, every: number): Date {
  return new Date(new Date(startedAt).getTime() + (Math.floor(day / every) + 1) * every * DAY_MS)
}

function Reminders({ d, s, grow, onChange }: {
  d: Record<string, unknown>
  s: SettingsView
  grow?: GrowView
  onChange: (key: string, v: number) => void
}) {
  const val = (k: string, fallback: number) => Number(d[k] ?? fallback)
  const cycle = grow?.cycle ?? null
  const day = cycle ? grow?.day ?? null : null
  const rows = REMINDERS.map(r => ({ ...r, days: val(r.key, r.fallback) }))
  // Span the timeline a little past the last reminder (or today), in 5-day steps.
  const span = Math.max(5, Math.ceil(Math.max(day ?? 0, ...rows.map(r => r.days)) * 8 / 7 / 5) * 5)
  const at = (n: number) => `${Math.min(100, (n / span) * 100)}%`
  const every = val('nutrientReminderDays', 7)
  const nutrientSub = every === 0
    ? 'Off'
    : cycle && day !== null
      ? `Recurring · next ${nextNutrients(cycle.startedAt, day, every).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
      : 'Recurring'
  return (
    <Section id="reminders" title="Grow reminders" sub="Days after a cycle starts. 0 turns a reminder off.">
      {day !== null && (
        <div className="pb-2" data-testid="reminder-timeline">
          <div className="relative mb-1 mt-1.5 h-1.5">
            <div className="absolute inset-x-0 top-0.5 h-0.5 bg-line" />
            {rows.filter(r => r.days > 0).map(r => (
              <div key={r.key} title={`${r.label} · day ${r.days}`} className="absolute -top-[3px] -ml-1.5 box-border size-3 rounded-full border-2 border-meter bg-surface" style={{ left: at(r.days) }} />
            ))}
            <div className="absolute -top-1.5 h-[18px] w-0.5 bg-ok" style={{ left: at(day) }} />
          </div>
          <div className="relative flex h-3.5 justify-between font-mono text-[10px] text-fg-3">
            <span>day 0</span>
            <span className="absolute -translate-x-1/2 whitespace-nowrap text-ok" style={{ left: at(day) }}>{`today · ${day}`}</span>
            <span>{span}</span>
          </div>
        </div>
      )}
      {rows.map(r => (
        <Row key={r.key} label={r.label} sub={reminderHint(r.days, Number((s as Record<string, unknown>)[r.key] ?? r.fallback), !!cycle?.issued.includes(r.kind), day)}>
          <Stepper label={r.label} className={stepper} value={r.days} min={0} max={r.max} onChange={v => onChange(r.key, v)} format={v => `${v} d`} />
        </Row>
      ))}
      <Row label="Nutrients" sub={nutrientSub}>
        <Stepper label="Nutrients" className={stepper} value={every} min={0} max={30} onChange={v => onChange('nutrientReminderDays', v)} format={v => `every ${v} d`} />
      </Row>
    </Section>
  )
}

function randomToken(): string {
  const b = new Uint8Array(24)
  crypto.getRandomValues(b)
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
}

const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(b < 1e10 ? 2 : 1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB` : `${Math.round(b / 1e3)} kB`)

function since(s: number): string {
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`
  if (s < 2 * 86400) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86400)} days`
}

/** SD card writes (ADR-0021): how fast this unit wears its card. */
function StorageCard() {
  const q = trpc.storage.flash.useQuery(undefined, { refetchInterval: 60_000 })
  return (
    <Section id="storage" title="SD card" sub="How much this unit writes to its SD card. Logs and swap stay in RAM to keep it low.">
      {q.data && <FlashRows f={q.data} />}
    </Section>
  )
}

function FlashRows({ f }: { f: inferRouterOutputs<AppRouter>['storage']['flash'] }) {
  if (!f.available) return <Row label="Flash writes" sub="No SD card counter on this machine"><span className="text-sm text-fg-2">—</span></Row>
  return (
    <>
      <Row label="Flash writes" sub={f.basis === 'history' ? `${Math.round(f.windowDays ?? 0)}-day average` : `average since boot (${since(f.uptimeS ?? 0)} ago)`}>
        <span className="font-mono text-sm" data-testid="flash-rate">{f.bytesPerDay === null ? '—' : `${size(f.bytesPerDay)}/day`}</span>
      </Row>
      <Row label="Written since boot"><span className="font-mono text-sm">{size(f.sinceBootBytes ?? 0)}</span></Row>
      <Row
        label="Card"
        sub={f.cardBytes && f.bytesPerDay !== null ? `At this rate, ${(f.bytesPerDay * 365 / f.cardBytes).toFixed(2)} full-card writes a year` : undefined}
      >
        <span className="font-mono text-sm">{`${f.device}${f.cardBytes ? ` · ${size(f.cardBytes)}` : ''}`}</span>
      </Row>
    </>
  )
}

const when = (ts: string) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** Off-card backups (ADR-0021): download any time, nightly to the mirror's bucket. */
function BackupCard() {
  const status = trpc.backup.status.useQuery(undefined, { refetchInterval: 30_000 })
  const run = trpc.backup.runNow.useMutation({ onSuccess: () => void status.refetch() })
  const info = trpc.backup.restoreInfo.useQuery()
  const [restoring, setRestoring] = useState<'restore' | 'undo' | null>(null)
  const undo = trpc.backup.undo.useMutation({ onSuccess: () => setRestoring('undo') })
  const [photos, setPhotos] = useState(false)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [confirmUndo, setConfirmUndo] = useState(false)
  const st = status.data
  const undoInfo = info.data?.undo
  if (!st?.available) {
    return <Section id="backup" title="Backup" sub="Backups are not available on this core." />
  }
  const last = st.lastSuccess
  const tried = st.lastBucketAttempt
  const nightlySub = st.nightly.enabled
    ? `After ${String(st.nightly.hour).padStart(2, '0')}:00, keeping the last ${st.nightly.keep}${tried && !tried.ok ? ` · last try failed: ${tried.detail}` : ''}`
    : 'Off. Set up the mirror under Off-device storage to back up every night.'
  return (
    <Section id="backup" tone={st.stale ? 'warn' : undefined} title="Backup" sub="A copy of this unit off its SD card, so a dead card is a quick swap: settings, schedules, grow cycle, pods, rules, probes, calibration and history.">
      <Row label="Last off-card backup" sub={st.stale ? `None for ${st.staleAfterDays} days or more` : last?.detail || undefined}>
        <span className="text-sm" data-testid="backup-last">{last ? `${when(last.ts)} · ${last.destination === 'bucket' ? 'bucket' : 'downloaded'}` : 'none yet'}</span>
      </Row>
      <Row label="Nightly to the bucket" sub={nightlySub}>
        <div className="flex flex-col items-end gap-1">
          <Button size="sm" disabled={!st.nightly.enabled || run.isPending} onClick={() => run.mutate()}>{run.isPending ? 'Backing up…' : 'Back up now'}</Button>
          {run.data && <span className={`text-xs ${run.data.ok ? 'text-fg-2' : 'text-danger'}`}>{run.data.ok ? `Uploaded ${size(run.data.bytes)}` : run.data.detail}</span>}
          {run.error && <span className="text-xs text-danger">{run.error.message}</span>}
        </div>
      </Row>
      <Row label="Include photos" sub="For downloads; the mirror already keeps them. Makes the file far larger."><Toggle label="Include photos in the download" on={photos} onChange={setPhotos} /></Row>
      <Row label="Download" sub="The file holds your bucket secret, MQTT password and HomeKit pairing keys. Keep it somewhere private.">
        <a href={`${apiBase()}/api/backup/download${photos ? '?photos=1' : ''}`} download className="inline-flex"><Button size="sm" icon={Download} tabIndex={-1}>Download backup</Button></a>
      </Row>
      <Row label="Restore" sub={info.data?.available === false ? 'Not installed on this core: run scripts/install on the unit' : 'Replace this unit with a backup, from a file or the bucket'}>
        <Button size="sm" disabled={!info.data?.available || restoreOpen} onClick={() => setRestoreOpen(true)}>Restore from a backup…</Button>
      </Row>
      {restoreOpen && !restoring && (
        <div className="py-3">
          <RestorePanel savedMirror={st.nightly.enabled} confirm onStarted={() => setRestoring('restore')} />
          <div className="mt-2"><Button size="sm" onClick={() => setRestoreOpen(false)}>Close</Button></div>
        </div>
      )}
      {undoInfo && (
        <Row
          label={undoInfo.undoneAt ? 'Redo restore' : 'Undo restore'}
          sub={undoInfo.undoneAt
            ? `You undid the restore of the backup from ${when(undoInfo.bundle.createdAt ?? undoInfo.restoredAt)}. This puts it back.`
            : `Restored the backup from ${when(undoInfo.bundle.createdAt ?? undoInfo.restoredAt)} on ${when(undoInfo.restoredAt)}. Undo puts back what it replaced.`}
        >
          <Button size="sm" disabled={undo.isPending || !!restoring} onClick={() => setConfirmUndo(true)}>{undoInfo.undoneAt ? 'Redo restore' : 'Undo restore'}</Button>
        </Row>
      )}
      {confirmUndo && !restoring && (
        <Alert
          tone="warn"
          className="mb-3"
          action={(
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  undo.mutate()
                  setConfirmUndo(false)
                }}
              >
                {undoInfo?.undoneAt ? 'Redo' : 'Undo'}
              </Button>
              <Button size="sm" onClick={() => setConfirmUndo(false)}>Cancel</Button>
            </div>
          )}
        >
          The unit restarts on the files it had before. Anything changed since is swapped out too, and comes back with another undo.
        </Alert>
      )}
      {undo.error && <span className="pb-3 text-xs text-danger">{undo.error.message}</span>}
      {restoring && <div className="pb-3 pt-3"><RestoreProgress undo={restoring === 'undo'} /></div>}
    </Section>
  )
}

/** Test and back-fill the mirror using the saved settings. */
function MirrorControls() {
  const status = trpc.storage.mirror.useQuery(undefined, { refetchInterval: 5000 })
  const test = trpc.storage.testMirror.useMutation()
  const sync = trpc.storage.syncMirror.useMutation({ onSuccess: () => void status.refetch() })
  const st = status.data
  if (!st?.available) return null
  return (
    <Row label="Mirror" sub={st.enabled ? `${st.uploaded} copied · ${st.pending} pending · ${st.failed} failed${st.lastError ? ` · ${st.lastError}` : ''}` : 'off — save an endpoint, bucket and keys to turn it on'}>
      <div className="flex flex-col items-end gap-1">
        <div className="flex gap-2">
          <Button size="sm" disabled={!st.enabled || test.isPending} onClick={() => test.mutate()}>{test.isPending ? 'Testing…' : 'Test'}</Button>
          <Button size="sm" disabled={!st.enabled || sync.isPending} onClick={() => sync.mutate()}>Copy existing photos</Button>
        </div>
        {test.data && <span className={`text-xs ${test.data.ok ? 'text-fg-2' : 'text-danger'}`}>{test.data.detail}</span>}
        {sync.data && <span className="text-xs text-fg-2">{`Queued ${sync.data.queued} files`}</span>}
        {sync.error && <span className="text-xs text-danger">{sync.error.message}</span>}
      </div>
    </Row>
  )
}
