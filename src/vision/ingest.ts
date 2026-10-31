/**
 * Results from off-device analysers (ADR-0019 phase 3). A remote worker pulls
 * stills through the REST API, runs whatever it likes, and posts per-pod
 * results here under its own analyser id; they land in the same table as the
 * on-device analysers, so the Analysis screen compares them directly.
 */
import { z } from 'zod'
import type { AnalysisRow, Store } from '../store/types'
import { DEVICE_ANALYZERS } from './analyzer'

export const IngestBatch = z.object({
  analyzer: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'lowercase letters, digits, dot, dash or underscore, up to 64'),
  version: z.number().int().min(1),
  results: z.array(z.object({
    captureId: z.string().min(1),
    slot: z.number().int().min(1).max(60),
    metric: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    value: z.number().finite(),
    detail: z.record(z.string(), z.unknown()).optional(),
    /** Needed only for captures the unit has already pruned. */
    ts: z.string().datetime().optional(),
    camera: z.enum(['upper', 'lower']).optional(),
  })).min(1).max(10_000),
})
export type IngestBatch = z.infer<typeof IngestBatch>

export interface IngestOutcome { stored: number, skipped: string[] }

export class IngestRefused extends Error {}

export function ingestResults(store: Store, batch: IngestBatch): IngestOutcome {
  if (DEVICE_ANALYZERS.some(a => a.id === batch.analyzer)) throw new IngestRefused(`${batch.analyzer} is an on-device analyser; post under your own id`)
  const rows: AnalysisRow[] = []
  const skipped = new Set<string>()
  for (const r of batch.results) {
    const capture = store.captures.get(r.captureId)
    const ts = capture?.ts ?? r.ts
    const camera = capture?.camera ?? r.camera
    if (!ts || !camera) {
      skipped.add(r.captureId)
      continue
    }
    rows.push({ captureId: r.captureId, ts, camera, analyzer: batch.analyzer, version: batch.version, source: 'remote', slot: r.slot, metric: r.metric, value: r.value, detail: r.detail ?? null, artifact: null })
  }
  store.analyses.add(rows)
  return { stored: rows.length, skipped: [...skipped] }
}
