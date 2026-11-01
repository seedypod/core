import { Link } from '@tanstack/react-router'
import { ArrowRight, Leaf, Power, Sprout, Sun, Thermometer, TriangleAlert, Waves, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Card, CardHeader, InlineError, KeyValue, Metric, SectionLabel } from '@/src/components/ds/core'
import { TowerView } from '@/src/components/Grow/TowerView'
import { ageDays } from '@/src/components/Grow/towerLayout'
import type { TowerPart } from '@/src/components/Grow/towerScene'
import type { Reading, SensorId } from '@/src/hardware/contract'
import { cn } from '@/lib/utils'
import { formatReading, SENSOR_META, withUnit } from '@/src/lib/sensorMeta'
import { trpc } from '@/src/utils/trpc'
import { SensorAge } from '@/src/components/ds/charts'
import { Trend } from './trend'

const STATUS_LABEL: Record<string, string> = { empty: 'Empty', seeded: 'Seeded', growing: 'Growing', harvest: 'Ready to harvest', attention: 'Needs attention' }
const OWNER = { manual: 'held by hand', autopilot: 'set by Autopilot', schedule: 'on schedule' } as const
const fmt = (r: Reading | undefined) => (r ? withUnit(r.value, r.unit) : '—')

/**
 * A reading pinned to the tower, with its panel: hovering shows it and the
 * pointer can move into it to use the controls; a click (or a touch) pins it
 * open until a click elsewhere.
 */
function Chip({ id, icon: Icon, label, active, warn, shown, pinned, onHover, onPin, children }: {
  id: TowerPart
  icon: LucideIcon
  label: string
  active?: boolean
  warn?: boolean
  shown: boolean
  pinned: boolean
  onHover: (part: TowerPart, on: boolean) => void
  onPin: (part: TowerPart | null) => void
  children?: ReactNode
}) {
  // Leaving waits a moment, so a pointer that strays off the edge on its way into the panel doesn't close it.
  const leave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(leave.current), [])
  return (
    <div
      className="relative"
      data-chip={id}
      onPointerEnter={(e) => {
        if (e.pointerType !== 'mouse') return
        clearTimeout(leave.current)
        onHover(id, true)
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') leave.current = setTimeout(() => onHover(id, false), 200)
      }}
    >
      <button
        type="button"
        aria-expanded={shown}
        onClick={() => onPin(pinned ? null : id)}
        className={cn(
          'flex items-center gap-1.5 whitespace-nowrap rounded-full border bg-surface/90 px-2.5 py-1 font-mono text-[12px] shadow-[var(--shadow-dialog)] backdrop-blur',
          warn ? 'border-[var(--status-warn)] text-[var(--status-warn)]' : shown ? 'border-fg-3 text-fg' : 'border-line-2 text-fg',
        )}
      >
        <Icon size={13} className={active ? 'text-[var(--accent-light)]' : 'text-fg-2'} />
        {label}
      </button>
      {shown && (
        // Padding, not margin, so the pointer crosses no gap on its way down into the panel.
        <div className="absolute left-0 top-full z-20 pt-2" onPointerDown={() => !pinned && onPin(id)}>
          <div role="dialog" aria-label={label} className="w-72 rounded-xl border border-line-2 bg-surface p-3 text-sm shadow-[var(--shadow-dialog)]">
            {children}
          </div>
        </div>
      )}
    </div>
  )
}

/** The top of a chip's panel: what it is, how fresh, and the reading itself. */
function PanelHead({ title, ts, value, right }: { title: string, ts?: string, value: string, right?: ReactNode }) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-fg-2">{title}</span>
        <SensorAge timestamp={ts} />
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="font-mono text-lg font-light">{value}</span>
        {right}
      </div>
    </>
  )
}

/**
 * Home (after ADR-0021's restore work made it the first screen): the tower in
 * 3D, its light, tank and air readings pinned to the parts they belong to with
 * their controls in place, and the cycle, alerts and the picked pod beside it.
 */
