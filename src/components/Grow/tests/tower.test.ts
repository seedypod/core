import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { plantScale, podPlaces, towerShape } from '../towerLayout'
import { createTower, DARK_PALETTE, LIGHT_PALETTE, type PodState } from '../towerScene'

describe('tower layout', () => {
  it('puts a Home\'s 30 pods on three columns of 10, numbered across then down', () => {
    const places = podPlaces(30)
    expect(towerShape(30)).toMatchObject({ columns: 3, rows: 10 })
    expect(places.map(p => [p.column, p.row]).slice(0, 4)).toEqual([[0, 0], [1, 0], [2, 0], [0, 1]])
    // The upper camera's pods (1–15) are the top five rows.
    expect(places.filter(p => p.row < 5).map(p => p.slot)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1))
    expect(places[0]?.y).toBeGreaterThan(places[29]?.y ?? Infinity)
    expect(new Set(places.map(p => `${p.x.toFixed(3)},${p.y.toFixed(3)}`)).size).toBe(30)
  })

  it('gives a Studio\'s 16 pods two columns of 8', () => {
    expect(towerShape(16)).toMatchObject({ columns: 2, rows: 8 })
  })

  it('alternates pods either side of each column', () => {
    const [a, b] = podPlaces(30).filter(p => p.column === 0)
    expect(a?.side).toBe(-(b?.side ?? 0))
  })

  it('sizes a plant by its green area, falling back on its status', () => {
    expect(plantScale('empty', 0.9)).toBe(0)
    expect(plantScale('seeded', 0.9)).toBe(0.25)
    expect(plantScale('growing', null)).toBe(0.5)
    expect(plantScale('harvest', undefined)).toBe(0.85)
    expect(plantScale('growing', 0)).toBe(0.3)
    expect(plantScale('growing', 0.5)).toBeCloseTo(0.75)
    expect(plantScale('attention', 2)).toBe(1)
  })
})

describe('tower scene', () => {
  const pods: PodState[] = Array.from({ length: 30 }, (_, i) => ({
    slot: i + 1,
    status: i < 6 ? 'harvest' : i === 8 ? 'attention' : i >= 24 ? 'empty' : 'growing',
    plant: i >= 24 ? null : 'Basil',
    green: i < 24 ? 0.4 : null,
  }))
  const state = { pods, waterPct: 50, lightLevel: 85, hovered: null, selected: null }
  const podGroup = (tower: ReturnType<typeof createTower>, slot: number) =>
    tower.root.children.find(o => o instanceof THREE.Group && o.userData.slot === slot) as THREE.Group
  const collarColor = (tower: ReturnType<typeof createTower>, slot: number) =>
    `#${((podGroup(tower, slot).children[1] as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHexString()}`

  it('builds a cup and plant per slot, every pickable naming its slot', () => {
    const tower = createTower(THREE, 30)
    const slots = new Set(tower.pickables.map(o => tower.slotOf(o)))
    expect(slots.size).toBe(30)
    expect(tower.slotOf(null)).toBeNull()
    expect(tower.slotOf(tower.root)).toBeNull()
    tower.dispose()
  })

  it('colours collars by status, hides empty pods\' plants, and highlights the selected pod', () => {
    const tower = createTower(THREE, 30)
    tower.update(state)
    expect(collarColor(tower, 1)).toBe(DARK_PALETTE.status.harvest)
    expect(collarColor(tower, 9)).toBe(DARK_PALETTE.status.attention)
    expect(collarColor(tower, 12)).toBe(DARK_PALETTE.status.growing)
    expect(podGroup(tower, 30).children[2]?.visible).toBe(false)
    expect(podGroup(tower, 12).children[2]?.scale.x).toBeCloseTo(plantScale('growing', 0.4))
    tower.update({ ...state, selected: 12 })
    expect(collarColor(tower, 12)).toBe(DARK_PALETTE.highlight)
    tower.dispose()
  })

  it('fills the tank window to the water level and lights the bars to the light level', () => {
    const tower = createTower(THREE, 30)
    const water = tower.root.getObjectByName('water') as THREE.Mesh
    tower.update(state)
    const half = water.scale.y
    tower.update({ ...state, waterPct: 100, lightLevel: 0 })
    expect(water.scale.y).toBeCloseTo(half * 2)
    const leds: THREE.MeshStandardMaterial[] = []
    tower.root.traverse(o => o instanceof THREE.Mesh && o.material instanceof THREE.MeshStandardMaterial && o.material.emissiveIntensity >= 0 && o.parent?.type === 'Mesh' && leds.push(o.material))
    expect(leds.length).toBe(2)
    expect(leds.every(m => m.emissiveIntensity === 0)).toBe(true)
    tower.update({ ...state, waterPct: null, lightLevel: 85 })
    expect(water.visible).toBe(false)
    expect(leds[0]?.emissiveIntensity).toBeGreaterThan(1)
    tower.dispose()
  })

  it('recolours for the light theme', () => {
    const tower = createTower(THREE, 30)
    tower.update(state)
    tower.recolor(LIGHT_PALETTE)
    expect(collarColor(tower, 1)).toBe(LIGHT_PALETTE.status.harvest)
    tower.dispose()
  })
})
