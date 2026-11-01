import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { BUDGET, createKit, measure, seeded, STAGES, type PlantStyle } from '../plants/kit'
import { LEAFY_BUILDERS } from '../plants/leafy'

type Archetype = keyof typeof LEAFY_BUILDERS

const VARIANTS: Record<Archetype, (string | undefined)[]> = {
  rosette: [undefined, 'frilly', 'romaine', 'head', 'endive'],
  upright: [undefined, 'curly', 'lacinato', 'chard', 'celery'],
  bokchoy: [undefined, 'tatsoi'],
  strap: [undefined, 'onion', 'grass'],
  cress: [undefined],
}
const CASES = (Object.keys(VARIANTS) as Archetype[]).flatMap(a => VARIANTS[a].map(v => [a, v] as const))
const SEEDS = [1, 2, 3, 7, 42]
const TALL = new Set(['romaine', 'celery'])

const styleFor = (variant?: string): PlantStyle => ({ leaf: '#5bbf5f', leafDark: '#3a8f45', accent: '#b48ad8', variant })

describe.each(CASES)('leafy %s (%s)', (archetype, variant) => {
  const kit = createKit(THREE)
  const style = styleFor(variant)
  const build = (stage: typeof STAGES[number], seed: number) => LEAFY_BUILDERS[archetype](kit, stage, style, seeded(seed))

  it('builds every stage within budget', () => {
    for (const stage of STAGES) {
      for (const seed of SEEDS) {
        const m = measure(THREE, build(stage, seed))
        expect(m.meshes).toBeGreaterThan(0)
        expect(m.meshes).toBeLessThanOrEqual(BUDGET.meshes)
        expect(m.triangles).toBeLessThanOrEqual(BUDGET.triangles)
      }
    }
  })

  it('grows from a small sprout and never shrinks from young to full', () => {
    for (const seed of SEEDS) {
      const sprout = measure(THREE, build('sprout', seed)).size
      expect(sprout.y).toBeGreaterThanOrEqual(0.012)
      expect(sprout.y).toBeLessThanOrEqual(0.025)
      const [young, bush, full] = (['young', 'bush', 'full'] as const).map(s => measure(THREE, build(s, seed)).size)
      const width = (v: THREE.Vector3) => Math.max(v.x, v.z)
      expect(bush.y).toBeGreaterThanOrEqual(young.y)
      expect(full.y).toBeGreaterThanOrEqual(bush.y)
      expect(width(bush)).toBeGreaterThanOrEqual(width(young))
      expect(width(full)).toBeGreaterThanOrEqual(width(bush))
    }
  })

  it('is harvest-sized at full', () => {
    for (const seed of SEEDS) {
      const { size } = measure(THREE, build('full', seed))
      expect(Math.max(size.x, size.z)).toBeGreaterThanOrEqual(0.06)
      expect(Math.max(size.x, size.z)).toBeLessThanOrEqual(0.09)
      expect(size.y).toBeLessThanOrEqual(TALL.has(variant ?? '') ? 0.12 : 0.1)
    }
  })

  it('tags every leaf-coloured mesh as a leaf', () => {
    const leafColors = new Set([style.leaf, style.leafDark].map(c => new THREE.Color(c).getHex()))
    for (const stage of STAGES) {
      let leaves = 0
      build(stage, 3).traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        if (m.userData.role === 'leaf') leaves++
        if (leafColors.has((m.material as THREE.MeshStandardMaterial).color.getHex())) expect(m.userData.role).toBe('leaf')
      })
      expect(leaves).toBeGreaterThan(0)
    }
  })

  it('builds the same plant from the same seed', () => {
    const snapshot = (seed: number) => {
      const out: number[] = []
      const g = build('full', seed)
      g.updateMatrixWorld(true)
      g.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) out.push(...o.matrixWorld.elements)
      })
      return out
    }
    expect(snapshot(5)).toEqual(snapshot(5))
    expect(snapshot(5)).not.toEqual(snapshot(6))
  })

  it('shares cached geometry between plants', () => {
    const fresh = createKit(THREE)
    const make = vi.fn()
    const geometry = fresh.geometry
    fresh.geometry = (key, m) => geometry(key, () => {
      make(key)
      return m()
    })
    const geometries = (seed: number) => {
      const out = new Set<THREE.BufferGeometry>()
      for (const stage of STAGES) {
        LEAFY_BUILDERS[archetype](fresh, stage, style, seeded(seed)).traverse((o) => {
          if ((o as THREE.Mesh).isMesh) out.add((o as THREE.Mesh).geometry)
        })
      }
      return out
    }
    const first = geometries(1)
    const made = make.mock.calls.length
    const second = geometries(2)
    expect(make.mock.calls.length).toBe(made)
    expect([...second].every(g => first.has(g))).toBe(true)
  })
})
