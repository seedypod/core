/**
 * Worker-thread entry: decodes and scores stills off core's event loop.
 * Bundled to server/dist/visionWorker.js next to the server.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { installLearned } from './analyzer'
import { execute, type AnalysisJob } from './execute'
import { learnedAnalyzers, type LearnedSpec } from './podState'

// The same weights files core lists, so the worker runs exactly what core shows; `configure` follows changes (#186).
installLearned(learnedAnalyzers((workerData as { learned?: LearnedSpec[] } | null)?.learned ?? []))

parentPort?.on('message', (m: { id: number, job: AnalysisJob } | { configure: LearnedSpec[] }) => {
  if ('configure' in m) {
    installLearned(learnedAnalyzers(m.configure))
    return
  }
  try {
    const out = execute(m.job)
    const transfer = (Array.isArray(out) ? out : []).flatMap(o => (o.artifacts ?? []).map(a => a.bytes.buffer as ArrayBuffer))
    parentPort?.postMessage({ id: m.id, out }, transfer)
  }
  catch (e) {
    parentPort?.postMessage({ id: m.id, error: (e as Error).message })
  }
})
