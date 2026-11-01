/**
 * Herb models: bushy herbs with opposite leaf pairs (basil, mint, oregano,
 * stevia), feathery herbs on long stalks from the base (dill, cilantro,
 * parsley, tarragon) and woody herbs (rosemary, lavender, thyme, savory, sage).
 * Dense parts (a stem of needles, a dill frond, a compound leaf) are merged into
 * one cached geometry each, so a full plant stays within a few dozen meshes.
 */
import type * as T from 'three'
import type { Kit, PlantBuilder, PlantStyle, Stage } from './kit'
import { leafBlade, placeLeaf, stem } from './shapes'

/** Linear size of each stage against the full plant. */
const GROWTH: Record<Stage, number> = { sprout: 0, young: 0.42, bush: 0.75, full: 1 }
const GOLDEN = 2.39996

/** Leaves outgrow stems early on: a young plant is mostly leaf. */
const leafSize = (g: number) => 0.2 + 0.8 * g
const jitter = (rand: () => number, amount: number) => 1 + (rand() * 2 - 1) * amount
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
/** Per-stage pick from a [young, bush, full] triple. */
const byStage = <V>(stage: Stage, v: [V, V, V]): V => v[stage === 'young' ? 0 : stage === 'bush' ? 1 : 2]

function tag<M extends T.Object3D>(o: M, role: string): M {
  o.userData.role = role
  return o
}

/** A leaf face up, its tip drooping with the blade's curl (placeLeaf tips towards the face, so lean the other way). */
function leaf(kit: Kit, geometry: T.BufferGeometry, material: T.Material, around: number, tilt: number, length: number, height = 0): T.Mesh {
  return placeLeaf(kit, geometry, material, { around, out: -tilt, length, height })
}

/** A group at `height` on its parent whose +y leans `tilt` from vertical towards `around`, with the same convention as `leaf`. */
function shoot(kit: Kit, around: number, tilt: number, height = 0): T.Group {
  const g = new kit.THREE.Group()
  g.position.y = height
  g.rotation.order = 'YXZ'
  g.rotation.set(-tilt, around, 0)
  return g
}

function stalk(kit: Kit, material: T.Material, radius: number, length: number): T.Mesh {
  const m = tag(new kit.THREE.Mesh(stem(kit, 0.5), material), 'stem')
  m.scale.set(radius, length, radius)
  return m
}

function leafMaterials(kit: Kit, style: PlantStyle, roughness = 0.8): [T.Material, T.Material] {
  return [kit.material(style.leaf, { roughness, double: true }), kit.material(style.leafDark, { roughness, double: true })]
}

/** Two seed leaves on a short stem, `width` from round (basil) to strap-like (dill). */
function sprout(kit: Kit, style: PlantStyle, rand: () => number, width: number): T.Group {
  const g = new kit.THREE.Group()
  const height = 0.011 + rand() * 0.004
  g.add(stalk(kit, kit.material(style.leafDark), 0.0009, height))
  const blade = leafBlade(kit, width, 0.25, 0.3)
  const mat = kit.material(style.leaf, { double: true })
  const around = rand() * Math.PI
  const length = width > 0.4 ? 0.007 : 0.01
  for (const side of [0, Math.PI]) g.add(leaf(kit, blade, mat, around + side, 1.1, length, height))
  return g
}

// --- Merged parts ---

const part = (THREE: Kit['THREE'], p: [number, number, number], r: [number, number, number], s: [number, number, number]) =>
  new THREE.Matrix4().compose(new THREE.Vector3(...p), new THREE.Quaternion().setFromEuler(new THREE.Euler(...r, 'YXZ')), new THREE.Vector3(...s))

