import { Link, useLocation } from '@tanstack/react-router'
import { ArrowUpRight, BookOpen, ChevronDown, ChevronRight, Droplets, FlaskConical, Sun, Thermometer } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { SidebarSearch } from '@/src/components/Search/CommandPalette'
import { DOCS_BASE } from '@/src/components/Search/docsIndex'
import { PlantThumb, podForm } from '@/src/components/Grow/PlantThumb'
import { ReadingFlag, ReadingsUpdated } from '@/src/components/Sensors/ReadingAge'
import { ageDays, podShown } from '@/src/components/Grow/towerLayout'
import type { Reading, SensorId } from '@/src/hardware/contract'
import { formatReading, SENSOR_META, withUnit } from '@/src/lib/sensorMeta'
import { checkSummary, STATE_TEXT, worstState } from '@/src/components/System/checkState'
import { trpc } from '@/src/utils/trpc'
import { NAV_GROUPS, navItems, type NavItem } from './navItems'

const STAGES = ['germination', 'seedling', 'vegetative', 'harvest'] as const
const SECTION = 'px-2.5 pb-1 font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-fg-3'
const FOOT_ROW = 'flex items-center gap-2.5 rounded-[7px] px-2.5 py-[7px] text-[14px] leading-5 text-fg-2 hover:text-fg'
export const COLLAPSED_KEY = 'seedypod.navCollapsed'

/** The nav groups this viewer has folded away; all open when nothing is saved. */
function savedCollapsed(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  }
  catch {
    return new Set()
  }
}

/** A system reading with a neutral meter under it, linking to its page. */
function Meter({ to, icon: Icon, label, value, pct, readings }: { to: string, icon: typeof Sun, label: string, value: string, pct: number | null, readings?: ReadonlyArray<Reading | undefined> }) {
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
      {readings && <ReadingFlag readings={readings} className="text-right" />}
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
  // Water-quality probes are optional, so the line shows only for those installed.
  const system = trpc.system.info.useQuery()
  const quality = (system.data?.system?.caps.sensors ?? []).filter(id => SENSOR_META[id].group === 'water-quality')
  const water = quality.map(id => `${SENSOR_META[id].label} ${formatReading(s[id])}`).join(' · ')
  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-line bg-active/40 p-3 font-mono text-[11px]">
      <Meter to="/light" icon={Sun} label="Light" value={l ? (l.on ? `${l.level}%` : 'off') : '…'} pct={l ? (l.on ? l.level : 0) : null} />
      <Meter to="/water" icon={Droplets} label="Tank" value={tank ? withUnit(tank.value, tank.unit) : '—'} pct={tank ? Number(tank.value) : null} readings={[tank]} />
      <Meter to="/sensors" icon={Thermometer} label="Air" value={air || '—'} pct={null} readings={[s.air_temp, s.humidity]} />
      {water && <Meter to="/sensors" icon={FlaskConical} label="Water" value={water} pct={null} readings={quality.map(id => s[id])} />}
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
        <NeedRow
          key={p.slot}
          to={p.slot}
          color="var(--pod-attention)"
          thumb={<PlantThumb plant={p.plant} stage={podForm({ status: p.status, green: outlook.get(p.slot)?.cover, ageDays: ageDays(p.plantedAt) })} size={32} passive />}
          title={p.plant ?? `Pod ${p.slot}`}
          sub={p.notes.trim() || 'Needs attention'}
          tag={`P${p.slot}`}
        />
      ))}
      {ready.length > 0 && (
        <NeedRow color="var(--pod-ready)" title={`${ready.length} ready to harvest`} sub={names.length > 2 ? `${names.slice(0, 2).join(', ')}, +${names.length - 2}` : names.join(', ')} />
      )}
    </div>
  )
}

