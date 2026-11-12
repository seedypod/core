/**
 * Fruiting crops: tomato, pepper and eggplant bushes, cucumber, bean and pea
 * vines, strawberries and brassicas. The fruit is what reads from across the
 * room, so it is sized up a little and hung where the leaves don't hide it.
 * `accent` is the ripe fruit (or curd, or bulb); `accent2` is the unripe fruit
 * on tomatoes and peppers and the flower colour on eggplant, vines and strawberries.
 */
import type * as T from 'three'
import type { Kit, PlantBuilder, PlantStyle, Stage } from './kit'
import { ball, cone, leafBlade, petalRing, placeLeaf, stem } from './shapes'

type Grown = Exclude<Stage, 'sprout'>

/** Overall size of each stage against the full plant. */
const SIZE: Record<Grown, number> = { young: 0.42, bush: 0.75, full: 1 }
const AT: Record<Grown, 0 | 1 | 2> = { young: 0, bush: 1, full: 2 }
const TAU = Math.PI * 2
const GOLDEN = 2.4

const WHITE = '#f4f1e8'
const YELLOW = '#f2cf3a'

function mesh(kit: Kit, geometry: T.BufferGeometry, material: T.Material, role?: string): T.Mesh {
  const m = new kit.THREE.Mesh(geometry, material)
  if (role) m.userData.role = role
  return m
}

/** The direction placeLeaf points a leaf: `around` radians about +y, tipped `out` from vertical. */
function dir(kit: Kit, around: number, out: number): T.Vector3 {
  return new kit.THREE.Vector3(Math.sin(out) * Math.sin(around), Math.cos(out), Math.sin(out) * Math.cos(around))
}

/** A stem from `a` to `b`, radius `r` at `a`. */
function stalk(kit: Kit, material: T.Material, a: T.Vector3, b: T.Vector3, r: number, taper = 0.6): T.Mesh {
  const { THREE } = kit
  const d = b.clone().sub(a)
  const m = mesh(kit, stem(kit, taper), material)
  m.position.copy(a)
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize())
  m.scale.set(r, Math.max(d.length(), 1e-4), r)
  return m
}

function leafAt(kit: Kit, geometry: T.BufferGeometry, material: T.Material, at: T.Vector3, o: { around: number, out: number, length: number, twist?: number }): T.Mesh {
  const m = placeLeaf(kit, geometry, material, o)
  m.position.copy(at)
  return m
}

function xf(kit: Kit, x: number, y: number, rz: number, s: number, sx = s): T.Matrix4 {
  const { THREE } = kit
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, 0),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, rz)),
    new THREE.Vector3(sx, s, s),
  )
}