/** One flat-normalled geometry from placed copies of unit parts, optionally bent back along +y like a drooping leaf. */
function merge(kit: Kit, parts: Array<[T.BufferGeometry, T.Matrix4]>, bend = 0): T.BufferGeometry {
  const { THREE } = kit
  const chunks = parts.map(([g, m]) => {
    const flat = g.index ? g.toNonIndexed() : g.clone()
    flat.applyMatrix4(m)
    const a = flat.attributes.position.array as Float32Array
    flat.dispose()
    return a
  })
  const out = new Float32Array(chunks.reduce((n, a) => n + a.length, 0))
  let offset = 0
  for (const a of chunks) {
    out.set(a, offset)
    offset += a.length
  }
  for (let i = 0; i < out.length; i += 3) out[i + 2] -= bend * out[i + 1] * out[i + 1]
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(out, 3))
  g.computeVertexNormals()
  return g
}

/** A three-sided open cone, base at the origin and tip at +y 1: a needle, a thread of dill. */
const needle = (kit: Kit) => kit.geometry('herb:needle', () => {
  const g = new kit.THREE.ConeGeometry(1, 1, 3, 1, true)
  g.translate(0, 0.5, 0)
  return g
})

interface Cluster {
  /** Needles (rosemary) or small blades of this width (thyme, lavender). */
  blade: number | 'needle'
  nodes: number
  /** Leaves per node: 2 for opposite pairs, 1 for a spiral. */
  pair: 1 | 2
  /** Leaf length against the shoot's. */
  length: number
  /** Angle out from the shoot, at its base. */
  angle: number
  /** Where along the shoot the leaves start. */
  from: number
}

/** The leaves of a whole shoot, unit length along +y, as one geometry: a sprig of thyme, a stem of rosemary needles. */
function clusterGeometry(kit: Kit, c: Cluster): T.BufferGeometry {
  return kit.geometry(`herb:cluster:${c.blade}:${c.nodes}:${c.pair}:${c.length}:${c.angle}:${c.from}`, () => {
    const { THREE } = kit
    const unit = c.blade === 'needle' ? needle(kit) : leafBlade(kit, c.blade, 0.2, 0.2)
    const parts: Array<[T.BufferGeometry, T.Matrix4]> = []
    for (let i = 0; i < c.nodes; i++) {
      const t = lerp(c.from, 1, i / (c.nodes - 1))
      const length = c.length * (1 - 0.45 * t)
      const tilt = c.angle * (1 - 0.4 * t)
      for (let s = 0; s < c.pair; s++) {
        const around = c.pair === 2 ? i * Math.PI / 2 + s * Math.PI : i * GOLDEN
        const scale: [number, number, number] = c.blade === 'needle' ? [length * 0.14, length, length * 0.07] : [length, length, length]
        parts.push([unit, part(THREE, [0, t, 0], [-tilt, around, 0], scale)])
      }
    }
    return merge(kit, parts)
  })
}

/** A flower spike, unit length along +y: stacked whorls of buds narrowing to the tip. */
function spikeGeometry(kit: Kit, whorls: number, radius: number): T.BufferGeometry {
  return kit.geometry(`herb:spike:${whorls}:${radius}`, () => {
    const { THREE } = kit
    const bud = kit.geometry('herb:octa', () => new THREE.OctahedronGeometry(1, 0))
    const parts: Array<[T.BufferGeometry, T.Matrix4]> = []
    const step = 1 / whorls
    for (let i = 0; i < whorls; i++) {
      const t = (i + 0.5) * step
      const r = radius * (1 - 0.5 * t)
      parts.push([bud, part(THREE, [0, t, 0], [0, i * 0.8, 0], [r, step * 0.6, r])])
    }
    return merge(kit, parts)
  })
}

/** A dill frond, unit length along +y: a thin rachis bristling with threads. */
function frondGeometry(kit: Kit): T.BufferGeometry {
  return kit.geometry('herb:frond', () => {
    const { THREE } = kit
    const parts: Array<[T.BufferGeometry, T.Matrix4]> = [[stem(kit, 0.5), part(THREE, [0, 0, 0], [0, 0, 0], [0.025, 1, 0.025])]]
    const thread = needle(kit)
    for (let i = 0; i < 7; i++) {
      const t = 0.15 + 0.85 * i / 6
      const length = 0.34 * (1 - 0.6 * t)
      for (let q = 0; q < 3; q++) parts.push([thread, part(THREE, [0, t, 0], [-0.95, i * 0.9 + q * Math.PI * 2 / 3, 0], [0.03, length, 0.03])])
    }
    return merge(kit, parts, 0.15)
  })
}

