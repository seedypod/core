/**
 * Node-only: runs the learned analysers in podvision (#191), a small Rust
 * binary separate from hald, instead of on the vision worker. In plain
 * JavaScript on a Pi Zero W, one capture's pod-state took about 33 s, and
 * the worker thread competed with core's API for the one core the whole
 * time. podvision decodes the still (scaled down where the crops allow),
 * crops the pods and runs every enabled revision's forward pass, at nice 19
 * in its own process, under a timeout.
 *
 * Analyser ids and versions don't change: results are stored as the
 * TypeScript runner would store them. The rule-based analysers still run on
 * the executor this wraps. If podvision is missing, fails, times out or
 * reports another version than core lists, this logs it and that executor
 * runs the learned analysers too.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setPriority } from 'node:os'
import { deviceAnalyzers, findAnalyzer } from './analyzer'
import { DAMAGED, type AnalysisJob, type Executor, type JobOutput, type JobResult } from './execute'
import { podStateRows, type LearnedSpec } from './podState'
import { podRegions, type PodRegions } from './regions'

export const INSTALLED_PODVISION = '/usr/local/bin/podvision'
export const PODVISION_TIMEOUT_MS = 60_000
/** Far more than 30 pods × a few revisions print; anything bigger is not podvision. */
const MAX_OUTPUT_BYTES = 4 << 20

/** `PODVISION` names the binary and an empty string turns it off; otherwise the installed one, when it's there. */
export function podvisionBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.PODVISION !== undefined) return env.PODVISION || null
  return existsSync(INSTALLED_PODVISION) ? INSTALLED_PODVISION : null
}

/** What podvision prints for one still. */
export interface PodvisionOutput {
  width: number
  height: number
  /** The still was decoded this many times smaller. */
  scale: number
  brightness: number
  damaged: boolean
  models: Array<{
    id: string
    version: number
    revision: string
    classes: string[]
    dark: boolean
    pods: Array<{ slot: number, class: number, probabilities: number[], logits: number[] }>
  }>
  ms: { decode: number, forward: number }
}

export interface PodvisionModel { id: string, path: string }

/** Run podvision once: the still on stdin, at nice 19, killed after `timeoutMs`. Rejects with what went wrong. */
export function runPodvision(bin: string, bytes: Uint8Array, regions: PodRegions, models: PodvisionModel[], timeoutMs = PODVISION_TIMEOUT_MS): Promise<PodvisionOutput> {
  return podvisionJson<PodvisionOutput>(bin, ['--pods', JSON.stringify(regions), ...models.flatMap(m => ['--model', `${m.id}=${m.path}`])], bytes, timeoutMs)
}

/** One run of podvision with `args`, the still on stdin, at nice 19, killed after `timeoutMs`; resolves with the JSON it prints. */
export function podvisionJson<T>(bin: string, args: string[], bytes: Uint8Array, timeoutMs = PODVISION_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    if (child.pid !== undefined) {
      try {
        setPriority(child.pid, 19)
      }
      catch {
        // It still runs, only at core's priority.
      }
    }
    const out: Buffer[] = []
    let size = 0
    let err = ''
    let settled = false
    const done = (e: Error | null, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (e) reject(e)
      else resolve(value as T)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done(new Error(`timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => {
      size += d.length
      if (size > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL')
        done(new Error('printed more than any result'))
      }
      else out.push(d)
    })
    child.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-2000)
    })
    child.on('error', e => done(e))
    child.on('close', (code, signal) => {
      if (code !== 0) return done(new Error(err.trim().split('\n').at(-1) || (signal ? `killed by ${signal}` : `exit ${code}`)))
      try {
        done(null, JSON.parse(Buffer.concat(out).toString('utf8')) as T)
      }
      catch (e) {
        done(new Error(`printed something that isn't JSON: ${(e as Error).message}`))
      }
    })
    // A binary that exits before reading the still leaves a broken pipe; its exit says why.
    child.stdin.on('error', () => {})
    child.stdin.end(bytes)
  })
}

export interface NativeExecutorOptions {
  bin: string
  /** Runs everything podvision doesn't: the rule-based analysers, and the learned ones when it fails. */
  fallback: Executor
  learned?: LearnedSpec[]
  timeoutMs?: number
  log?: (msg: string) => void
}

export interface NativeExecutor {
  run: Executor
  /** Change the learned analysers podvision runs (#186), with the worker's. */
  configure(learned: LearnedSpec[]): void
  /** Why the last still podvision was given went to TypeScript instead, or null if it ran there or hasn't run yet. */
  lastError(): string | null
}

const isJpeg = (b: Uint8Array) => b.byteLength >= 4 && b[0] === 0xFF && b[1] === 0xD8

export function createNativeExecutor(o: NativeExecutorOptions): NativeExecutor {
  let specs = o.learned ?? []
  let lastError: string | null = null
  const log = o.log ?? (m => console.warn(m))

  /** The learned analysers of this job that podvision can run: enabled, listed here, with a file on disk. */
  const nativeFor = (job: AnalysisJob) => specs.flatMap((s) => {
    const a = findAnalyzer(s.id)
    return s.path && s.text !== null && job.analyzers.includes(s.id) && a && !a.disabled ? [{ id: s.id, path: s.path, version: a.version }] : []
  })

  const run: Executor = async (job) => {
    const native = isJpeg(job.bytes) ? nativeFor(job) : []
    if (native.length === 0) return o.fallback(job)
    let scored: JobOutput
    try {
      const out = await runPodvision(o.bin, job.bytes, job.regions ?? podRegions(job.camera), native, o.timeoutMs)
      lastError = null
      if (out.damaged) return DAMAGED
      scored = native.map((n) => {
        const m = out.models.find(x => x.id === n.id)
        if (!m) throw new Error(`no result for ${n.id}`)
        if (m.version !== n.version) throw new Error(`${n.id} ran version ${m.version}, core lists ${n.version}`)
        return { analyzer: n.id, version: n.version, results: m.pods.flatMap(p => podStateRows(p.slot, p.probabilities, p.class, m.classes, m.revision)) }
      })
    }
    catch (e) {
      lastError = (e as Error).message
      log(`podvision: ${(e as Error).message}; running ${native.map(n => n.id).join(', ')} in TypeScript`)
      return o.fallback(job)
    }
    const rest = job.analyzers.filter(id => !native.some(n => n.id === id))
    let others: JobResult = []
    if (rest.length) others = await o.fallback({ ...job, analyzers: rest })
    if (others === DAMAGED) return DAMAGED
    const all = [...(others ?? []), ...scored]
    const order = deviceAnalyzers().map(a => a.id)
    return all.sort((a, b) => order.indexOf(a.analyzer) - order.indexOf(b.analyzer))
  }

  return {
    run,
    configure(next) {
      specs = next
    },
    lastError: () => lastError,
  }
}