/** Bakes transformed parts into one geometry, optionally warping each vertex; only call inside kit.geometry. */
function merge(kit: Kit, parts: [T.BufferGeometry, T.Matrix4][], warp?: (v: T.Vector3) => void): T.BufferGeometry {
  const { THREE } = kit
  const chunks = parts.map(([g, m]) => {
    const c = g.index ? g.toNonIndexed() : g.clone()
    c.applyMatrix4(m)
    const a = c.attributes.position.array as Float32Array
    c.dispose()
    return a
  })
  const out = new Float32Array(chunks.reduce((n, a) => n + a.length, 0))
  let at = 0
  for (const a of chunks) {
    out.set(a, at)
    at += a.length
  }
  if (warp) {
    const v = new THREE.Vector3()
    for (let i = 0; i < out.length; i += 3) {
      v.fromArray(out, i)
      warp(v)
      v.toArray(out, i)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(out, 3))
  g.computeVertexNormals()
  return g
}

/** A leaflet with a toothed edge: unit length along +y, facing +z, like leafBlade. */
function serrated(kit: Kit, width: number, teeth: number): T.BufferGeometry {
  return kit.geometry(`fr:serrate:${width.toFixed(2)}:${teeth}`, () => {
    const { THREE } = kit
    const n = teeth * 2
    const edge = (i: number) => (width / 2) * Math.sin(Math.PI * Math.pow(i / n, 0.75)) * (i % 2 ? 1 : 0.72)
    const s = new THREE.Shape()
    s.moveTo(0, 0)
    for (let i = 1; i < n; i++) s.lineTo(edge(i), i / n)
    s.lineTo(0, 1)
    for (let i = n - 1; i > 0; i--) s.lineTo(-edge(i), i / n)
    return new THREE.ShapeGeometry(s)
  })
}

/** A tomato's compound leaf: a rachis with two pairs of toothed leaflets and a tip leaflet, drooping. */
function tomatoLeaf(kit: Kit): T.BufferGeometry {
  return kit.geometry('fr:tomato-leaf', () => {
    const leaflet = serrated(kit, 0.55, 3)
    return merge(kit, [
      [stem(kit, 0.5), new kit.THREE.Matrix4().makeScale(0.014, 0.6, 0.014)],
      [leaflet, xf(kit, 0, 0.55, 0, 0.45)],
      [leaflet, xf(kit, 0, 0.42, -1.05, 0.36)],
      [leaflet, xf(kit, 0, 0.42, 1.05, 0.36)],
      [leaflet, xf(kit, 0, 0.16, -1.2, 0.3)],
      [leaflet, xf(kit, 0, 0.16, 1.2, 0.3)],
    ], (v) => {
      v.z += 0.3 * v.y * v.y
    })
  })
}

/** Three leaflets on a stalk (bean, strawberry); `petiole` is the bare stalk's share of the length. */
function trifoliate(kit: Kit, serrate: boolean, petiole: number): T.BufferGeometry {
  return kit.geometry(`fr:trifoliate:${serrate ? 1 : 0}:${petiole.toFixed(2)}`, () => {
    const leaflet = serrate ? serrated(kit, 0.72, 4) : leafBlade(kit, 0.55, 0, 0.2)
    const l = 1 - petiole
    const parts: [T.BufferGeometry, T.Matrix4][] = [
      [leaflet, xf(kit, 0, petiole, 0, l * 0.62)],
      [leaflet, xf(kit, 0, petiole, -0.95, l * 0.5)],
      [leaflet, xf(kit, 0, petiole, 0.95, l * 0.5)],
    ]
    if (petiole > 0) parts.push([stem(kit, 0.7), new kit.THREE.Matrix4().makeScale(0.02, petiole, 0.02)])
    return merge(kit, parts, (v) => {
      v.z += 0.12 * v.x * v.x + 0.15 * v.y * v.y
    })
  })
}

/** A curling tendril: unit length, straight then coiling. */
function tendril(kit: Kit, segments: number): T.BufferGeometry {
  return kit.geometry(`fr:tendril:${segments}`, () => {
    const { THREE } = kit
    const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.02, 0.35, 0)]
    for (let i = 0; i <= 8; i++) {
      const a = (i / 8) * TAU * 1.4
      const r = 0.16 * (1 - i / 11)
      points.push(new THREE.Vector3(r - r * Math.cos(a) + 0.02, 0.5 + r * Math.sin(a) + i * 0.02, 0.03 * i))
    }
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), segments, 0.02, 3, false)
  })
}

/** A pea leaf: a rachis with two pairs of round leaflets ending in a tendril. */
function peaLeaf(kit: Kit): T.BufferGeometry {
  return kit.geometry('fr:pea-leaf', () => {
    const leaflet = leafBlade(kit, 0.8, 0, 0.2)
    const coil = new kit.THREE.Matrix4().compose(
      new kit.THREE.Vector3(0, 0.6, 0),
      new kit.THREE.Quaternion(),
      new kit.THREE.Vector3(0.5, 0.5, 0.5),
    )
    return merge(kit, [
      [stem(kit, 0.6), new kit.THREE.Matrix4().makeScale(0.02, 0.62, 0.02)],
      [leaflet, xf(kit, 0, 0.18, -1.0, 0.32)],
      [leaflet, xf(kit, 0, 0.18, 1.0, 0.32)],
      [leaflet, xf(kit, 0, 0.42, -0.9, 0.3)],
      [leaflet, xf(kit, 0, 0.42, 0.9, 0.3)],
      [tendril(kit, 10), coil],
    ], (v) => {
      v.z += 0.2 * v.y * v.y
    })
  })
}

/** A cucumber leaf: broad, five shallow pointed lobes and a heart-shaped base at the origin. */
function lobedLeaf(kit: Kit): T.BufferGeometry {
  return kit.geometry('fr:lobed', () => {
    const { THREE } = kit
    // [degrees around the blade's centre, radius]: lobe tips alternate with shallow notches.
    const outline: [number, number][] = [
      [-70, 0.2], [-30, 0.42], [0, 0.34], [30, 0.5], [60, 0.4], [90, 0.54],
      [120, 0.4], [150, 0.5], [180, 0.34], [210, 0.42], [250, 0.2],
    ]
    const cy = 0.12
    const top = cy + 0.54
    const s = new THREE.Shape()
    s.moveTo(0, 0)
    for (const [deg, r] of outline) {
      const a = (deg * Math.PI) / 180
      s.lineTo((Math.cos(a) * r) / top, (cy + Math.sin(a) * r) / top)
    }
    s.lineTo(0, 0)
    const g = new THREE.ShapeGeometry(s)
    const p = g.attributes.position as T.BufferAttribute
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i)
      const y = p.getY(i)
      p.setZ(i, 0.18 * x * x + 0.22 * y * y)
    }
    g.computeVertexNormals()
    return g
  })
}