/** A fan-shaped leaflet from its base at the origin, unit long, its edge scalloped (`sharp` false) or toothed into `lobes`. */
function leafletGeometry(kit: Kit, lobes: number, depth: number, sharp: boolean, spread: number): T.BufferGeometry {
  return kit.geometry(`herb:leaflet:${lobes}:${depth}:${sharp ? 1 : 0}:${spread}`, () => {
    const { THREE } = kit
    const s = new THREE.Shape()
    s.moveTo(0, 0)
    // A toothed edge needs only its points and notches; a scalloped one rounds each lobe.
    const steps = lobes * (sharp ? 2 : 4)
    for (let i = 0; i <= steps; i++) {
      const u = i / steps
      const phase = (u * lobes) % 1
      const bump = sharp ? 1 - Math.abs(2 * phase - 1) : Math.sin(Math.PI * phase)
      const a = lerp(-spread, spread, u)
      const r = (1 - depth * (1 - bump)) * (0.8 + 0.2 * Math.cos(a))
      s.lineTo(Math.sin(a) * r, Math.cos(a) * r)
    }
    s.lineTo(0, 0)
    return new THREE.ShapeGeometry(s, 1)
  })
}

interface Compound {
  lobes: number
  depth: number
  sharp: boolean
  spread: number
  petiole: number
  leaflet: number
  /** Lateral leaflet pairs: distance below the tip, angle out, size against the terminal leaflet. */
  pairs: Array<[number, number, number]>
}

const COMPOUND: Record<'cilantro' | 'parsley', Compound> = {
  cilantro: { lobes: 3, depth: 0.22, sharp: false, spread: 0.85, petiole: 0.6, leaflet: 0.38, pairs: [[0.06, 1.0, 0.85]] },
  parsley: { lobes: 5, depth: 0.3, sharp: true, spread: 0.7, petiole: 0.55, leaflet: 0.34, pairs: [[0.05, 0.85, 0.85], [0.2, 1.15, 0.7]] },
}

/** A whole compound leaf, unit long: a petiole topped by a terminal leaflet and lateral pairs, drooping. */
function compoundGeometry(kit: Kit, kind: keyof typeof COMPOUND): T.BufferGeometry {
  return kit.geometry(`herb:compound:${kind}`, () => {
    const { THREE } = kit
    const c = COMPOUND[kind]
    const leaflet = leafletGeometry(kit, c.lobes, c.depth, c.sharp, c.spread)
    const s = c.leaflet
    const parts: Array<[T.BufferGeometry, T.Matrix4]> = [
      [stem(kit, 0.5), part(THREE, [0, 0, 0], [0, 0, 0], [0.018, c.petiole, 0.018])],
      [leaflet, part(THREE, [0, c.petiole, 0], [0, 0, 0], [s, s, s])],
    ]
    for (const [below, angle, size] of c.pairs) {
      for (const side of [-1, 1]) parts.push([leaflet, part(THREE, [0, c.petiole - below, 0], [0, 0, side * angle], [s * size, s * size, s * size])])
    }
    return merge(kit, parts, 0.35)
  })
}

