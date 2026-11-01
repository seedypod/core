import { Link, useLocation } from '@tanstack/react-router'
import { Droplets, Sprout, Sun, Thermometer } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { SidebarSearch } from '@/src/components/Search/CommandPalette'
import { podShown } from '@/src/components/Grow/towerLayout'
import type { Reading, SensorId } from '@/src/hardware/contract'
import { withUnit } from '@/src/lib/sensorMeta'
import { trpc } from '@/src/utils/trpc'
import { NAV_GROUPS, navItems, type NavItem } from './navItems'

const STAGES = ['germination', 'seedling', 'vegetative', 'harvest'] as const
const SECTION = 'px-2.5 pb-1 font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-fg-3'

/** A system reading with a neutral meter under it, linking to its page. */
function Meter({ to, icon: Icon, label, value, pct }: { to: string, icon: typeof Sun, label: string, value: string, pct: number | null }) {
  return (
    <Link to={to} className="flex flex-col gap-1.5 text-fg-2 hover:text-fg">
      <span className="flex items-center gap-1.5">
        <Icon size={14} />
        <span className="flex-1">{label}</span>
        <span className="text-fg">{value}</span>
      </span>
      {pct !== null && (
        <span className="h-[3px] rounded-full bg-line">
          <span className="block h-full rounded-full bg-meter" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
        </span>
      )}
    </Link>
  )
}

/** Light, tank and air, so they show on every page. */
function Readings() {
  const light = trpc.light.get.useQuery()
  const sensors = trpc.sensors.latest.useQuery()
  const s: Partial<Record<SensorId, Reading>> = sensors.data ?? {}
  const l = light.data
  const tank = s.water_level_pct
  const air = [s.air_temp, s.humidity].filter((r): r is Reading => !!r).map(r => withUnit(r.value, r.unit)).join(' · ')
  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-line bg-active/40 p-3 font-mono text-[11px]">
      <Meter to="/light" icon={Sun} label="Light" value={l ? (l.on ? `${l.level}%` : 'off') : '…'} pct={l ? (l.on ? l.level : 0) : null} />
      <Meter to="/water" icon={Droplets} label="Tank" value={tank ? withUnit(tank.value, tank.unit) : '—'} pct={tank ? Number(tank.value) : null} />
      <Meter to="/sensors" icon={Thermometer} label="Air" value={air || '—'} pct={null} />
    </div>
  )
}

/** Pods that want something done: each one needing attention, then those ready to harvest as one line. */
function NeedsYou() {
  const pods = trpc.grow.pods.useQuery()
  const harvest = trpc.grow.harvest.useQuery(undefined, { refetchInterval: 10 * 60_000 })
  const outlook = new Map((harvest.data ?? []).map(o => [o.slot, o]))
  const shown = (pods.data ?? []).map(p => ({ ...p, shown: podShown({ status: p.status, harvest: outlook.get(p.slot) ?? null }) }))
  const attention = shown.filter(p => p.shown === 'attention')
  const ready = shown.filter(p => p.shown === 'ready')
  if (!attention.length && !ready.length) return null
  const names = ready.map(p => p.plant ?? `Pod ${p.slot}`)
  return (
    <div className="flex flex-col gap-0.5">
      <div className={SECTION}>Needs you</div>
      {attention.map(p => (
        <NeedRow key={p.slot} to={p.slot} color="var(--pod-attention)" title={p.plant ?? `Pod ${p.slot}`} sub={p.notes.trim() || 'Needs attention'} tag={`P${p.slot}`} />
      ))}
      {ready.length > 0 && (
        <NeedRow color="var(--pod-ready)" title={`${ready.length} ready to harvest`} sub={names.length > 2 ? `${names.slice(0, 2).join(', ')}, +${names.length - 2}` : names.join(', ')} />
      )}
    </div>
  )
}

function NeedRow({ to, color, title, sub, tag }: { to?: number, color: string, title: string, sub: string, tag?: string }) {
  return (
    <Link to="/grow" search={to ? { pod: to } : {}} className="flex gap-2.5 rounded-lg px-2.5 py-2 hover:bg-active/60">
      <span className="mt-1.5 size-[7px] shrink-0 rounded-full" style={{ background: color }} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] text-fg">{title}</span>
        <span className="truncate text-xs text-fg-2">{sub}</span>
      </span>
      {tag && <span className="pt-0.5 font-mono text-[10px] text-fg-3">{tag}</span>}
    </Link>
  )
}

