/**
 * What the Pods tab says about each pod, as plain functions: its state from
 * the grower's label, the tagger's suggestion or the pod record; whether a
 * seeded pod has gone past its plant's sprouting window; and the words for
 * its tag, its list row and the page's summary.
 */
import type { inferRouterOutputs } from '@trpc/server'
import { ageDays } from '@/src/components/Grow/towerLayout'
import type { SproutWindow } from '@/src/plants/catalog'
import type { AppRouter } from '@/src/server/routers/app'
import type { PodLabelValue } from '@/src/store/types'

type Outputs = inferRouterOutputs<AppRouter>
type Pod = Outputs['grow']['pods'][number]
type Label = Outputs['vision']['labels'][number]
type Hint = Outputs['vision']['suggestions'][number]

const pct = (v: number) => `${Math.round(v * 100)}%`

/**
 * A pod's state and where it came from: the grower's label on the latest
 * photo (`label`), their last label carried forward (`carry`), a confident
 * pod-state model (`model`), or the pod record (`record`). `at` is when the
 * grower labelled it; `by` names the model with its confidence.
 */
export interface PodState {
  stage: PodLabelValue
  from: 'label' | 'carry' | 'model' | 'record'
  at: string | null
  by: string | null
  confidence: number | null
}

/** The record's status as a label, for a pod nothing has labelled or suggested. */
const RECORD: Record<Pod['status'], PodLabelValue> = { empty: 'empty', seeded: 'seeded', growing: 'growing', harvest: 'ready', attention: 'unhealthy' }

/**
 * A pod's state on the latest photo. A pod with no record, or marked empty,
 * is empty whatever the photo shows; otherwise the grower's label on that
 * photo, then the tagger's suggestion for it (which carries their last label
 * forward unless the model is sure of a later stage), then the record.
 */
export function podState(pod: Pod | undefined, label: Label | undefined, hint: Hint | undefined): PodState {
  const none = { at: null, by: null, confidence: null }
  if (!pod || pod.status === 'empty') return { stage: 'empty', from: 'record', ...none }
  if (label) return { stage: label.label, from: 'label', ...none, at: label.labelledAt }
  if (hint?.by === 'carry') return { stage: hint.label, from: 'carry', ...none, at: hint.from }
  if (hint && hint.by !== 'record') return { stage: hint.label, from: 'model', ...none, by: hint.by, confidence: hint.confidence }
  return { stage: hint?.label ?? RECORD[pod.status], from: 'record', ...none }
}

/** Everything the Pods tab knows about one pod beyond its record: its state, its age, its plant's sprouting window and where it stands against it, and its confirmed yCube code. */
export interface PodStory {
  state: PodState
  day: number | null
  window: SproutWindow | null
  sprout: Sprouting | null
  code: string | null
}

/** Whole days since a pod was sown, or null with no sowing date. */
export function podDay(plantedAt: string | null | undefined, now: Date = new Date()): number | null {
  const d = ageDays(plantedAt, now)
  return d === null ? null : Math.floor(d)
}

/** Where a planted pod stands against its plant's sprouting window. */
export type Sprouting = 'on time' | 'late' | 'sprouted'

/**
 * A pod still seeded after the last day its plant usually sprouts by is
 * late; one still seeded before then is on time; one showing a sprout or
 * more has sprouted. Null for an empty or unhealthy pod, or with no sowing
 * date or window to go by.
 */
export function sprouting(stage: PodLabelValue, day: number | null, window: SproutWindow | null): Sprouting | null {
  if (day === null || !window || stage === 'empty' || stage === 'unhealthy') return null
  if (stage !== 'seeded') return 'sprouted'
  return day > window.days[1] ? 'late' : 'on time'
}

/** The sprouting-window chip: `day 8 · on time`, `day 12 · late`, `day 8 · sprouted`, or just the day without a window. */
export function sproutChip(day: number | null, sprout: Sprouting | null): string | null {
  if (day === null) return null
  return sprout ? `day ${day} · ${sprout}` : `day ${day}`
}

/** Who said what the pod is, and when: `you · 17 Nov`, `pod-state 86%`, `pod record`. */
export function labelledBy(s: PodState): string {
  const when = (ts: string) => new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' })
  if ((s.from === 'label' || s.from === 'carry') && s.at) return `you · ${when(s.at)}`
  if (s.from === 'model' && s.by) return `${s.by.split('@')[0]}${s.confidence === null ? '' : ` ${pct(s.confidence)}`}`
  return 'pod record'
}

/** The window in words: `day 5–10 typical`, or `about day 7–14` when it is the category's rather than the plant's. */
export function windowText(w: SproutWindow): string {
  const [a, b] = w.days
  return w.estimated ? `about day ${a}–${b}` : `day ${a}–${b} typical`
}

/** A plant's name short enough for a tag on the photo: leading words go while it is longer than ten letters. "Perpetual Spinach" → "Spinach", "Green Bok Choy" → "Bok Choy". */
export function shortName(plant: string): string {
  const words = plant.trim().split(/\s+/)
  while (words.length > 1 && words.join(' ').length > 10) words.shift()
  return words.join(' ')
}

/** Leaf cover now and since the first of the recent photos: `1% ↑ from 0%`. */
export function coverChange(recent: readonly number[], now: number | null): string | null {
  if (now === null) return null
  const first = recent.length > 1 ? recent[0] : undefined
  if (first === undefined || Math.round(first * 100) === Math.round(now * 100)) return pct(now)
  return `${pct(now)} ${now > first ? '↑' : '↓'} from ${pct(first)}`
}

/** The page's summary on Pods: `Day 8 · 10 planted · 2 sprouted · 2 look late`. */
export function podsSummary(day: number | null, pods: ReadonlyArray<{ stage: PodLabelValue, sprout: Sprouting | null }>): string {
  const planted = pods.filter(p => p.stage !== 'empty')
  const up = planted.filter(p => p.stage === 'sprouted' || p.stage === 'growing' || p.stage === 'ready').length
  const late = planted.filter(p => p.sprout === 'late').length
  return [
    day !== null && `Day ${day}`,
    `${planted.length} planted`,
    up > 0 && `${up} sprouted`,
    late > 0 && `${late} ${late === 1 ? 'looks' : 'look'} late`,
  ].filter(Boolean).join(' · ')
}