/** A leaf with a quilted surface, from a grid so it has inner vertices to pucker: sage. */
function textureLeafGeometry(kit: Kit, width: number): T.BufferGeometry {
  return kit.geometry(`herb:quilted:${width}`, () => {
    const { THREE } = kit
    const g = new THREE.PlaneGeometry(1, 1, 4, 6)
    const p = g.attributes.position as T.BufferAttribute
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) * 2
      const v = p.getY(i) + 0.5
      const half = (width / 2) * Math.sin(Math.PI * Math.min(1, v ** 0.8)) ** 0.8
      const col = Math.round((u + 1) * 2)
      const row = Math.round(v * 6)
      const pucker = (col + row) % 2 ? 0.02 : -0.02
      p.setXYZ(i, u * half, v, -0.2 * v * v + 0.12 * u * u + pucker)
    }
    g.computeVertexNormals()
    return g
  })
}

// --- Herb bush ---

interface Bush {
  height: number
  nodes: number
  sides: number
  sideNodes: number
  sideTilt: number
  /** Side shoot length against the main stem's. */
  sideLength: number
  leafLength: number
  leafTilt: number
  blade: [number, number, number]
  roughness: number
  cotyledon: number
  spikes?: boolean
}

const BUSH: Record<string, Bush> = {
  basil: { height: 0.06, nodes: 5, sides: 3, sideNodes: 3, sideTilt: 0.65, sideLength: 0.6, leafLength: 0.036, leafTilt: 1.1, blade: [0.75, 0.35, 0.7], roughness: 0.45, cotyledon: 0.8 },
  thai: { height: 0.064, nodes: 5, sides: 3, sideNodes: 3, sideTilt: 0.68, sideLength: 0.6, leafLength: 0.032, leafTilt: 1.05, blade: [0.5, 0.3, 0.5], roughness: 0.5, cotyledon: 0.75, spikes: true },
  mint: { height: 0.055, nodes: 5, sides: 4, sideNodes: 4, sideTilt: 0.6, sideLength: 0.7, leafLength: 0.023, leafTilt: 1.05, blade: [0.58, 0.25, 0.35], roughness: 0.7, cotyledon: 0.75 },
  oregano: { height: 0.03, nodes: 3, sides: 5, sideNodes: 3, sideTilt: 1.1, sideLength: 1.15, leafLength: 0.015, leafTilt: 0.95, blade: [0.9, 0.15, 0.35], roughness: 0.75, cotyledon: 0.8 },
  stevia: { height: 0.085, nodes: 6, sides: 2, sideNodes: 4, sideTilt: 0.45, sideLength: 0.7, leafLength: 0.03, leafTilt: 0.85, blade: [0.32, 0.2, 0.25], roughness: 0.7, cotyledon: 0.6 },
}

/** A stem of opposite leaf pairs, each pair a quarter turn from the last, crowding and shrinking towards the tip. */
function leafyShoot(kit: Kit, g: T.Group, f: Bush, length: number, nodes: number, leafLength: number, mats: [T.Material, T.Material], stemMat: T.Material, rand: () => number) {
  g.add(stalk(kit, stemMat, 0.0013, length))
  const blade = leafBlade(kit, ...f.blade)
  const phase = rand() * Math.PI
  // A seedling's two pairs are both open; on a grown shoot the tip pair is small and folded up.
  const fold = nodes > 2 ? 1 : 0.6
  for (let i = 0; i < nodes; i++) {
    const t = ((i + 1) / nodes) ** 0.65
    const size = leafLength * (1 - 0.4 * (t * fold) ** 2) * jitter(rand, 0.08)
    const tilt = f.leafTilt * (1 - 0.45 * (t * fold) ** 2)
    for (const side of [0, Math.PI]) g.add(leaf(kit, blade, mats[t < 0.5 || rand() < 0.25 ? 1 : 0], phase + i * Math.PI / 2 + side, tilt, size, t * length))
  }
}

