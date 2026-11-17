/**
 * How well each analyser agrees with the grower's labels: the labels given
 * in Teach are the yardstick for the methods, so the Methods tab can say
 * which version is right rather than only that they differ.
 *
 * A green-area reading agrees when an `empty` or `seeded` pod reads under 2 %
 * and a `sprouted`, `growing` or `ready` pod reads 2 % or more. An
 * `unhealthy` pod can be green or brown, so green area isn't scored on it.
 * A pod-state reading agrees when its class is the label; the model has no
 * `seeded` class, so a `seeded` pod agrees with `empty`.
 */
import type { AnalysisRow, PodLabel, PodLabelValue } from '../store/types'
import { POD_STATES } from './podState'

/** The green area that tells a pod with a plant up from one without. */
export const AGREE_GREEN = 0.02

/** What each label expects of green area: no plant up, a plant up, or no say. */
const GREEN: Record<PodLabelValue, 'under' | 'over' | null> = {
  empty: 'under',
  seeded: 'under',
  sprouted: 'over',
  growing: 'over',
  ready: 'over',
  unhealthy: null,
}

export interface Agreement {
  analyzer: string
  version: number
  /** The metric scored: `green_fraction` or `pod_state`. */
  metric: string
  /** Labelled pods whose reading agrees. */
  agree: number
  /** Labelled pods scored. */
  total: number
}

type Row = Pick<AnalysisRow, 'captureId' | 'slot' | 'analyzer' | 'version' | 'metric' | 'value' | 'detail'>

/** A pod-state row's class name. */
const stateOf = (r: Pick<Row, 'value' | 'detail'>) => (typeof r.detail?.state === 'string' ? r.detail.state : POD_STATES[r.value])

/** Whether one reading agrees with one label; null when the label says nothing about the metric. */
export function agrees(label: PodLabelValue, r: Pick<Row, 'metric' | 'value' | 'detail'>): boolean | null {
  if (r.metric === 'green_fraction') {
    const want = GREEN[label]
    return want === null ? null : (r.value >= AGREE_GREEN) === (want === 'over')
  }
  if (r.metric === 'pod_state') return stateOf(r) === (label === 'seeded' ? 'empty' : label)
  return null
}

/**
 * Each analyser@version's agreement with the labels, scoring a reading only
 * against the label on the same capture and pod. Analysers with no reading
 * on a labelled pod are left out; the order is the rows' first appearance.
 */
export function agreement(labels: Array<Pick<PodLabel, 'captureId' | 'slot' | 'label'>>, rows: Row[]): Agreement[] {
  const label = new Map(labels.map(l => [`${l.captureId}|${l.slot}`, l.label]))
  const out = new Map<string, Agreement>()
  for (const r of rows) {
    const l = label.get(`${r.captureId}|${r.slot}`)
    if (!l) continue
    const ok = agrees(l, r)
    if (ok === null) continue
    const k = `${r.analyzer}@${r.version}|${r.metric}`
    const a = out.get(k) ?? { analyzer: r.analyzer, version: r.version, metric: r.metric, agree: 0, total: 0 }
    a.total += 1
    if (ok) a.agree += 1
    out.set(k, a)
  }
  return [...out.values()]
}
