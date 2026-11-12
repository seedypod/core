/**
 * Flowering plants: bedding flowers that mound with blooms held above the
 * leaves, flower spikes (snapdragon, stock) and a dwarf sunflower.
 */
import type * as T from 'three'
import type { Kit, PlantBuilder, PlantStyle, Stage } from './kit'
import { ball, cone, leafBlade, petalRing, placeLeaf, stem } from './shapes'

/** Size of each stage relative to the plant in bloom. */
const GROWTH: Record<Exclude<Stage, 'sprout'>, number> = { young: 0.4, bush: 0.75, full: 1 }
const GOLDEN = 2.39996
const GREY = '#a3aaa3'

function mix(kit: Kit, a: string, b: string, t: number): string {
  return `#${new kit.THREE.Color(a).lerp(new kit.THREE.Color(b), t).getHexString()}`
}

function part(kit: Kit, geometry: T.BufferGeometry, material: T.Material, role?: string): T.Mesh {
  const m = new kit.THREE.Mesh(geometry, material)
  if (role) m.userData.role = role
  return m
}

/** A stalk from `from` to `to`, `radius` thick at the base. */
function stalk(kit: Kit, material: T.Material, from: T.Vector3, to: T.Vector3, radius: number): T.Mesh {
  const { THREE } = kit
  const d = to.clone().sub(from)
  const m = part(kit, stem(kit, 0.6), material)
  m.position.copy(from)
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize())
  m.scale.set(radius, d.length(), radius)
  return m
}

/** Bends a flat part lying in the xy plane back along its length, as leafBlade does. */
function bend<G extends T.BufferGeometry>(g: G, curl: number): G {
  const p = g.attributes.position as T.BufferAttribute
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i)
    p.setZ(i, -curl * y * y * 0.6)
  }
  g.computeVertexNormals()
  return g
}

/** A ferny pinnate leaf (marigold): unit length along +y, leaflets alternating up both sides. */
function fernLeaf(kit: Kit): T.BufferGeometry {
  return kit.geometry('flw:fern', () => {
    const { THREE } = kit
    const n = 5
    const right: [number, number][] = []
    for (let i = 0; i < n; i++) {
      const y = 0.1 + (i / n) * 0.8
      right.push([0.035, y], [0.34 * (1 - (i / n) * 0.7), y + 0.1])
    }
    const s = new THREE.Shape()
    s.moveTo(0, 0)
    for (const [x, y] of right) s.lineTo(x, y)
    s.lineTo(0, 1)
    for (const [x, y] of [...right].reverse()) s.lineTo(-x, y - 0.05)
    s.lineTo(0, 0)
    return bend(new THREE.ShapeGeometry(s), 0.3)
  })
}

/** A heart-shaped leaf (sunflower): unit length along +y, lobed either side of the base. */
function heartLeaf(kit: Kit): T.BufferGeometry {
  return kit.geometry('flw:heart', () => {
    const { THREE } = kit
    const s = new THREE.Shape()
    s.moveTo(0, 0.1)
    s.bezierCurveTo(0.2, -0.08, 0.6, 0.1, 0.48, 0.45)
    s.bezierCurveTo(0.38, 0.72, 0.12, 0.88, 0, 1)
    s.bezierCurveTo(-0.12, 0.88, -0.38, 0.72, -0.48, 0.45)
    s.bezierCurveTo(-0.6, 0.1, -0.2, -0.08, 0, 0.1)
    return bend(new THREE.ShapeGeometry(s, 3), 0.35)
  })
}

/** A flat five-petalled flower with fringed petal tips (dianthus), radius 1, facing +y. */
function fringedFlower(kit: Kit): T.BufferGeometry {
  return kit.geometry('flw:fringe:5', () => {
    const { THREE } = kit
    const steps = 60
    const s = new THREE.Shape()
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2
      const petal = Math.abs(Math.cos(a * 2.5))
      const r = (0.3 + 0.7 * Math.sqrt(petal)) * (petal > 0.5 && i % 2 ? 0.84 : 1)
      if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r)
      else s.lineTo(Math.cos(a) * r, Math.sin(a) * r)
    }
    const g = new THREE.ShapeGeometry(s, 1)
    g.rotateX(-Math.PI / 2)
    return g
  })
}

