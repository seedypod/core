/**
 * Process-wide event bus (ADR-0015): every mutation and every HAL event is
 * broadcast here, and the UI subscribes over SSE (tRPC subscription) so it
 * never polls.
 */
import type { HalEvent } from '../hardware/types'

export type CoreEvent
  = | { kind: 'hal', event: HalEvent }
    | { kind: 'mutation', path: string }
    | { kind: 'schedule', action: 'fired' | 'changed', id: string }
    // A step of an update (ADR-0026), with the helper's new log lines.
    | { kind: 'update', state: string, lines: string[] }

export interface EventBus {
  emit(e: CoreEvent): void
  subscribe(l: (e: CoreEvent) => void): () => void
}

export function createEventBus(): EventBus {
  const listeners = new Set<(e: CoreEvent) => void>()
  return {
    emit(e) {
      for (const l of listeners) l(e)
    },
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
  }
}
