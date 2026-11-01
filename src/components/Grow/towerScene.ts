/**
 * The tower as three.js objects (after sleepypod's bedModel3D): base and tank,
 * the pod columns, a cup and plant per slot, and the two light bars. An
 * original, stylized model of the Gardyn's form, not its CAD. Rendering, camera
 * and input live in TowerView3D; this module only builds and updates the scene.
 */
import type * as T from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { LEAF_COUNT, plantForm, plantScale, podPlaces, towerShape, type PodStatus } from './towerLayout'

export type Three = typeof T

export interface TowerPalette {
  body: string
  trim: string
  cup: string
  leaf: string
  leafDark: string
  /** Leaves of a pod that needs attention: yellowing. */
  leafSick: string
  status: Record<PodStatus, string>
  water: string
  ledOn: string
  ledOff: string
  highlight: string
}

export const DARK_PALETTE: TowerPalette = {
  body: '#2a2a2f',
  trim: '#3a3a40',
  cup: '#1c1c20',
  leaf: '#50c878',
  leafDark: '#2f8f55',
  leafSick: '#b8b04a',
  status: { empty: '#3a3a40', seeded: '#8b8b92', growing: '#a99cf2', harvest: '#e0976a', attention: '#f08cc4' },
  water: '#7ab5e0',
  ledOn: '#fff1dc',
  ledOff: '#26262a',
  highlight: '#ececec',
}

export const LIGHT_PALETTE: TowerPalette = {
  ...DARK_PALETTE,
  body: '#f2f1ee',
  trim: '#d9d8d4',
  cup: '#e6e5e1',
  status: { empty: '#d9d8d4', seeded: '#8b8b92', growing: '#6a58d6', harvest: '#c8643a', attention: '#c2438c' },
  water: '#4a90d9',
  ledOff: '#cfcfcc',
  highlight: '#17171a',
}

/** Parts of the tower that carry a control on Home; `air` is only an anchor for the readings. */
export type TowerPart = 'light' | 'tank' | 'air'
export type TowerTarget = { kind: 'pod', slot: number } | { kind: 'part', part: TowerPart }

export interface PodState {
  slot: number
  status: PodStatus
  plant: string | null
  /** Latest green fraction from the primary analyser, when there is one. */
  green?: number | null
  /** Days since planting, for the size when there's no measurement. */
  ageDays?: number | null
  /** Growth verdict from the green-area trend. */
  verdict?: 'growing' | 'stalled' | 'declining' | 'unknown'
  /** The last few green fractions, oldest first. */
  recent?: number[]
  notes?: string
}

export interface TowerState {
  pods: PodState[]
  /** 0–100, or null when the reading is unavailable. */
  waterPct: number | null
  /** 0–100; 0 when the light is off. */
  lightLevel: number
  /** Water flows up the columns while the pump runs. */
  pumpOn?: boolean
  hovered: number | null
  selected: number | null
}

// The order leaves appear in as a plant fills out: the crown first, then around it, then on top.
const LEAVES = [
  { x: 0, y: 0.03, z: 0, r: 0.032 },
  { x: -0.024, y: 0.018, z: 0.012, r: 0.024 },
  { x: 0.024, y: 0.02, z: 0.01, r: 0.025 },
  { x: 0.004, y: 0.05, z: -0.006, r: 0.022 },
  { x: -0.018, y: 0.042, z: -0.016, r: 0.021 },
  { x: 0.02, y: 0.044, z: 0.016, r: 0.02 },
  { x: -0.01, y: 0.066, z: 0.008, r: 0.018 },
  { x: 0.014, y: 0.064, z: -0.012, r: 0.017 },
]

