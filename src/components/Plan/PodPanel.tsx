import { ArrowLeftRight, ChevronDown, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { ZONE_COLOR, ZONE_LABEL, ZONES, type LightZone } from '@/src/components/Grow/lightZones'
import { Button } from '@/src/components/ds/core'

const SHORT: Record<LightZone, string> = { high: 'High', medium: 'Medium', low: 'Low' }

interface Props {
  slot: number
  zone: LightZone
  /** The plant in the pod, planned or in the tower now, by name and catalog id (null when the catalog doesn't know it). */
  plant: string | null
  plantId: string | null
  /** Why the plan put it here; none for a pod in the tower now. */
  reason?: string
  planted: boolean
  /** A suggested move this pod takes part in, as the Suggested moves card words it. */
  move?: string
  plants: { id: string, name: string, zone: LightZone }[]
  /** The zones this plan may put the pod's plant in, and whether they are the plan's own rather than the plant's usual ones; none when the catalog doesn't know it. */
  zones?: { allowed: LightZone[], own: boolean }
  /** Set the plan's zones for the pod's plant, or null to go back to its usual ones. */
  onZones: (zones: LightZone[] | null) => void
  /** Put this plant in the pod, or none. */
  onPlant: (plantId: string | null) => void
  /** Start picking the pod to swap this one with. */
  onSwap: () => void
  onClose: () => void
}

/**
 * The tapped pod on the plan grid: what's in it and why, a plant to put there
 * instead (those suited to its light first), the zones the plan may use for
 * that plant, and Swap. Planned, planted and empty pods all edit the same way.
 */
export function PodPanel({ slot, zone, plant, plantId, reason, planted, move, plants, zones, onZones, onPlant, onSwap, onClose }: Props) {
  const suited = plants.filter(p => p.zone === zone)
  const others = plants.filter(p => p.zone !== zone)
  const about = reason ? `Planned: ${reason}.` : planted ? 'In the tower now.' : 'Nothing planned here.'
  // Below the layout on a narrow screen, so it comes into view when opened.
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [])
  return (
    <aside ref={ref} aria-label={`Pod ${slot}`} className="flex w-full flex-col gap-3 rounded-[14px] border border-line bg-surface p-4">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-1.5 font-mono text-[11px] tracking-[0.06em] text-fg-3">
            <span className="size-[7px] rounded-full" style={{ background: ZONE_COLOR[zone] }} />
            {`POD ${slot} · ${ZONE_LABEL[zone].toUpperCase()}`}
          </div>
          <div className={plant ? 'truncate text-[17px] font-medium' : 'text-[17px] font-medium text-fg-2'}>{plant ?? 'Empty'}</div>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="cursor-pointer text-fg-3 hover:text-fg"><X size={16} /></button>
      </div>
      <p className="text-[13px] leading-normal text-fg-2">{about}</p>
      {move && (
        <p className="flex gap-1.5 text-[13px] leading-normal text-fg-2">
          <ArrowLeftRight size={14} className="mt-[3px] shrink-0" aria-hidden="true" />
          {`Suggested: ${move}`}
        </p>
      )}
      <label className="flex items-center justify-between gap-3 border-y border-line/70 py-2.5 text-[13px]">
        <span className="shrink-0 text-fg-2">Plant</span>
        <span className="flex min-w-0 items-center gap-1">
          <select
            aria-label="Plant"
            value={plantId ?? ''}
            onChange={e => onPlant(e.target.value)}
            className="min-w-0 max-w-[160px] cursor-pointer appearance-none truncate bg-transparent text-right text-fg outline-none"
          >
            {!plantId && <option value="" disabled>{plant ?? 'Pick a plant'}</option>}
            <optgroup label={`Suits ${ZONE_LABEL[zone].toLowerCase()}`}>
              {suited.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </optgroup>
            <optgroup label="Other plants">
              {others.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </optgroup>
          </select>
          <ChevronDown size={16} className="pointer-events-none shrink-0 text-fg-2" />
        </span>
      </label>
      {zones && (
        <div className="flex flex-col gap-1.5 text-[13px]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-fg-2">Does ok in</span>
            <span role="group" aria-label="Zones for this plan" className="flex gap-1">
              {ZONES.map((z) => {
                const on = zones.allowed.includes(z)
                return (
                  <button
                    key={z}
                    type="button"
                    aria-pressed={on}
                    // A plant needs one zone at least.
                    disabled={on && zones.allowed.length === 1}
                    onClick={() => onZones(on ? zones.allowed.filter(x => x !== z) : [...zones.allowed, z])}
                    className={cn('rounded-full border px-2 py-0.5 text-[11px] disabled:cursor-not-allowed', on ? 'border-fg-2 text-fg' : 'border-line text-fg-3')}
                  >
                    {SHORT[z]}
                  </button>
                )
              })}
            </span>
          </div>
          <span className="text-[11px] text-fg-3">
            {zones.own
              ? (
                  <>
                    {'Your zones for this plan. '}
                    <button type="button" onClick={() => onZones(null)} className="cursor-pointer underline">Usual zones</button>
                  </>
                )
              : 'Its usual zones; change them for this plan.'}
          </span>
        </div>
      )}
      <div className="flex gap-2">
        <Button icon={ArrowLeftRight} className="min-w-0 flex-1" onClick={onSwap}>Swap</Button>
        {plant && <Button onClick={() => onPlant(null)}>Remove</Button>}
      </div>
    </aside>
  )
}