const herbBush: PlantBuilder = (kit, stage, style, rand) => {
  const f = BUSH[style.variant ?? ''] ?? BUSH.basil
  if (stage === 'sprout') return sprout(kit, style, rand, f.cotyledon)
  const growth = GROWTH[stage]
  const group = new kit.THREE.Group()
  const mats = leafMaterials(kit, style, f.roughness)
  const stemMat = kit.material(style.leafDark)
  const phase = rand() * Math.PI * 2
  const leafLength = f.leafLength * leafSize(growth)
  const height = f.height * growth * jitter(rand, 0.05)
  const main = shoot(kit, phase, rand() * 0.1)
  leafyShoot(kit, main, f, height, byStage(stage, [2, f.nodes - 1, f.nodes]), leafLength, mats, stemMat, rand)
  group.add(main)
  const tips: Array<[T.Group, number]> = [[main, height]]
  const sides = byStage(stage, [0, Math.ceil(f.sides / 2), f.sides])
  for (let k = 0; k < sides; k++) {
    const length = height * f.sideLength * jitter(rand, 0.1)
    const side = shoot(kit, phase + (k + 1) * GOLDEN + (rand() - 0.5) * 0.4, f.sideTilt * (k % 2 ? 0.7 : 1) * jitter(rand, 0.1), height * (0.12 + 0.3 * k / sides))
    leafyShoot(kit, side, f, length, byStage(stage, [0, f.sideNodes - 1, f.sideNodes]), leafLength * 0.85, mats, stemMat, rand)
    group.add(side)
    tips.push([side, length])
  }
  if (f.spikes && stage === 'full') {
    const spike = spikeGeometry(kit, 5, 0.22)
    const mat = kit.material(style.accent ?? style.leafDark, { roughness: 0.6 })
    for (const [s, length] of tips.slice(0, 3)) {
      const m = tag(new kit.THREE.Mesh(spike, mat), 'flower')
      m.position.y = length
      m.scale.setScalar(0.022 * jitter(rand, 0.1))
      s.add(m)
    }
  }
  return group
}

// --- Feathery ---

/** Compound leaves on long petioles in a rosette, the outer ones splayed and the newest upright in the middle. */
function compoundRosette(kit: Kit, stage: Stage, style: PlantStyle, rand: () => number, kind: keyof typeof COMPOUND): T.Group {
  const group = new kit.THREE.Group()
  const growth = GROWTH[stage]
  const geometry = compoundGeometry(kit, kind)
  const [light, dark] = leafMaterials(kit, style, kind === 'parsley' ? 0.6 : 0.75)
  const n = byStage(stage, kind === 'parsley' ? [4, 10, 15] : [4, 9, 13])
  const length = (kind === 'parsley' ? 0.045 : 0.042) * leafSize(growth)
  const phase = rand() * Math.PI * 2
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    const mat = kind === 'parsley' ? (i % 3 ? dark : light) : (i % 2 ? dark : light)
    group.add(leaf(kit, geometry, mat, phase + i * GOLDEN + (rand() - 0.5) * 0.3, lerp(0.85, 0.3, t) * jitter(rand, 0.08), length * (1 - 0.2 * t) * jitter(rand, 0.06), 0.002))
  }
  return group
}

/** Dill: a few thin stalks, each carrying feathery fronds, the top one reaching up. */
function dill(kit: Kit, stage: Stage, style: PlantStyle, rand: () => number): T.Group {
  const group = new kit.THREE.Group()
  const growth = GROWTH[stage]
  const frond = frondGeometry(kit)
  const [light, dark] = leafMaterials(kit, style, 0.8)
  const stemMat = kit.material(style.leafDark)
  const stalks = byStage(stage, [3, 3, 4])
  const fronds = byStage(stage, [1, 2, 3])
  const phase = rand() * Math.PI * 2
  for (let k = 0; k < stalks; k++) {
    const length = 0.06 * growth * (1 - 0.18 * k / stalks) * jitter(rand, 0.06)
    const s = shoot(kit, phase + k * Math.PI * 2 / stalks + (rand() - 0.5) * 0.5, lerp(0.1, 0.35, k / stalks) * jitter(rand, 0.15))
    s.add(stalk(kit, stemMat, 0.0008, length))
    for (let m = 0; m < fronds; m++) {
      const frondLength = 0.036 * leafSize(growth) * (1 - 0.15 * m) * jitter(rand, 0.08)
      const tilt = m === 0 ? 0.15 : 0.85
      s.add(leaf(kit, frond, m % 2 ? dark : light, m * Math.PI + rand() * 0.6, tilt, frondLength, length * (1 - 0.32 * m)))
    }
    group.add(s)
  }
  return group
}

