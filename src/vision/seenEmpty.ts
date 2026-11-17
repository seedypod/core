/**
 * Pods the cameras see empty while their record still holds a plant: the
 * plant was taken out and the record never heard. It reads what the pod-state
 * model already stored, the same results the tagger's suggestions use (#261).
 */
import type { Store } from '../store/types'
import { POD_STATE_ID } from './podState'
import { SUGGEST_CONFIDENCE } from './suggestLabel'

/** Older than this, the newest result says nothing about the pod now: the cameras stopped, or the light stayed off. */
export const SEEN_MAX_AGE_MS = 2 * 86_400_000

export interface SeenEmpty {
  slot: number
  /** The model's confidence that the pod is empty. */
  confidence: number
  /** The photo's time. */
  ts: string
}

/**
 * Each pod whose newest pod-state result (the newest version's) says `empty`
 * with confidence ≥ SUGGEST_CONFIDENCE, from a photo taken after the pod's
 * record last changed and within SEEN_MAX_AGE_MS. Dark stills are never
 * scored, so they never count. Seeded pods are left out: the model has no
 * `seeded` class, so a sown yCube looks empty to it.
 */
export function seenEmpty(store: Pick<Store, 'pods' | 'analyses'>, now: Date): SeenEmpty[] {
  const since = now.getTime() - SEEN_MAX_AGE_MS
  const version = Math.max(0, ...store.analyses.stats().filter(s => s.analyzer === POD_STATE_ID).map(s => s.version))
  const out: SeenEmpty[] = []
  for (const pod of store.pods.list()) {
    if (pod.status === 'empty' || pod.status === 'seeded') continue
    const last = store.analyses.series({ analyzer: POD_STATE_ID, version, slot: pod.slot, metric: 'pod_state', limit: 1 }).at(-1)
    const t = last ? Date.parse(last.ts) : Number.NaN
    if (!last || !(t >= since) || t <= Date.parse(pod.updatedAt)) continue
    const d = store.analyses.forCapture(last.captureId).find(r => r.analyzer === POD_STATE_ID && r.version === version && r.slot === pod.slot && r.metric === 'pod_state')?.detail
    if (d?.state === 'empty' && typeof d.confidence === 'number' && d.confidence >= SUGGEST_CONFIDENCE) out.push({ slot: pod.slot, confidence: d.confidence, ts: last.ts })
  }
  return out
}
