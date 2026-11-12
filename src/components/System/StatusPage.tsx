import { TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { alertActions, describeAlert } from '@/src/components/Alerts/AlertsPage'
import { apiBase, trpc } from '@/src/utils/trpc'
import { checkSummary, worstState } from './checkState'
import { StatusCards } from './StatusCards'
import { coreBuild, fmtAgo, fmtUptime, healthHeadline, wifiBars } from './statusData'
import { TodayTimeline } from './TodayTimeline'
import { useNow } from './useNow'

const MONO = 'font-mono text-[13px] text-fg'

/** System › Status: is the unit alive and doing what it should today. */
export function StatusPage() {
  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-5">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
          <div className="font-mono text-xs text-fg-3">System /</div>
          <h1 className="text-2xl font-semibold">Status</h1>
        </div>
        <LivePill />
      </div>
      <HealthStrip />
      <AlertCard />
      <TodayTimeline />
      <StatusCards />
    </div>
  )
}

/** How often hald's sensor readings arrive and how old the newest is, from the live event stream. */
export function useLiveReadings(paused: boolean): { hz: number | null, ageS: number | null } {
  const [live, setLive] = useState<{ newest: number | null, ticks: number[] }>({ newest: null, ticks: [] })
  const now = useNow(500)
  trpc.events.onChange.useSubscription(undefined, {
    onData(e) {
      if (paused || e.kind !== 'hal' || e.event.type !== 'sensor') return
      const ts = Date.parse(e.event.reading.ts)
      const t = Date.now()
      // A tick publishes every sensor in a burst: readings within 250 ms of the last one belong to the same tick.
      setLive(l => ({
        newest: Math.max(l.newest ?? ts, ts),
        ticks: l.ticks.length && t - (l.ticks.at(-1) as number) < 250 ? l.ticks : [...l.ticks.filter(b => t - b < 10_000), t],
      }))
    },
  })
  const recent = live.ticks.filter(b => now - b < 10_000)
  const first = recent[0]
  const last = recent.at(-1)
  const hz = first !== undefined && last !== undefined && last > first ? (recent.length - 1) / ((last - first) / 1000) : null
  const ageS = live.newest === null ? null : Math.max(0, (now - live.newest) / 1000)
  return { hz, ageS }
}

function LivePill() {
  const [paused, setPaused] = useState(false)
  const info = trpc.system.info.useQuery()
  const { hz, ageS } = useLiveReadings(paused)
  const sensors = info.data?.system?.caps.sensors.length
  return (
    <div className="flex flex-wrap items-center gap-3.5 rounded-[10px] border border-line py-[5px] pl-3 pr-[5px] font-mono text-xs text-fg-2" data-testid="live-pill">
      <span className={cn('flex items-center gap-1.5', paused ? 'text-fg-3' : 'text-pod-ok')}>
        <span className={cn('size-1.5 rounded-full', paused ? 'bg-fg-3' : 'bg-pod-ok')} />
        {paused ? 'PAUSED' : 'LIVE'}
      </span>
      <span>{hz === null ? '— Hz' : `${hz >= 1 ? Math.round(hz) : hz.toFixed(1)} Hz`}</span>
      {sensors !== undefined && <span>{`${sensors} sensor${sensors === 1 ? '' : 's'}`}</span>}
      <span>{`reading age ${ageS === null ? '—' : `${ageS < 10 ? ageS.toFixed(1) : Math.round(ageS)}s`}`}</span>
      <button type="button" onClick={() => setPaused(p => !p)} className="cursor-pointer rounded-md border border-line bg-transparent px-[9px] py-[3px] font-mono text-xs text-fg hover:bg-active">
        {paused ? 'Resume' : 'Pause'}
      </button>
    </div>
  )
}

function Stat({ label, children }: { label: string, children: ReactNode }) {
  return (
    <div className="flex flex-col gap-[5px]">
      <div>{label}</div>
      <div className={cn(MONO, 'flex items-center gap-1.5')}>{children}</div>
    </div>
  )
}

