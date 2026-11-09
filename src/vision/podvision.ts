/**
 * The native pod-state runner (#191), Node-only. `podvision` is a small Rust
 * binary (hal/crates/podvision, never part of hald: ADR 0004, ADR 0019) that
 * decodes a still, crops the pods and runs every enabled pod-state revision's
 * forward pass. Core starts it once per capture as a child process at nice 19,
 * so the work competes with nothing core does, and kills it after a timeout.
 *
 * It sits in front of the existing executor: the learned analysers go to the
 * binary, the rest (and every learned one, whenever the binary is missing,
 * fails or times out) to the TypeScript path, which stays the reference. The
 * binary's probabilities become rows through the same `podRows` as
 * classifyPods, under the same analyser ids and versions.
 *
 * Releases carry the binary in the core tarball as `bin/podvision-<target>`, so
 * the installer and the web updater (ADR 0026) unpack, checksum and roll it
 * back with the rest of the release. PODVISION_BIN points somewhere else; set
 * it to an empty string to always run in TypeScript.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setPriority } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deviceAnalyzers, type AnalyzerOutput } from './analyzer'
import { DAMAGED, type AnalysisJob, type Executor } from './execute'
import { podRows, POD_STATES, type LearnedSpec } from './podState'
import { podRegions } from './regions'

const here = dirname(fileURLToPath(import.meta.url))

/** A capture takes a few seconds on a Pi Zero W; anything near this is stuck, and TypeScript takes over. */
export const PODVISION_TIMEOUT_MS = 60_000
/** Lowest priority: core's API and hald's loops always come first. */
export const PODVISION_NICE = 19
const MAX_STDOUT = 4 << 20
const MAX_STDERR = 16 << 10

/** The Rust target a release builds for this machine, or null where there is none. */
export function podvisionTarget(platform: string = process.platform, arch: string = process.arch): string | null {
  if (platform !== 'linux') return null
  // 32-bit Node on a 64-bit kernel is still a 32-bit userland.
  if (arch === 'arm') return 'arm-unknown-linux-gnueabihf'
  if (arch === 'arm64') return 'aarch64-unknown-linux-gnu'
  return null
}

/** Where the binary can be: `bin/` two levels up from src/vision (tsx) and from server/dist (the bundle), or the working directory. */
export function podvisionCandidates(env: NodeJS.ProcessEnv = process.env, target = podvisionTarget()): string[] {
  if (env.PODVISION_BIN !== undefined) return env.PODVISION_BIN ? [env.PODVISION_BIN] : []
  if (!target) return []
  return [resolve(here, `../../bin/podvision-${target}`), resolve(process.cwd(), `bin/podvision-${target}`)]
}

/** The binary to run, or null and why not. */
export function findPodvision(candidates = podvisionCandidates()): { path: string | null, why?: string } {
  const path = candidates.find(p => existsSync(p))
  if (path) return { path }
  return { path: null, why: candidates.length ? `no podvision binary at ${candidates[0]}` : 'no podvision build for this machine, or PODVISION_BIN=""' }
}

export interface NativePod { slot: number, class: number, probabilities: number[] }
export interface NativeModelResult { analyzer: string, version: number, revision: string, skipped: string | null, pods: NativePod[] }
export interface NativeResult {
  width: number
  height: number
  decoded: { width: number, height: number, eighths: number }
  damaged: boolean
  brightness?: number
  models: NativeModelResult[]
  timing: { decodeMs: number, forwardMs: number, totalMs: number }
}

export interface RunOptions {
  /** The binary, or a command that runs it (tests use `node fake.mjs`). */
  command: string[]
  args: string[]
  stdin: Uint8Array
  timeoutMs?: number
}

/** Run the binary once at nice 19, the still on stdin; resolves to its JSON, rejects on any failure. */
export function runPodvision(o: RunOptions): Promise<NativeResult> {
  return new Promise((resolvePromise, reject) => {
    const [cmd, ...pre] = o.command as [string, ...string[]]
    const child = spawn(cmd, [...pre, ...o.args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let settled = false
    const finish = (e: Error | null, r?: NativeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (e) reject(e)
      else resolvePromise(r as NativeResult)
    }
    const timeoutMs = o.timeoutMs ?? PODVISION_TIMEOUT_MS
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(`timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    child.on('error', e => finish(e))
    // Before the still goes in: the binary waits on stdin, so all of its work runs at this priority.
    try {
      if (child.pid !== undefined) setPriority(child.pid, PODVISION_NICE)
    }
    catch {
      // Already gone, or not allowed here; it still runs, just not niced.
    }
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      out += d
      if (out.length > MAX_STDOUT) {
        child.kill('SIGKILL')
        finish(new Error('printed more than any result should be'))
      }
    })
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      err = (err + d).slice(-MAX_STDERR)
    })
    child.on('close', (code, signal) => {
      if (code !== 0) return finish(new Error(`exited with ${code ?? signal}${err.trim() ? `: ${err.trim().split('\n').at(-1)}` : ''}`))
      try {
        finish(null, checkResult(JSON.parse(out)))
      }
      catch (e) {
        finish(new Error(`printed something that isn't a result: ${(e as Error).message}`))
      }
    })
    // An early exit closes the pipe; the exit code says why.
    child.stdin.on('error', () => {})
    child.stdin.end(Buffer.from(o.stdin.buffer, o.stdin.byteOffset, o.stdin.byteLength))
  })
}