interface PodShape {
  /** Radius (against length) from the stalk end to the tip, evenly spaced. */
  r: number[]
  segments: number
  /** How far the tip curves to one side. */
  bend?: number
  /** Lengthwise lobes, as on a bell pepper. */
  lobes?: number
  /** Bulges of the seeds inside, as on a pea pod. */
  bumps?: number
}

type Pod = 'bell' | 'chili' | 'banana' | 'eggplant' | 'cucumber' | 'bean' | 'pea' | 'strawberry'

const PODS: Record<Pod, PodShape> = {
  bell: { r: [0.42, 0.55, 0.56, 0.52, 0.4, 0], segments: 8, lobes: 4 },
  chili: { r: [0.2, 0.25, 0.24, 0.21, 0.16, 0.1, 0], segments: 6, bend: 0.12 },
  banana: { r: [0.15, 0.17, 0.16, 0.14, 0.11, 0.08, 0.04, 0], segments: 6, bend: 0.22 },
  eggplant: { r: [0.14, 0.2, 0.26, 0.29, 0.29, 0.22, 0], segments: 7, bend: 0.08 },
  cucumber: { r: [0.08, 0.17, 0.19, 0.19, 0.19, 0.17, 0.11, 0], segments: 6, bend: 0.06 },
  bean: { r: [0.03, 0.06, 0.065, 0.065, 0.06, 0.05, 0.03, 0], segments: 5, bend: 0.2 },
  pea: { r: [0.05, 0.16, 0.18, 0.18, 0.17, 0.13, 0], segments: 6, bend: 0.12, bumps: 4 },
  strawberry: { r: [0.36, 0.48, 0.45, 0.36, 0.22, 0], segments: 7 },
}

/** A fruit or pod hanging from its stalk at the origin, unit length down -y. */
function pod(kit: Kit, kind: Pod): T.BufferGeometry {
  return kit.geometry(`fr:pod:${kind}`, () => {
    const { THREE } = kit
    const shape = PODS[kind]
    const n = shape.r.length - 1
    // Lathe points run bottom to top so faces wind outwards.
    const points = shape.r.map((r, i) => new THREE.Vector2(r, -i / n)).reverse()
    points.push(new THREE.Vector2(0, 0))
    const g = new THREE.LatheGeometry(points, shape.segments)
    const p = g.attributes.position as T.BufferAttribute
    for (let i = 0; i < p.count; i++) {
      const t = -p.getY(i)
      const a = Math.atan2(p.getZ(i), p.getX(i))
      let k = 1
      if (shape.lobes) k *= 1 + 0.14 * Math.cos(shape.lobes * a)
      if (shape.bumps) k *= 1 + 0.14 * Math.abs(Math.sin(shape.bumps * Math.PI * t))
      p.setX(i, p.getX(i) * k + (shape.bend ?? 0) * t * t)
      p.setZ(i, p.getZ(i) * k)
    }
    g.computeVertexNormals()
    return g
  })
}

/** A cauliflower curd: a flattened, knobbly dome. */
function curd(kit: Kit): T.BufferGeometry {
  return kit.geometry('fr:curd', () => {
    const g = new kit.THREE.IcosahedronGeometry(1, 2)
    const p = g.attributes.position as T.BufferAttribute
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i)
      const y = p.getY(i)
      const z = p.getZ(i)
      const k = 1 + 0.16 * Math.abs(Math.sin(6 * x + 1) * Math.sin(6 * y + 2) * Math.sin(6 * z))
      p.setXYZ(i, x * k, (y < 0 ? y * 0.35 : y * 0.75) * k, z * k)
    }
    g.computeVertexNormals()
    return g
  })
}

/** Two seed leaves on a short stem; `width` shapes them (round for brassicas, narrow for tomatoes). */
function seedling(kit: Kit, style: PlantStyle, rand: () => number, width: number): T.Group {
  const { THREE } = kit
  const g = new THREE.Group()
  const h = 0.01 + rand() * 0.004
  const top = new THREE.Vector3(0, h, 0)
  g.add(stalk(kit, kit.material(style.leafDark), new THREE.Vector3(), top, 0.0009))
  const leaf = leafBlade(kit, width, -0.1, 0.2)
  const mat = kit.material(style.leaf, { double: true })
  const around = rand() * TAU
  for (const side of [0, Math.PI]) {
    g.add(leafAt(kit, leaf, mat, top, { around: around + side, out: 1.0 + rand() * 0.25, length: 0.008 + rand() * 0.002 }))
  }
  return g
}

