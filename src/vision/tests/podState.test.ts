import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deviceAnalyzers, findAnalyzer, info, installLearned, RULE_ANALYZERS, runAnalyzers } from '../analyzer'
import { forward, ModelError, parseModel, softmax, type ModelFile } from '../cnn'
import { execute } from '../execute'
import { podStateCandidates, readPodStateModel } from '../modelFile'
import { brightness, classifyPods, cropInput, cropWindow, NO_WEIGHTS, POD_STATE_ID, POD_STATES, podStateAnalyzer, podStateFromText } from '../podState'
import parity from './parity/pod-state-parity.json'
import { jpeg } from './fixtures'

const fixture = parity as unknown as {
  model: ModelFile
  image: { width: number, height: number, rgba: string }
  cases: Array<{ rect: { x: number, y: number, w: number, h: number }, inputSum: number, inputHead: number[], logits: number[], probabilities: number[] }>
}
const image = { width: fixture.image.width, height: fixture.image.height, data: Uint8Array.from(atob(fixture.image.rgba), c => c.charCodeAt(0)) }
const model = parseModel(fixture.model)
const clone = (): ModelFile => JSON.parse(JSON.stringify(fixture.model)) as ModelFile

afterEach(() => installLearned([]))

describe('pod-state forward pass', () => {
  it('matches PyTorch on the fixture crops within 1e-4', () => {
    expect(model.params).toBe(23_909)
    for (const c of fixture.cases) {
      const x = cropInput(image, c.rect, model.file.input)
      expect(x.reduce((s, v) => s + v, 0)).toBeCloseTo(c.inputSum, 1)
      c.inputHead.forEach((v, i) => expect(Math.abs((x[i] as number) - v)).toBeLessThan(1e-6))
      const logits = forward(model, x)
      c.logits.forEach((v, i) => expect(Math.abs((logits[i] as number) - v)).toBeLessThan(1e-4))
      const p = softmax(logits)
      c.probabilities.forEach((v, i) => expect(Math.abs((p[i] as number) - v)).toBeLessThan(1e-4))
    }
  })

  it('reuses its buffers without one call leaking into the next', () => {
    const [a, b] = fixture.cases.map(c => cropInput(image, c.rect, model.file.input))
    const first = forward(model, a as Float32Array)
    forward(model, b as Float32Array)
    expect([...forward(model, a as Float32Array)]).toEqual([...first])
  })

  it('refuses inputs of the wrong size', () => {
    expect(() => forward(model, new Float32Array(10))).toThrow(ModelError)
  })

  it('turns logits into probabilities that sum to 1, stable for large values', () => {
    const p = softmax(new Float32Array([1000, 1000, 0]))
    expect(p[0]).toBeCloseTo(0.5)
    expect(p.reduce((s, v) => s + v, 0)).toBeCloseTo(1)
  })
})

