import { ArrowLeftRight, ChevronDown, X } from 'lucide-react'
import { ZONE_COLOR, ZONE_LABEL, type LightZone } from '@/src/components/Grow/lightZones'
import { Button } from '@/src/components/ds/core'

interface Props {
  slot: number
  zone: LightZone
  /** The plant in the pod, planned or in the tower now, by name and catalog id (null when the catalog doesn't know it). */
  plant: string | null
  plantId: string | null
  /** Why the plan put it here; none for a pod in the tower now. */
  reason?: string
  planted: boolean
  plants: { id: string, name: string, zone: LightZone }[]
  /** Put this plant in the pod, or none. */
  onPlant: (plantId: string | null) => void
  /** Start picking the pod to swap this one with. */
  onSwap: () => void
  onClose: () => void
}

/**
 * The tapped pod on the plan grid: what's in it and why, a plant to put there
 * instead (those suited to its light first), and Swap. Planned, planted and
 * empty pods all edit the same way.
 */
export function PodPanel({ slot, zone, plant, plantId, reason, planted, plants, onPlant, onSwap, onClose }: Props) {
  const suited = plants.filter(p => p.zone === zone)
  const others = plants.filter(p => p.zone !== zone)
  const about = reason ? `Planned: ${reason}.` : planted ? 'In the tower now.' : 'Nothing planned here.'
  return (
    <aside aria-label={`Pod ${slot}`} className="flex w-full shrink-0 flex-col gap-3 rounded-[14px] border border-line bg-surface p-4 min-[640px]:w-[260px]">
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
      <div className="flex gap-2">
        <Button icon={ArrowLeftRight} full onClick={onSwap}>Swap</Button>
        {plant && <Button onClick={() => onPlant(null)}>Remove</Button>}
      </div>
    </aside>
  )
}