/** A flower facing out and a little down from where it hangs, with a centre on white ones. */
function flower(kit: Kit, g: T.Group, at: T.Vector3, around: number, radius: number, color: string, centre?: string) {
  const { THREE } = kit
  const f = new THREE.Group()
  f.position.copy(at)
  f.rotation.order = 'YXZ'
  f.rotation.set(1.9, around, 0)
  const petals = mesh(kit, petalRing(kit, 5), kit.material(color, { double: true }), 'flower')
  petals.scale.setScalar(radius)
  f.add(petals)
  if (centre) {
    const c = mesh(kit, ball(kit, 0), kit.material(centre), 'flower')
    c.scale.setScalar(radius * 0.35)
    f.add(c)
  }
  g.add(f)
}

/** A pod hanging at `at` on a short stalk from `from`, with a calyx cap. */
function hangPod(kit: Kit, g: T.Group, from: T.Vector3, at: T.Vector3, kind: Pod, length: number, color: string, o: { calyx: string, roughness?: number, tilt: number, turn: number }) {
  g.add(stalk(kit, kit.material(o.calyx), from, at, length * 0.035 + 0.0004))
  const f = mesh(kit, pod(kit, kind), kit.material(color, { roughness: o.roughness ?? 0.45 }), 'fruit')
  f.position.copy(at)
  f.rotation.order = 'YXZ'
  f.rotation.set(0, o.turn, o.tilt)
  f.scale.setScalar(length)
  g.add(f)
  const top = PODS[kind].r[0] * length
  const cap = mesh(kit, cone(kit, 5), kit.material(o.calyx))
  cap.position.copy(at)
  cap.position.y -= length * 0.1
  cap.scale.set(top * 1.15, length * 0.1 + 0.001, top * 1.15)
  g.add(cap)
  return f
}

interface BushKind {
  leaf: (kit: Kit) => T.BufferGeometry
  /** Full-size length of the lowest leaves, m. */
  leafLen: number
  leafRoughness?: number
  /** Leaves at young, bush and full. */
  leaves: [number, number, number]
  height: number
  /** Fruit (trusses for tomatoes) at full. */
  fruits: number
  pod?: Pod
  fruitLen: number
  color: string
  flower: string
  /** style.accent2 colours the flowers rather than unripe fruit. */
  accent2Flower?: boolean
  roughness?: number
}

const BUSHES: Record<string, BushKind> = {
  'cherry-tomato': { leaf: tomatoLeaf, leafLen: 0.045, leaves: [4, 7, 8], height: 0.1, fruits: 3, fruitLen: 0.0065, color: '#d8382b', flower: YELLOW, roughness: 0.35 },
  'pepper': { leaf: k => leafBlade(k, 0.52, -0.2, 0.3), leafLen: 0.042, leafRoughness: 0.5, leaves: [4, 8, 9], height: 0.09, fruits: 3, pod: 'bell', fruitLen: 0.022, color: '#d4302a', flower: WHITE, roughness: 0.3 },
  'jalapeno': { leaf: k => leafBlade(k, 0.44, -0.2, 0.25), leafLen: 0.04, leafRoughness: 0.55, leaves: [4, 8, 9], height: 0.095, fruits: 4, pod: 'chili', fruitLen: 0.03, color: '#2f6b2a', flower: WHITE, roughness: 0.3 },
  'banana': { leaf: k => leafBlade(k, 0.46, -0.2, 0.25), leafLen: 0.04, leafRoughness: 0.55, leaves: [4, 8, 9], height: 0.095, fruits: 3, pod: 'banana', fruitLen: 0.042, color: '#e8d24a', flower: WHITE, roughness: 0.35 },
  'eggplant': { leaf: k => leafBlade(k, 0.64, -0.35, 0.35), leafLen: 0.044, leafRoughness: 0.95, leaves: [3, 6, 7], height: 0.085, fruits: 3, pod: 'eggplant', fruitLen: 0.036, color: '#4a2259', flower: '#b58fd6', accent2Flower: true, roughness: 0.25 },
}