describe('weights file validation', () => {
  const broken: Array<[string, (f: ModelFile) => unknown]> = [
    ['not a seedypod-cnn', f => ({ ...f, format: 'onnx' })],
    ['format version', f => ({ ...f, formatVersion: 2 })],
    ['version must', f => ({ ...f, version: 0 })],
    ['at least two', f => ({ ...f, classes: ['one'] })],
    ['layout HWC', f => ({ ...f, input: { ...f.input, layout: 'CHW' } })],
    ['mean and std', f => ({ ...f, input: { ...f.input, std: [1, 0, 1] } })],
    ['layers is empty', f => ({ ...f, layers: [] })],
    ['takes 4 channels', f => ({ ...f, layers: [{ ...f.layers[0], in: 4 }, ...f.layers.slice(1)] })],
    ['is missing', (f) => {
      delete f.tensors['fc.bias']
      return f
    }],
    ['expected 5', f => ({ ...f, tensors: { ...f.tensors, 'fc.bias': { ...f.tensors['fc.bias'], shape: [4] } } })],
    ['its shape says', f => ({ ...f, tensors: { ...f.tensors, 'fc.bias': { ...f.tensors['fc.bias'], data: 'AAAAAA==' } } })],
    ['must be float32', f => ({ ...f, tensors: { ...f.tensors, 'fc.bias': { ...f.tensors['fc.bias'], dtype: 'float16' } } })],
    ['not a known layer', f => ({ ...f, layers: [{ type: 'softmax' }, ...f.layers] })],
    ['gap layer before', f => ({ ...f, layers: f.layers.filter(l => l.type !== 'gap') })],
    ['follows a flattening', f => ({ ...f, layers: [...f.layers.slice(0, -1), { type: 'gap' }, f.layers.at(-1)] })],
    ['on a 1×1 map', f => ({ ...f, input: { ...f.input, width: 1, height: 1 } })],
    ['one output per class', f => ({ ...f, classes: [...f.classes, 'extra'] })],
  ]
  it.each(broken)('names the problem: %s', (msg, change) => {
    expect(() => parseModel(change(clone()))).toThrow(msg)
  })

  it('rejects anything that is not an object', () => {
    expect(() => parseModel(null)).toThrow('not a seedypod-cnn')
  })
})

describe('pod crops', () => {
  it('read the same integer window as the rule-based analysers, clamped to the frame', () => {
    expect(cropWindow({ x: 10.4, y: 7.6, w: 70.3, h: 66.2 }, 160, 120)).toEqual({ x0: 10, y0: 7, x1: 81, y1: 74 })
    expect(cropWindow({ x: 150, y: 110, w: 30, h: 30 }, 160, 120)).toEqual({ x0: 150, y0: 110, x1: 160, y1: 120 })
    expect(cropWindow({ x: 200, y: 5, w: 0, h: 0 }, 160, 120)).toEqual({ x0: 159, y0: 5, x1: 160, y1: 6 })
  })

  it('average each cell and normalise per channel', () => {
    const flat = { width: 4, height: 4, data: new Uint8Array(64).fill(51) }
    const inp = { width: 2, height: 2, channels: 3, layout: 'HWC' as const, scale: 255, mean: [0.2, 0, 0.1], std: [1, 0.5, 0.1] }
    expect([...cropInput(flat, { x: 0, y: 0, w: 4, h: 4 }, inp)].map(v => Math.round(v * 1000) / 1000)).toEqual(Array(4).fill([0, 0.4, 1]).flat())
  })
})

