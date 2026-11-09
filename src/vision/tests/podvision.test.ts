import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encode } from 'jpeg-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installLearned } from '../analyzer'
import { decodeJpeg } from '../analyze'
import { forward, parseModel, softmax } from '../cnn'
import { DAMAGED, inlineExecutor, type AnalysisJob, type Executor } from '../execute'
import { cropInput, learnedAnalyzers, POD_STATES, type LearnedSpec } from '../podState'
import { findPodvision, nativeExecutor, PODVISION_NICE, podvisionCandidates, podvisionTarget, runPodvision, withPodvision } from '../podvision'
import { cameraSlots } from '../regions'
import { jpeg } from './fixtures'
import parity from './parity/pod-state-parity.json'

// Each test starts Node a few times; the whole suite runs at once in CI.
vi.setConfig({ testTimeout: 30_000 })

const fake = fileURLToPath(new URL('./fakePodvision.mjs', import.meta.url))
const command = (mode: string) => [process.execPath, fake, mode]

let dir = ''
let specs: LearnedSpec[] = []

/** The parity model as two enabled revisions on disk, the way the registry lists them. */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podvision-'))
  specs = [['pod-state', 1], ['pod-state-v2', 2]].map(([id, version]) => {
    const text = JSON.stringify({ ...parity.model, version, revision: `rev-${version}` })
    const path = join(dir, `${id}.json`)
    writeFileSync(path, text)
    return { id: id as string, label: id as string, text, path }
  })
  installLearned(learnedAnalyzers(specs))
})

afterEach(() => {
  installLearned([])
  rmSync(dir, { recursive: true, force: true })
})

const job = (analyzers: string[], bytes = jpeg(320, 240, true)): AnalysisJob => ({ bytes, camera: 'upper', analyzers, opts: { artifacts: false } })

/** Stands in for the vision worker: an empty output per analyser, without decoding anything. */
const stub: Executor = async j => j.analyzers.map(analyzer => ({ analyzer, version: 0, results: [] }))

function spy(inner: Executor = stub) {
  const calls: string[][] = []
  const run: Executor = (j) => {
    calls.push(j.analyzers)
    return inner(j)
  }
  return { run, calls }
}

