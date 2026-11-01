/**
 * Harvest outlook per pod (ADR-0022). The camera leads: leaf cover (the
 * primary analyser's green fraction) against a target, and how fast it is
 * climbing, give "ready" or "about N days". An optional plant profile adds a
 * harvest window in days from planting and its own target; without photos the
 * window alone decides. Read-only: it never changes a pod's status.
 */
import type { PlantProfile, Pod, Store } from '../store/types'

const DAY_MS = 86_400_000
/** Leaf cover at which a crop with no profile counts as ready. */
export const DEFAULT_TARGET_COVER = 0.4
/** "Soon" is ready within this many days. */
export const SOON_DAYS = 7
/** How long a window the camera's estimate opens, lacking a profile's. */
export const CAMERA_WINDOW_DAYS = 7
/** Below this daily gain the cover is called level. */
const LEVEL_PER_DAY = 0.002
const MIN_POINTS = 4

export type HarvestState = 'ready' | 'soon' | 'growing' | 'unknown'

export interface HarvestOutlook {
  slot: number
  plant: string | null
  state: HarvestState
  ageDays: number | null
  /** Latest leaf cover since planting or the last cut, 0–1. */
  cover: number | null
  targetCover: number
  /** Leaf cover gained per day over the recent photos. */
  coverPerDay: number | null
  /** The harvest window in days from planting, and where it came from. */
  window: { start: number, end: number, source: 'profile' | 'camera' } | null
  /** 0 when ready now. */
  daysToReady: number | null
  /** Days left in the window, once ready. */
  daysLeft: number | null
  /** The profile that matched, by name. */
  profile: string | null
  /** One sentence: why this state. */
  reason: string
}

const pct = (v: number) => `${Math.round(v * 100)}%`
const days = (v: number) => `${Math.max(0, Math.round(v))} d`

/** The profile for a plant name: an exact name, else the longest profile name whose words all appear in it ("Kale" for "Red Russian Kale"). */
export function matchProfile(plant: string | null, profiles: PlantProfile[]): PlantProfile | null {
  if (!plant) return null
  const key = plant.trim().toLowerCase()
  const exact = profiles.find(p => p.key === key)
  if (exact) return exact
  const have = new Set(key.split(/[^a-zÀ-ɏ]+/).filter(Boolean))
  let best: PlantProfile | null = null
  for (const p of profiles) {
    const ws = p.key.split(/[^a-zÀ-ɏ]+/).filter(Boolean)
    if (ws.length > 0 && ws.every(w => have.has(w)) && (!best || p.key.length > best.key.length)) best = p
  }
  return best
}

/** Least-squares slope of value over days. */
function slopePerDay(points: { t: number, v: number }[]): number {
  const n = points.length
  const mt = points.reduce((s, p) => s + p.t, 0) / n
  const mv = points.reduce((s, p) => s + p.v, 0) / n
  let num = 0
  let den = 0
  for (const p of points) {
    num += (p.t - mt) * (p.v - mv)
    den += (p.t - mt) ** 2
  }
  return den === 0 ? 0 : num / den
}

