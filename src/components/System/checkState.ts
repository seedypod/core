import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@/src/server/routers/app'

export type SystemCheck = inferRouterOutputs<AppRouter>['system']['checks']['checks'][number]
export type CheckState = SystemCheck['state']

/** Worst first. Idle is a service that's off or not on this host, so it passes. */
const RANK: Record<CheckState, number> = { down: 3, stalled: 2, idle: 1, ok: 0 }

export const STATE_LABEL: Record<CheckState, string> = { ok: 'OK', idle: 'Idle', stalled: 'Stalled', down: 'Down' }
/** Pod colours carry the state: green running, clay off, amber behind, red down. */
export const STATE_BG: Record<CheckState, string> = { ok: 'bg-pod-ok', idle: 'bg-pod-empty', stalled: 'bg-pod-ready', down: 'bg-pod-attention' }
export const STATE_TEXT: Record<CheckState, string> = { ok: 'text-pod-ok', idle: 'text-fg-3', stalled: 'text-pod-ready', down: 'text-pod-attention' }

export function worstState(checks: ReadonlyArray<Pick<SystemCheck, 'state'>>): CheckState | null {
  return checks.reduce<CheckState | null>((w, c) => (w === null || RANK[c.state] > RANK[w] ? c.state : w), null)
}

/** How many checks pass (ok or idle) out of all of them; null before there are any. */
export function checkSummary(checks: ReadonlyArray<Pick<SystemCheck, 'state'>>): { passing: number, total: number } | null {
  if (!checks.length) return null
  return { passing: checks.filter(c => RANK[c.state] <= RANK.idle).length, total: checks.length }
}