function checkResult(r: unknown): NativeResult {
  const res = r as NativeResult
  if (!res || typeof res !== 'object' || typeof res.damaged !== 'boolean' || !Array.isArray(res.models)) throw new Error('no damaged flag or models list')
  for (const m of res.models) {
    if (!Array.isArray(m?.pods)) throw new Error('a model without pods')
    for (const p of m.pods) {
      if (!Number.isInteger(p?.slot) || !Array.isArray(p.probabilities) || p.probabilities.length !== POD_STATES.length || !p.probabilities.every(v => Number.isFinite(v))) throw new Error('a pod without a slot and one probability per class')
    }
  }
  return res
}

const isJpeg = (b: Uint8Array) => b.byteLength >= 4 && b[0] === 0xFF && b[1] === 0xD8

export interface NativeExecutorOptions {
  /** Runs everything the binary doesn't: the vision worker, or inline. */
  inner: Executor
  command: string[]
  /** The learned analysers core lists now, with their weights files' paths. */
  learned: () => LearnedSpec[]
  timeoutMs?: number
  log?: (line: string) => void
}

/** An executor that scores the learned analysers with the binary and the rest with `inner`, falling back to `inner` for all of them. */
export function nativeExecutor(o: NativeExecutorOptions): Executor {
  const log = o.log ?? ((line: string) => console.warn(line))
  return async (job: AnalysisJob) => {
    const paths = new Map(o.learned().filter(s => s.text !== null && s.path).map(s => [s.id, s.path as string]))
    const native = deviceAnalyzers().filter(a => !a.disabled && paths.has(a.id) && job.analyzers.includes(a.id))
    if (native.length === 0 || !isJpeg(job.bytes)) return o.inner(job)
    let res: NativeResult
    try {
      const regions = job.regions ?? podRegions(job.camera)
      res = await runPodvision({
        command: o.command,
        args: ['--image', '-', '--regions', JSON.stringify(regions), ...native.flatMap(a => ['--model', paths.get(a.id) as string])],
        stdin: job.bytes,
        timeoutMs: o.timeoutMs,
      })
      if (!res.damaged) {
        const wrong = native.findIndex((a, i) => res.models[i]?.version !== a.version)
        if (wrong >= 0) throw new Error(`${native[wrong]?.id}'s weights file is no longer version ${native[wrong]?.version}`)
      }
    }
    catch (e) {
      log(`podvision: ${(e as Error).message}; scoring ${native.map(a => a.id).join(', ')} in TypeScript`)
      return o.inner(job)
    }
    if (res.damaged) return DAMAGED
    const learned: Array<AnalyzerOutput & { analyzer: string, version: number }> = native.map((a, i) => {
      const m = res.models[i] as NativeModelResult
      return { analyzer: a.id, version: a.version, results: m.pods.flatMap(p => podRows(POD_STATES, m.revision, p.slot, p.probabilities)) }
    })
    const ids = new Set(native.map(a => a.id))
    const rest = job.analyzers.filter(id => !ids.has(id))
    if (!deviceAnalyzers().some(a => !a.disabled && rest.includes(a.id))) return learned
    const other = await o.inner({ ...job, analyzers: rest })
    if (other === DAMAGED) return DAMAGED
    return [...(other ?? []), ...learned]
  }
}

/**
 * Put the binary in front of `inner` when there is one for this machine, and say which way pod-state runs.
 * Returns `inner` unchanged without the binary.
 */
export function withPodvision(inner: Executor, learned: () => LearnedSpec[], found = findPodvision(), log: (line: string) => void = console.log): Executor {
  if (!found.path) {
    log(`pod-state runs in TypeScript: ${found.why}`)
    return inner
  }
  log(`pod-state runs natively with ${found.path} at nice ${PODVISION_NICE}`)
  return nativeExecutor({ inner, command: [found.path], learned })
}
