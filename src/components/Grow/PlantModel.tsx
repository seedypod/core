import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { lookup } from './plants/catalog'
import { STAGES, type Stage } from './plants/kit'
import type { PlantMount } from './plantRenderer'
import { loadPlantRenderer, webGL } from './plantThumbs'
import { PlantThumb } from './PlantThumb'

/** What the scrubber calls each stage, seedling to harvest. */
export const STAGE_LABEL: Record<Stage, string> = { sprout: 'seedling', young: 'young', bush: 'bushy', full: 'harvest' }

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * A pod's plant as a small, slowly turning 3D model (still under
 * prefers-reduced-motion), with a scrubber across its stages from seedling to
 * harvest that starts on `today`'s, to compare today's plant with a
 * harvest-ready one. An unrecognised plant is labelled the generic model.
 * Without WebGL the still (or its neutral stand-in) shows instead. Key it by
 * pod and stage so a new pod starts on its own stage.
 */
export function PlantModel({ plant, today, seed }: { plant: string | null, today: Stage, seed: number }) {
  const host = useRef<HTMLDivElement>(null)
  const [mount, setMount] = useState<PlantMount | null>(null)
  const [stage, setStage] = useState(today)
  const [failed, setFailed] = useState(() => !webGL())
  const generic = lookup(plant) === null

  useEffect(() => {
    const el = host.current
    if (failed || !el) return
    let alive = true
    let m: PlantMount | null = null
    void loadPlantRenderer().then((mod) => {
      if (!alive) return
      m = mod.mountPlant(el, { plant, seed, turn: !reducedMotion(), onFail: () => setFailed(true) })
      setMount(m)
    }).catch(() => {
      if (alive) setFailed(true)
    })
    return () => {
      alive = false
      m?.dispose()
      setMount(null)
    }
  }, [plant, seed, failed])

  useEffect(() => {
    mount?.show(stage)
  }, [mount, stage])

  const at = STAGES.indexOf(stage)
  return (
    <div className="flex flex-col gap-2" data-testid="plant-model">
      <div className="relative grid h-[150px] place-items-center overflow-hidden rounded-[10px] bg-app">
        {failed
          ? <PlantThumb plant={plant} stage={stage} size={88} />
          : <div ref={host} className="absolute inset-0" data-ready={mount ? true : undefined} />}
        {generic && <span className="absolute left-2 top-1.5 rounded bg-surface/80 px-1.5 py-0.5 font-mono text-[10px] text-fg-3">generic model</span>}
      </div>
      <input
        type="range"
        min={0}
        max={STAGES.length - 1}
        step={1}
        value={at}
        aria-label="Growth stage"
        aria-valuetext={`${STAGE_LABEL[stage]}${stage === today ? ' (today)' : ''}`}
        onChange={e => setStage(STAGES[Number(e.target.value)] ?? today)}
        className="w-full cursor-pointer accent-[var(--text-2)]"
      />
      <div className="flex justify-between font-mono text-[10px] text-fg-3">
        {STAGES.map(s => (
          <span key={s} className={cn(s === stage && 'text-fg')}>{s === today ? `${STAGE_LABEL[s]} · today` : STAGE_LABEL[s]}</span>
        ))}
      </div>
    </div>
  )
}