/** A branching stem of broad leaves with fruit hanging opposite them. */
const fruitingBush: PlantBuilder = (kit, stage, style, rand) => {
  const k = BUSHES[style.variant ?? ''] ?? BUSHES.pepper
  if (stage === 'sprout') return seedling(kit, style, rand, k.pod ? 0.5 : 0.36)
  const { THREE } = kit
  const g = new THREE.Group()
  const s = SIZE[stage]
  const n = k.leaves[AT[stage]]
  const stemMat = kit.material(style.leafDark)
  const leafGeo = k.leaf(kit)
  const leafMat = kit.material(style.leaf, { double: true, roughness: k.leafRoughness })
  const oldMat = kit.material(style.leafDark, { double: true, roughness: k.leafRoughness })

  const origin = new THREE.Vector3()
  const lean = dir(kit, rand() * TAU, 0.12 + rand() * 0.12)
  const top = lean.clone().multiplyScalar(k.height * s)
  g.add(stalk(kit, stemMat, origin, top, 0.0012 + 0.0018 * s, 0.45))

  // Every node's randoms are drawn whether or not this stage shows it, so a plant keeps its shape as it grows.
  const base = rand() * TAU
  const nodes = Array.from({ length: k.leaves[2] }, (_, j) => ({ around: base + j * GOLDEN + (rand() - 0.5) * 0.5, out: rand(), len: rand() }))
  nodes.slice(0, n).forEach((node, j) => {
    const up = n > 1 ? j / (n - 1) : 1
    const at = origin.clone().lerp(top, 0.3 + 0.7 * ((j + 1) / n))
    const end = at.clone().addScaledVector(dir(kit, node.around, 1.0), 0.012 * s)
    g.add(stalk(kit, stemMat, at, end, 0.0006 + 0.0006 * s))
    g.add(leafAt(kit, leafGeo, up < 0.3 ? oldMat : leafMat, end, {
      around: node.around,
      out: 1.35 - 0.7 * up + (node.out - 0.5) * 0.2,
      length: k.leafLen * s * (1 - 0.3 * up) * (0.9 + 0.2 * node.len),
    }))
  })

  const fruits = Array.from({ length: k.fruits }, () => ({ tilt: rand(), turn: rand(), size: rand(), ripe: [rand(), rand(), rand(), rand()] }))
  if (stage === 'young') return g
  const ripe = style.accent ?? k.color
  const unripe = (!k.accent2Flower && style.accent2) || '#86b84a'
  const bloom = (k.accent2Flower && style.accent2) || k.flower
  const hung = nodes.slice(0, n)
  fruits.forEach((f, i) => {
    const node = hung[Math.min(hung.length - 1, Math.floor(((i + 0.5) / k.fruits) * hung.length * 0.7))]
    const j = hung.indexOf(node)
    const around = node.around + Math.PI * (0.8 + 0.4 * f.turn)
    const from = origin.clone().lerp(top, 0.3 + 0.7 * ((j + 1) / n))
    const out = dir(kit, around, 1.3)
    if (!k.pod) {
      // A tomato truss: a stalk arching out with fruit along it, ripening from the stem outwards.
      const end = from.clone().addScaledVector(out, 0.024 * s).add(new THREE.Vector3(0, -0.012 * s, 0))
      g.add(stalk(kit, stemMat, from, end, 0.0007))
      f.ripe.forEach((r, m) => {
        const at = from.clone().lerp(end, 0.35 + 0.65 * (m / 3))
        at.y -= k.fruitLen * (0.9 + (m % 2) * 0.6)
        at.addScaledVector(dir(kit, around + Math.PI / 2, Math.PI / 2), (m % 2 ? 1 : -1) * k.fruitLen * 0.5)
        if (stage === 'bush' && m >= 2) return flower(kit, g, at, around, 0.005, k.flower)
        const fruit = mesh(kit, ball(kit, 1), kit.material(stage === 'full' && r < 0.75 ? ripe : unripe, { roughness: k.roughness }), 'fruit')
        fruit.position.copy(at)
        fruit.scale.set(1, 0.88, 1).multiplyScalar(k.fruitLen * (stage === 'full' ? 0.9 + 0.2 * f.size : 0.55))
        g.add(fruit)
      })
      return
    }
    const at = from.clone().addScaledVector(out, (0.008 + k.fruitLen * 0.4) * s).add(new THREE.Vector3(0, -0.004 * s, 0))
    if (stage === 'bush') {
      g.add(stalk(kit, stemMat, from, at, 0.0005))
      return flower(kit, g, at, around, 0.0055, bloom, k.flower === WHITE ? YELLOW : undefined)
    }
    // The last fruit set is still ripening.
    hangPod(kit, g, from, at, k.pod, k.fruitLen * (0.9 + 0.2 * f.size), i === k.fruits - 1 ? unripe : ripe, { calyx: style.leafDark, roughness: k.roughness, tilt: (f.tilt - 0.5) * 0.5, turn: around })
  })
  return g
}

interface VineKind {
  /** Twining (beans) or sprawling up and over (cucumber, pea). */
  twine: boolean
  leaf: (kit: Kit) => T.BufferGeometry
  leafLen: number
  /** A separate leaf stalk this long at full, or 0 when the leaf carries its own. */
  petiole: number
  leaves: [number, number, number]
  length: number
  tendrils: number
  pod: Pod
  pods: number
  podLen: number
  color: string
  flower: string
  /** Pods hang in pairs from a node. */
  paired: boolean
}

