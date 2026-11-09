/** What the update helper reports (ADR-0026). Browser-safe: the router and the demo import it. */
export type UpdateChannel = 'stable' | 'dev'

export const UPDATE_STATES = ['queued', 'downloading', 'verifying', 'stopping', 'swapping', 'installing', 'starting', 'health', 'rolling-back', 'done', 'rolled-back', 'rollback-failed', 'refused', 'failed'] as const
export type UpdateState = typeof UPDATE_STATES[number]
const RUNNING = new Set<UpdateState>(['queued', 'downloading', 'verifying', 'stopping', 'swapping', 'installing', 'starting', 'health', 'rolling-back'])
export const isRunning = (s: UpdateState | undefined) => !!s && RUNNING.has(s)
