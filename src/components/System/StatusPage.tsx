import { Link } from '@tanstack/react-router'
import type { inferRouterOutputs } from '@trpc/server'
import { ChevronRight, HardDrive, Radio } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Card, CardHeader, KeyValue } from '@/src/components/ds/core'
import { timeAgo } from '@/src/lib/timeAgo'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'
import { checkSummary, STATE_BG, STATE_LABEL, STATE_TEXT, worstState, type SystemCheck } from './checkState'

type Outputs = inferRouterOutputs<AppRouter>

const LABEL = 'font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-fg-3'
const GROUPS: ReadonlyArray<{ label: string, ids: readonly string[] }> = [
  { label: 'Hardware', ids: ['hal', 'sensors', 'light', 'pump', 'cameras'] },
  { label: 'Services', ids: ['autopilot', 'network', 'storage', 'backup', 'mirror'] },
  { label: 'Integrations', ids: ['homekit', 'bridge'] },
]
/** Where to go to fix or look closer at each check. */
const LINK: Record<string, string> = {
  sensors: '/sensors', light: '/light', pump: '/water', cameras: '/cameras', autopilot: '/autopilot', network: '/wifi',
  storage: '/settings#storage', backup: '/settings#backup', mirror: '/settings#off-device', homekit: '/settings#homekit', bridge: '/settings#home-assistant',
}
const HEADLINE = { ok: 'All running', idle: 'All running', stalled: 'Running behind', down: 'Something is down' } as const

/** `512 kB`, `3.2 GB`, `2.0 TB`. */
export const size = (b: number) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : b >= 1e9 ? `${(b / 1e9).toFixed(b < 1e10 ? 1 : 0)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB` : `${Math.round(b / 1e3)} kB`)

/** "1 down · 2 stalled", or how many pass when nothing is wrong. */
export function problemLine(checks: ReadonlyArray<Pick<SystemCheck, 'state'>>): string {
  const down = checks.filter(c => c.state === 'down').length
  const stalled = checks.filter(c => c.state === 'stalled').length
  const parts = [down && `${down} down`, stalled && `${stalled} stalled`].filter(Boolean)
  const s = checkSummary(checks)
  return parts.length ? parts.join(' · ') : s ? `${s.passing} of ${s.total} checks passing` : ''
}

