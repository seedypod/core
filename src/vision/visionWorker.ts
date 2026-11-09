/**
 * Worker-thread entry: decodes and scores stills off core's event loop.
 * Bundled to server/dist/visionWorker.js next to the server.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { installLearned } from './analyzer'
import { execute, type AnalysisJob } from './execute'
import { podStateFromText } from './podState'

// The same weights core read at startup, so the worker runs exactly what core lists.
const model = (workerData as { podStateModel?: { text: string | null, missing?: string } } | null)?.podStateModel
if (model) installLearned([podStateFromText(model.text, model.missing)])

parentPort?.on('message', (m: { id: number, job: AnalysisJob }) => {
  try {
    const out = execute(m.job)
    const transfer = (Array.isArray(out) ? out : []).flatMap(o => (o.artifacts ?? []).map(a => a.bytes.buffer as ArrayBuffer))
    parentPort?.postMessage({ id: m.id, out }, transfer)
  }
  catch (e) {
    parentPort?.postMessage({ id: m.id, error: (e as Error).message })
  }
})
