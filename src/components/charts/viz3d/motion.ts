/**
 * The maths behind the 3D charts' loading state, kept apart from three.js so
 * it tests on its own: one progress value per chart runs 0→1 over LOAD_MS once
 * data arrives, and each point eases from the grey travelling wave to its value
 * a little after the one before it, so the data sweeps in from the left.
 */

export type VizState = 'loading' | 'ready' | 'empty' | 'error'

/** How long a chart takes to sweep from the loading wave into its data. */
export const LOAD_MS = 1300
/** How long a background refresh takes to move the old values to the new. */
export const TWEEN_MS = 600

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
export const easeOutCubic = (v: number) => 1 - (1 - clamp01(v)) ** 3
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** Load progress P at `now` for data that arrived at `readyAt`; wall-clock, so it advances off-screen too. Reduced motion skips the sweep. */
export function progressAt(readyAt: number | null, now: number, reduced = false): number {
  if (readyAt === null) return 0
  if (reduced) return 1
  return clamp01((now - readyAt) / LOAD_MS)
}

/** How far point `i` of `n` has turned from wave to value at progress `p`: left first, each later one a little behind. */
export function pointEase(p: number, i: number, n: number): number {
  return easeOutCubic(p * 1.5 - (n > 0 ? i / n : 0) * 0.5)
}

/** The loading wave's height at point `i` of `n`, `t` seconds in. */
export function waveY(i: number, n: number, t: number): number {
  return 0.1 + 0.06 * Math.sin((i / Math.max(1, n)) * 9 - t * 3.2)
}

/** A sequential pulse for the pods while loading: 0..1, each pod a beat after the one before. */
export function pulse(i: number, t: number): number {
  return 0.5 + 0.5 * Math.sin(t * 4 - i * 0.45)
}

/** Scene scale so `need` world units always fit the visible width. */
export function fitScale(visibleWidth: number, need: number): number {
  if (!(visibleWidth > 0) || !(need > 0)) return 1
  return Math.min(1, visibleWidth / need)
}

/** Visible width and height in world units at `distance` from a perspective camera. */
export function visibleSize(fovDeg: number, aspect: number, distance: number): { width: number, height: number } {
  const height = 2 * distance * Math.tan((fovDeg * Math.PI) / 360)
  return { width: height * aspect, height }
}

/** World height a label needs so it is at least `minPx` tall on a canvas `heightPx` tall showing `visibleHeight` world units. */
export function labelHeight(base: number, minPx: number, heightPx: number, visibleHeight: number, sceneScale: number): number {
  if (!(heightPx > 0) || !(visibleHeight > 0) || !(sceneScale > 0)) return base
  const perPx = visibleHeight / heightPx / sceneScale
  return Math.max(base, minPx * perPx)
}

/**
 * Where a chart stands between states. `setState('loading')` resets the
 * sweep; `setData` while already shown tweens old values to new instead.
 */
export interface Phase { state: VizState, readyAt: number | null, tweenAt: number | null }

export const initialPhase = (): Phase => ({ state: 'loading', readyAt: null, tweenAt: null })

export function nextPhase(phase: Phase, event: { kind: 'state', state: VizState } | { kind: 'data' }, now: number): Phase {
  if (event.kind === 'state') {
    if (event.state === 'loading') return { state: 'loading', readyAt: null, tweenAt: null }
    if (event.state === 'ready') return phase.state === 'ready' ? phase : { state: 'ready', readyAt: now, tweenAt: null }
    return { state: event.state, readyAt: phase.readyAt, tweenAt: null }
  }
  // New data on a chart already showing data: keep the sweep where it is and tween.
  if (phase.state === 'ready' && phase.readyAt !== null) return { ...phase, tweenAt: now }
  return { state: 'ready', readyAt: now, tweenAt: null }
}

/** Tween position 0..1 for a background refresh started at `tweenAt`. */
export function tweenAt(tweenStart: number | null, now: number, reduced = false): number {
  if (tweenStart === null || reduced) return 1
  return easeOutCubic((now - tweenStart) / TWEEN_MS)
}
