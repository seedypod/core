import { Link } from '@tanstack/react-router'
import { Bell, CalendarClock, Cable, CameraOff, Check, ChevronRight, CloudOff, Droplets, FlaskConical, Info, Scissors, Sprout, Sun, Thermometer, Unplug, Wheat, Waves, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/src/components/ds/core'
import { SegmentedControl } from '@/src/components/ds/forms'
import { DOCS_BASE } from '@/src/components/Search/docsIndex'
import { pumpFault } from '@/src/lib/pumpFault'
import { fmtStamp, timeAgo } from '@/src/lib/timeAgo'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'

type AlertRow = inferRouterOutputs<AppRouter>['alerts']['list'][number]

const LINK_GUIDE = `${DOCS_BASE}/core/maintenance/#reseat-a-camera-cable`

const LABEL: Record<string, string> = {
  camera_link_upper: 'Top camera connection', camera_link_lower: 'Bottom camera connection', camera_hub_flaky: 'Camera hub connection',
  water_low: 'Water low', pump_fault: 'Pump fault', dose_fault: 'Dosing lockout', over_temp: 'Board over temperature', camera_missing: 'Camera not capturing', hal_offline: 'Hardware daemon offline', mirror_failed: 'Off-device copy failed',
  reminder_thinning: 'Thin seedlings', reminder_root_check: 'Check roots', reminder_harvest: 'Harvest window', reminder_nutrients: 'Add nutrients', reminder_sow: 'Start new yCubes', reminder_first_harvest: 'First harvest', reminder_schedule_switch: 'Schedule didn’t switch', light_fault: 'Light fault',
  setup_light_schedule: 'No light schedule', setup_pump_schedule: 'No pump schedule', setup_water_sensor: 'Tank sensor',
  watering_followed: 'Watering moved to the next stage',
  chore_top_off: 'Top off the tank', chore_feed: 'Feed', chore_thin: 'Thin seedlings',
}
const ICON: Record<string, LucideIcon> = {
  camera_link_upper: Cable, camera_link_lower: Cable, camera_hub_flaky: Cable,
  water_low: Droplets, pump_fault: Waves, dose_fault: FlaskConical, over_temp: Thermometer, camera_missing: CameraOff, hal_offline: Unplug, mirror_failed: CloudOff, light_fault: Sun,
  reminder_thinning: Scissors, reminder_root_check: Sprout, reminder_harvest: Wheat, reminder_nutrients: FlaskConical, reminder_sow: Sprout,
  setup_light_schedule: CalendarClock, setup_pump_schedule: CalendarClock, setup_water_sensor: Waves,
  chore_top_off: Droplets, chore_feed: FlaskConical, chore_thin: Scissors,
}
const HARDWARE = new Set(['water_low', 'pump_fault', 'dose_fault', 'over_temp', 'camera_missing', 'hal_offline', 'light_fault', 'camera_link_upper', 'camera_link_lower', 'camera_hub_flaky'])
/** Notices with a repair to follow in the docs. */
const GUIDE: Record<string, string> = { camera_link_upper: LINK_GUIDE, camera_link_lower: LINK_GUIDE, camera_hub_flaky: LINK_GUIDE }
/** What clearing a latched fault turns back on, and what to fix first. */
const LATCH: Record<string, string> = {
  water_low: 'It clears by itself after a minute of good readings once the tank is filled.',
  pump_fault: 'Clearing it re-enables the pump; fix the cause first. A dry-run clears by itself once the water has read good for a minute.',
  dose_fault: 'Clearing it re-enables dosing. Fix the cause first.',
  over_temp: 'Clearing it re-enables the outputs. Let the board cool first.',
  camera_missing: 'Clearing it re-enables the camera. Fix the cause first.',
  light_fault: 'Clearing it re-enables the light. Fix the cause first.',
}

/**
 * The buttons an open alert gets: a latched fault is cleared, a reminder is done
 * (logged) or skipped, anything else dismissed. `resolve` acknowledges, which
 * clears a hardware latch and logs a chore; `skip` closes it without either.
 */
export function alertActions(kind: string): { resolve: string, skip: string | null } {
  if (kind in LATCH && kind !== 'water_low') return { resolve: 'Clear fault', skip: null }
  if (categoryOf(kind) === 'reminder') return { resolve: 'Done', skip: 'Skip' }
  return { resolve: 'Dismiss', skip: null }
}

/** How a closed alert ended. */
export function alertOutcome(a: Pick<AlertRow, 'kind' | 'active' | 'clearedAt' | 'acknowledgedAt' | 'dismissedAt'>): string {
  if (a.active) return ''
  if (a.acknowledgedAt) return categoryOf(a.kind) === 'reminder' ? ' · done' : a.kind in LATCH ? ' · cleared by you' : ' · dismissed'
  if (a.dismissedAt) return ' · skipped'
  return a.clearedAt ? ' · resolved by itself' : ''
}
const VIEW: Record<string, { to: string, label: string }> = {
  camera_missing: { to: '/cameras', label: 'View camera' },
  camera_link_upper: { to: '/cameras', label: 'View camera' },
  camera_link_lower: { to: '/cameras', label: 'View camera' },
  camera_hub_flaky: { to: '/cameras', label: 'View cameras' },
  water_low: { to: '/water', label: 'View water' },
  pump_fault: { to: '/water', label: 'View water' },
  light_fault: { to: '/light', label: 'View light' },
  over_temp: { to: '/sensors', label: 'View sensors' },
  mirror_failed: { to: '/settings', label: 'View settings' },
  setup_light_schedule: { to: '/light', label: 'View light' },
  setup_pump_schedule: { to: '/water', label: 'View water' },
  watering_followed: { to: '/water', label: 'View water' },
  setup_water_sensor: { to: '/sensors', label: 'View sensors' },
  chore_top_off: { to: '/water', label: 'View water' },
  chore_feed: { to: '/water', label: 'View water' },
  chore_thin: { to: '/grow', label: 'View pods' },
  reminder_first_harvest: { to: '/grow', label: 'View grow' },
  reminder_schedule_switch: { to: '/grow', label: 'View grow' },
}
const PODS = { upper: '1–15', lower: '16–30' } as const

/** The page that shows an alert's part of the tower, and the link's words. */
export const alertView = (kind: string): { to: string, label: string } | undefined => VIEW[kind]

export const categoryOf = (kind: string): 'hardware' | 'reminder' | 'service' => (HARDWARE.has(kind) ? 'hardware' : kind.startsWith('reminder_') || kind.startsWith('chore_') ? 'reminder' : 'service')

/** Title and detail for an alert; a camera alert names the camera and the pods it covers. */
export function describeAlert(a: Pick<AlertRow, 'kind' | 'detail'>): { title: string, detail: string } {
  const cam = a.kind === 'camera_missing' ? /^(upper|lower) camera returned (\d+) bytes/.exec(a.detail) : null
  if (cam) {
    const camera = cam[1] as keyof typeof PODS
    return { title: `${camera === 'upper' ? 'Upper' : 'Lower'} camera not capturing`, detail: `Returned ${cam[2]} bytes on the last capture. Pods ${PODS[camera]} have no new photos.` }
  }
  // The current guard says what the pump drew; the title keeps which fault it is.
  const pump = a.kind === 'pump_fault' ? pumpFault(a.detail) : null
  if (pump?.detail) return { title: `Pump fault: ${pump.reason}`, detail: pump.detail }
  return { title: LABEL[a.kind] ?? a.kind, detail: a.detail }
}

/** "2 open · 1 hardware, 1 reminder". */
export function openSummary(open: Array<Pick<AlertRow, 'kind'>>): string {
  if (!open.length) return 'Nothing open'
  const n = (c: string) => open.filter(a => categoryOf(a.kind) === c).length
  const parts = [[n('hardware'), 'hardware'], [n('reminder'), n('reminder') === 1 ? 'reminder' : 'reminders'], [n('service'), 'service']]
    .filter(([c]) => (c as number) > 0).map(([c, l]) => `${c} ${l}`)
  return `${open.length} open · ${parts.join(', ')}`
}

export function AlertsPage() {
  const utils = trpc.useUtils()
  const [view, setView] = useState<'active' | 'all'>('active')
  const alerts = trpc.alerts.list.useQuery({ activeOnly: view === 'active' })
  const open = trpc.alerts.list.useQuery({ activeOnly: true })
  const pods = trpc.grow.pods.useQuery()
  const ack = trpc.alerts.acknowledge.useMutation({
    onSuccess: () => {
      void utils.alerts.invalidate()
      void utils.pump.invalidate()
    },
  })
  const dismiss = trpc.alerts.dismiss.useMutation({ onSuccess: () => utils.alerts.invalidate() })
  const [now] = useState(() => Date.now())
  const attention = (pods.data ?? []).filter(p => p.status === 'attention')
  const rows = alerts.data ?? []

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-6">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-[240px] flex-1 flex-col gap-1">
          <h1 className="text-2xl font-semibold">Alerts</h1>
          <p className="text-[13px] text-fg-2">{openSummary(open.data ?? [])}</p>
        </div>
        <SegmentedControl ariaLabel="Alerts" value={view} onChange={setView} options={[{ value: 'active', label: 'Open' }, { value: 'all', label: 'History' }]} />
      </div>

      <div className="flex flex-col gap-3">
        {rows.length === 0 && (
          <div className="rounded-[14px] border border-dashed border-line-2 px-5 py-4 text-[13px] text-fg-2">
            Nothing to see. Faults stay here until you clear them or they resolve by themselves; reminders clear when you mark the chore done.
          </div>
        )}
        {rows.map((a) => {
          const cat = categoryOf(a.kind)
          const { title, detail } = describeAlert(a)
          const Icon = ICON[a.kind] ?? Bell
          const hot = a.active && cat === 'hardware'
          const tone = cat === 'hardware' ? 'attention' : 'ready'
          const go = a.active ? VIEW[a.kind] : undefined
          const actions = alertActions(a.kind)
          return (
            <div key={a.id} data-testid={`alert-${a.kind}`} className={cn('flex flex-col gap-3.5 rounded-[14px] border bg-surface px-5 py-[18px]', hot ? 'border-pod-attention/45' : 'border-line', !a.active && 'opacity-75')}>
              <div className="flex flex-wrap items-start gap-3.5">
                <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', tone === 'attention' ? 'bg-pod-attention/15 text-pod-attention' : 'bg-pod-ready/15 text-pod-ready')}>
                  <Icon size={16} />
                </span>
                <div className="flex min-w-[220px] flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[15px] font-medium">{title}</span>
                    <span className={cn('rounded-[10px] px-2 py-0.5 font-mono text-[10px] font-medium uppercase', tone === 'attention' ? 'bg-pod-attention/15 text-pod-attention' : 'bg-pod-ready/15 text-pod-ready')}>{cat}</span>
                  </div>
                  {detail && <span className="text-[13px] text-fg-2">{detail}</span>}
                  <span className="font-mono text-[11px] text-fg-3">
                    {`${fmtStamp(a.raisedAt)} · ${timeAgo(a.raisedAt, now)}`}
                    {a.clearedAt ? ` → cleared ${fmtStamp(a.clearedAt)}` : ''}
                    {alertOutcome(a)}
                  </span>
                </div>
                {a.active && (
                  <div className="flex flex-wrap gap-2">
                    {go && <Link to={go.to} className="rounded-ctl border border-line-2 px-3 py-[7px] text-[13px] text-fg hover:bg-active">{go.label}</Link>}
                    {a.active && GUIDE[a.kind] && <a href={GUIDE[a.kind]} target="_blank" rel="noopener noreferrer" className="rounded-ctl border border-line-2 px-3 py-[7px] text-[13px] text-fg hover:bg-active">How to reseat it</a>}
                    {actions.skip && <Button icon={X} className="px-3 py-[7px] text-fg-2" title="Close it without logging it as done" onClick={() => dismiss.mutate({ id: a.id })}>{actions.skip}</Button>}
                    <Button variant="primary" icon={Check} className="px-3 py-[7px]" onClick={() => ack.mutate({ id: a.id })}>{actions.resolve}</Button>
                  </div>
                )}
              </div>
              {a.active && LATCH[a.kind] && (
                <div className="flex items-start gap-2.5 rounded-lg bg-active/60 px-3 py-2.5 text-xs leading-normal text-fg-2">
                  <Info size={16} className="shrink-0" />
                  <span>{LATCH[a.kind]}</span>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {view === 'active' && attention.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-fg-3">Plants · from Grow</h2>
          {attention.map(p => (
            <Link key={p.slot} to="/grow" search={{ pod: p.slot }} className="flex flex-wrap items-center gap-3 rounded-[14px] border border-line bg-surface px-5 py-3.5 text-fg hover:border-line-2">
              <span className="size-[7px] shrink-0 rounded-full bg-pod-attention" />
              <span className="min-w-[200px] flex-1 text-[13px]">
                {`${p.plant ?? `Pod ${p.slot}`} · pod ${p.slot} `}
                <span className="text-fg-2">{`· ${p.notes.trim() || 'needs attention'}`}</span>
              </span>
              <ChevronRight size={16} className="text-fg-3" />
            </Link>
          ))}
        </section>
      )}
    </div>
  )
}
