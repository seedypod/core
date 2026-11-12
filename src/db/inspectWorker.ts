/**
 * Worker-thread entry: one scan or integrity check, then exit, so it holds no
 * RAM between runs. Bundled to server/dist/inspectWorker.js next to the server.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { runJob, yieldToEventLoop, type InspectJob } from './scan'

try {
  yieldToEventLoop()
  parentPort?.postMessage({ result: runJob(workerData as InspectJob) })
}
catch (e) {
  parentPort?.postMessage({ error: (e as Error).message })
}
