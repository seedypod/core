import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { FLOWER_BUILDERS } from '../plants/flowers'
import { BUDGET, createKit, measure, seeded, STAGES, type PlantStyle, type Stage } from '../plants/kit'

const CASES: { archetype: keyof typeof FLOWER_BUILDERS, variant?: string }[] = [
  { archetype: 'flower' },
  ...['marigold', 'dianthus', 'petunia', 'impatiens', 'torenia', 'campanula'].map(variant => ({ archetype: 'flower' as const, variant })),
  { archetype: 'spike' },
  { archetype: 'spike', variant: 'stock' },
  { archetype: 'sunflower' },
]
const SEEDS = [1, 7, 42, 1234, 99991]

function style(variant?: string): PlantStyle {
  return { leaf: '#4a8a3a', leafDark: '#2f5e2a', accent: '#f4a623', accent2: '#5a3010', variant }
}

function meshes(group: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh)
  })
  return out
}

describe.each(CASES)('$archetype $variant', ({ archetype, variant }) => {
  const build = (stage: Stage, seed: number, kit = createKit(THREE)) => FLOWER_BUILDERS[archetype](kit, stage, style(variant), seeded(seed))

  it('builds every stage within the budget', () => {
    for (const seed of SEEDS) {
      for (const stage of STAGES) {
        const m = measure(THREE, build(stage, seed))
        expect(m.meshes, stage).toBeGreaterThan(0)
        expect(m.meshes, stage).toBeLessThanOrEqual(BUDGET.meshes)
        expect(m.triangles, stage).toBeLessThanOrEqual(BUDGET.triangles)
      }
    }
  })

  it('never shrinks from young to bush to full, and fits the envelope in bloom', () => {
    const tall = archetype === 'sunflower' ? 0.22 : 0.14
    for (const seed of SEEDS) {
      const [young, bush, full] = (['young', 'bush', 'full'] as const).map(stage => measure(THREE, build(stage, seed)).size) as [THREE.Vector3, THREE.Vector3, THREE.Vector3]
      const width = (v: THREE.Vector3) => Math.max(v.x, v.z)
      expect(bush.y).toBeGreaterThanOrEqual(young.y)
      expect(full.y).toBeGreaterThanOrEqual(bush.y)
      expect(width(bush)).toBeGreaterThanOrEqual(width(young))
      expect(width(full)).toBeGreaterThanOrEqual(width(bush))
      expect(full.y).toBeLessThanOrEqual(tall)
      expect(width(full)).toBeLessThanOrEqual(0.1)
      const sprout = measure(THREE, build('sprout', seed)).size
      expect(sprout.y).toBeGreaterThanOrEqual(0.012)
      expect(sprout.y).toBeLessThanOrEqual(0.025)
    }
  })

  it('tags leaves and flowers, with blooms only once it flowers', () => {
    const roles = (stage: Stage) => meshes(build(stage, 7)).map(m => m.userData.role as string | undefined)
    for (const stage of STAGES) expect(roles(stage), stage).toContain('leaf')
    expect(roles('young')).not.toContain('flower')
    expect(roles('full')).toContain('flower')
    const full = meshes(build('full', 7))
    const petals = full.filter(m => m.userData.role === 'flower').map(m => (m.material as THREE.MeshStandardMaterial).color.getHexString())
    expect(petals).toContain('f4a623')
  })

  it('builds the same plant from the same seed', () => {
    const kit = createKit(THREE)
    const snapshot = (g: THREE.Group) => {
      g.updateMatrixWorld(true)
      return meshes(g).map(m => [m.geometry.uuid, (m.material as THREE.Material).uuid, m.userData.role, ...m.matrixWorld.elements])
    }
    for (const stage of STAGES) {
      expect(snapshot(build(stage, 42, kit))).toEqual(snapshot(build(stage, 42, kit)))
    }
  })

  it('shares cached geometry between plants', () => {
    const kit = createKit(THREE)
    for (const stage of STAGES) {
      const first = new Set(meshes(build(stage, 1, kit)).map(m => m.geometry))
      for (const m of meshes(build(stage, 2, kit))) expect(first.has(m.geometry), stage).toBe(true)
    }
  })
})