const VINES: Record<string, VineKind> = {
  cucumber: { twine: false, leaf: lobedLeaf, leafLen: 0.036, petiole: 0.016, leaves: [3, 5, 6], length: 0.09, tendrils: 2, pod: 'cucumber', pods: 3, podLen: 0.045, color: '#3d7a2c', flower: YELLOW, paired: false },
  bean: { twine: true, leaf: k => trifoliate(k, false, 0.28), leafLen: 0.05, petiole: 0, leaves: [3, 6, 7], length: 0.12, tendrils: 0, pod: 'bean', pods: 4, podLen: 0.055, color: '#5a9a32', flower: WHITE, paired: true },
  pea: { twine: false, leaf: peaLeaf, leafLen: 0.045, petiole: 0, leaves: [4, 7, 9], length: 0.12, tendrils: 2, pod: 'pea', pods: 4, podLen: 0.032, color: '#6cb83c', flower: WHITE, paired: true },
}

/** A twining stem: unit height, two and a half turns, starting at the origin. */
function twine(kit: Kit, radius: number): { geometry: T.BufferGeometry, at: (f: number) => T.Vector3 } {
  const { THREE } = kit
  const at = (f: number) => {
    const a = f * TAU * 2.5
    return new THREE.Vector3(radius * Math.sin(a), f, radius * (Math.cos(a) - 1))
  }
  const geometry = kit.geometry(`fr:twine:${radius.toFixed(3)}`, () => {
    const points = Array.from({ length: 21 }, (_, i) => at(i / 20))
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 30, 0.012, 4, false)
  })
  return { geometry, at }
}

/** Point `f` of the way along a polyline by length. */
function along(points: T.Vector3[], f: number): T.Vector3 {
  const lengths = points.slice(1).map((p, i) => p.distanceTo(points[i]))
  let left = f * lengths.reduce((a, b) => a + b, 0)
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i] || i === lengths.length - 1) return points[i].clone().lerp(points[i + 1], Math.min(1, left / lengths[i]))
    left -= lengths[i]
  }
  return points[0].clone()
}

/** A climbing or sprawling vine with leaves either side, tendrils and hanging pods. */
const vine: PlantBuilder = (kit, stage, style, rand) => {
  const k = VINES[style.variant ?? ''] ?? VINES.bean
  if (stage === 'sprout') return seedling(kit, style, rand, k.twine ? 0.62 : 0.5)
  const { THREE } = kit
  const g = new THREE.Group()
  const s = SIZE[stage]
  const n = k.leaves[AT[stage]]
  const stemMat = kit.material(style.leafDark)
  const leafMat = kit.material(style.leaf, { double: true })
  const oldMat = kit.material(style.leafDark, { double: true })
  const heading = rand() * TAU

  let at: (f: number) => T.Vector3
  if (k.twine) {
    const t = twine(kit, 0.07)
    const m = mesh(kit, t.geometry, stemMat)
    m.rotation.y = heading
    m.scale.setScalar(k.length * s)
    g.add(m)
    at = f => t.at(f).applyAxisAngle(new THREE.Vector3(0, 1, 0), heading).multiplyScalar(k.length * s)
  }
  else {
    // Up out of the cup, then over and a little down as it outgrows its support.
    const bends = k.pod === 'pea' ? [0.05, 0.25, 0.5, 0.8] : [0.1, 0.4, 0.75, 1.05]
    const points = [new THREE.Vector3()]
    bends.forEach((b, i) => {
      const step = dir(kit, heading + (rand() - 0.5) * 0.4, b).multiplyScalar((k.length * s) / bends.length)
      points.push(points[i].clone().add(step))
    })
    points.slice(1).forEach((p, i) => g.add(stalk(kit, stemMat, points[i], p, (0.0018 - i * 0.0003) * (0.5 + 0.5 * s), 0.8)))
    at = f => along(points, f)
  }

  const nodes = Array.from({ length: k.leaves[2] }, () => ({ side: rand(), out: rand(), len: rand() }))
  nodes.slice(0, n).forEach((node, j) => {
    const up = n > 1 ? j / (n - 1) : 1
    const p = at(0.18 + 0.82 * ((j + 1) / n))
    const around = k.twine ? heading + j * GOLDEN + node.side : heading + (j % 2 ? 1 : -1) * (1.3 + node.side * 0.6)
    let base = p
    if (k.petiole) {
      base = p.clone().addScaledVector(dir(kit, around, 0.6), k.petiole * s)
      g.add(stalk(kit, stemMat, p, base, 0.0008))
    }
    g.add(leafAt(kit, k.leaf(kit), up < 0.25 ? oldMat : leafMat, base, {
      around,
      out: 1.0 + (node.out - 0.5) * 0.4 + (k.twine ? 0.2 : 0),
      length: k.leafLen * s * (1 - 0.25 * up) * (0.9 + 0.2 * node.len),
    }))
  })

  const curls = Array.from({ length: k.tendrils }, () => ({ f: rand(), around: rand() }))
  if (stage !== 'young') {
    curls.forEach((c) => {
      const t = mesh(kit, tendril(kit, 14), stemMat)
      t.position.copy(at(0.55 + 0.4 * c.f))
      t.rotation.order = 'YXZ'
      t.rotation.set(0.5, heading + (c.around - 0.5) * 3, 0)
      t.scale.setScalar(0.022 * s)
      g.add(t)
    })
  }

  const pods = Array.from({ length: k.pods }, () => ({ f: rand(), tilt: rand(), size: rand() }))
  if (stage === 'young') return g
  const color = style.accent ?? k.color
  const bloom = style.accent2 ?? k.flower
  pods.forEach((d, i) => {
    const pair = k.paired ? Math.floor(i / 2) : i
    const groups = k.paired ? Math.ceil(k.pods / 2) : k.pods
    const from = at(0.35 + 0.5 * ((pair + 0.5) / groups) + (d.f - 0.5) * 0.06)
    const around = heading + (k.paired ? (i % 2 ? 0.7 : -0.7) : (i % 2 ? 1.6 : -1.6) + Math.PI * 0.15)
    const hang = from.clone().addScaledVector(dir(kit, around, 1.4), 0.008 * s)
    if (stage === 'bush') {
      g.add(stalk(kit, stemMat, from, hang, 0.0005))
      return flower(kit, g, hang, around, k.flower === YELLOW ? 0.007 : 0.005, bloom, k.flower === WHITE ? YELLOW : undefined)
    }
    const fruit = hangPod(kit, g, from, hang, k.pod, k.podLen * (0.88 + 0.24 * d.size), color, { calyx: style.leafDark, tilt: (d.tilt - 0.5) * 0.5 + (i % 2 ? 0.15 : -0.15), turn: around })
    // The last cucumber still wears its flower at the blossom end.
    if (k.flower === YELLOW && i === k.pods - 1) {
      const tip = new THREE.Vector3(PODS[k.pod].bend ?? 0, -1, 0).applyEuler(fruit.rotation).multiplyScalar(fruit.scale.x).add(fruit.position)
      flower(kit, g, tip, around, 0.006, bloom)
    }
  })
  return g
}

