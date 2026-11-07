/**
 * Node-only DatabaseInspector: scans on a worker thread, one at a time, and
 * caches the report. A scan reads the whole file, seconds to minutes on a Pi
 * Zero W, so the UI never drives it faster than the cache allows.
 */
import { Worker, type WorkerOptions } from 'node:worker_threads'
import type { DatabaseInspector, DatabaseReport, IntegrityRun } from './inspect'
import { runJob, type InspectJob } from './scan'

const CACHE_MS = 5 * 60_000
/** A slow scan caches for longer, so it never takes more than 1/20th of the time however large the file grows. */
const CACHE_SCAN_RATIO = 20
const TIMEOUT_MS = 5 * 60_000

export interface InspectorOptions {
  path: string
  migrationsFolder: string
  /** The bundled worker; null runs on this thread (`tsx watch`, where there is no bundle). */
  worker: URL | null
  workerOptions?: WorkerOptions
  timeoutMs?: number
  now?: () => Date
}

export function runInWorker<T>(script: URL, job: InspectJob, timeoutMs: number, options?: WorkerOptions): Promise<T> {
  const worker = new Worker(script, { ...options, workerData: job })
  worker.unref()
  let timer: ReturnType<typeof setTimeout>
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`database scan timed out after ${timeoutMs / 1000} s`)), timeoutMs)
    worker.once('message', (m: { result: T } | { error: string }) => ('error' in m ? reject(new Error(m.error)) : resolve(m.result)))
    worker.once('error', reject)
    worker.once('exit', code => reject(new Error(`database scan worker exited with code ${code}`)))
  }).finally(() => {
    clearTimeout(timer)
    void worker.terminate()
  })
}

export class NodeDatabaseInspector implements DatabaseInspector {
  private report: Omit<DatabaseReport, 'integrity'> | null = null
  private integrity: IntegrityRun | null = null
  private scanning: Promise<Omit<DatabaseReport, 'integrity'>> | null = null
  private checking: Promise<IntegrityRun> | null = null
  /** One worker at a time: two would share the same core and hold two isolates in 426 MB. */
  private queue: Promise<unknown> = Promise.resolve()
  private readonly now: () => Date

  constructor(private readonly o: InspectorOptions) {
    this.now = o.now ?? (() => new Date())
  }

  private run<T>(job: InspectJob): Promise<T> {
    const { worker, workerOptions, timeoutMs = TIMEOUT_MS } = this.o
    const result = this.queue.then(() => (worker ? runInWorker<T>(worker, job, timeoutMs, workerOptions) : runJob(job) as T))
    this.queue = result.catch(() => undefined)
    return result
  }

  private fresh(): boolean {
    if (!this.report) return false
    const age = this.now().getTime() - Date.parse(this.report.at)
    return age < Math.max(CACHE_MS, this.report.scanMs * CACHE_SCAN_RATIO)
  }

  async inspect(): Promise<DatabaseReport> {
    if (!this.fresh()) {
      const { path, migrationsFolder } = this.o
      this.scanning ??= this.run<Omit<DatabaseReport, 'integrity'>>({ kind: 'scan', path, migrationsFolder, now: this.now().getTime() })
        .finally(() => {
          this.scanning = null
        })
      this.report = await this.scanning
    }
    return { ...this.report as Omit<DatabaseReport, 'integrity'>, integrity: this.integrity }
  }

  async checkIntegrity(): Promise<IntegrityRun> {
    this.checking ??= this.run<IntegrityRun>({ kind: 'integrity', path: this.o.path, now: this.now().getTime() })
      .finally(() => {
        this.checking = null
      })
    this.integrity = await this.checking
    return this.integrity
  }
}