describe('the native pod-state runner', () => {
  it('scores the learned analysers with the binary and the rest in TypeScript, in the usual order', async () => {
    const inner = spy(inlineExecutor)
    const log = vi.fn()
    const run = nativeExecutor({ inner: inner.run, command: command('ok'), learned: () => specs, log })
    const out = await run(job(['green-threshold', 'pod-state', 'pod-state-v2']))
    if (!Array.isArray(out)) throw new Error('should have scored it')
    expect(out.map(o => `${o.analyzer}@${o.version}`)).toEqual(['green-threshold@2', 'pod-state@1', 'pod-state-v2@2'])
    expect(inner.calls).toEqual([['green-threshold']])
    const rows = out[1]?.results ?? []
    expect(rows.filter(r => r.metric === 'pod_state').map(r => r.slot)).toEqual(cameraSlots('upper'))
    expect(rows[0]).toEqual({ slot: 1, metric: 'pod_state', value: 1, detail: { state: 'sprouted', confidence: 0.6, probabilities: { empty: 0.1, sprouted: 0.6, growing: 0.1, ready: 0.1, unhealthy: 0.1 }, revision: 'rev-1' } })
    expect(rows[1]).toEqual({ slot: 1, metric: 'pod_state_confidence', value: 0.6 })
    expect(out[2]?.results[0]?.detail?.revision).toBe('rev-2')
    expect(log).not.toHaveBeenCalled()
  })

  it('never decodes in TypeScript when only learned analysers run, as on a re-run', async () => {
    const inner = spy(inlineExecutor)
    const out = await nativeExecutor({ inner: inner.run, command: command('ok'), learned: () => specs })(job(['pod-state', 'no-such-analyser']))
    expect(Array.isArray(out) && out.map(o => o.analyzer)).toEqual(['pod-state'])
    expect(inner.calls).toEqual([])
  })

  it('runs at nice 19 with the still on stdin', async () => {
    const bytes = jpeg(32, 24, true)
    const res = await runPodvision({ command: command('ok'), args: ['--regions', '{"1":{"x":0,"y":0,"w":1,"h":1}}', '--model', specs[0]?.path as string], stdin: bytes }) as unknown as { nice: number, stdinBytes: number }
    expect(res.nice).toBe(PODVISION_NICE)
    expect(res.stdinBytes).toBe(bytes.byteLength)
  })

  it('returns damaged for a torn frame without asking TypeScript', async () => {
    const inner = spy()
    expect(await nativeExecutor({ inner: inner.run, command: command('damaged'), learned: () => specs })(job(['green-threshold', 'pod-state']))).toBe(DAMAGED)
    expect(inner.calls).toEqual([])
  })

  it.each([
    ['a missing binary', ['/nonexistent/podvision'], /ENOENT/],
    ['a failure', command('fail'), /exited with 4: podvision: bad JPEG: unexpected EOF/],
    ['nonsense on stdout', command('garbage'), /printed something that isn't a result/],
    ['a flood on stdout', command('flood'), /printed more than any result should be/],
    ['a result without a probability per class', command('short'), /one probability per class/],
  ])('falls back to TypeScript on %s, and logs it', async (_what, cmd, why) => {
    const inner = spy()
    const log = vi.fn()
    const out = await nativeExecutor({ inner: inner.run, command: cmd, learned: () => specs, log })(job(['green-threshold', 'pod-state']))
    expect(inner.calls).toEqual([['green-threshold', 'pod-state']])
    expect(Array.isArray(out) && out.map(o => o.analyzer)).toEqual(['green-threshold', 'pod-state'])
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]?.[0]).toMatch(why)
    expect(log.mock.calls[0]?.[0]).toMatch(/scoring pod-state in TypeScript$/)
  })

  it('kills a run that outlasts the timeout and falls back', async () => {
    const inner = spy()
    const log = vi.fn()
    const started = Date.now()
    await nativeExecutor({ inner: inner.run, command: command('hang'), learned: () => specs, log, timeoutMs: 300 })(job(['pod-state']))
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(inner.calls).toEqual([['pod-state']])
    expect(log.mock.calls[0]?.[0]).toMatch(/timed out after 300 ms/)
  })

  it('falls back when a weights file changed under it', async () => {
    const inner = spy()
    const log = vi.fn()
    writeFileSync(specs[0]?.path as string, JSON.stringify({ ...parity.model, version: 7 }))
    await nativeExecutor({ inner: inner.run, command: command('ok'), learned: () => specs, log })(job(['pod-state']))
    expect(inner.calls).toEqual([['pod-state']])
    expect(log.mock.calls[0]?.[0]).toMatch(/pod-state's weights file is no longer version 1/)
  })

  it('leaves to TypeScript what it can\'t run: no learned analyser, no file on disk, not a JPEG', async () => {
    const inner = spy(async () => null)
    const log = vi.fn()
    const run = (learned: LearnedSpec[]) => nativeExecutor({ inner: inner.run, command: command('fail'), learned: () => learned, log })
    await run(specs)(job(['green-threshold']))
    await run(specs.map(s => ({ ...s, path: undefined })))(job(['pod-state']))
    await run(specs)(job(['pod-state'], new TextEncoder().encode('<svg/>')))
    expect(inner.calls).toEqual([['green-threshold'], ['pod-state'], ['pod-state']])
    expect(log).not.toHaveBeenCalled()
  })

  it('keeps the learned results when TypeScript can\'t decode what the binary could, and passes on a damaged frame', async () => {
    const out = await nativeExecutor({ inner: async () => null, command: command('ok'), learned: () => specs })(job(['green-threshold', 'pod-state']))
    expect(Array.isArray(out) && out.map(o => o.analyzer)).toEqual(['pod-state'])
    expect(await nativeExecutor({ inner: async () => DAMAGED, command: command('ok'), learned: () => specs })(job(['exg-otsu', 'pod-state']))).toBe(DAMAGED)
  })
})