/** The ring of checks passing, the headline, then the unit's vitals in a row. */
function HealthStrip() {
  const checks = trpc.system.checks.useQuery(undefined, { refetchInterval: 30_000 })
  const info = trpc.system.info.useQuery()
  const settings = trpc.settings.get.useQuery()
  const wifi = trpc.network.status.useQuery(undefined, { refetchInterval: 60_000 })
  const scan = trpc.network.scan.useQuery(undefined, { refetchInterval: 60_000 })
  const bridge = trpc.system.bridge.useQuery(undefined, { refetchInterval: 30_000 })
  const flash = trpc.storage.flash.useQuery(undefined, { refetchInterval: 60_000 })
  const bootLog = trpc.system.bootLog.useQuery()
  const list = checks.data?.checks ?? []
  const summary = checkSummary(list)
  const worstKind = worstState(list)
  const worst = list.find(c => c.state === worstKind) ?? null
  const head = healthHeadline(settings.data?.unitName ?? 'seedypod', list, worst)
  const frac = summary ? summary.passing / summary.total : 0
  const C = 2 * Math.PI * 26
  const core = info.data ? coreBuild(info.data.coreVersion) : null
  const sys = info.data?.system
  const signal = (scan.data ?? []).find(n => n.inUse)?.signal ?? null
  const f = flash.data
  const total = f && f.usedBytes !== null && f.freeBytes !== null ? f.usedBytes + f.freeBytes : null
  const usedPct = total && f?.usedBytes != null ? Math.round((f.usedBytes / total) * 100) : null

  return (
    <section aria-label="Health" className="flex flex-wrap items-center gap-7 rounded-[14px] border border-line bg-surface px-[22px] py-[18px]">
      <div className="flex min-w-[240px] flex-1 items-center gap-3.5">
        <div className="relative size-[60px] shrink-0">
          <svg viewBox="0 0 60 60" className="size-[60px] -rotate-90" aria-hidden>
            <circle cx="30" cy="30" r="26" fill="none" stroke="var(--color-line)" strokeWidth="3.5" />
            {frac > 0 && <circle cx="30" cy="30" r="26" fill="none" stroke="var(--color-pod-ok)" strokeWidth="3.5" strokeLinecap="round" strokeDasharray={`${(frac * C).toFixed(1)} ${C.toFixed(1)}`} />}
          </svg>
          <div className="absolute inset-0 flex items-center justify-center font-mono text-xs font-medium" aria-label={summary ? `${summary.passing} of ${summary.total} checks passing` : undefined}>
            {summary ? `${summary.passing}/${summary.total}` : '—'}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-[3px]">
          <div className="text-base font-semibold">{head.title}</div>
          <div className="text-[13px] text-fg-2">{head.sub}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-[26px] text-xs text-fg-3">
        <Stat label="Core">
          {core?.build ?? '—'}
          {core && <span className="rounded border border-line px-[5px] text-[11px] text-fg-3">{core.channel}</span>}
        </Stat>
        {bootLog.data && (
          <Stat label="USB hub">
            {bootLog.data.hub ? `up on ${bootLog.data.hub.up} of the last ${bootLog.data.hub.of} boots` : `${bootLog.data.boots} boots logged`}
            <a href={`${apiBase()}/api/system/boot-log`} className="underline">Boot log</a>
          </Stat>
        )}
        <Stat label="Hardware">{info.data ? (info.data.halOnline && sys ? `hald ${sys.halVersion} · v${sys.contract}` : 'offline') : '—'}</Stat>
        <Stat label="Wi-Fi">
          {wifi.data?.available && wifi.data.mode === 'client'
            ? (
                <>
                  {signal !== null && (
                    <span className="flex h-3 items-end gap-0.5" aria-label={`Signal ${signal}%`}>
                      {[4, 7, 10, 12].map((h, i) => <span key={h} className={cn('w-[3px]', i < wifiBars(signal) ? 'bg-pod-ok' : 'bg-line-2')} style={{ height: h }} />)}
                    </span>
                  )}
                  {[wifi.data.ssid, signal !== null && `${signal}%`].filter(Boolean).join(' ')}
                </>
              )
            : wifi.data ? (wifi.data.available ? wifi.data.mode : 'not managed') : '—'}
        </Stat>
        <Stat label="Home Assistant">
          {bridge.data
            ? (
                <>
                  <span className={cn('size-1.5 rounded-full', bridge.data.state === 'connected' ? 'bg-pod-ok' : bridge.data.state === 'off' ? 'bg-fg-3' : 'bg-pod-attention')} />
                  {bridge.data.state === 'connected' ? 'bridged' : bridge.data.state === 'off' ? 'off' : 'error'}
                </>
              )
            : '—'}
        </Stat>
        <Stat label="SD card">
          {usedPct === null
            ? '—'
            : (
                <>
                  <span className="h-1 w-9 rounded-sm bg-line" role="meter" aria-label="SD card used" aria-valuenow={usedPct} aria-valuemin={0} aria-valuemax={100}>
                    <span className="block h-full rounded-sm bg-meter" style={{ width: `${usedPct}%` }} />
                  </span>
                  {`${usedPct}%`}
                </>
              )}
        </Stat>
        {f?.uptimeS != null && <Stat label="Uptime">{fmtUptime(f.uptimeS)}</Stat>}
      </div>
    </section>
  )
}