/** One pod's outlook from its leaf-cover series (oldest first) and profile. */
export function outlookFor(pod: Pod, series: { ts: string, value: number }[], profile: PlantProfile | null, now: Date): HarvestOutlook {
  const t = now.getTime()
  const planted = pod.plantedAt ? Date.parse(pod.plantedAt) : Number.NaN
  const ageDays = Number.isNaN(planted) ? null : Math.max(0, (t - planted) / DAY_MS)
  const cut = pod.lastHarvestAt ? Date.parse(pod.lastHarvestAt) : Number.NaN
  const from = Math.max(Number.isNaN(planted) ? -Infinity : planted, Number.isNaN(cut) ? -Infinity : cut)
  const pts = series.map(p => ({ t: Date.parse(p.ts), v: p.value })).filter(p => p.t > from && p.t <= t)
  const target = profile?.targetCover ?? DEFAULT_TARGET_COVER
  const cover = pts.at(-1)?.v ?? null
  const recent = pts.slice(-12)
  const span = recent.length > 1 ? ((recent.at(-1)?.t ?? 0) - (recent[0]?.t ?? 0)) / DAY_MS : 0
  const rate = recent.length >= MIN_POINTS && span >= 1 ? slopePerDay(recent.map(p => ({ t: p.t / DAY_MS, v: p.v }))) : null
  const out: HarvestOutlook = { slot: pod.slot, plant: pod.plant, state: 'unknown', ageDays, cover, targetCover: target, coverPerDay: rate, window: null, daysToReady: null, daysLeft: null, profile: profile?.name ?? null, reason: '' }

  // The camera's view.
  const crossed = pts.find(p => p.v >= target)
  const level = cover !== null && rate !== null && cover >= target * 0.75 && rate <= LEVEL_PER_DAY && span >= 3
  const cameraReady = cover !== null && (cover >= target || level)
  const eta = !cameraReady && cover !== null && rate !== null && rate > LEVEL_PER_DAY ? (target - cover) / rate : null

  // The window: the profile's from planting, else the camera's. A cut pod has regrowth, not a first window.
  if (profile?.harvestMinDays != null && profile.harvestMaxDays != null && ageDays !== null && Number.isNaN(cut)) {
    out.window = { start: profile.harvestMinDays, end: profile.harvestMaxDays, source: 'profile' }
  }
  else if (ageDays !== null && (cameraReady || eta !== null)) {
    const start = cameraReady ? ageDays - (t - (crossed?.t ?? t)) / DAY_MS : ageDays + (eta ?? 0)
    out.window = { start: Math.round(start * 10) / 10, end: Math.round((start + CAMERA_WINDOW_DAYS) * 10) / 10, source: 'camera' }
  }
  const coverNote = cover === null ? '' : ` Leaf cover ${pct(cover)}, ${cover >= target ? 'above' : 'behind'} the ${pct(target)} target.`
  const leftIn = (w: NonNullable<HarvestOutlook['window']>) => (ageDays === null ? null : Math.max(0, w.end - ageDays))

  if (pod.status === 'harvest' || cameraReady) {
    out.state = 'ready'
    out.daysToReady = 0
    out.daysLeft = out.window ? leftIn(out.window) : null
    const best = out.daysLeft !== null ? (out.daysLeft > 0 ? `Best within ${days(out.daysLeft)}.` : 'Past its window; cut soon.') : ''
    const why = pod.status === 'harvest' && !cameraReady
      ? 'Marked ready on Grow.'
      : level && cover !== null && cover < target ? `Leaf cover has levelled off at ${pct(cover)}.` : ''
    out.reason = [best, why, why.startsWith('Leaf') ? '' : coverNote.trim()].filter(Boolean).join(' ')
  }
  else if (eta !== null && cover !== null && rate !== null) {
    out.state = eta <= SOON_DAYS ? 'soon' : 'growing'
    out.daysToReady = Math.round(eta * 10) / 10
    out.reason = `Leaf cover ${pct(cover)}, gaining ${(rate * 100).toFixed(1)}% a day: about ${days(eta)} to the ${pct(target)} target.`
  }
  else if (out.window?.source === 'profile' && ageDays !== null) {
    const w = out.window
    const range = `${w.start}–${w.end} d`
    if (ageDays >= w.start) {
      out.state = 'ready'
      out.daysToReady = 0
      out.daysLeft = leftIn(w)
      out.reason = ageDays > w.end ? `Past its ${range} window.${coverNote}` : `Day ${Math.floor(ageDays)} of a ${range} window for ${profile?.name}.${coverNote}`
    }
    else {
      out.state = w.start - ageDays <= SOON_DAYS ? 'soon' : 'growing'
      out.daysToReady = Math.round((w.start - ageDays) * 10) / 10
      out.reason = `${days(w.start - ageDays)} until its ${range} window.${coverNote}`
    }
  }
  else if (cover !== null) {
    out.state = 'growing'
    out.reason = `Leaf cover ${pct(cover)} of a ${pct(target)} target; a few more photos will give a rate.`
  }
  else {
    out.reason = !Number.isNaN(cut)
      ? 'Cut recently; waiting for photos of the regrowth.'
      : ageDays === null ? 'No photos yet, and no planting date for a harvest window.' : 'No photos yet, and no harvest window for this plant.'
  }
  out.reason = out.reason.trim()
  return out
}

/** The outlook for every planted pod, from the primary analyser's leaf cover. */
export function harvestOutlook(store: Store, now: Date): HarvestOutlook[] {
  const analyzer = store.settings.get().primaryAnalyzer
  const profiles = store.plants.list()
  return store.pods.list().filter(p => p.status !== 'empty').map((pod) => {
    const series = store.analyses.series({ analyzer, slot: pod.slot, metric: 'green_fraction', limit: 96 }).map(p => ({ ts: p.ts, value: p.value }))
    return outlookFor(pod, series, matchProfile(pod.plant, profiles), now)
  })
}
