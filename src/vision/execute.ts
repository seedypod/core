/**
 * The pure analysis step: JPEG bytes in, per-analyser outputs out. Shared by
 * the inline executor (tests, browser demo) and the worker thread (the unit),
 * so both paths score a still identically.
 */
import { DEVICE_ANALYZERS, runAnalyzers, type AnalyzerOptions, type AnalyzerOutput } from './analyzer'
import { decodeJpeg, hasZeroFilledRows } from './analyze'
import type { PodRegions } from './regions'

export interface AnalysisJob {
  bytes: Uint8Array
  camera: 'upper' | 'lower'
  /** The camera's pod boxes as fractions of the frame; the defaults when left out. */
  regions?: PodRegions
  /** Analyser ids to run; unknown ids are ignored. */
  analyzers: string[]
  opts: AnalyzerOptions
}

export type JobOutput = Array<AnalyzerOutput & { analyzer: string, version: number }>

/** The still is a picture of a damaged frame, so nothing it ever scored should stand. */
export const DAMAGED = 'damaged'

export type JobResult = JobOutput | typeof DAMAGED | null

/** Returns null when the bytes are not a decodable JPEG (demo SVGs, stubs). */
export function execute(job: AnalysisJob): JobResult {
  const img = decodeJpeg(job.bytes)
  if (!img) return null
  if (hasZeroFilledRows(img)) return DAMAGED
  return runAnalyzers(img, job.camera, DEVICE_ANALYZERS.filter(a => job.analyzers.includes(a.id)), job.opts, job.regions)
}

/** Runs a job somewhere: on this thread, or on a worker so the event loop never stalls. */
export type Executor = (job: AnalysisJob) => Promise<JobResult>

export const inlineExecutor: Executor = async job => execute(job)
