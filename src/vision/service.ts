/**
 * Runs the on-device analysers over captures (ADR-0019): one job at a time,
 * at most one waiting per camera (a newer still replaces an older one that
 * hasn't started), results upserted into the shared table, large outputs
 * written to the blob sink.
 */
import type { BlobSink } from '../camera/captures'
import type { EventBus } from '../lib/eventBus'
import type { AnalysisRow, Capture, Store } from '../store/types'
import { DEVICE_ANALYZERS, info, type AnalyzerInfo } from './analyzer'
import { inlineExecutor, type Executor, type JobOutput } from './execute'

export interface AnalysisServiceOptions {
  store: Store
  sink: BlobSink
  events?: EventBus
  executor?: Executor
}

export interface AnalysisStatus {
  running: string | null
  waiting: string[]
  /** Stills skipped because a newer one from the same camera arrived first. */
  dropped: number
  failed: number
  backfill: { analyzer: string, done: number, total: number } | null
}

export interface AnalyzerListing extends AnalyzerInfo {
  source: 'device' | 'remote'
  primary: boolean
  rows: number
  captures: number
  firstTs: string | null
  lastTs: string | null
}

interface Job { capture: Capture, bytes: Uint8Array }

export class AnalysisService {
  private readonly executor: Executor
  private readonly waiting = new Map<'upper' | 'lower', Job>()
  private running: Capture | null = null
  private chain: Promise<void> = Promise.resolve()
  private dropped = 0
  private failed = 0
  private backfill: AnalysisStatus['backfill'] = null

  constructor(private readonly o: AnalysisServiceOptions) {
    this.executor = o.executor ?? inlineExecutor
  }

  /** Queue a fresh capture for every on-device analyser. Never throws. */
  enqueue(capture: Capture, bytes: Uint8Array): void {
    if (this.waiting.has(capture.camera)) this.dropped++
    this.waiting.set(capture.camera, { capture, bytes })
    this.chain = this.chain.then(() => this.drain(capture.camera))
  }

  /** Resolves when everything queued so far has finished. */
  idle(): Promise<void> {
    return this.chain
  }

  status(): AnalysisStatus {
    return { running: this.running?.id ?? null, waiting: [...this.waiting.values()].map(j => j.capture.id), dropped: this.dropped, failed: this.failed, backfill: this.backfill }
  }

  /**
   * Re-score stored captures with one analyser, newest first, in the
   * background. Returns how many captures it will visit.
   */
  rerun(analyzerId: string, limit = 2000): number {
    const analyzer = DEVICE_ANALYZERS.find(a => a.id === analyzerId)
    if (!analyzer) throw new Error(`${analyzerId} is not an on-device analyser`)
    if (this.backfill) throw new Error(`already re-running ${this.backfill.analyzer}`)
    const captures = this.o.store.captures.list(undefined, limit)
    this.backfill = { analyzer: analyzerId, done: 0, total: captures.length }
    for (const capture of captures) {
      this.chain = this.chain.then(async () => {
        const bytes = await this.o.sink.get(capture.path)
        if (bytes) await this.analyse(capture, bytes, [analyzerId])
        if (this.backfill) this.backfill.done++
      })
    }
    this.chain = this.chain.then(() => {
      this.backfill = null
      this.o.events?.emit({ kind: 'mutation', path: 'analyses' })
    })
    return captures.length
  }

  /** Every analyser that is registered here or has results in the table. */
  list(): AnalyzerListing[] {
    const primary = this.o.store.settings.get().primaryAnalyzer
    const stats = this.o.store.analyses.stats()
    const out: AnalyzerListing[] = DEVICE_ANALYZERS.map((a) => {
      const s = stats.filter(x => x.analyzer === a.id && x.version === a.version)
      return { ...info(a), source: 'device', primary: a.id === primary, ...totals(s) }
    })
    const seen = new Set(out.map(a => `${a.id}@${a.version}`))
    for (const s of stats) {
      const key = `${s.analyzer}@${s.version}`
      if (seen.has(key)) continue
      seen.add(key)
      const known = DEVICE_ANALYZERS.find(a => a.id === s.analyzer)
      out.push({
        id: s.analyzer,
        version: s.version,
        label: known?.label ?? s.analyzer,
        description: known ? `Older version of ${known.label}.` : 'Results posted by an off-device worker.',
        metrics: known?.metrics ?? [],
        runsOn: [s.source],
        source: s.source,
        primary: s.analyzer === primary && !known,
        ...totals(stats.filter(x => x.analyzer === s.analyzer && x.version === s.version)),
      })
    }
    return out
  }

  /** Remove a capture's artifacts from the sink (called when the capture is pruned). */
  async removeArtifacts(captureId: string): Promise<void> {
    for (const r of this.o.store.analyses.forCapture(captureId)) {
      if (r.artifact) await this.o.sink.remove(r.artifact)
    }
  }

  private async drain(camera: 'upper' | 'lower'): Promise<void> {
    const job = this.waiting.get(camera)
    if (!job) return
    this.waiting.delete(camera)
    await this.analyse(job.capture, job.bytes, DEVICE_ANALYZERS.map(a => a.id))
  }

  private async analyse(capture: Capture, bytes: Uint8Array, analyzers: string[]): Promise<void> {
    this.running = capture
    try {
      const opts = { artifacts: this.o.store.settings.get().analysisArtifacts }
      const out = await this.executor({ bytes, camera: capture.camera, analyzers, opts })
      if (out) {
        this.o.store.analyses.add(await this.toRows(capture, out))
        this.o.events?.emit({ kind: 'mutation', path: 'analyses' })
      }
    }
    catch {
      // Analysis is best-effort: a bad frame or a crashed worker never fails a capture.
      this.failed++
    }
    finally {
      this.running = null
    }
  }

  private async toRows(capture: Capture, out: JobOutput): Promise<AnalysisRow[]> {
    const rows: AnalysisRow[] = []
    for (const o of out) {
      let artifact: string | null = null
      for (const a of o.artifacts ?? []) {
        artifact = await this.o.sink.put(artifactKey(capture.id, o.analyzer, o.version, a.name), a.bytes)
      }
      for (const r of o.results) {
        rows.push({ captureId: capture.id, ts: capture.ts, camera: capture.camera, analyzer: o.analyzer, version: o.version, source: 'device', slot: r.slot, metric: r.metric, value: r.value, detail: r.detail ?? null, artifact })
      }
    }
    return rows
  }
}

/** Blob key for an analyser's large output, e.g. `analysis/upper-…/exg-otsu@1/mask.pbm`. */
export function artifactKey(captureId: string, analyzer: string, version: number, name: string): string {
  return `analysis/${captureId}/${analyzer}@${version}/${name}`
}

function totals(s: Array<{ rows: number, captures: number, firstTs: string, lastTs: string }>) {
  return {
    rows: s.reduce((n, x) => n + x.rows, 0),
    captures: s.reduce((n, x) => n + x.captures, 0),
    firstTs: s.map(x => x.firstTs).sort()[0] ?? null,
    lastTs: s.map(x => x.lastTs).sort().at(-1) ?? null,
  }
}
