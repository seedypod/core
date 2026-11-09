/**
 * Node-only executor that runs analysis on a worker thread. A JPEG decode
 * takes ~1 s on a Pi Zero 2 W; on the main thread that pauses the API, live
 * events and MQTT for the duration.
 */
import { Worker, type WorkerOptions } from 'node:worker_threads'
import type { AnalysisJob, Executor, JobResult } from './execute'
import type { LearnedSpec } from './podState'

export interface WorkerExecutor {
  run: Executor
  /** Change the learned analysers the worker runs (#186); jobs sent after this use them. */
  configure(learned: LearnedSpec[]): void
  close(): Promise<void>
}

/** `learned`: the learned analysers to run, as weights files' text. A worker that restarts gets the latest. */
export function createWorkerExecutor(script: URL, options?: WorkerOptions, learned: LearnedSpec[] = []): WorkerExecutor {
  let config = learned
  let worker: Worker | null = null
  let seq = 0
  const pending = new Map<number, { resolve: (o: JobResult) => void, reject: (e: Error) => void }>()

  const failAll = (e: Error) => {
    for (const p of pending.values()) p.reject(e)
    pending.clear()
    worker = null
  }
  const ensure = (): Worker => {
    if (worker) return worker
    const w = new Worker(script, { ...options, workerData: { learned: config } })
    w.on('message', (m: { id: number, out?: JobResult, error?: string }) => {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      if (m.error !== undefined) p.reject(new Error(m.error))
      else p.resolve(m.out ?? null)
    })
    // A crashed worker fails its in-flight jobs; the next job starts a fresh one.
    w.on('error', failAll)
    w.on('exit', code => failAll(new Error(`vision worker exited with code ${code}`)))
    w.unref()
    worker = w
    return w
  }

  return {
    run: (job: AnalysisJob) => new Promise<JobResult>((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      // Copy so the caller's buffer (also written to the sink) is not detached by the transfer.
      const bytes = job.bytes.slice()
      ensure().postMessage({ id, job: { ...job, bytes } }, [bytes.buffer as ArrayBuffer])
    }),
    configure(next: LearnedSpec[]) {
      config = next
      worker?.postMessage({ configure: next })
    },
    async close() {
      const w = worker
      worker = null
      if (w) await w.terminate()
    },
  }
}