/** Builds the tower for `podCount` slots. Every pickable mesh carries `userData.slot`. */
export function createTower(THREE: Three, podCount: number, palette: TowerPalette = DARK_PALETTE) {
  const shape = towerShape(podCount)
  const places = podPlaces(podCount)
  const root = new THREE.Group()
  root.name = 'tower'
  const geometries: T.BufferGeometry[] = []
  const materials: T.Material[] = []
  const geo = <G extends T.BufferGeometry>(g: G) => (geometries.push(g), g)
  const mat = (o: T.MeshStandardMaterialParameters) => {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.05, ...o })
    materials.push(m)
    return m
  }

  // Base: the reservoir, with a window that shows the water level.
  const baseDepth = 0.34
  const baseWidth = shape.width + 0.14
  const bodyMat = mat({ color: palette.body })
  const trimMat = mat({ color: palette.trim, roughness: 0.5 })
  const base = new THREE.Mesh(geo(new RoundedBoxGeometry(baseWidth, shape.baseTop, baseDepth, 4, 0.03)), bodyMat)
  base.position.y = shape.baseTop / 2
  base.castShadow = true
  base.receiveShadow = true
  root.add(base)
  const lid = new THREE.Mesh(geo(new RoundedBoxGeometry(baseWidth + 0.01, 0.02, baseDepth + 0.01, 2, 0.008)), trimMat)
  lid.position.y = shape.baseTop
  root.add(lid)
  const windowHeight = shape.baseTop * 0.62
  const windowMat = mat({ color: palette.cup, roughness: 0.3 })
  const tankWindow = new THREE.Mesh(geo(new THREE.PlaneGeometry(0.05, windowHeight)), windowMat)
  tankWindow.position.set(baseWidth / 2 - 0.07, shape.baseTop * 0.5, baseDepth / 2 + 0.001)
  root.add(tankWindow)
  const waterMat = mat({ color: palette.water, roughness: 0.2, emissive: palette.water, emissiveIntensity: 0.25 })
  const water = new THREE.Mesh(geo(new THREE.PlaneGeometry(0.04, 1)), waterMat)
  water.name = 'water'
  water.position.set(tankWindow.position.x, 0, baseDepth / 2 + 0.002)
  root.add(water)

  // The columns the pods hang on, each with a channel the water climbs while the pump runs.
  const columnHeight = shape.height - shape.baseTop
  // One soft swell per repeat, so the channel shimmers rather than strobes.
  const stripes = new Uint8Array(32 * 4)
  for (let i = 0; i < 32; i++) stripes.set([255, 255, 255, Math.round(120 + 135 * (0.5 + 0.5 * Math.sin((i / 32) * Math.PI * 2)))], i * 4)
  const flowTex = new THREE.DataTexture(stripes, 1, 32)
  flowTex.wrapT = THREE.RepeatWrapping
  flowTex.repeat.set(1, columnHeight * 1.5)
  flowTex.magFilter = THREE.LinearFilter
  flowTex.needsUpdate = true
  const flowMat = new THREE.MeshBasicMaterial({ color: palette.water, map: flowTex, transparent: true, opacity: 0, depthWrite: false })
  materials.push(flowMat)
  const flowGeo = geo(new THREE.CylinderGeometry(0.008, 0.008, columnHeight, 10, 1, true))
  for (const x of shape.columnX) {
    const column = new THREE.Mesh(geo(new RoundedBoxGeometry(0.045, columnHeight, 0.06, 3, 0.015)), bodyMat)
    column.position.set(x, shape.baseTop + columnHeight / 2, 0)
    column.castShadow = true
    root.add(column)
    const flow = new THREE.Mesh(flowGeo, flowMat)
    flow.name = 'flow'
    flow.position.set(x, shape.baseTop + columnHeight / 2, 0.038)
    flow.renderOrder = 2
    root.add(flow)
    const cap = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 20)), trimMat)
    cap.position.set(x, shape.height + 0.01, 0)
    root.add(cap)
  }

  // Pods: a tilted cup with a status collar, and the plant in it.
  const cupGeo = geo(new THREE.CylinderGeometry(0.03, 0.022, 0.05, 20, 1, true))
  const collarGeo = geo(new THREE.TorusGeometry(0.03, 0.006, 8, 24))
  const leafGeo = geo(new THREE.IcosahedronGeometry(1, 1))
  const cupMat = mat({ color: palette.cup, side: THREE.DoubleSide })
  const leafMat = mat({ color: palette.leaf, roughness: 0.8, flatShading: true })
  const leafDarkMat = mat({ color: palette.leafDark, roughness: 0.85, flatShading: true })
  const leafSickMat = mat({ color: palette.leafSick, roughness: 0.85, flatShading: true })
  const sproutGeo = geo(new THREE.SphereGeometry(1, 10, 6))
  const stemGeo = geo(new THREE.CylinderGeometry(0.002, 0.003, 0.03, 6))
  const pods = new Map<number, { group: T.Group, collar: T.Mesh, collarMat: T.MeshStandardMaterial, plant: T.Group, leaves: T.Mesh[], sprout: T.Group }>()
  const pickables: T.Object3D[] = []
  for (const p of places) {
    const group = new THREE.Group()
    group.position.set(p.x, p.y, p.z)
    // Lean out from the spine and towards the viewer, as the cups do on the bars.
    group.rotation.set(0.35, 0, -p.side * 0.35)
    const cup = new THREE.Mesh(cupGeo, cupMat)
    const collarMat = mat({ color: palette.status.empty, roughness: 0.4 })
    const collar = new THREE.Mesh(collarGeo, collarMat)
    collar.rotation.x = Math.PI / 2
    collar.position.y = 0.025
    const plant = new THREE.Group()
    plant.position.y = 0.022
    const leaves = LEAVES.map((l, i) => {
      const leaf = new THREE.Mesh(leafGeo, i % 2 ? leafDarkMat : leafMat)
      leaf.position.set(l.x, l.y, l.z)
      leaf.scale.setScalar(l.r)
      leaf.castShadow = true
      plant.add(leaf)
      return leaf
    })
    // A seedling: a stem and two seed leaves.
    const sprout = new THREE.Group()
    sprout.position.y = 0.02
    const stem = new THREE.Mesh(stemGeo, leafDarkMat)
    stem.position.y = 0.012
    sprout.add(stem)
    for (const side of [-1, 1]) {
      const seedLeaf = new THREE.Mesh(sproutGeo, leafMat)
      seedLeaf.position.set(side * 0.009, 0.028, 0)
      seedLeaf.scale.set(0.011, 0.004, 0.007)
      seedLeaf.rotation.z = side * 0.4
      sprout.add(seedLeaf)
    }
    group.add(cup, collar, plant, sprout)
    group.traverse((o) => {
      o.userData.slot = p.slot
    })
    root.add(group)
    pickables.push(cup, collar, ...plant.children, ...sprout.children)
    pods.set(p.slot, { group, collar, collarMat, plant, leaves, sprout })
  }

  for (const m of [base, lid, tankWindow, water]) m.userData.part = 'tank'

  // Light bars on stalks either side, angled in towards the plants.
  const ledMats: T.MeshStandardMaterial[] = []
  const barHeight = columnHeight * 0.92
  for (const side of [-1, 1]) {
    const x = side * (baseWidth / 2 + 0.02)
    const stalk = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.008, 0.008, shape.height + 0.06, 12)), trimMat)
    stalk.position.set(x, (shape.height + 0.06) / 2, 0.16)
    root.add(stalk)
    const housing = new THREE.Mesh(geo(new RoundedBoxGeometry(0.03, barHeight, 0.03, 2, 0.01)), bodyMat)
    housing.position.set(x - side * 0.01, shape.baseTop + 0.04 + barHeight / 2, 0.16)
    housing.rotation.y = side * 0.5
    housing.castShadow = true
    root.add(housing)
    const ledMat = mat({ color: palette.ledOff, emissive: palette.ledOn, emissiveIntensity: 0 })
    ledMats.push(ledMat)
    const led = new THREE.Mesh(geo(new THREE.PlaneGeometry(0.016, barHeight * 0.96)), ledMat)
    led.position.set(-side * 0.0151, 0, 0)
    led.rotation.y = -side * Math.PI / 2
    housing.add(led)
    for (const m of [stalk, housing, led]) m.userData.part = 'light'
  }
  // What the bars cast on the plants; it follows the light's level.
  const growLight = new THREE.PointLight(palette.ledOn, 0, 1.6, 1.5)
  growLight.position.set(0, shape.baseTop + columnHeight / 2, 0.45)
  root.add(growLight)

  const parts: T.Object3D[] = []
  root.traverse((o) => {
    if (o.userData.part) parts.push(o)
  })
  pickables.push(...parts)

  let current: TowerState | null = null
  let colors = palette
  // Animated: the tank eases to its level; the water channels fade in and flow while the pump runs.
  let waterShown: number | null = null
  let waterTarget = 0
  let pumpOn = false
  // The light fades between levels the way a dimmed LED driver ramps, rather than snapping.
  let lightShown: number | null = null
  let lightTarget = 0

  function setWater(level: number) {
    water.visible = level > 0.001
    water.scale.y = Math.max(0.001, windowHeight * 0.96 * level)
    water.position.y = tankWindow.position.y - windowHeight * 0.48 + water.scale.y / 2
  }

  const ledOn = new THREE.Color()
  function setLight(level: number) {
    ledOn.set(colors.ledOn)
    for (const m of ledMats) {
      m.emissiveIntensity = level * 2.2
      m.color.set(colors.ledOff).lerp(ledOn, Math.min(1, level * 4))
    }
    growLight.intensity = level * 1.6
  }

  function paint(state: TowerState) {
    const bySlot = new Map(state.pods.map(p => [p.slot, p]))
    for (const [slot, pod] of pods) {
      const s = bySlot.get(slot)
      const status = s?.status ?? 'empty'
      const scale = plantScale(status, s?.green, s?.ageDays)
      const form = plantForm(status, scale)
      pod.plant.userData.form = form
      pod.sprout.visible = form === 'sprout'
      pod.plant.visible = LEAF_COUNT[form] > 0
      pod.plant.scale.setScalar(scale || 1)
      pod.leaves.forEach((leaf, i) => {
        leaf.visible = i < LEAF_COUNT[form]
        leaf.material = status === 'attention' && i % 2 === 0 ? leafSickMat : i % 2 ? leafDarkMat : leafMat
      })
      const focus = state.selected === slot || state.hovered === slot
      pod.collarMat.color.set(focus ? colors.highlight : colors.status[status])
      pod.collarMat.emissive.set(colors.status[status])
      pod.collarMat.emissiveIntensity = focus ? 0.9 : status === 'attention' ? 0.5 : 0.15
      pod.collar.scale.setScalar(focus ? 1.25 : 1)
    }
    waterTarget = state.waterPct === null ? 0 : Math.max(0, Math.min(100, state.waterPct)) / 100
    if (waterShown === null) {
      waterShown = waterTarget
      setWater(waterTarget)
    }
    pumpOn = !!state.pumpOn
    lightTarget = Math.max(0, Math.min(100, state.lightLevel)) / 100
    if (lightShown === null) lightShown = lightTarget
    setLight(lightShown)
  }

  return {
    root,
    shape,
    pickables,
    /** Where a pod's collar sits in world space, for pinning a callout to it; false for no such slot. */
    podAnchor(slot: number, target: T.Vector3): boolean {
      const pod = pods.get(slot)
      if (!pod) return false
      pod.collar.getWorldPosition(target)
      return true
    },
    /** Slot under a ray hit, or null. */
    slotOf(object: T.Object3D | null | undefined): number | null {
      const s = object?.userData.slot
      return typeof s === 'number' ? s : null
    },
    /** What a ray hit: a pod, a part with a control, or nothing. */
    targetOf(object: T.Object3D | null | undefined): TowerTarget | null {
      const slot = object?.userData.slot
      if (typeof slot === 'number') return { kind: 'pod', slot }
      const part = object?.userData.part as TowerPart | undefined
      return part ? { kind: 'part', part } : null
    },
    update(state: TowerState) {
      current = state
      paint(state)
    },
    /** Advances the animations by `dt` seconds; true while anything is still moving. */
    /** 0–1: the light level as drawn right now, mid-fade included. */
    light: () => lightShown ?? lightTarget,
    tick(dt: number): boolean {
      let moving = false
      const shown = waterShown ?? waterTarget
      if (Math.abs(shown - waterTarget) > 0.002) {
        waterShown = shown + (waterTarget - shown) * Math.min(1, dt * 3)
        moving = true
      }
      else waterShown = waterTarget
      setWater(waterShown)
      const light = lightShown ?? lightTarget
      if (Math.abs(light - lightTarget) > 0.003) {
        lightShown = light + (lightTarget - light) * Math.min(1, dt * 2.5)
        moving = true
      }
      else lightShown = lightTarget
      setLight(lightShown)
      const flowTarget = pumpOn ? 0.45 : 0
      if (Math.abs(flowMat.opacity - flowTarget) > 0.01) {
        flowMat.opacity += (flowTarget - flowMat.opacity) * Math.min(1, dt * 1.5)
        moving = true
      }
      else flowMat.opacity = flowTarget
      if (pumpOn) {
        flowTex.offset.y -= dt * 0.3
        moving = true
      }
      return moving
    },
    recolor(next: TowerPalette) {
      colors = next
      bodyMat.color.set(next.body)
      trimMat.color.set(next.trim)
      cupMat.color.set(next.cup)
      windowMat.color.set(next.cup)
      leafMat.color.set(next.leaf)
      leafDarkMat.color.set(next.leafDark)
      leafSickMat.color.set(next.leafSick)
      waterMat.color.set(next.water)
      waterMat.emissive.set(next.water)
      flowMat.color.set(next.water)
      for (const m of ledMats) m.emissive.set(next.ledOn)
      if (current) paint(current)
    },
    dispose() {
      flowTex.dispose()
      for (const g of geometries) g.dispose()
      for (const m of materials) m.dispose()
    },
  }
}

export type Tower = ReturnType<typeof createTower>