describe('pod-state analyser', () => {
  it('names a state and a confidence for every pod', () => {
    const pods = { 3: fixture.cases[0]?.rect as never, 7: fixture.cases[1]?.rect as never }
    const rows = classifyPods(model, image, pods)
    expect(rows.map(r => `${r.slot}:${r.metric}`)).toEqual(['3:pod_state', '3:pod_state_confidence', '7:pod_state', '7:pod_state_confidence'])
    const state = rows[0]
    const p = fixture.cases[0]?.probabilities as number[]
    const best = p.indexOf(Math.max(...p))
    expect(state?.value).toBe(best)
    expect(state?.detail).toMatchObject({ state: POD_STATES[best], revision: 'parity-fixture' })
    expect(rows[1]?.value).toBeCloseTo(p[best] as number, 3)
    expect(Object.keys(state?.detail?.probabilities as object)).toEqual([...POD_STATES])
  })

  it('skips a still darker than the model was trained on', () => {
    const dark = { width: 10, height: 10, data: new Uint8Array(400).fill(20) }
    expect(brightness(dark)).toBeCloseTo(20 / 255)
    expect(brightness({ width: 0, height: 0, data: new Uint8Array(0) })).toBe(0)
    const pods = { 1: { x: 0, y: 0, w: 10, h: 10 } }
    expect(classifyPods(parseModel({ ...clone(), minBrightness: 0.1 }), dark, pods)).toEqual([])
    expect(classifyPods(parseModel({ ...clone(), minBrightness: 0.05 }), dark, pods)).toHaveLength(2)
  })

  it('runs as one more device analyser once installed, and through the shared execute step', () => {
    installLearned([podStateFromText(JSON.stringify(fixture.model))])
    const a = findAnalyzer(POD_STATE_ID)
    expect(a?.disabled).toBeUndefined()
    expect(a?.version).toBe(1)
    expect(info(a as never)).not.toHaveProperty('disabled')
    expect(deviceAnalyzers().map(x => x.id)).toEqual([...RULE_ANALYZERS.map(x => x.id), POD_STATE_ID])
    const out = execute({ bytes: jpeg(320, 240, true), camera: 'upper', analyzers: [POD_STATE_ID], opts: { artifacts: false } })
    if (!Array.isArray(out)) throw new Error('should have scored it')
    expect(out.map(o => `${o.analyzer}@${o.version}`)).toEqual(['pod-state@1'])
    expect(out[0]?.results.filter(r => r.metric === 'pod_state')).toHaveLength(15)
  }, 30_000)

  it('stays listed but never runs without weights, and says why', () => {
    installLearned([podStateFromText(null)])
    const a = findAnalyzer(POD_STATE_ID)
    expect(a?.disabled).toBe(NO_WEIGHTS)
    expect(info(a as never).disabled).toBe(NO_WEIGHTS)
    expect(a?.run(image, {}, { artifacts: false }).results).toEqual([])
    const out = execute({ bytes: jpeg(320, 240, true), camera: 'upper', analyzers: [POD_STATE_ID, 'exg-otsu'], opts: { artifacts: false } })
    expect(Array.isArray(out) && out.map(o => o.analyzer)).toEqual(['exg-otsu'])
    expect(runAnalyzers(image, 'upper', [podStateAnalyzer(null)], { artifacts: false })[0]?.results).toEqual([])
  })

  it('is disabled with the reason when the file is bad or for another analyser', () => {
    expect(podStateFromText('{').disabled).toMatch(/could not be loaded/)
    expect(podStateFromText(JSON.stringify({ ...fixture.model, analyzer: 'leaf-count' })).disabled).toMatch(/for leaf-count/)
    expect(podStateFromText(JSON.stringify({ ...fixture.model, classes: ['a', 'b', 'c', 'd', 'e'] })).disabled).toMatch(/classes must be/)
    expect(podStateFromText('{').disabled).toMatch(/not JSON/)
    expect(podStateFromText(null, 'gone').disabled).toBe('gone')
  })
})

describe('shipped weights file', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('is looked for at models/pod-state.json, or where POD_STATE_MODEL says', () => {
    expect(podStateCandidates({}).every(p => p.endsWith(join('models', 'pod-state.json')))).toBe(true)
    expect(podStateCandidates({ POD_STATE_MODEL: '/x/y.json' })).toEqual(['/x/y.json'])
    expect(podStateCandidates({ POD_STATE_MODEL: '' })).toEqual([])
    expect(readPodStateModel([]).missing).toMatch(/POD_STATE_MODEL=""/)
  })

  it('reads the first file that exists and says where it looked when none does', () => {
    dir = mkdtempSync(join(tmpdir(), 'pod-state-'))
    const file = join(dir, 'pod-state.json')
    expect(readPodStateModel([file]).missing).toContain(file)
    writeFileSync(file, '{"x":1}')
    expect(readPodStateModel([join(dir, 'nope.json'), file])).toEqual({ text: '{"x":1}', path: file })
    expect(readPodStateModel([dir]).missing).toMatch(/could not be read/)
  })

  it('ships in the repo, loads, and stays under 500 KB', () => {
    const { text } = readPodStateModel()
    expect(text).not.toBeNull()
    expect((text as string).length).toBeLessThan(500_000)
    const a = podStateFromText(text)
    expect(a.disabled).toBeUndefined()
    expect(a.description).toMatch(/bootstrap-2026-11.*weak labels.*baseline to beat/)
  })
})
