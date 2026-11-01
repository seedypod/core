import * as THREE from 'three'
import type * as T from 'three'
import { describe, expect, it } from 'vitest'
import { FRUITING_BUILDERS } from '../plants/fruiting'
import { BUDGET, createKit, measure, seeded, STAGES, type Stage } from '../plants/kit'

type Archetype = keyof typeof FRUITING_BUILDERS

const VARIANTS: Record<Archetype, (string | undefined)[]> = {
  'fruiting-bush': [undefined, 'cherry-tomato', 'pepper', 'jalapeno', 'banana', 'eggplant'],
  'vine': [undefined, 'cucumber', 'bean', 'pea'],
  'strawberry': [undefined],
  'brassica-head': [undefined, 'kohlrabi'],
}
const CASES = Object.entries(VARIANTS).flatMap(([a, vs]) => vs.map(v => [a as Archetype, v] as const))
const STYLE = { leaf: '#4f8a3a', leafDark: '#2f5e2a', accent: '#d8323a', accent2: '#8fbf4f' }
const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1)

function build(a: Archetype, variant: string | undefined, stage: Stage, seed: number, kit = createKit(THREE)) {
  return FRUITING_BUILDERS[a](kit, stage, { ...STYLE, variant }, seeded(seed))
}

function meshes(g: T.Object3D): T.Mesh[] {
  const out: T.Mesh[] = []
  g.traverse((o) => {
    if ((o as T.Mesh).isMesh) out.push(o as T.Mesh)
  })
  return out
}

const roles = (g: T.Object3D, role: string) => meshes(g).filter(m => m.userData.role === role)

describe.each(CASES)('%s %s', (a, variant) => {
  it('builds every stage within budget', () => {
    for (const stage of STAGES) {
      const m = measure(THREE, build(a, variant, stage, 1))
      expect(m.meshes, stage).toBeGreaterThan(0)
      expect(m.meshes, stage).toBeLessThanOrEqual(BUDGET.meshes)
      expect(m.triangles, stage).toBeLessThanOrEqual(BUDGET.triangles)
    }
  })

  it('is a small seedling at sprout', () => {
    for (const seed of SEEDS) {
      const g = build(a, variant, 'sprout', seed)
      const { size } = measure(THREE, g)
      expect(size.y).toBeGreaterThanOrEqual(0.012)
      expect(size.y).toBeLessThanOrEqual(0.025)
      expect(roles(g, 'leaf')).toHaveLength(2)
    }
  })

  it('never shrinks from young to bush to full, and stays within the envelope at full', () => {
    for (const seed of SEEDS) {
      const [young, bush, full] = (['young', 'bush', 'full'] as const).map(s => measure(THREE, build(a, variant, s, seed)).size)
      for (const [smaller, larger] of [[young, bush], [bush, full]]) {
        expect(larger.y).toBeGreaterThanOrEqual(smaller.y)
        expect(Math.max(larger.x, larger.z)).toBeGreaterThanOrEqual(Math.max(smaller.x, smaller.z))
      }
      expect(full.y).toBeLessThanOrEqual(0.16)
      expect(full.x).toBeLessThanOrEqual(0.12)
      expect(full.z).toBeLessThanOrEqual(0.12)
    }
  })

  it('tags leaves, fruit and flowers, with ripe fruit only once grown', () => {
    const young = build(a, variant, 'young', 3)
    expect(roles(young, 'leaf').length).toBeGreaterThanOrEqual(3)
    expect(roles(young, 'fruit')).toHaveLength(0)
    expect(roles(young, 'flower')).toHaveLength(0)
    const bush = build(a, variant, 'bush', 3)
    expect(roles(bush, 'fruit').length + roles(bush, 'flower').length).toBeGreaterThan(0)
    const full = build(a, variant, 'full', 3)
    expect(roles(full, 'leaf').length).toBeGreaterThan(0)
    const fruit = roles(full, 'fruit')
    expect(fruit.length).toBeGreaterThan(0)
    const accent = new THREE.Color(STYLE.accent).getHex()
    expect(fruit.some(m => (m.material as T.MeshStandardMaterial).color.getHex() === accent)).toBe(true)
  })

  it('builds the same plant from the same seed', () => {
    const kit = createKit(THREE)
    for (const stage of STAGES) {
      const sig = (g: T.Group) => {
        g.updateMatrixWorld(true)
        return meshes(g).map(m => [m.geometry.uuid, (m.material as T.Material).uuid, m.userData.role, ...m.matrixWorld.elements.map(e => e.toFixed(6))])
      }
      expect(sig(build(a, variant, stage, 42, kit))).toEqual(sig(build(a, variant, stage, 42, kit)))
    }
  })

  it('reuses the kit\'s cached geometries for a second plant', () => {
    const kit = createKit(THREE)
    for (const stage of STAGES) {
      const first = new Set(meshes(build(a, variant, stage, 5, kit)).map(m => m.geometry))
      for (const m of meshes(build(a, variant, stage, 6, kit))) expect(first.has(m.geometry)).toBe(true)
    }
  })
})