/** Tarragon: upright stems set with narrow lance leaves in a spiral. */
function tarragon(kit: Kit, stage: Stage, style: PlantStyle, rand: () => number): T.Group {
  const group = new kit.THREE.Group()
  const growth = GROWTH[stage]
  const blade = leafBlade(kit, 0.18, 0.2, 0.1)
  const [light, dark] = leafMaterials(kit, style, 0.7)
  const stemMat = kit.material(style.leafDark)
  const stems = byStage(stage, [2, 4, 5])
  const leaves = byStage(stage, [2, 5, 6])
  const phase = rand() * Math.PI * 2
  for (let k = 0; k < stems; k++) {
    const length = 0.082 * growth * (1 - 0.2 * k / stems) * jitter(rand, 0.05)
    const s = shoot(kit, phase + k * Math.PI * 2 / stems + (rand() - 0.5) * 0.4, lerp(0.12, 0.42, k / stems))
    s.add(stalk(kit, stemMat, 0.0011, length))
    const turn = rand() * Math.PI * 2
    for (let j = 0; j < leaves; j++) {
      const t = lerp(0.3, 1, (j + 1) / leaves)
      const size = 0.032 * leafSize(growth) * (1 - 0.35 * t) * jitter(rand, 0.08)
      s.add(leaf(kit, blade, j % 2 ? dark : light, turn + j * GOLDEN, 0.55 * (1 - 0.3 * t), size, t * length))
    }
    group.add(s)
  }
  return group
}

const featheryHerb: PlantBuilder = (kit, stage, style, rand) => {
  const v = style.variant
  if (stage === 'sprout') return sprout(kit, style, rand, v === 'cilantro' ? 0.4 : v === 'parsley' ? 0.3 : 0.2)
  if (v === 'cilantro' || v === 'parsley') return compoundRosette(kit, stage, style, rand, v)
  if (v === 'tarragon') return tarragon(kit, stage, style, rand)
  return dill(kit, stage, style, rand)
}

// --- Woody ---

interface Sprigs {
  count: [number, number, number]
  length: number
  /** Lean of the most splayed and the most upright stem. */
  tilt: [number, number]
  stemRadius: number
  cluster: Cluster
}

const SPRIGS: Record<string, Sprigs> = {
  rosemary: { count: [2, 4, 6], length: 0.078, tilt: [0.36, 0.06], stemRadius: 0.0011, cluster: { blade: 'needle', nodes: 36, pair: 1, length: 0.2, angle: 0.95, from: 0.1 } },
  lavender: { count: [3, 5, 6], length: 0.042, tilt: [0.7, 0.25], stemRadius: 0.001, cluster: { blade: 0.18, nodes: 6, pair: 2, length: 0.5, angle: 0.55, from: 0.2 } },
  thyme: { count: [4, 8, 12], length: 0.036, tilt: [1.15, 0.3], stemRadius: 0.0005, cluster: { blade: 0.6, nodes: 9, pair: 2, length: 0.22, angle: 1.0, from: 0.08 } },
  savory: { count: [3, 6, 10], length: 0.062, tilt: [0.48, 0.08], stemRadius: 0.0006, cluster: { blade: 0.35, nodes: 9, pair: 2, length: 0.2, angle: 0.75, from: 0.1 } },
}