/** A lathed flower, its rim in five lobes: `points` are [radius, height] pairs, the last one the rim. */
function lathe(kit: Kit, name: string, points: [number, number][]): T.BufferGeometry {
  return kit.geometry(`flw:${name}`, () => {
    const { THREE } = kit
    const segments = 10
    const g = new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segments)
    const p = g.attributes.position as T.BufferAttribute
    for (let i = 1; i <= segments; i += 2) {
      const v = i * points.length + points.length - 1
      p.setXYZ(v, p.getX(v) * 0.8, p.getY(v), p.getZ(v) * 0.8)
    }
    g.computeVertexNormals()
    return g
  })
}

/** A funnel opening up +y from a narrow tube at the origin to a lobed rim of radius 1 at height 1. */
function trumpet(kit: Kit): T.BufferGeometry {
  return lathe(kit, 'trumpet', [[0.08, 0], [0.14, 0.4], [0.38, 0.78], [1, 1]])
}

/** A bell hanging down -y from the origin, its lobed mouth radius 1 at depth 1. */
function bell(kit: Kit): T.BufferGeometry {
  return lathe(kit, 'bell', [[0.06, 0], [0.45, -0.12], [0.55, -0.5], [1, -1]])
}

/** Two seed leaves on a short stem. */
function seedling(kit: Kit, style: PlantStyle, rand: () => number, size = 1): T.Group {
  const group = new kit.THREE.Group()
  const h = (0.01 + rand() * 0.005) * size
  const s = part(kit, stem(kit, 0.7), kit.material(style.leafDark))
  s.scale.set(0.0012, h, 0.0012)
  group.add(s)
  const blade = leafBlade(kit, 0.7, 0.1, 0.25)
  const mat = kit.material(style.leaf, { double: true })
  const turn = rand() * Math.PI
  for (const side of [0, Math.PI]) {
    group.add(placeLeaf(kit, blade, mat, { around: turn + side, out: 1.15 + rand() * 0.2, length: 0.011 * size, height: h }))
  }
  return group
}

function budMaterial(kit: Kit, style: PlantStyle, t = 0.35): T.MeshStandardMaterial {
  return kit.material(mix(kit, style.leafDark, style.accent ?? style.leafDark, t))
}

/** A bloom of radius `r` facing +y from the origin, made of meshes tagged 'flower'. */
type Head = (kit: Kit, style: PlantStyle, r: number, rand: () => number) => T.Group

function head(kit: Kit, ...parts: T.Mesh[]): T.Group {
  const g = new kit.THREE.Group()
  for (const p of parts) {
    p.userData.role = 'flower'
    g.add(p)
  }
  return g
}

// Calendula: a semi-double ring of petals round a dark eye.
const daisy: Head = (kit, style, r, rand) => {
  const petals = kit.material(style.accent ?? '#f4a623', { double: true })
  const turn = rand() * Math.PI
  const outer = part(kit, petalRing(kit, 14), petals)
  outer.scale.setScalar(r)
  outer.rotation.y = turn
  const inner = part(kit, petalRing(kit, 14), petals)
  inner.scale.setScalar(r * 0.72)
  inner.position.y = r * 0.08
  inner.rotation.y = turn + Math.PI / 14
  const eye = part(kit, ball(kit, 1), kit.material(style.accent2 ?? '#6b3a12'))
  eye.scale.set(r * 0.34, r * 0.16, r * 0.34)
  eye.position.y = r * 0.1
  return head(kit, outer, inner, eye)
}

// Marigold: a dense pompom of stacked petal layers.
const pompom: Head = (kit, style, r, rand) => {
  const outerMat = kit.material(style.accent ?? '#f28c1b', { double: true })
  const turn = rand() * Math.PI
  const base = part(kit, petalRing(kit, 10), outerMat)
  base.scale.setScalar(r)
  base.rotation.y = turn
  const mid = part(kit, petalRing(kit, 10), kit.material(style.accent2 ?? style.accent ?? '#f6c026', { double: true }))
  mid.scale.setScalar(r * 0.78)
  mid.position.y = r * 0.22
  mid.rotation.set(0.15, turn + 0.3, 0)
  const top = part(kit, ball(kit, 1), outerMat)
  top.scale.set(r * 0.55, r * 0.42, r * 0.55)
  top.position.y = r * 0.3
  return head(kit, base, mid, top)
}

