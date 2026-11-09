import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findAnalyzer, installLearned } from '../analyzer'
import type { Rect } from '../greenArea'
import { decodeJpeg } from '../analyze'
import { forward, softmax, type ModelFile } from '../cnn'
import type { AnalysisJob, Executor } from '../execute'
import { createNativeExecutor, INSTALLED_PODVISION, podvisionBinary, runPodvision, type PodvisionOutput } from '../nativeExecutor'
import { classifyPods, cropInput, cropWindow, learnedAnalyzers, parsePodStateModel, type LearnedSpec } from '../podState'
import { podRegions, toPixels } from '../regions'
import parity from './parity/pod-state-parity.json'
import { jpeg } from './fixtures'

const modelPath = resolve(import.meta.dirname, '../../../models/pod-state.json')
const modelText = readFileSync(modelPath, 'utf8')
const shipped: LearnedSpec = { id: 'pod-state', label: 'Pod state (learned)', text: modelText, path: modelPath }
const version = parsePodStateModel(modelText).file.version
const LOWER = Array.from({ length: 15 }, (_, i) => 16 + i)

let dir: string
let log: ReturnType<typeof vi.fn<(m: string) => void>>
let fallback: ReturnType<typeof vi.fn<Executor>>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podvision-'))
  log = vi.fn<(m: string) => void>()
  fallback = vi.fn<Executor>(async job => job.analyzers.map(a => ({ analyzer: a, version: findAnalyzer(a)?.version ?? 0, results: [{ slot: 16, metric: 'green_fraction', value: 0.5 }] })))
  installLearned(learnedAnalyzers([shipped]))
})

afterEach(() => {
  installLearned([])
  rmSync(dir, { recursive: true, force: true })
})

interface Plan { exit?: number, stdout?: unknown, stderr?: string, sleep?: number }

