import { Link, useNavigate } from '@tanstack/react-router'
import { Camera, History } from 'lucide-react'
import { useState } from 'react'
import { CareSummary } from '@/src/components/Care/CareSummary'
import { TowerView } from '@/src/components/Grow/TowerView'
import { ageDays, podShown, SHOWN_TOKEN, type PodShown } from '@/src/components/Grow/towerLayout'
import type { TowerPart } from '@/src/components/Grow/towerScene'
import type { Reading, SensorId } from '@/src/hardware/contract'
import { withUnit } from '@/src/lib/sensorMeta'
import { trpc } from '@/src/utils/trpc'

const fmt = (r: Reading | undefined) => (r ? withUnit(r.value, r.unit) : '—')

/** Where a click on each part of the tower goes: its page, now its readings live in the sidebar. */
const PART_PAGE = { light: '/light', tank: '/water', air: '/sensors' } as const satisfies Record<TowerPart, string>

/** The counts over the tower, each with the statuses it takes in, so they add up to every pod. */
const COUNTED: { shown: PodShown, label: string, takes: PodShown[] }[] = [
  { shown: 'growing', label: 'growing', takes: ['growing', 'soon', 'seeded'] },
  { shown: 'ready', label: 'ready', takes: ['ready'] },
  { shown: 'attention', label: 'attention', takes: ['attention'] },
  { shown: 'empty', label: 'empty', takes: ['empty'] },
]

const SECONDARY = 'flex items-center justify-center gap-1.5 rounded-ctl border border-line-2 p-[9px] text-[13px] text-fg-2 hover:bg-active hover:text-fg'

/**
 * Home (after ADR-0021's restore work made it the first screen): the tower in
 * 3D across the page, the cycle's day, stage and pod counts over its top left,
 * and the picked pod's callout pinned to it with what to do about it. Light,
 * tank and air live in the sidebar; clicking the light bars or the tank opens
 * their page.
 */
export function TowerHome({ onUnavailable }: { onUnavailable: () => void }) {
  const navigate = useNavigate()
  const sensors = trpc.sensors.latest.useQuery()
  const lightState = trpc.light.get.useQuery()
  const pumpState = trpc.pump.get.useQuery()
  const grow = trpc.grow.current.useQuery()
  const pods = trpc.grow.pods.useQuery()
  const trends = trpc.vision.podTrends.useQuery()
  const harvest = trpc.grow.harvest.useQuery(undefined, { refetchInterval: 10 * 60_000 })
  const markHarvested = trpc.grow.markHarvested.useMutation({ onSuccess: () => Promise.all([pods.refetch(), harvest.refetch()]) })
  const updatePod = trpc.grow.updatePod.useMutation({ onSuccess: () => pods.refetch() })
  const [selected, setSelected] = useState<number | null>(null)

  const s: Partial<Record<SensorId, Reading>> = sensors.data ?? {}
  const l = lightState.data
  const p = pumpState.data
  const all = pods.data ?? []
  const green = new Map((trends.data ?? []).map(t => [t.slot, t]))
  const outlook = new Map((harvest.data ?? []).map(o => [o.slot, o]))
  const towerPods = all.map((x) => {
    const t = green.get(x.slot)
    return { slot: x.slot, status: x.status, plant: x.plant, green: t?.green ?? null, verdict: t?.verdict, recent: t?.recent, notes: x.notes, ageDays: ageDays(x.plantedAt), statusSince: x.statusSince, harvest: outlook.get(x.slot) ?? null }
  })
  const shownOf = new Map(towerPods.map(x => [x.slot, podShown(x)]))
  // Counted as the tower shows them, so "ready" includes pods the camera calls ready.
  const counts = [...shownOf.values()].reduce<Partial<Record<PodShown, number>>>((m, v) => ({ ...m, [v]: (m[v] ?? 0) + 1 }), {})
  const picked = selected === null ? null : towerPods.find(x => x.slot === selected) ?? null
  const cycle = grow.data?.cycle

  const partLabels: Partial<Record<TowerPart, string>> = {
    light: `Grow light · ${l ? (l.on ? `${l.level}%` : 'off') : '…'}`,
    tank: `Tank · ${fmt(s.water_level_pct)}${p?.on ? ' · pump running' : ''}`,
  }
  const overview = (
    <div className="flex flex-col gap-1.5 pl-2.5 pt-2" data-testid="home-cycle">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <div className="font-mono text-[24px] font-medium">{cycle ? `Day ${grow.data?.day}` : 'No cycle'}</div>
        <div className="text-[13px] text-fg-2">
          {cycle
            ? `${cycle.stage[0]?.toUpperCase()}${cycle.stage.slice(1)}${cycle.notes ? ` · ${cycle.notes}` : ''}`
            : <Link to="/grow" className="hover:text-fg">Start one on Grow for thinning, root-check, harvest and nutrient reminders.</Link>}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 font-mono text-[11px] text-fg-2" data-testid="home-counts">
        {COUNTED.map(c => (
          <span key={c.shown} className="flex items-center gap-1.5">
            <span className="size-[7px] rounded-full" style={{ background: SHOWN_TOKEN[c.shown] }} />
            {`${c.takes.reduce((n, t) => n + (counts[t] ?? 0), 0)} ${c.label}`}
          </span>
        ))}
      </div>
      <CareSummary className="pt-0.5" />
    </div>
  )

  const shown = picked ? shownOf.get(picked.slot) : undefined
  // The pod's leaf-cover trend lives on Grow; beside "Mark harvested" it's an icon alone.
  const history = (slot: number, iconOnly: boolean) => (
    <Link to="/grow" search={{ pod: slot }} aria-label="Growth history" className={`${SECONDARY} ${iconOnly ? 'px-3' : 'flex-1'}`}>
      <History size={16} strokeWidth={1.75} />
      {!iconOnly && 'Growth history'}
    </Link>
  )
  const podAction = picked && (
    shown === 'ready'
      ? (
          <>
            <button type="button" disabled={markHarvested.isPending} onClick={() => markHarvested.mutate({ slot: picked.slot })} className="flex-1 rounded-ctl bg-pod-ready p-[9px] text-[13px] font-medium text-inverse hover:opacity-90 disabled:opacity-60">
              Mark harvested
            </button>
            {history(picked.slot, true)}
          </>
        )
      : shown === 'attention'
        ? (
            <>
              <Link to="/cameras" className={`${SECONDARY} flex-1 text-fg`}>
                <Camera size={16} strokeWidth={1.75} />
                View photo
              </Link>
              <button type="button" disabled={updatePod.isPending} onClick={() => updatePod.mutate({ slot: picked.slot, status: 'growing' })} className={`${SECONDARY} px-3 disabled:opacity-60`}>
                Dismiss
              </button>
            </>
          )
        : shown === 'empty'
          ? <Link to="/grow" search={{ pod: picked.slot }} className={`${SECONDARY} flex-1`}>Plant on Grow</Link>
          : history(picked.slot, false)
  )

  return (
    <TowerView
      pods={towerPods}
      waterPct={s.water_level_pct?.value ?? null}
      lightLevel={l?.on ? l.level : 0}
      pumpOn={!!p?.on}
      selected={selected}
      onSelect={slot => setSelected(slot === selected ? null : slot)}
      onClose={() => setSelected(null)}
      onPart={part => void navigate({ to: PART_PAGE[part] })}
      partLabels={partLabels}
      controls={overview}
      legend={false}
      podAction={podAction}
      onUnavailable={onUnavailable}
    />
  )
}