function NavLink({ item, active, meta, children }: { item: NavItem, active: boolean, meta?: ReactNode, children?: ReactNode }) {
  const Icon = item.icon
  return (
    <Link
      to={item.to}
      aria-current={active ? 'page' : undefined}
      className={cn('flex flex-col gap-[7px] rounded-[7px] px-2.5 py-[7px] text-[14px] leading-5 text-fg-2 hover:text-fg', active && 'bg-active text-fg')}
    >
      <span className="flex items-center gap-2.5">
        <Icon size={16} />
        <span className="flex-1">{item.label}</span>
        {meta}
      </span>
      {children}
    </Link>
  )
}

export function Sidebar({ status }: { status: { name: string, line: string, online: boolean } }) {
  const { pathname } = useLocation()
  const grow = trpc.grow.current.useQuery()
  const alerts = trpc.alerts.list.useQuery({ activeOnly: true })
  const autopilot = trpc.automations.status.useQuery(undefined, { refetchInterval: 60_000 })
  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to))
  const cycle = grow.data?.cycle
  const stage = cycle ? STAGES.indexOf(cycle.stage as typeof STAGES[number]) : -1
  const alertCount = (alerts.data ?? []).filter(a => a.active).length

  const metaFor = (to: string): ReactNode => {
    if (to === '/grow' && cycle) return <span className="font-mono text-[11px] text-fg-3">{`Day ${grow.data?.day}`}</span>
    if (to === '/autopilot' && autopilot.data?.enabled) return <span aria-label="Autopilot on" className="size-1.5 rounded-full bg-pod-ok" />
    if (to === '/alerts' && alertCount > 0) return <span className="rounded-full bg-pod-attention px-[7px] py-px font-mono text-[11px] font-medium text-inverse">{alertCount}</span>
    return null
  }

  return (
    <aside className="sticky top-0 hidden h-dvh w-[244px] shrink-0 flex-col gap-3.5 overflow-y-auto border-r border-line bg-surface px-3 pb-3 pt-[18px] min-[900px]:flex">
      <Link to="/" className="flex items-center gap-2.5 px-2">
        <span className="grid size-[26px] place-items-center rounded-[7px] bg-pod-ok text-app"><Sprout size={16} /></span>
        <span className="font-semibold tracking-tight">seedypod</span>
      </Link>
      <SidebarSearch className="w-full" />
      <Readings />
      <NeedsYou />
      <nav className="flex flex-col gap-3 border-t border-line pt-3">
        {NAV_GROUPS.map(g => (
          <div key={g.id} className="flex flex-col gap-0.5">
            <div className={SECTION}>{g.label}</div>
            {navItems.filter(i => i.group === g.id).map(item => (
              <NavLink key={item.to} item={item} active={isActive(item.to)} meta={metaFor(item.to)}>
                {item.to === '/grow' && cycle && stage >= 0 && (
                  <span className="flex h-[3px] gap-0.5 pl-[26px]" aria-label={`Stage: ${cycle.stage}`}>
                    {STAGES.map((s, i) => <span key={s} className={cn('flex-1 rounded-full', i <= stage ? 'bg-meter' : 'bg-line')} />)}
                  </span>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-0.5 pt-2">
        {navItems.filter(i => i.group === 'system').map(item => (
          <NavLink key={item.to} item={item} active={isActive(item.to)} meta={metaFor(item.to)} />
        ))}
        <div className="mt-1.5 flex items-center gap-2.5 border-t border-line px-2.5 pb-0.5 pt-2.5">
          <span className={cn('size-[7px] shrink-0 rounded-full', status.online ? 'bg-pod-ok shadow-[0_0_0_3px_color-mix(in_srgb,var(--pod-ok)_20%,transparent)]' : 'bg-pod-empty')} />
          <span className="flex min-w-0 flex-col gap-px">
            <span className="truncate text-[13px]">{status.name}</span>
            <span className="font-mono text-[10px] text-fg-3">{status.line}</span>
          </span>
        </div>
      </div>
    </aside>
  )
}