// Dianthus: fringed flat petals with a contrasting eye.
const fringed: Head = (kit, style, r, rand) => {
  const accent = style.accent ?? '#e0457b'
  const turn = rand() * Math.PI
  const petals = part(kit, fringedFlower(kit), kit.material(accent, { double: true }))
  petals.scale.setScalar(r)
  petals.rotation.y = turn
  const eye = part(kit, petalRing(kit, 5), kit.material(style.accent2 ?? mix(kit, accent, '#000000', 0.45), { double: true }))
  eye.scale.setScalar(r * 0.38)
  eye.position.y = r * 0.03
  eye.rotation.y = turn
  return head(kit, petals, eye)
}

// Petunia: an open funnel with a paler throat.
const funnel: Head = (kit, style, r) => {
  const accent = style.accent ?? '#8e3fb5'
  const bloom = part(kit, trumpet(kit), kit.material(accent, { double: true }))
  bloom.scale.set(r, r * 0.9, r)
  const throat = part(kit, ball(kit, 0), kit.material(style.accent2 ?? mix(kit, accent, '#ffffff', 0.5)))
  throat.scale.setScalar(r * 0.14)
  throat.position.y = r * 0.35
  return head(kit, bloom, throat)
}

// Impatiens: five flat petals and a small eye.
const flat: Head = (kit, style, r, rand) => {
  const petals = part(kit, petalRing(kit, 5), kit.material(style.accent ?? '#f25c8a', { double: true }))
  petals.scale.setScalar(r)
  petals.rotation.y = rand() * Math.PI
  const eye = part(kit, ball(kit, 0), kit.material(style.accent2 ?? '#ffffff'))
  eye.scale.set(r * 0.16, r * 0.1, r * 0.16)
  return head(kit, petals, eye)
}

// Torenia: a pale tube flaring into four darker lobes.
const wishbone: Head = (kit, style, r, rand) => {
  const accent = style.accent ?? '#5b3fa8'
  const tube = part(kit, trumpet(kit), kit.material(style.accent2 ?? mix(kit, accent, '#ffffff', 0.6), { double: true }))
  tube.scale.set(r * 0.55, r * 1.1, r * 0.55)
  const lobes = part(kit, petalRing(kit, 4), kit.material(accent, { double: true }))
  lobes.scale.setScalar(r)
  lobes.position.y = r * 1.05
  lobes.rotation.y = rand() * Math.PI
  return head(kit, tube, lobes)
}

// Campanula: a bell hanging from the stem tip; aimed with a negative tilt so it nods.
const hangingBell: Head = (kit, style, r) => {
  const b = part(kit, bell(kit), kit.material(style.accent ?? '#7d6fd6', { double: true }))
  b.scale.setScalar(r)
  return head(kit, b)
}

interface MoundForm {
  leaf: (kit: Kit) => T.BufferGeometry
  /** Leaves at full size. */
  leaves: number
  /** Leaf length at full size, m. */
  length: number
  /** Out angle of the innermost and outermost leaves, rad; past π/2 they spill over the cup. */
  spread: [number, number]
  blooms: number
  /** Bloom radius, m. */
  size: number
  /** Lowest and highest bloom at full size, m. */
  height: [number, number]
  /** How far out from the centre the blooms sit at full size, m. */
  reach: number
  /** How far the blooms face outward; negative hangs them nodding. */
  tilt: number
  head: Head
  /** Flower stem radius, m. */
  stalk: number
  grey?: boolean
  gloss?: boolean
}

