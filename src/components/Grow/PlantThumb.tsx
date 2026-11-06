import { Leaf } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'
import { cachedThumb, plantThumb, thumbKey, threeLoaded } from './plantThumbs'
import { plantForm, plantScale, type PlantForm, type PodStatus } from './towerLayout'

/** The stage a pod's plant is drawn at, as the tower draws it: 'none' when the pod is empty. */
export function podForm(p: { status: PodStatus, green?: number | null, ageDays?: number | null }): PlantForm {
  return plantForm(p.status, plantScale(p.status, p.green, p.ageDays))
}

const subscribeTheme = (cb: () => void) => {
  const o = new MutationObserver(cb)
  o.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => o.disconnect()
}
/** Whether the page is on the light theme, following changes to it. */
export const useLightTheme = () => useSyncExternalStore(subscribeTheme, () => document.documentElement.dataset.theme === 'light', () => false)

/**
 * A pod's plant as a small still of its 3D model at `stage`, rendered once and
 * shared. An unrecognised plant (or one still rendering, or no WebGL) shows a
 * plain neutral leaf instead, so the generic model never passes for a variety
 * at a glance; an empty pod, an empty dashed ring. Decorative: the plant's name
 * always sits beside it. `passive` keeps the leaf until three.js is on the page
 * anyway: the sidebar shows on every page, and one thumbnail isn't worth 150 KB.
 */
export function PlantThumb({ plant, stage, size = 36, passive = false, className }: { plant: string | null | undefined, stage: PlantForm, size?: number, passive?: boolean, className?: string }) {
  const light = useLightTheme()
  const key = stage === 'none' ? null : thumbKey(plant, stage, light)
  const [loaded, setLoaded] = useState<{ key: string, url: string } | null>(null)
  useEffect(() => {
    if (!key || stage === 'none') return
    let alive = true
    void (passive ? threeLoaded() : Promise.resolve()).then(() => plantThumb(plant, stage, light)).then((url) => {
      if (alive && url) setLoaded({ key, url })
    })
    return () => {
      alive = false
    }
  }, [key, plant, stage, light, passive])
  const url = cachedThumb(key) ?? (loaded?.key === key ? loaded.url : null)
  const kind = url ? 'model' : stage === 'none' ? 'empty' : 'neutral'
  return (
    <span
      data-testid="plant-thumb"
      data-kind={kind}
      aria-hidden="true"
      className={cn('grid shrink-0 place-items-center overflow-hidden rounded-full', kind === 'empty' ? 'border border-dashed border-line-2' : 'bg-active text-fg-3', className)}
      style={{ width: size, height: size }}
    >
      {url
        ? <img src={url} alt="" width={size} height={size} className="size-full object-contain" />
        : kind === 'neutral' && <Leaf size={Math.round(size * 0.5)} strokeWidth={1.75} />}
    </span>
  )
}