export function TowerHome({ onUnavailable }: { onUnavailable: () => void }) {
  const sensors = trpc.sensors.latest.useQuery()
  const lightState = trpc.light.get.useQuery()
  const pumpState = trpc.pump.get.useQuery()
  const alerts = trpc.alerts.list.useQuery({ activeOnly: true })
  const system = trpc.system.info.useQuery()
  const grow = trpc.grow.current.useQuery()
  const pods = trpc.grow.pods.useQuery()
  const trends = trpc.vision.podTrends.useQuery()
  const owner = trpc.light.owner.useQuery(undefined, { refetchInterval: 30_000 })
  const day = { hours: 24, maxPoints: 96 }
  const every5 = { refetchInterval: 5 * 60_000 }
  const tankHistory = trpc.telemetry.history.useQuery({ sensor: 'water_level_pct', ...day }, every5)
  const airHistory = trpc.telemetry.history.useQuery({ sensor: 'air_temp', ...day }, every5)
  const humidityHistory = trpc.telemetry.history.useQuery({ sensor: 'humidity', ...day }, every5)
  const setLight = trpc.light.set.useMutation({ onSuccess: () => lightState.refetch() })
  const runPump = trpc.pump.runOnce.useMutation({ onSuccess: () => pumpState.refetch() })
  const stopPump = trpc.pump.stop.useMutation({ onSuccess: () => pumpState.refetch() })
  const [open, setOpen] = useState<TowerPart | null>(null)
  const [hovered, setHovered] = useState<TowerPart | null>(null)
  const hover = (part: TowerPart, on: boolean) => setHovered(h => (on ? part : h === part ? null : h))
  const shown = hovered ?? open
  const [selected, setSelected] = useState<number | null>(null)
  const [level, setLevel] = useState<number | null>(null)

  // Escape, or a click anywhere outside the open chip, closes its panel.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(null)
        setHovered(null)
      }
    }
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.(`[data-chip="${open}"]`)) setOpen(null)
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open])

  const s: Partial<Record<SensorId, Reading>> = sensors.data ?? {}
  const l = lightState.data
  const p = pumpState.data
  const active = (alerts.data ?? []).filter(a => a.active)
  const waterLow = active.some(a => a.kind === 'water_low')
  const all = pods.data ?? []
  const green = new Map((trends.data ?? []).map(t => [t.slot, t]))
  const towerPods = all.map(x => ({ slot: x.slot, status: x.status, plant: x.plant, green: green.get(x.slot)?.green ?? null, ageDays: ageDays(x.plantedAt) }))
  const cycle = grow.data?.cycle
  const counts = all.reduce<Record<string, number>>((m, x) => ({ ...m, [x.status]: (m[x.status] ?? 0) + 1 }), {})
  const pod = selected === null ? null : all.find(x => x.slot === selected)
  const podTrend = selected === null ? undefined : green.get(selected)
  const quality = (system.data?.system?.caps.sensors ?? []).filter(id => SENSOR_META[id].group === 'water-quality')
  const chip = (id: TowerPart) => ({ id, shown: shown === id, pinned: open === id, onHover: hover, onPin: setOpen })
  const shownLevel = level ?? l?.level ?? 0

  const partLabels: Partial<Record<TowerPart, string>> = {
    light: `Grow light · ${l ? (l.on ? `${l.level}%` : 'off') : '…'}`,
    tank: `Tank · ${fmt(s.water_level_pct)}${p?.on ? ' · pump running' : ''}`,
  }
  const controls = [
    (
      <Chip
        key="light"
        {...chip('light')}
        icon={Sun}
        label={l ? (l.on ? `${l.level}%` : 'off') : '…'}
        active={!!l?.on}
      >
        <PanelHead
          title={`Grow light${owner.data?.source ? ` · ${OWNER[owner.data.source]}` : ''}`}
          ts={l?.since}
          value={l ? (l.on ? `${l.level}%` : 'Off') : '…'}
          right={<Button size="sm" icon={Power} onClick={() => setLight.mutate({ on: !l?.on })}>{l?.on ? 'Turn off' : 'Turn on'}</Button>}
        />
        <input
          type="range"
          min={0}
          max={100}
          value={shownLevel}
          aria-label="Brightness"
          onChange={e => setLevel(Number(e.target.value))}
          onPointerUp={() => level !== null && setLight.mutate({ level }, { onSettled: () => setLevel(null) })}
          onKeyUp={() => level !== null && setLight.mutate({ level }, { onSettled: () => setLevel(null) })}
          className="mt-3 w-full accent-[var(--accent-light)]"
        />
        <div className="mt-1 flex justify-between text-xs text-fg-2">
          <span>{`${shownLevel}%`}</span>
          <Link to="/light" className="flex items-center gap-1 hover:text-fg">
            Schedule
            <ArrowRight size={12} />
          </Link>
        </div>
      </Chip>
    ),
    (
      <Chip
        key="tank"
        {...chip('tank')}
        icon={Waves}
        label={fmt(s.water_level_pct)}
        warn={waterLow}
      >
        <PanelHead title={p?.on ? 'Tank · pump running' : 'Tank'} ts={s.water_level_pct?.ts} value={fmt(s.water_level_pct)} />
        <div className="mt-2"><Trend label="Tank level" points={tankHistory.data ?? []} color="var(--chart-water)" unit="%" /></div>
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <KeyValue label="Tank" value={fmt(s.water_level_pct)} size={13} />
          <KeyValue label="Distance" value={fmt(s.water_distance)} size={13} />
          <KeyValue label="Pump" value={p ? (p.on ? `${p.level}% · ${p.remainingS ?? '∞'}s left` : p.fault ? `fault: ${p.fault}` : 'idle') : '…'} size={13} />
          <KeyValue label="Power" value={fmt(s.pump_w)} size={13} />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" disabled={!!p?.on} onClick={() => runPump.mutate({ durationS: 300 })}>Run 5 min</Button>
          <Button size="sm" disabled={!p?.on} onClick={() => stopPump.mutate()}>Stop</Button>
          <Link to="/water" className="ml-auto flex items-center gap-1 text-xs text-fg-2 hover:text-fg">
            Water
            <ArrowRight size={12} />
          </Link>
        </div>
        {runPump.error && <InlineError>{runPump.error.message}</InlineError>}
      </Chip>
    ),
    (
      <Chip
        key="air"
        {...chip('air')}
        icon={Thermometer}
        label={`${fmt(s.air_temp)} · ${fmt(s.humidity)}`}
      >
        <PanelHead title="Environment" ts={s.air_temp?.ts} value={`${fmt(s.air_temp)} · ${fmt(s.humidity)}`} />
        <div className="mt-2 flex flex-col gap-3">
          <Trend label="Air temperature" points={airHistory.data ?? []} color="var(--chart-temp)" unit={s.air_temp?.unit ?? '°C'} height={56} />
          <Trend label="Humidity" points={humidityHistory.data ?? []} color="var(--chart-humidity)" unit="%" height={56} />
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
          <KeyValue label="Air" value={fmt(s.air_temp)} size={13} />
          <KeyValue label="Humidity" value={fmt(s.humidity)} size={13} />
          <KeyValue label="Board" value={fmt(s.pcb_temp)} size={13} />
        </div>
      </Chip>
    ),
  ]

  return (
    <div className="mx-auto grid max-w-[1180px] gap-4 [grid-template-areas:'tower'_'side'] min-[900px]:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)] min-[900px]:[grid-template-areas:'tower_side']">
      <div className="min-w-0 [grid-area:tower]">
        <TowerView
          pods={towerPods}
          waterPct={s.water_level_pct?.value ?? null}
          lightLevel={l?.on ? l.level : 0}
          pumpOn={!!p?.on}
          selected={selected}
          onSelect={(slot) => {
            setOpen(null)
            setSelected(slot)
          }}
          onPart={setOpen}
          partLabels={partLabels}
          controls={controls}
          onUnavailable={onUnavailable}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-4 [grid-area:side]">
        {active.length > 0 && (
          <Card tone="warn">
            <CardHeader title={`${active.length} alert${active.length > 1 ? 's' : ''}`} icon={TriangleAlert} right={<Link to="/alerts" className="text-xs text-fg-2 hover:text-fg">All alerts</Link>} />
            <ul className="mt-2 flex flex-col gap-1.5 text-sm">
              {active.map(a => (
                <li key={a.id}>
                  <span className="font-mono text-xs text-fg-2">{a.kind}</span>
                  <span className="block text-fg">{a.detail}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card>
          <CardHeader
            title={cycle ? `Day ${grow.data?.day}` : 'No active cycle'}
            subtitle={cycle ? `${cycle.stage}${cycle.notes ? ` · ${cycle.notes}` : ''}` : 'Start one on Grow for thinning, root-check, harvest and nutrient reminders.'}
            icon={Leaf}
            right={(
              <Link to="/grow" className="flex items-center gap-1 text-xs text-fg-2 hover:text-fg">
                Grow
                <ArrowRight size={12} />
              </Link>
            )}
          />
          <p className="mt-3 font-mono text-[11px] text-fg-3" data-testid="home-counts">
            {`${counts.growing ?? 0} growing · ${counts.harvest ?? 0} ready · ${counts.attention ?? 0} attention`}
          </p>
        </Card>

        <Card>
          <CardHeader
            title={pod ? `Pod ${pod.slot}` : 'Pods'}
            subtitle={pod ? pod.plant ?? 'Empty' : 'Click a pod on the tower. Point at the light, tank or air readings to see and control them.'}
            icon={Sprout}
          />
          {pod && (
            <div className="mt-3 flex flex-col gap-2">
              <KeyValue label="Status" value={STATUS_LABEL[pod.status] ?? pod.status} />
              <KeyValue label="Green area" value={typeof podTrend?.green === 'number' ? `${Math.round(podTrend.green * 100)}%` : '—'} />
              {pod.notes && <KeyValue label="Notes" value={pod.notes} />}
              <Link to="/grow" search={{ pod: pod.slot }} className="mt-1 flex items-center gap-1 text-sm text-fg underline-offset-2 hover:underline">
                Edit on Grow
                <ArrowRight size={14} />
              </Link>
            </div>
          )}
        </Card>

        {quality.length > 0 && (
          <>
            <SectionLabel>Water quality</SectionLabel>
            <div className="grid grid-cols-2 gap-3">
              {quality.map(id => <Metric key={id} label={SENSOR_META[id].label} value={formatReading(s[id])} icon={SENSOR_META[id].icon} />)}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