/** A low rosette of toothed trifoliate leaves, with berries hanging over the cup's edge. */
const strawberry: PlantBuilder = (kit, stage, style, rand) => {
  if (stage === 'sprout') return seedling(kit, style, rand, 0.7)
  const { THREE } = kit
  const g = new THREE.Group()
  const s = SIZE[stage]
  const n = [4, 7, 8][AT[stage]]
  const stemMat = kit.material(style.leafDark)
  const leafGeo = trifoliate(kit, true, 0)
  const leafMat = kit.material(style.leaf, { double: true, roughness: 0.6 })
  const oldMat = kit.material(style.leafDark, { double: true, roughness: 0.6 })

  const crown = mesh(kit, ball(kit, 0), stemMat)
  crown.position.y = 0.002
  crown.scale.set(0.006, 0.005, 0.006).multiplyScalar(0.6 + 0.4 * s)
  g.add(crown)
  const root = new THREE.Vector3(0, 0.003, 0)

  const base = rand() * TAU
  const leaves = Array.from({ length: 8 }, (_, j) => ({ around: base + j * GOLDEN + (rand() - 0.5) * 0.4, tip: rand(), len: rand() }))
  leaves.slice(0, n).forEach((l, j) => {
    const end = root.clone().addScaledVector(dir(kit, l.around, 0.2 + 0.35 * l.tip), 0.045 * s * (0.85 + 0.3 * l.len))
    g.add(stalk(kit, stemMat, root, end, 0.0007 + 0.0003 * s))
    g.add(leafAt(kit, leafGeo, j < 2 && n > 4 ? oldMat : leafMat, end, { around: l.around, out: 1.1 + 0.3 * l.tip, length: 0.034 * s }))
  })

  const berries = Array.from({ length: 5 }, () => ({ around: rand(), reach: rand(), size: rand() }))
  if (stage === 'young') return g
  const ripe = style.accent ?? '#d7263d'
  const unripe = '#dfe8b0'
  berries.forEach((b, i) => {
    const around = base + 0.6 + i * (TAU / 5) + (b.around - 0.5) * 0.6
    const out = dir(kit, around, Math.PI / 2)
    if (stage === 'bush') {
      if (i > 2) return
      const at = root.clone().addScaledVector(dir(kit, around, 0.85), 0.034 * s)
      g.add(stalk(kit, stemMat, root, at, 0.0005))
      return flower(kit, g, at, around, 0.006, style.accent2 ?? WHITE, YELLOW)
    }
    // The stalk arches up and over the cup's rim, and the berry hangs from it.
    const arch = out.clone().multiplyScalar(0.02).add(new THREE.Vector3(0, 0.012, 0))
    const at = out.multiplyScalar(0.036 + 0.008 * b.reach)
    const length = 0.017 * (0.9 + 0.2 * b.size)
    g.add(stalk(kit, stemMat, root, arch, 0.0006, 0.9))
    hangPod(kit, g, arch, at, 'strawberry', length, i === 4 ? unripe : ripe, { calyx: style.leaf, roughness: 0.4, tilt: 0.25, turn: around + Math.PI / 2 })
  })
  return g
}