const MOUNDS: Record<string, MoundForm> = {
  calendula: { leaf: k => leafBlade(k, 0.4, 0.3, 0.2), leaves: 16, length: 0.042, spread: [0.3, 1.35], blooms: 5, size: 0.016, height: [0.052, 0.075], reach: 0.024, tilt: 0.35, head: daisy, stalk: 0.0015 },
  marigold: { leaf: fernLeaf, leaves: 18, length: 0.04, spread: [0.3, 1.3], blooms: 5, size: 0.013, height: [0.045, 0.065], reach: 0.024, tilt: 0.3, head: pompom, stalk: 0.0015 },
  dianthus: { leaf: k => leafBlade(k, 0.14, 0.35, 0.1), leaves: 20, length: 0.04, spread: [0.25, 1.2], blooms: 6, size: 0.012, height: [0.07, 0.105], reach: 0.03, tilt: 0.4, head: fringed, stalk: 0.001, grey: true },
  petunia: { leaf: k => leafBlade(k, 0.6, 0.35, 0.25), leaves: 14, length: 0.033, spread: [0.7, 2], blooms: 6, size: 0.015, height: [0.02, 0.05], reach: 0.028, tilt: 1.1, head: funnel, stalk: 0.0012 },
  impatiens: { leaf: k => leafBlade(k, 0.55, 0.2, 0.2), leaves: 14, length: 0.034, spread: [0.5, 1.4], blooms: 7, size: 0.012, height: [0.035, 0.05], reach: 0.026, tilt: 0.4, head: flat, stalk: 0.001, gloss: true },
  torenia: { leaf: k => leafBlade(k, 0.5, 0.3, 0.2), leaves: 14, length: 0.032, spread: [0.5, 1.5], blooms: 7, size: 0.009, height: [0.03, 0.048], reach: 0.03, tilt: 0.8, head: wishbone, stalk: 0.001 },
  campanula: { leaf: k => leafBlade(k, 0.85, 0.15, 0.3), leaves: 16, length: 0.026, spread: [0.6, 1.45], blooms: 8, size: 0.0075, height: [0.05, 0.075], reach: 0.03, tilt: -0.7, head: hangingBell, stalk: 0.0008 },
}

const mound: PlantBuilder = (kit, stage, style, rand) => {
  if (stage === 'sprout') return seedling(kit, style, rand)
  const { THREE } = kit
  const f = MOUNDS[style.variant ?? ''] ?? MOUNDS.calendula
  const g = GROWTH[stage]
  const group = new THREE.Group()
  const leafColor = f.grey ? mix(kit, style.leaf, GREY, 0.25) : style.leaf
  const darkColor = f.grey ? mix(kit, style.leafDark, GREY, 0.25) : style.leafDark
  const o = { double: true, roughness: f.gloss ? 0.45 : 0.8 }
  const leafMat = kit.material(leafColor, o)
  const darkMat = kit.material(darkColor, o)
  const geo = f.leaf(kit)
  const young = stage === 'young'
  const n = young ? 3 + Math.floor(rand() * 3) : stage === 'bush' ? Math.round(f.leaves * 0.8) : f.leaves
  // A young plant's few leaves are big for its size and still upright.
  const leafScale = young ? 0.55 : g
  const spread = (f.spread[1] - f.spread[0]) * (young ? 0.6 : 1)
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    group.add(placeLeaf(kit, geo, rand() < 0.3 ? darkMat : leafMat, {
      around: i * GOLDEN + rand() * 0.4,
      out: f.spread[0] + spread * t + (rand() - 0.5) * 0.15,
      length: f.length * leafScale * (0.8 + 0.2 * t + 0.15 * rand()),
      height: 0.003 * g * (1 - t),
      twist: (rand() - 0.5) * 0.4,
    }))
  }
  if (young) return group
  const stalkMat = kit.material(darkColor)
  const budMat = budMaterial(kit, style)
  const blooms = stage === 'bush' ? Math.max(3, f.blooms - 1) : f.blooms
  for (let b = 0; b < blooms; b++) {
    const around = b * GOLDEN + rand() * 0.6
    const c = Math.cos(around)
    const s = Math.sin(around)
    const out = f.reach * g * (0.35 + 0.65 * rand())
    // The first bloom always tops the plant, so a stage is never shorter than the one before.
    const y = (f.height[0] + (f.height[1] - f.height[0]) * (b === 0 ? 1 : rand())) * g
    const at = new THREE.Vector3(c * out, y, s * out)
    group.add(stalk(kit, stalkMat, new THREE.Vector3(c * out * 0.2, 0, s * out * 0.2), at, f.stalk))
    const face = new THREE.Vector3(c * f.tilt, 1, s * f.tilt).normalize()
    if (stage === 'bush') {
      const bud = part(kit, ball(kit, 0), budMat, 'flower')
      bud.scale.set(f.size * 0.3, f.size * 0.42, f.size * 0.3)
      bud.position.copy(at)
      bud.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), face)
      group.add(bud)
      continue
    }
    const h = f.head(kit, style, f.size * (0.85 + 0.3 * rand()), rand)
    h.position.copy(at)
    h.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), face)
    group.add(h)
  }
  return group
}