/** Woody stems, each with its leaves as one merged cluster: a few for rosemary, a low mound of many for thyme. */
function sprigs(kit: Kit, stage: Stage, style: PlantStyle, rand: () => number, f: Sprigs, spikes: boolean): T.Group {
  const group = new kit.THREE.Group()
  const growth = GROWTH[stage]
  const cluster = clusterGeometry(kit, f.cluster)
  const leafMat = kit.material(style.leaf, { roughness: 0.85, double: true })
  const stemMat = kit.material(style.leafDark)
  const n = byStage(stage, f.count)
  const phase = rand() * Math.PI * 2
  for (let k = 0; k < n; k++) {
    const length = f.length * growth * jitter(rand, 0.06)
    const s = shoot(kit, phase + k * GOLDEN, lerp(f.tilt[0], f.tilt[1], k / Math.max(1, n - 1)) * jitter(rand, 0.06))
    s.add(stalk(kit, stemMat, f.stemRadius, length))
    const leaves = tag(new kit.THREE.Mesh(cluster, leafMat), 'leaf')
    leaves.scale.setScalar(length)
    s.add(leaves)
    group.add(s)
  }
  // Lavender's flowers: slender spikes on long bare stalks above the leaves.
  if (spikes) {
    const spike = spikeGeometry(kit, 8, 0.14)
    const flowerMat = kit.material(style.accent ?? style.leafDark, { roughness: 0.7 })
    for (let k = 0; k < 5; k++) {
      const length = 0.072 * jitter(rand, 0.06)
      const s = shoot(kit, phase + (k + 0.5) * Math.PI * 2 / 5, lerp(0.35, 0.05, k / 4))
      s.add(stalk(kit, stemMat, 0.0006, length))
      const m = tag(new kit.THREE.Mesh(spike, flowerMat), 'flower')
      m.position.y = length
      m.scale.setScalar(0.024)
      s.add(m)
      group.add(s)
    }
  }
  return group
}

/** Sage: soft, puckered oval leaves in opposite pairs on short stems, a loose rosette. */
function sage(kit: Kit, stage: Stage, style: PlantStyle, rand: () => number): T.Group {
  const group = new kit.THREE.Group()
  const growth = GROWTH[stage]
  const blade = textureLeafGeometry(kit, 0.5)
  const [light, dark] = leafMaterials(kit, style, 1)
  const stemMat = kit.material(style.leafDark)
  const stems = byStage(stage, [1, 3, 4])
  const phase = rand() * Math.PI * 2
  for (let k = 0; k < stems; k++) {
    const length = 0.026 * growth * jitter(rand, 0.1)
    const s = shoot(kit, phase + k * Math.PI * 2 / stems, stems === 1 ? 0 : lerp(0.55, 0.3, k / stems))
    s.add(stalk(kit, stemMat, 0.0012, length))
    const turn = rand() * Math.PI
    s.add(leaf(kit, blade, dark, turn, 1.1, 0.034 * leafSize(growth) * jitter(rand, 0.06), length * 0.4))
    s.add(leaf(kit, blade, dark, turn + Math.PI, 1.1, 0.034 * leafSize(growth) * jitter(rand, 0.06), length * 0.4))
    s.add(leaf(kit, blade, light, turn + Math.PI / 2, 0.55, 0.027 * leafSize(growth) * jitter(rand, 0.06), length))
    s.add(leaf(kit, blade, light, turn - Math.PI / 2, 0.55, 0.027 * leafSize(growth) * jitter(rand, 0.06), length))
    group.add(s)
  }
  return group
}

const woodyHerb: PlantBuilder = (kit, stage, style, rand) => {
  const v = style.variant ?? ''
  if (stage === 'sprout') return sprout(kit, style, rand, v === 'sage' ? 0.6 : 0.35)
  if (v === 'sage') return sage(kit, stage, style, rand)
  return sprigs(kit, stage, style, rand, SPRIGS[v] ?? SPRIGS.rosemary, v === 'lavender' && stage === 'full')
}

/** Builders for the herb archetypes; `style.variant` picks the herb within each (see the catalog). */
export const HERB_BUILDERS: Record<'herb-bush' | 'feathery' | 'woody', PlantBuilder> = {
  'herb-bush': herbBush,
  'feathery': featheryHerb,
  'woody': woodyHerb,
}