/** Broad blue-green leaves round a cauliflower curd, or a kohlrabi's swollen stem with leaves on stalks. */
const brassicaHead: PlantBuilder = (kit, stage, style, rand) => {
  if (stage === 'sprout') return seedling(kit, style, rand, 0.95)
  const { THREE } = kit
  const g = new THREE.Group()
  const s = SIZE[stage]
  const leafMat = kit.material(style.leaf, { double: true, roughness: 0.55 })
  const oldMat = kit.material(style.leafDark, { double: true, roughness: 0.55 })
  const base = rand() * TAU

  if (style.variant === 'kohlrabi') {
    const n = [4, 6, 8][AT[stage]]
    const color = style.accent ?? '#7b4a9c'
    const r = stage === 'young' ? 0.004 : 0.021 * s * (stage === 'bush' ? 0.75 : 1)
    const centre = new THREE.Vector3(0, r * 0.85, 0)
    if (stage !== 'young') {
      const bulb = mesh(kit, ball(kit, 1), kit.material(color, { roughness: 0.4 }), 'fruit')
      bulb.position.copy(centre)
      bulb.scale.set(r, r * 0.9, r)
      g.add(bulb)
    }
    const stalkMat = kit.material(stage === 'young' ? style.leafDark : color)
    const leaf = leafBlade(kit, 0.58, -0.15, 0.3)
    const leaves = Array.from({ length: 8 }, (_, j) => ({ around: base + j * GOLDEN + (rand() - 0.5) * 0.4, tip: rand(), len: rand() }))
    leaves.slice(0, n).forEach((l, j) => {
      const from = centre.clone().addScaledVector(dir(kit, l.around, 0.5 + 0.4 * l.tip), r * 0.85)
      const end = from.clone().addScaledVector(dir(kit, l.around, 0.2 + 0.3 * l.tip), 0.03 * s * (0.85 + 0.3 * l.len))
      g.add(stalk(kit, stalkMat, from, end, 0.0011, 0.5))
      g.add(leafAt(kit, leaf, j < 2 && n > 4 ? oldMat : leafMat, end, { around: l.around, out: 0.75 + 0.35 * l.tip, length: 0.031 * s }))
    })
    return g
  }

  const n = [4, 9, 11][AT[stage]]
  const core = mesh(kit, stem(kit, 0.7), kit.material(style.leafDark))
  core.scale.set(0.005 * s, 0.016 * s, 0.005 * s)
  g.add(core)
  const leaf = leafBlade(kit, 0.62, 0.12, 0.45)
  const leaves = Array.from({ length: 11 }, (_, j) => ({ around: base + j * GOLDEN + (rand() - 0.5) * 0.3, out: rand(), len: rand() }))
  leaves.slice(0, n).forEach((l, j) => {
    const inner = n > 1 ? j / (n - 1) : 0
    g.add(leafAt(kit, leaf, inner < 0.3 ? oldMat : leafMat, new THREE.Vector3(0, 0.004 + 0.01 * inner * s, 0), {
      around: l.around,
      out: 1.2 - 0.45 * inner + (l.out - 0.5) * 0.2,
      length: 0.058 * s * (1 - 0.2 * inner) * (0.9 + 0.2 * l.len),
    }))
  })
  if (stage === 'young') return g
  const r = stage === 'bush' ? 0.009 : 0.021
  const head = mesh(kit, curd(kit), kit.material(style.accent ?? '#f1ead2', { roughness: 0.9 }), 'fruit')
  head.position.y = 0.016 * s + r * 0.4
  head.rotation.y = base
  head.scale.setScalar(r)
  g.add(head)
  return g
}

/** Builders for the fruiting archetypes; each reads `style.variant` for the crop. */
export const FRUITING_BUILDERS: Record<'fruiting-bush' | 'vine' | 'strawberry' | 'brassica-head', PlantBuilder> = {
  'fruiting-bush': fruitingBush,
  'vine': vine,
  'strawberry': strawberry,
  'brassica-head': brassicaHead,
}