const spike: PlantBuilder = (kit, stage, style, rand) => {
  if (stage === 'sprout') return seedling(kit, style, rand)
  const { THREE } = kit
  const stock = style.variant === 'stock'
  const g = GROWTH[stage]
  const group = new THREE.Group()
  const leafColor = stock ? mix(kit, style.leaf, GREY, 0.3) : style.leaf
  const darkColor = stock ? mix(kit, style.leafDark, GREY, 0.3) : style.leafDark
  const leafMat = kit.material(leafColor, { double: true })
  const darkMat = kit.material(darkColor, { double: true })
  const stalkMat = kit.material(darkColor)
  const geo = leafBlade(kit, stock ? 0.3 : 0.2, 0.25, 0.15)
  const up = new THREE.Vector3(0, 1, 0)

  if (stage === 'young') {
    // A leafy shoot: two pairs of narrow leaves up a short stem.
    const h = 0.055 * g
    group.add(stalk(kit, stalkMat, new THREE.Vector3(), new THREE.Vector3(0, h, 0), 0.0018))
    const turn = rand() * Math.PI
    for (let i = 0; i < 4; i++) {
      group.add(placeLeaf(kit, geo, i < 2 ? darkMat : leafMat, {
        around: turn + (i % 2) * Math.PI + (i < 2 ? 0 : Math.PI / 2),
        out: (i < 2 ? 1.1 : 0.6) + rand() * 0.2,
        length: 0.042 * g * (0.9 + 0.2 * rand()),
        height: i < 2 ? h * 0.3 : h * 0.85,
      }))
    }
    return group
  }

  const rosette = stock ? 12 : 10
  for (let i = 0; i < rosette; i++) {
    const t = i / (rosette - 1)
    group.add(placeLeaf(kit, geo, rand() < 0.35 ? darkMat : leafMat, {
      around: i * GOLDEN + rand() * 0.4,
      out: 0.35 + 0.9 * t + (rand() - 0.5) * 0.15,
      length: 0.042 * g * (0.8 + 0.2 * t + 0.15 * rand()),
      height: 0.002 * (1 - t),
      twist: (rand() - 0.5) * 0.4,
    }))
  }

  const top = stock ? 0.1 : 0.125
  const size = stock ? 0.0075 : 0.0062
  const floretGeo = ball(kit, stock ? 1 : 0)
  const flowerMat = kit.material(style.accent ?? (stock ? '#c77dd1' : '#f2557a'))
  const budMat = budMaterial(kit, style, 0.25)
  const spikes = stock ? 2 : 3
  const turn = rand() * Math.PI * 2
  for (let k = 0; k < spikes; k++) {
    const main = k === 0
    const around = turn + k * 2.1 + rand() * 0.5
    const lean = main ? rand() * 0.08 : 0.22 + rand() * 0.1
    const dir = new THREE.Vector3(Math.sin(lean) * Math.cos(around), Math.cos(lean), Math.sin(lean) * Math.sin(around))
    const h = top * g * (main ? 1 : 0.72 + rand() * 0.12)
    const base = dir.clone().setY(0).multiplyScalar(0.01)
    group.add(stalk(kit, stalkMat, base, base.clone().addScaledVector(dir, h), main ? 0.0022 : 0.0018))
    for (const side of [0, Math.PI]) {
      const leaf = placeLeaf(kit, geo, leafMat, { around: around + side + Math.PI / 2, out: 0.7 + rand() * 0.2, length: 0.026 * g })
      leaf.position.copy(base).addScaledVector(dir, h * 0.3)
      group.add(leaf)
    }
    // Florets open from the bottom of the spike up; the tip stays in bud.
    const n = stock ? (main ? 12 : 8) : (main ? 9 : 6)
    const span = stock ? 0.45 : 0.55
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1)
      const open = stage === 'full' && u < (stock ? 0.85 : 0.75)
      const r = size * (1 - 0.45 * u) * (open ? 1 : 0.6)
      const a = i * GOLDEN + around
      const floret = part(kit, floretGeo, open ? flowerMat : budMat, 'flower')
      floret.position.copy(base).addScaledVector(dir, h * (1 - span + span * u))
      floret.position.x += Math.cos(a) * r * 0.7
      floret.position.z += Math.sin(a) * r * 0.7
      if (stock) floret.scale.setScalar(r)
      else floret.scale.set(r * 0.9, r * 1.15, r * 0.9)
      floret.quaternion.setFromUnitVectors(up, dir)
      group.add(floret)
    }
  }
  return group
}