/** System › Status: each part of the unit at a glance, then the disk and the Home Assistant bridge. */
export function StatusPage() {
  const checks = trpc.system.checks.useQuery(undefined, { refetchInterval: 30_000 })
  const info = trpc.system.info.useQuery()
  const flash = trpc.storage.flash.useQuery(undefined, { refetchInterval: 60_000 })
  const bridge = trpc.system.bridge.useQuery(undefined, { refetchInterval: 30_000 })
  const [now] = useState(() => Date.now())
  const list = checks.data?.checks ?? []
  const worst = worstState(list)
  const summary = checkSummary(list)
  const placed = new Set(GROUPS.flatMap(g => g.ids))
  const groups = GROUPS.map((g, i) => ({ label: g.label, rows: list.filter(c => g.ids.includes(c.id) || (i === GROUPS.length - 1 && !placed.has(c.id))) }))
  const host = info.data?.coreHost

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-[240px] flex-1 flex-col gap-1">
          <h1 className="text-2xl font-semibold">Status</h1>
          {info.data && (
            <p className="font-mono text-[11px] text-fg-3">
              {[`core ${info.data.coreVersion}`, host && `${host.hostname} (${host.arch})`, info.data.system && `hald ${info.data.system.halVersion}`].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
        {worst && summary && (
          <div className="flex items-center gap-2.5 rounded-[14px] border border-line bg-surface px-4 py-2.5" data-testid="status-summary">
            <span className={cn('size-2 rounded-full', STATE_BG[worst])} />
            <span className="flex flex-col">
              <span className="text-[14px] font-medium">{HEADLINE[worst]}</span>
              <span className="text-xs text-fg-2">{problemLine(list)}</span>
            </span>
            <span className="ml-2 font-mono text-[13px] text-fg-2">{`${summary.passing}/${summary.total}`}</span>
          </div>
        )}
      </div>

      {checks.isError && <div className="rounded-[14px] border border-dashed border-line-2 px-5 py-4 text-[13px] text-fg-2">Core didn&apos;t answer the status check. It may be restarting.</div>}

      <div className="grid gap-6 min-[1000px]:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-6">
          {groups.filter(g => g.rows.length).map(g => (
            <section key={g.label} className="flex flex-col gap-2.5" aria-label={g.label}>
              <h2 className={LABEL}>{g.label}</h2>
              <ul className="flex flex-col overflow-hidden rounded-[14px] border border-line bg-surface">
                {g.rows.map(c => <CheckRow key={c.id} check={c} now={now} />)}
              </ul>
            </section>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader icon={HardDrive} title="Storage" subtitle="Where the database, photos and backups live" />
            {flash.data && <StorageBody f={flash.data} />}
          </Card>
          <Card>
            <CardHeader icon={Radio} title="Home Assistant" subtitle="MQTT bridge for grow events and buttons" />
            {bridge.data && <BridgeBody b={bridge.data} now={now} />}
          </Card>
        </div>
      </div>
    </div>
  )
}

function CheckRow({ check: c, now }: { check: SystemCheck, now: number }) {
  const to = LINK[c.id]
  const body = (
    <>
      <span className={cn('mt-1.5 size-[7px] shrink-0 rounded-full', STATE_BG[c.state])} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px]">{c.label}</span>
        <span className="text-[13px] text-fg-2 text-pretty">{c.detail}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        <span className={cn('font-mono text-[11px] font-medium uppercase tracking-[0.06em]', STATE_TEXT[c.state])}>{STATE_LABEL[c.state]}</span>
        {c.since && <span className="font-mono text-[11px] text-fg-3">{`since ${timeAgo(c.since, now)}`}</span>}
      </span>
      {to && <ChevronRight size={16} className="mt-0.5 shrink-0 text-fg-3" />}
    </>
  )
  const row = 'flex items-start gap-3 px-5 py-3.5'
  return (
    <li data-testid={`check-${c.id}`} className="border-t border-line first:border-t-0">
      {to ? <Link to={to} className={cn(row, 'text-fg hover:bg-active/60')}>{body}</Link> : <div className={row}>{body}</div>}
    </li>
  )
}

function StorageBody({ f }: { f: Pick<Outputs['storage']['flash'], 'usedBytes' | 'freeBytes' | 'bytesPerDay' | 'device'> }) {
  if (f.usedBytes === null || f.freeBytes === null) return <p className="text-[13px] text-fg-2">Not measured on this machine.</p>
  const total = f.usedBytes + f.freeBytes
  const pct = total > 0 ? (f.usedBytes / total) * 100 : 0
  return (
    <>
      <div className="h-1.5 rounded-full bg-line" role="meter" aria-label="Disk used" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-meter" style={{ width: `${pct}%` }} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <KeyValue label="Used" value={size(f.usedBytes)} />
        <KeyValue label="Free" value={size(f.freeBytes)} />
        <KeyValue label="Writes" value={f.bytesPerDay === null ? '—' : `${size(f.bytesPerDay)}/day`} />
        <KeyValue label="Card" value={f.device ?? '—'} />
      </div>
    </>
  )
}

function BridgeBody({ b, now }: { b: Outputs['system']['bridge'], now: number }) {
  if (b.state === 'off') return <p className="text-[13px] text-fg-2">No broker set. Add one in Settings to publish to Home Assistant.</p>
  const up = b.state === 'connected'
  return (
    <>
      <span className={cn('flex items-center gap-2 text-[13px]', up ? 'text-pod-ok' : 'text-pod-attention')}>
        <span className={cn('size-[7px] rounded-full', up ? 'bg-pod-ok' : 'bg-pod-attention')} />
        {up ? 'Connected' : 'Disconnected'}
        {b.since && <span className="font-mono text-[11px] text-fg-3">{timeAgo(b.since, now)}</span>}
      </span>
      <KeyValue label="Broker" value={b.broker ?? '—'} />
      {!up && b.error && <p className="text-xs text-fg-2">{b.error}</p>}
    </>
  )
}
