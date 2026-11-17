/**
 * Pod boxes that look off their pod, for Teach's queue. The tagger asks the
 * grower to dismiss a suggestion where the pod can't be seen or its box isn't
 * on one (#261), so a pod dismissed on photo after photo is a box to move, or
 * to remove where the camera can't see the pod at all.
 */
import type { Store } from '../store/types'
import { cameraOf, type Camera } from './regions'

/** Dismissals older than this say nothing about the box now. */
export const OFF_WINDOW_MS = 7 * 86_400_000
/** One dismissal can be a pod hidden by a neighbour's leaves; this many photos is the box. */
export const OFF_PHOTOS = 2

export interface BoxOff {
  camera: Camera
  slot: number
  /** The photos in the window its suggestion was dismissed on. */
  photos: number
}

/**
 * Each pod whose suggestion was dismissed on OFF_PHOTOS or more photos taken
 * in the last OFF_WINDOW_MS, while its box is still the measured default.
 * Moving or removing the box takes it off the list, by slot.
 */
export function boxesOff(store: Pick<Store, 'dismissals' | 'settings'>, now: Date): BoxOff[] {
  const own = store.settings.get().podRegions
  const photos = new Map<number, Set<string>>()
  for (const d of store.dismissals.range(new Date(now.getTime() - OFF_WINDOW_MS).toISOString(), now.toISOString())) {
    photos.set(d.slot, (photos.get(d.slot) ?? new Set()).add(d.captureId))
  }
  const out: BoxOff[] = []
  for (const [slot, ids] of [...photos].sort(([a], [b]) => a - b)) {
    const camera = cameraOf(slot)
    if (!camera || ids.size < OFF_PHOTOS || own?.[camera]?.[slot] !== undefined) continue
    out.push({ camera, slot, photos: ids.size })
  }
  return out
}