const sunflower: PlantBuilder = (kit, stage, style, rand) => {
  if (stage === 'sprout') return seedling(kit, style, rand, 1.4)
  const { THREE } = kit
  const g = GROWTH[stage]
  const group = new THREE.Group()
  const h = 0.17 * g
  const stalkMat = kit.material(style.leafDark)
  group.add(stalk(kit, stalkMat, new THREE.Vector3(), new THREE.Vector3(0, h, 0), 0.002 + 0.002 * g))
  const leafMat = kit.material(style.leaf, { double: true })
  const darkMat = kit.material(style.leafDark, { double: true })
  const geo = heartLeaf(kit)
  const pairs = stage === 'young' ? 2 : stage === 'bush' ? 4 : 5
  for (let k = 0; k < pairs; k++) {
    const u = k / pairs
    const around = k * (Math.PI / 2) + (rand() - 0.5) * 0.3
    const length = 0.044 * (0.5 + 0.5 * g) * (1 - 0.35 * u) * (0.92 + 0.16 * rand())
    for (const side of [0, Math.PI]) {
      group.add(placeLeaf(kit, geo, k === 0 ? darkMat : leafMat, {
        around: around + side,
        out: 1 + rand() * 0.25,
        length,
        height: h * (0.1 + 0.75 * u),
        twist: (rand() - 0.5) * 0.3,
      }))
    }
  }
  if (stage === 'young') return group

  if (stage === 'bush') {
    const bud = part(kit, ball(kit, 1), budMaterial(kit, style, 0.15), 'flower')
    bud.scale.set(0.011, 0.013, 0.011)
    bud.position.y = h + 0.008
    const sepals = part(kit, petalRing(kit, 8), darkMat, 'flower')
    sepals.scale.setScalar(0.014)
    sepals.position.y = h + 0.003
    group.add(bud, sepals)
    return group
  }

  // The head turns out of the tower towards the room (+z) and looks up a little.
  const pivot = new THREE.Group()
  pivot.position.y = h
  pivot.rotation.y = (rand() - 0.5) * 0.6
  const face = new THREE.Group()
  face.rotation.x = 0.85
  const petalMat = kit.material(style.accent ?? '#f7c21b', { double: true })
  const outer = part(kit, petalRing(kit, 16), petalMat)
  outer.scale.setScalar(0.032)
  outer.position.y = 0.004
  const inner = part(kit, petalRing(kit, 16), petalMat)
  inner.scale.setScalar(0.026)
  inner.position.y = 0.005
  inner.rotation.y = Math.PI / 16
  const disc = part(kit, ball(kit, 1), kit.material(style.accent2 ?? '#4a2c14'))
  disc.scale.set(0.019, 0.005, 0.019)
  disc.position.y = 0.006
  const calyx = part(kit, cone(kit, 8), stalkMat)
  calyx.scale.set(0.017, 0.008, 0.017)
  calyx.rotation.x = Math.PI
  calyx.position.y = 0.004
  for (const m of [outer, inner, disc, calyx]) {
    m.userData.role = 'flower'
    face.add(m)
  }
  pivot.add(face)
  group.add(pivot)
  return group
}

/** Flowering archetypes; `flower` takes variants marigold, dianthus, petunia, impatiens, torenia and campanula (default calendula), `spike` takes stock (default snapdragon). */
export const FLOWER_BUILDERS: Record<'flower' | 'spike' | 'sunflower', PlantBuilder> = {
  flower: mound,
  spike,
  sunflower,
}