/** A stand-in podvision: it logs its arguments and how much it read, then does what the plan says. */
function fake(plan: Plan): string {
  const bin = join(dir, 'podvision')
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan))
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs')
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'plan.json'))}, 'utf8'))
let n = 0
process.stdin.on('data', d => { n += d.length })
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, JSON.stringify({ args: process.argv.slice(2), stdin: n }) + '\\n')
  setTimeout(() => {
    if (plan.stderr) process.stderr.write(plan.stderr)
    if (plan.stdout !== undefined) process.stdout.write(typeof plan.stdout === 'string' ? plan.stdout : JSON.stringify(plan.stdout))
    process.exitCode = plan.exit ?? 0
  }, plan.sleep ?? 0)
})
`)
  chmodSync(bin, 0o755)
  return bin
}

const calls = (): Array<{ args: string[], stdin: number }> => existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { args: string[], stdin: number }) : []

/** podvision's answer: every lower pod "growing" at 0.7. */
function answer(o: Partial<PodvisionOutput> = {}, model: Partial<PodvisionOutput['models'][number]> = {}): PodvisionOutput {
  return {
    width: 1280,
    height: 960,
    scale: 1,
    brightness: 0.4,
    damaged: false,
    models: [{ id: 'pod-state', version, revision: 'bootstrap', classes: ['empty', 'sprouted', 'growing', 'ready', 'unhealthy'], dark: false, pods: LOWER.map(slot => ({ slot, class: 2, probabilities: [0.05, 0.1, 0.7, 0.1, 0.05], logits: [0, 0, 0, 0, 0] })), ...model }],
    ms: { decode: 1, forward: 1 },
    ...o,
  }
}

const job = (analyzers: string[], bytes = jpeg(64, 48, true)): AnalysisJob => ({ bytes, camera: 'lower', analyzers, opts: { artifacts: false } })

describe('native executor', () => {
  it('runs pod-state in podvision and the rule-based analysers on the fallback', async () => {
    const bin = fake({ stdout: answer() })
    const ex = createNativeExecutor({ bin, fallback, learned: [shipped], log })
    const bytes = jpeg(64, 48, true)
    const out = await ex.run(job(['green-threshold', 'pod-state', 'exg-otsu'], bytes))
    if (!Array.isArray(out)) throw new Error('should have scored it')
    expect(out.map(o => o.analyzer)).toEqual(['green-threshold', 'exg-otsu', 'pod-state'])
    expect(fallback).toHaveBeenCalledOnce()
    expect(fallback.mock.calls[0]?.[0].analyzers).toEqual(['green-threshold', 'exg-otsu'])
    const pod = out[2]
    expect(pod?.version).toBe(version)
    expect(pod?.results).toHaveLength(30)
    expect(pod?.results[0]).toEqual({ slot: 16, metric: 'pod_state', value: 2, detail: { state: 'growing', confidence: 0.7, probabilities: { empty: 0.05, sprouted: 0.1, growing: 0.7, ready: 0.1, unhealthy: 0.05 }, revision: 'bootstrap' } })
    expect(pod?.results[1]).toEqual({ slot: 16, metric: 'pod_state_confidence', value: 0.7 })
    const [call] = calls()
    expect(call?.stdin).toBe(bytes.byteLength)
    expect(call?.args).toEqual(['--pods', JSON.stringify(podRegions('lower')), '--model', `pod-state=${modelPath}`])
    expect(log).not.toHaveBeenCalled()
  })

  it('passes the calibrated boxes and leaves the fallback alone when only learned analysers run', async () => {
    const ex = createNativeExecutor({ bin: fake({ stdout: answer() }), fallback, learned: [shipped], log })
    const regions = { 16: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }
    const out = await ex.run({ ...job(['pod-state']), regions })
    expect(Array.isArray(out) && out.map(o => o.analyzer)).toEqual(['pod-state'])
    expect(fallback).not.toHaveBeenCalled()
    expect(calls()[0]?.args[1]).toBe(JSON.stringify(regions))
  })

  it('stores nothing for a dark still and drops a damaged one', async () => {
    const dark = await createNativeExecutor({ bin: fake({ stdout: answer({}, { dark: true, pods: [] }) }), fallback, learned: [shipped], log }).run(job(['pod-state']))
    expect(dark).toEqual([{ analyzer: 'pod-state', version, results: [] }])
    const damaged = await createNativeExecutor({ bin: fake({ stdout: answer({ damaged: true, models: [] }) }), fallback, learned: [shipped], log }).run(job(['exg-otsu', 'pod-state']))
    expect(damaged).toBe('damaged')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('takes the fallback\'s word on a damaged frame, and keeps its own results when the fallback can\'t decode', async () => {
    const bin = fake({ stdout: answer() })
    fallback.mockResolvedValueOnce('damaged')
    expect(await createNativeExecutor({ bin, fallback, learned: [shipped], log }).run(job(['exg-otsu', 'pod-state']))).toBe('damaged')
    fallback.mockResolvedValueOnce(null)
    const out = await createNativeExecutor({ bin, fallback, learned: [shipped], log }).run(job(['exg-otsu', 'pod-state']))
    expect(Array.isArray(out) && out.map(o => o.analyzer)).toEqual(['pod-state'])
  })

  const failures: Array<[string, Plan, string]> = [
    ['exits non-zero', { exit: 1, stderr: 'podvision: not a decodable JPEG\n' }, 'podvision: podvision: not a decodable JPEG; running pod-state in TypeScript'],
    ['exits non-zero without a word', { exit: 3 }, 'exit 3'],
    ['prints something else', { stdout: 'hello' }, 'isn\'t JSON'],
    ['leaves a model out', { stdout: answer({ models: [] }) }, 'no result for pod-state'],
    ['ran another version', { stdout: answer({}, { version: 99 }) }, `pod-state ran version 99, core lists ${version}`],
    ['prints far too much', { stdout: 'x'.repeat(5 << 20) }, 'printed more than any result'],
  ]
  for (const [what, plan, message] of failures) {
    it(`runs everything on the fallback when podvision ${what}`, async () => {
      const ex = createNativeExecutor({ bin: fake(plan), fallback, learned: [shipped], log })
      const out = await ex.run(job(['exg-otsu', 'pod-state']))
      expect(Array.isArray(out) && out.map(o => o.analyzer)).toEqual(['exg-otsu', 'pod-state'])
      expect(fallback.mock.calls[0]?.[0].analyzers).toEqual(['exg-otsu', 'pod-state'])
      expect(log.mock.calls[0]?.[0]).toContain(message)
    })
  }

  it('kills podvision when it runs past the timeout', async () => {
    const ex = createNativeExecutor({ bin: fake({ stdout: answer(), sleep: 5000 }), fallback, learned: [shipped], log, timeoutMs: 300 })
    const started = Date.now()
    await ex.run(job(['pod-state']))
    expect(Date.now() - started).toBeLessThan(3000)
    expect(log.mock.calls[0]?.[0]).toContain('timed out after 300 ms')
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('falls back when the binary is gone', async () => {
    const ex = createNativeExecutor({ bin: join(dir, 'missing'), fallback, learned: [shipped], log })
    await ex.run(job(['pod-state']))
    expect(log.mock.calls[0]?.[0]).toContain('ENOENT')
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('never starts podvision for what it can\'t run', async () => {
    const bin = fake({ stdout: answer() })
    // Not a JPEG (a demo SVG), a spec with no file on disk, a revision that isn't listed, and no learned analyser asked for.
    await createNativeExecutor({ bin, fallback, learned: [shipped], log }).run(job(['pod-state'], new Uint8Array([60, 115, 118, 103])))
    await createNativeExecutor({ bin, fallback, learned: [{ ...shipped, path: undefined }], log }).run(job(['pod-state']))
    await createNativeExecutor({ bin, fallback, learned: [{ ...shipped, id: 'pod-state-other' }], log }).run(job(['pod-state-other']))
    await createNativeExecutor({ bin, fallback, learned: [shipped], log }).run(job(['exg-otsu']))
    expect(calls()).toEqual([])
    expect(fallback).toHaveBeenCalledTimes(4)
  })

  it('follows the registry\'s changes', async () => {
    const bin = fake({ stdout: answer() })
    const ex = createNativeExecutor({ bin, fallback, log })
    await ex.run(job(['pod-state']))
    expect(calls()).toHaveLength(0)
    ex.configure([shipped])
    await ex.run(job(['pod-state']))
    expect(calls()).toHaveLength(1)
  })
})

describe('podvision binary', () => {
  it('is PODVISION when set, off when that is empty, else the installed one if it is there', () => {
    expect(podvisionBinary({ PODVISION: '/opt/podvision' })).toBe('/opt/podvision')
    expect(podvisionBinary({ PODVISION: '' })).toBeNull()
    expect(podvisionBinary({})).toBe(existsSync(INSTALLED_PODVISION) ? INSTALLED_PODVISION : null)
  })
})

// The real binary, when it's built (CI builds it before the unit tests): `cargo build -p podvision` in hal/.
const built = [process.env.PODVISION_TEST_BIN, resolve(import.meta.dirname, '../../../hal/target/release/podvision'), resolve(import.meta.dirname, '../../../hal/target/debug/podvision')].find(p => p && existsSync(p))

describe.skipIf(!built)('podvision itself', () => {
  const bin = built as string
  const fixture = parity as unknown as { model: ModelFile, image: { width: number, height: number, rgba: string }, cases: Array<{ rect: { x: number, y: number, w: number, h: number }, logits: number[] }> }
  const { width, height } = fixture.image
  const rgba = Uint8Array.from(atob(fixture.image.rgba), c => c.charCodeAt(0))

  it('matches the parity fixture within 1e-4, as core\'s own forward pass does', async () => {
    const model = join(dir, 'parity.json')
    writeFileSync(model, JSON.stringify(fixture.model))
    // Raw pixels, so no decoder stands between the fixture and the crops.
    const rgb = new Uint8Array(width * height * 3)
    for (let p = 0; p < width * height; p++) rgb.set(rgba.subarray(p * 4, p * 4 + 3), p * 3)
    const ppm = new Uint8Array([...new TextEncoder().encode(`P6\n${width} ${height}\n255\n`), ...rgb])
    const regions = Object.fromEntries(fixture.cases.map((c, i) => [i + 1, { x: c.rect.x / width, y: c.rect.y / height, w: c.rect.w / width, h: c.rect.h / height }]))
    const out = await runPodvision(bin, ppm, regions, [{ id: 'pod-state', path: model }])
    expect(out).toMatchObject({ width, height, scale: 1, damaged: false })
    const ts = parsePodStateModel(JSON.stringify(fixture.model))
    const img = { width, height, data: rgba }
    const px = toPixels(regions, width, height)
    out.models[0]?.pods.forEach((p, i) => {
      const c = fixture.cases[i] as { rect: unknown, logits: number[] }
      // The fraction's round trip can be a hair off; the pixels read are the same.
      expect(cropWindow(px[p.slot] as Rect, width, height)).toEqual(cropWindow(c.rect as Rect, width, height))
      const mine = forward(ts, cropInput(img, px[p.slot] as never, ts.file.input))
      c.logits.forEach((v, k) => {
        expect(Math.abs((p.logits[k] as number) - v)).toBeLessThan(1e-4)
        expect(Math.abs((p.logits[k] as number) - (mine[k] as number))).toBeLessThan(1e-4)
      })
    })
  })

  // jpeg-js and podvision's decoder round chroma differently (podvision's is libjpeg's, which training uses), so
  // the two runners agree to the decoders' difference, not to 1e-4. Sharp colour bands make that difference largest.
  it('names the same state as the TypeScript runner on a JPEG, within the decoders\' difference', async () => {
    const bytes = jpeg(640, 480, true)
    const camera = 'lower'
    const regions = podRegions(camera)
    const out = await runPodvision(bin, bytes, regions, [{ id: 'pod-state', path: modelPath }])
    const img = decodeJpeg(bytes)
    if (!img) throw new Error('fixture should decode')
    const ts = classifyPods(parsePodStateModel(modelText), img, toPixels(regions, img.width, img.height))
    const model = out.models[0]
    expect(model?.pods.map(p => p.slot)).toEqual(LOWER)
    for (const p of model?.pods ?? []) {
      const theirs = ts.find(r => r.slot === p.slot && r.metric === 'pod_state')
      const probabilities = (theirs?.detail as { probabilities: Record<string, number> }).probabilities
      expect(p.class).toBe(theirs?.value)
      model?.classes.forEach((c, k) => expect(Math.abs((p.probabilities[k] as number) - (probabilities[c] as number))).toBeLessThan(0.1))
    }
    expect(softmax(new Float32Array(model?.pods[0]?.logits ?? [])).every((v, k) => Math.abs(v - (model?.pods[0]?.probabilities[k] as number)) < 1e-5)).toBe(true)
  })

  it('exits non-zero on a broken still or weights file', async () => {
    await expect(runPodvision(bin, new Uint8Array([0xFF, 0xD8, 0xFF, 0x00]), podRegions('upper'), [{ id: 'pod-state', path: modelPath }])).rejects.toThrow(/JPEG/)
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{"format":"onnx"}')
    await expect(runPodvision(bin, jpeg(64, 48, true), podRegions('upper'), [{ id: 'pod-state', path: broken }])).rejects.toThrow(/model pod-state/)
  })
})