describe('finding the binary', () => {
  it('knows the release target for each Pi', () => {
    expect(podvisionTarget('linux', 'arm')).toBe('arm-unknown-linux-gnueabihf')
    expect(podvisionTarget('linux', 'arm64')).toBe('aarch64-unknown-linux-gnu')
    expect(podvisionTarget('linux', 'x64')).toBeNull()
    expect(podvisionTarget('darwin', 'arm64')).toBeNull()
  })

  it('looks in the release\'s bin/, or where PODVISION_BIN says', () => {
    expect(podvisionCandidates({}, 'arm-unknown-linux-gnueabihf').every(p => p.endsWith(join('bin', 'podvision-arm-unknown-linux-gnueabihf')))).toBe(true)
    expect(podvisionCandidates({}, null)).toEqual([])
    expect(podvisionCandidates({ PODVISION_BIN: '/x/podvision' })).toEqual(['/x/podvision'])
    expect(podvisionCandidates({ PODVISION_BIN: '' })).toEqual([])
    expect(findPodvision([fake])).toEqual({ path: fake })
    expect(findPodvision(['/nope/podvision']).why).toContain('/nope/podvision')
    expect(findPodvision([]).why).toMatch(/PODVISION_BIN=""/)
  })

  it('stands in front of the executor only when there is a binary, and says which way pod-state runs', () => {
    const log = vi.fn()
    expect(withPodvision(inlineExecutor, () => specs, { path: null, why: 'none here' }, log)).toBe(inlineExecutor)
    expect(log).toHaveBeenLastCalledWith('pod-state runs in TypeScript: none here')
    expect(withPodvision(inlineExecutor, () => specs, { path: '/bin/podvision' }, log)).not.toBe(inlineExecutor)
    expect(log).toHaveBeenLastCalledWith('pod-state runs natively with /bin/podvision at nice 19')
  })
})

// The real binary, when it has been built (cargo build -p podvision): the same still through both runners.
const built = [process.env.PODVISION_TEST_BIN, ...['release', 'debug'].map(p => fileURLToPath(new URL(`../../../hal/target/${p}/podvision`, import.meta.url)))].find(p => p && existsSync(p))

describe.skipIf(!built)('the built binary', () => {
  it('agrees with the TypeScript runner on a still, class for class', () => {
    const fx = parity as unknown as { image: { width: number, height: number, rgba: string }, model: unknown }
    const rgba = Uint8Array.from(atob(fx.image.rgba), c => c.charCodeAt(0))
    const bytes = new Uint8Array(encode({ data: rgba, width: fx.image.width, height: fx.image.height }, 95).data)
    const regions = { 1: { x: 0, y: 0, w: 0.5, h: 0.6 }, 2: { x: 0.4, y: 0.3, w: 0.6, h: 0.7 } }
    const out = JSON.parse(execFileSync(built as string, ['--regions', JSON.stringify(regions), '--model', specs[0]?.path as string], { input: bytes, encoding: 'utf8' }))
    const img = decodeJpeg(bytes)
    if (!img) throw new Error('should decode')
    const model = parseModel(fx.model)
    for (const [i, r] of Object.values(regions).entries()) {
      const ts = softmax(forward(model, cropInput(img, { x: r.x * img.width, y: r.y * img.height, w: r.w * img.width, h: r.h * img.height }, model.file.input)))
      const native = out.models[0].pods[i]
      expect(native.probabilities).toHaveLength(POD_STATES.length)
      expect(native.class).toBe(ts.indexOf(Math.max(...ts)))
      // Only the JPEG decoders differ (jpeg-js vs jpeg-decoder); the crop and forward pass match to 1e-4 (cargo test).
      native.probabilities.forEach((p: number, c: number) => expect(Math.abs(p - (ts[c] as number))).toBeLessThan(0.05))
    }
  })

  it('exits non-zero on a malformed still or weights file', () => {
    const run = (args: string[], input: Uint8Array | string) => {
      try {
        execFileSync(built as string, args, { input, stdio: 'pipe' })
        return 0
      }
      catch (e) {
        return (e as { status: number }).status
      }
    }
    const regions = ['--regions', '{"1":{"x":0,"y":0,"w":1,"h":1}}']
    expect(run([...regions, '--model', specs[0]?.path as string], 'GIF89a')).toBe(4)
    writeFileSync(join(dir, 'bad.json'), '{"format":"seedypod-cnn"}')
    expect(run([...regions, '--model', join(dir, 'bad.json')], jpeg(16, 16, true))).toBe(3)
    expect(run(['--model', 'x'], '')).toBe(2)
  })
})
