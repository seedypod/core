/**
 * The pure analysis step: JPEG bytes in, per-analyser outputs out. Shared by
 * the inline executor (tests, browser demo) and the worker thread (the unit),
 * so both paths score a still identically.
 */
import { DEVICE_ANALYZERS, runAnalyzers, type AnalyzerOptions, type AnalyzerOutput } from './analyzer'
import { decodeJpeg } from './analyze'

export interface AnalysisJob {
  bytes: Uint8Array
  camera: 'upper' | 'lower'
  /** Analyser ids to run; unknown ids are ignored. */
  analyzers: string[]
  opts: AnalyzerOptions
}

export type JobOutput = Array<AnalyzerOutput & { analyzer: string, version: number }>

/** Returns null when the bytes are not a decodable JPEG (demo SVGs, stubs). */
export function execute(job: AnalysisJob): JobOutput | null {
  const img = decodeJpeg(job.bytes)
  if (!img) return null
  return runAnalyzers(img, job.camera, DEVICE_ANALYZERS.filter(a => job.analyzers.includes(a.id)), job.opts)
}

/** Runs a job somewhere: on this thread, or on a worker so the event loop never stalls. */
export type Executor = (job: AnalysisJob) => Promise<JobOutput | null>

export const inlineExecutor: Executor = async job => execute(job)