/** "Camera alert", "Pump alert": the card's title from the first alert's kind. */
export function alertTitle(kinds: string[]): string {
  if (kinds.length > 1) return `${kinds.length} alerts`
  const k = kinds[0] ?? ''
  if (k.startsWith('reminder_')) return 'Reminder'
  const word = k.split('_')[0] ?? ''
  return `${word.charAt(0).toUpperCase()}${word.slice(1)} alert`
}

/** Where the alert comes from: the camera, the actuator, hald, Grow or core. */
export function alertSource(kind: string, detail: string): string {
  const cam = /^(upper|lower) camera/.exec(detail)
  if (kind === 'camera_missing' && cam) return cam[1] as string
  if (kind.startsWith('camera_link_')) return kind.slice('camera_link_'.length)
  if (kind === 'camera_hub_flaky') return 'usb hub'
  if (kind.endsWith('_fault')) return kind.slice(0, -'_fault'.length)
  if (['water_low', 'over_temp', 'hal_offline'].includes(kind)) return 'hald'
  if (kind.startsWith('reminder_')) return 'grow'
  return 'core'
}

const LATCHED = new Set(['water_low', 'pump_fault', 'dose_fault', 'over_temp', 'camera_missing', 'light_fault'])

/** Active alerts with an Acknowledge each; hidden when nothing is open. */
function AlertCard() {
  const utils = trpc.useUtils()
  const alerts = trpc.alerts.list.useQuery({ activeOnly: true })
  const ack = trpc.alerts.acknowledge.useMutation({
    onSuccess: () => {
      void utils.alerts.invalidate()
      void utils.system.invalidate()
    },
  })
  const now = useNow(60_000)
  const open = (alerts.data ?? []).filter(a => a.active)
  const first = open[0]
  if (!first) return null
  const { detail } = describeAlert(first)
  return (
    <section aria-label="Alerts" className="flex flex-col gap-3 rounded-[14px] border border-pod-attention/35 bg-surface px-[22px] py-[18px]">
      <div className="flex items-center gap-2.5 text-pod-attention">
        <TriangleAlert size={16} />
        <h2 className="text-[15px] font-semibold text-fg">{alertTitle([...new Set(open.map(a => a.kind))])}</h2>
      </div>
      {open.map(a => (
        <div key={a.id} className="flex items-center gap-2.5 border-t border-line pt-3 font-mono text-[13px]">
          <span className="size-1.5 shrink-0 rounded-full bg-pod-attention" />
          <span className="min-w-0 flex-1">{`${alertSource(a.kind, a.detail)} · ${a.kind} · ${fmtAgo(a.raisedAt, now)}`}</span>
          <button type="button" disabled={ack.isPending} onClick={() => ack.mutate({ id: a.id })} className="cursor-pointer rounded-md border border-line bg-transparent px-2.5 py-1 font-sans text-xs font-medium text-fg hover:bg-active disabled:opacity-60">
            {alertActions(a.kind).resolve}
          </button>
        </div>
      ))}
      <p className="text-[13px] leading-normal text-fg-2 text-pretty">
        {detail}
        {LATCHED.has(first.kind) && first.kind !== 'water_low' && `${detail ? ' ' : ''}It stays until you clear it, once the cause is fixed; a pump dry-run clears by itself after a minute of good water.`}
      </p>
    </section>
  )
}
