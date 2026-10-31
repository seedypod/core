import { describe, expect, it } from 'vitest'
import { decodeJpeg } from '../analyze'
import { DEVICE_ANALYZERS, excessGreen, exgOtsu, findAnalyzer, greenThreshold, info, maskPbm, otsu, runAnalyzers } from '../analyzer'
import { execute } from '../execute'
import { jpeg } from './fixtures'

const img = (bytes: Uint8Array) => {
  const d = decodeJpeg(bytes)
  if (!d) throw new Error('fixture did not decode')
  return d
}

describe('analysers', () => {
  it('describe themselves completely and uniquely', () => {
    const ids = DEVICE_ANALYZERS.map(a => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const a of DEVICE_ANALYZERS) {
      const i = info(a)
      expect(i).not.toHaveProperty('run')
      expect(i.label && i.description && i.version >= 1).toBeTruthy()
      expect(i.metrics.map(m => m.name)).toContain('green_fraction')
      expect(i.runsOn).toContain('device')
    }
    expect(findAnalyzer('exg-otsu')).toBe(exgOtsu)
    expect(findAnalyzer('nope')).toBeUndefined()
  })

  it('score the green column high and the soil column low', () => {
    const out = runAnalyzers(img(jpeg(300, 250, true)), 'upper', DEVICE_ANALYZERS, { artifacts: false })
    expect(out.map(o => `${o.analyzer}@${o.version}`)).toEqual(['green-threshold@1', 'exg-otsu@1'])
    for (const o of out) {
      expect(o.results).toHaveLength(15)
      const bySlot = new Map(o.results.map(r => [r.slot, r.value]))
      // Left column (slots 1, 4, 7, …) is green; right column (3, 6, …) is soil.
      expect(bySlot.get(1)).toBeGreaterThan(0.5)
      expect(bySlot.get(3)).toBeLessThan(0.05)
      expect(o.artifacts).toBeUndefined()
    }
    const lower = runAnalyzers(img(jpeg(300, 250, false)), 'lower', [greenThreshold], { artifacts: false })[0]
    expect(lower?.results.map(r => r.slot)).toEqual(Array.from({ length: 15 }, (_, i) => 16 + i))
  })

  it('exg-otsu reports its per-image threshold and emits a mask only when asked', () => {
    const [o] = runAnalyzers(img(jpeg(64, 40, true)), 'upper', [exgOtsu], { artifacts: true })
    expect(o?.results[0]?.detail).toHaveProperty('threshold')
    const mask = o?.artifacts?.[0]
    expect(mask?.name).toBe('mask.pbm')
    expect(new TextDecoder().decode(mask?.bytes.slice(0, 9))).toBe('P4\n64 40\n')
  })

  it('otsu splits a bimodal histogram between its modes and never calls flat soil plant', () => {
    const bimodal = new Uint8Array(200)
    bimodal.fill(130, 0, 100)
    bimodal.fill(220, 100)
    const t = otsu(bimodal)
    expect(t).toBeGreaterThanOrEqual(138)
    expect(t).toBeLessThan(220)
    expect(otsu(new Uint8Array(50).fill(100))).toBe(138)
  })

  it('excess green clamps into a byte and the PBM packs eight pixels per byte', () => {
    const px = { width: 2, height: 1, data: new Uint8Array([0, 255, 0, 255, 255, 0, 255, 255]) }
    expect([...excessGreen(px)]).toEqual([255, 0])
    const mask = maskPbm(new Uint8Array([255, 0, 255, 0, 0, 0, 0, 0, 255]), 9, 1, 138)
    const header = 'P4\n9 1\n'.length
    expect([...mask.slice(header)]).toEqual([0b10100000, 0b10000000])
  })

  it('execute runs only the requested analysers and skips non-JPEGs', () => {
    expect(execute({ bytes: new Uint8Array([1, 2]), camera: 'upper', analyzers: ['exg-otsu'], opts: { artifacts: false } })).toBeNull()
    const out = execute({ bytes: jpeg(60, 50, true), camera: 'upper', analyzers: ['exg-otsu', 'unknown'], opts: { artifacts: false } })
    expect(out?.map(o => o.analyzer)).toEqual(['exg-otsu'])
  })
})