/** A pod's row; with `thumb` (its plant's picture) the status colour rides on the picture's corner. */
function NeedRow({ to, color, thumb, title, sub, tag }: { to?: number, color: string, thumb?: ReactNode, title: string, sub: string, tag?: string }) {
  return (
    <Link to="/grow" search={to ? { pod: to } : {}} className="flex gap-2.5 rounded-lg px-2.5 py-2 hover:bg-active/60">
      {thumb
        ? (
            <span className="relative shrink-0 self-center">
              {thumb}
              <span className="absolute -bottom-px -right-px size-[9px] rounded-full ring-2 ring-surface" style={{ background: color }} />
            </span>
          )
        : <span className="mt-1.5 size-[7px] shrink-0 rounded-full" style={{ background: color }} />}
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
  const checks = trpc.system.checks.useQuery(undefined, { refetchInterval: 60_000 })
  const sensors = trpc.sensors.latest.useQuery()
  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to))
  const cycle = grow.data?.cycle
  const stage = cycle ? STAGES.indexOf(cycle.stage as typeof STAGES[number]) : -1
  const alertCount = (alerts.data ?? []).filter(a => a.active).length
  const passing = checkSummary(checks.data?.checks ?? [])
  const worst = worstState(checks.data?.checks ?? [])
  const [collapsed, setCollapsed] = useState(savedCollapsed)
  const toggle = (id: string) => {
    const next = new Set(collapsed)
    if (!next.delete(id)) next.add(id)
    setCollapsed(next)
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
    }
    catch {
      // private window: the choice lasts for this visit
    }
  }

  const metaFor = (to: string): ReactNode => {
    if (to === '/grow' && cycle) return <span className="font-mono text-[11px] text-fg-3">{`Day ${grow.data?.day}`}</span>
    if (to === '/autopilot' && autopilot.data?.enabled) return <span aria-label="Autopilot on" className="size-1.5 rounded-full bg-pod-ok" />
    if (to === '/status' && passing) return <span aria-label={`${passing.passing} of ${passing.total} checks passing`} className={cn('font-mono text-[11px]', worst === 'down' || worst === 'stalled' ? STATE_TEXT[worst] : 'text-fg-3')}>{`${passing.passing}/${passing.total}`}</span>
    if (to === '/alerts' && alertCount > 0) return <span className="rounded-full bg-pod-attention px-[7px] py-px font-mono text-[11px] font-medium text-inverse">{alertCount}</span>
    return null
  }

  return (
    <aside className="sticky top-0 hidden h-dvh w-[244px] shrink-0 flex-col gap-3.5 overflow-y-auto border-r border-line bg-surface px-3 pb-3 pt-[18px] min-[900px]:flex">
      <Link to="/" className="flex items-center gap-2.5 px-2">
        <img src="/brand/icon-64.png" alt="" width={26} height={26} className="size-[26px]" />
        <span className="font-semibold tracking-tight">seedypod</span>
      </Link>
      <SidebarSearch className="w-full" />
      <Readings />
      <NeedsYou />
      <nav className="flex flex-col gap-3 border-t border-line pt-3">
        {NAV_GROUPS.map((g) => {
          const open = !collapsed.has(g.id)
          // A folded group still shows the current page, so it never disappears.
          const items = navItems.filter(i => i.group === g.id && (open || isActive(i.to)))
          return (
            <div key={g.id} className="flex flex-col gap-0.5">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={`nav-${g.id}`}
                onClick={() => toggle(g.id)}
                className={cn(SECTION, 'flex cursor-pointer items-center border-0 bg-transparent text-left hover:text-fg-2')}
              >
                <span className="flex-1">{g.label}</span>
                <ChevronDown size={12} aria-hidden className={cn('transition-transform', !open && '-rotate-90')} />
              </button>
              <div id={`nav-${g.id}`} className="flex flex-col gap-0.5">
                {items.map(item => (
                  <NavLink key={item.to} item={item} active={isActive(item.to)} meta={metaFor(item.to)}>
                    {item.to === '/grow' && cycle && stage >= 0 && (
                      <span className="flex h-[3px] gap-0.5 pl-[26px]" aria-label={`Stage: ${cycle.stage}`}>
                        {STAGES.map((s, i) => <span key={s} className={cn('flex-1 rounded-full', i <= stage ? 'bg-meter' : 'bg-line')} />)}
                      </span>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          )
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-0.5 pt-2">
        <a href={DOCS_BASE} target="_blank" rel="noopener noreferrer" className={FOOT_ROW}>
          <BookOpen size={16} />
          <span className="flex-1">Docs</span>
          <ArrowUpRight size={14} aria-hidden className="text-fg-3" />
        </a>
        {navItems.filter(i => i.group === 'foot').map(item => (
          <NavLink key={item.to} item={item} active={isActive(item.to)} meta={metaFor(item.to)} />
        ))}
        <Link to="/status" className="mt-1.5 flex items-center gap-2.5 border-t border-line px-2.5 pb-0.5 pt-2.5 text-fg hover:bg-active/40">
          <span className={cn('size-[7px] shrink-0 rounded-full', status.online ? 'bg-pod-ok shadow-[0_0_0_3px_color-mix(in_srgb,var(--pod-ok)_20%,transparent)]' : 'bg-pod-empty')} />
          <span className="flex min-w-0 flex-1 flex-col gap-px">
            <span className="truncate text-[13px]">{status.name}</span>
            <span className="font-mono text-[10px] text-fg-3">{status.line}</span>
            {/* The readings above share one age; a row says so itself only once it goes stale. */}
            <ReadingsUpdated readings={Object.values(sensors.data ?? {})} />
          </span>
          <ChevronRight size={14} aria-hidden className="shrink-0 text-fg-3" />
        </Link>
      </div>
    </aside>
  )
}
