import type * as T from 'three'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { HERB_BUILDERS } from '../plants/herbs'
import { BUDGET, createKit, measure, seeded, STAGES, type Kit, type PlantStyle, type Stage } from '../plants/kit'

type Archetype = keyof typeof HERB_BUILDERS

const VARIANTS: Record<Archetype, Array<string | undefined>> = {
  'herb-bush': [undefined, 'mint', 'oregano', 'stevia', 'thai'],
  'feathery': [undefined, 'cilantro', 'parsley', 'tarragon'],
  'woody': [undefined, 'lavender', 'thyme', 'savory', 'sage'],
}
const CASES = (Object.keys(VARIANTS) as Archetype[]).flatMap(archetype =>
  VARIANTS[archetype].map(variant => ({ archetype, variant, name: `${archetype} ${variant ?? 'default'}` })))
const STYLE: PlantStyle = { leaf: '#5bbf5f', leafDark: '#3a8f45', accent: '#8f6fc9' }
const SEEDS = [1, 42, 2026]

function build(kit: Kit, c: { archetype: Archetype, variant?: string }, stage: Stage, seed = 1) {
  return HERB_BUILDERS[c.archetype](kit, stage, { ...STYLE, variant: c.variant }, seeded(seed))
}

function meshes(group: T.Object3D): T.Mesh[] {
  const out: T.Mesh[] = []
  group.traverse((o) => {
    if ((o as T.Mesh).isMesh) out.push(o as T.Mesh)
  })
  return out
}

const width = (size: T.Vector3) => Math.max(size.x, size.z)

describe.each(CASES)('$name', (c) => {
  it('builds every stage within the draw budget', () => {
    const kit = createKit(THREE)
    for (const stage of STAGES) {
      const m = measure(THREE, build(kit, c, stage))
      expect(m.meshes, stage).toBeGreaterThan(0)
      expect(m.meshes, stage).toBeLessThanOrEqual(BUDGET.meshes)
      expect(m.triangles, stage).toBeLessThanOrEqual(BUDGET.triangles)
    }
  })

  it('sprouts small and grows without shrinking to a full plant of herb size', () => {
    const kit = createKit(THREE)
    for (const seed of SEEDS) {
      const sprout = measure(THREE, build(kit, c, 'sprout', seed)).size
      expect(sprout.y).toBeGreaterThanOrEqual(0.012)
      expect(sprout.y).toBeLessThanOrEqual(0.025)
      const size = (stage: Stage) => measure(THREE, build(kit, c, stage, seed)).size
      const [young, bush, full] = [size('young'), size('bush'), size('full')]
      for (const [smaller, larger, stage] of [[young, bush, 'bush'], [bush, full, 'full']] as const) {
        expect(larger.y, `${stage} height, seed ${seed}`).toBeGreaterThanOrEqual(smaller.y)
        expect(width(larger), `${stage} width, seed ${seed}`).toBeGreaterThanOrEqual(width(smaller))
      }
      expect(width(full)).toBeGreaterThanOrEqual(0.05)
      expect(width(full)).toBeLessThanOrEqual(0.09)
      expect(full.y).toBeLessThanOrEqual(0.11)
    }
  })

  it('tags every mesh with its role, and has leaves at every stage', () => {
    const kit = createKit(THREE)
    for (const stage of STAGES) {
      const roles = meshes(build(kit, c, stage)).map(m => m.userData.role as string | undefined)
      for (const role of roles) expect(['leaf', 'stem', 'flower']).toContain(role)
      expect(roles.filter(r => r === 'leaf').length, stage).toBeGreaterThanOrEqual(2)
    }
  })

  it('is the same plant for the same seed and a different one for another', () => {
    const kit = createKit(THREE)
    const pose = (g: T.Group) => {
      g.updateMatrixWorld(true)
      return meshes(g).map(m => m.matrixWorld.elements.map(n => n.toFixed(6)).join())
    }
    const a = pose(build(kit, c, 'full', 7))
    expect(pose(build(kit, c, 'full', 7))).toEqual(a)
    expect(pose(build(kit, c, 'full', 8))).not.toEqual(a)
  })

  it('shares its geometries and materials between plants', () => {
    const kit = createKit(THREE)
    let made = 0
    const geometry = kit.geometry
    kit.geometry = (key, make) => geometry(key, () => (made++, make()))
    for (const stage of STAGES) {
      const first = meshes(build(kit, c, stage, 1))
      const again = meshes(build(kit, c, stage, 1))
      again.forEach((m, i) => {
        expect(m.geometry, stage).toBe(first[i]?.geometry)
        expect(m.material, stage).toBe(first[i]?.material)
      })
      made = 0
      build(kit, c, stage, 2)
      expect(made, `${stage} geometries built for a second plant`).toBe(0)
    }
  })
})

describe('herb flowers', () => {
  it.each([['herb-bush', 'thai'], ['woody', 'lavender']] as const)('%s %s flowers only when full', (archetype, variant) => {
    const kit = createKit(THREE)
    const flowers = (stage: Stage) => meshes(build(kit, { archetype, variant }, stage)).filter(m => m.userData.role === 'flower')
    expect(flowers('bush')).toHaveLength(0)
    expect(flowers('full').length).toBeGreaterThanOrEqual(3)
    expect((flowers('full')[0]?.material as T.MeshStandardMaterial | undefined)?.color.getHexString()).toBe('8f6fc9')
  })
})
