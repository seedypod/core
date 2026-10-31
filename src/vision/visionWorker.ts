/**
 * Worker-thread entry: decodes and scores stills off core's event loop.
 * Bundled to server/dist/visionWorker.js next to the server.
 */
import { parentPort } from 'node:worker_threads'
import { execute, type AnalysisJob } from './execute'

parentPort?.on('message', (m: { id: number, job: AnalysisJob }) => {
  try {
    const out = execute(m.job)
    const transfer = (out ?? []).flatMap(o => (o.artifacts ?? []).map(a => a.bytes.buffer as ArrayBuffer))
    parentPort?.postMessage({ id: m.id, out }, transfer)
  }
  catch (e) {
    parentPort?.postMessage({ id: m.id, error: (e as Error).message })
  }
})
