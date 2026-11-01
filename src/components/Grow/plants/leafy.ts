/**
 * Leafy greens: lettuces, greens on stalks, bok choy, strap-leaved alliums
 * and grasses, and watercress. Each builder grows from two seed leaves to a
 * harvest-ready head, varying leaf count, size, lean and colour by `rand`.
 *
 * Leaves here follow one convention on top of `placeLeaf`: `tilt` leans a leaf
 * out from the centre, its +z face is the upper side, a positive `curl` droops
 * the tip outwards and a negative one lifts it, and `cup` lifts the edges.
 */
import type * as T from 'three'
import { seeded, type Kit, type PlantBuilder, type PlantStyle, type Stage, type PlantThree } from './kit'
import { ball, placeLeaf, stem, strapLeaf } from './shapes'

type Grown = Exclude<Stage, 'sprout'>

const GOLDEN = Math.PI * (3 - Math.sqrt(5))
/** Each stage's size next to the full plant. */
const GROW: Record<Grown, number> = { young: 0.42, bush: 0.75, full: 1 }
const STAGE_INDEX: Record<Grown, number> = { young: 0, bush: 1, full: 2 }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const jitter = (rand: () => number, amount: number) => (rand() * 2 - 1) * amount

type Profile = 'oval' | 'round' | 'spoon' | 'lance'

/** Half-width along a blade, 0 at the base to 1 at the tip. */
const PROFILE: Record<Profile, (u: number) => number> = {
  oval: u => Math.sin(Math.PI * (0.06 + 0.92 * u)) ** 0.8,
  round: u => Math.sin(Math.PI * (0.04 + 0.9 * u)) ** 0.5,
  spoon: u => Math.sin(Math.PI * (0.04 + 0.92 * u ** 1.6)) ** 0.6,
  lance: u => Math.sin(Math.PI * (0.03 + 0.95 * u ** 0.8)),
}

interface BladeShape {
  /** Widest width relative to length. */
  width: number
  curl?: number
  cup?: number
  /** Wavy, lobed edges: 0 smooth, 1 frilly. */
  ruffle?: number
  /** Half-waves along each edge. */
  waves?: number
  profile?: Profile
  /** Fraction of the length that is a bare leaf stalk. */
  stalk?: number
  rows?: number
  cols?: 3 | 5
}

/**
 * A leaf blade with a real midrib and edges (unlike shapes' outline-only
 * blade), so it can cup, ruffle and carry a stalk. Same frame as `leafBlade`.
 */
function bladeGeometry(THREE: PlantThree, o: BladeShape): T.BufferGeometry {
  const { width, curl = 0, cup = 0, ruffle = 0, waves = 0, profile = 'oval', stalk = 0, rows = 6, cols = 5 } = o
  const half = width / 2
  const across = cols === 5 ? [-1, -0.5, 0, 0.5, 1] : [-1, 0, 1]
  const pos: number[] = []
  for (let i = 0; i <= rows; i++) {
    // With a stalk, the first segment is the bare stalk and the blade starts above it.
    const u = stalk > 0 ? Math.max(0, i - 1) / (rows - 1) : i / rows
    const y = stalk > 0 && i > 0 ? stalk + (1 - stalk) * u : u
    const w = stalk > 0 && i === 0 ? 0.03 : half * PROFILE[profile](u)
    for (const a of across) {
      const wave = ruffle * Math.sin(waves * Math.PI * u + (a < 0 ? 1.9 : 0)) * Math.abs(a)
      const x = a * w * (1 + 0.35 * wave)
      const z = -curl * y * y * 0.6 + cup * x * x / half * 0.9 + 0.08 * wave * (w / half)
      pos.push(x, y, z)
    }
  }
  const index: number[] = []
  const n = across.length
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = i * n + j
      index.push(a, a + 1, a + n + 1, a, a + n + 1, a + n)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(index)
  g.computeVertexNormals()
  return g
}

function blade(kit: Kit, o: BladeShape): T.BufferGeometry {
  const f = (v = 0) => v.toFixed(2)
  const key = `leafy:blade:${o.profile ?? 'oval'}:${f(o.width)}:${f(o.curl)}:${f(o.cup)}:${f(o.ruffle)}:${f(o.waves)}:${f(o.stalk)}:${o.rows ?? 6}:${o.cols ?? 5}`
  return kit.geometry(key, () => bladeGeometry(kit.THREE, o))
}

/** Joins throwaway parts into one geometry, so a cluster of blades costs one mesh. */
function merge(THREE: PlantThree, parts: T.BufferGeometry[]): T.BufferGeometry {
  const flat = parts.map(p => p.index ? p.toNonIndexed() : p)
  const arrays = flat.map(p => p.getAttribute('position').array as Float32Array)
  const out = new Float32Array(arrays.reduce((n, a) => n + a.length, 0))
  let at = 0
  for (const a of arrays) {
    out.set(a, at)
    at += a.length
  }
  for (const p of [...parts, ...flat]) p.dispose()
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(out, 3))
  g.computeVertexNormals()
  return g
}

const leafMat = (kit: Kit, color: string, roughness?: number) => kit.material(color, { double: true, roughness })

/** `placeLeaf` in this file's convention (see the header). */
function leaf(kit: Kit, geometry: T.BufferGeometry, material: T.Material, o: { around: number, tilt: number, length: number, height?: number, twist?: number }): T.Mesh {
  return placeLeaf(kit, geometry, material, { ...o, out: -o.tilt })
}

/** A frame turned `around` and leaned `tilt` out, for a stalk with a leaf on it. */
function pivot(kit: Kit, around: number, tilt: number, height = 0): T.Group {
  const p = new kit.THREE.Group()
  p.position.y = height
  p.rotation.order = 'YXZ'
  p.rotation.set(-tilt, around, 0)
  return p
}

/** A leaf stalk: radius `rx` across and `rz` front to back at the base, tapering up. */
function stalkMesh(kit: Kit, material: T.Material, length: number, rx: number, rz: number, taper = 0.7): T.Mesh {
  const m = new kit.THREE.Mesh(stem(kit, taper), material)
  m.scale.set(rx, length, rz)
  return m
}

const COTYLEDON: BladeShape = { width: 0.7, cup: 0.35, curl: -0.15, profile: 'round', rows: 4 }

/** Two seed leaves on a short stem, about 0.015 m tall. */
function sprout(kit: Kit, style: PlantStyle, rand: () => number, size = 0.009): T.Group {
  const g = new kit.THREE.Group()
  const mat = leafMat(kit, style.leaf)
  const h = 0.008 + rand() * 0.004
  const s = stalkMesh(kit, mat, h, 0.0011, 0.0011)
  s.userData.role = 'leaf'
  g.add(s)
  const geo = blade(kit, COTYLEDON)
  const around = rand() * Math.PI
  const length = size * (0.9 + rand() * 0.2)
  for (const k of [0, 1]) g.add(leaf(kit, geo, mat, { around: around + k * Math.PI, tilt: 1.15 + jitter(rand, 0.1), length, height: h }))
  return g
}

interface RosetteSpec {
  count: [number, number, number]
  /** Young leaves at the heart, then old leaves round the outside. */
  inner: BladeShape
  outer: BladeShape
  length: [number, number]
  tilt: [number, number]
  /** Chance an outer leaf is the second colour; inner leaves keep the first. */
  dark: number
}

const ROSETTES: Record<'loose' | 'frilly' | 'romaine' | 'endive', RosetteSpec> = {
  loose: {
    count: [4, 8, 11],
    inner: { width: 0.85, cup: 0.5, curl: -0.3, profile: 'round' },
    outer: { width: 0.95, cup: 0.25, curl: 0.1, ruffle: 0.25, waves: 5, profile: 'round' },
    length: [0.024, 0.04],
    tilt: [0.35, 1.2],
    dark: 0.35,
  },
  frilly: {
    count: [5, 10, 15],
    inner: { width: 0.6, cup: 0.3, curl: -0.1, ruffle: 0.8, waves: 9, rows: 8 },
    outer: { width: 0.65, cup: 0.15, curl: 0.2, ruffle: 1, waves: 11, rows: 8 },
    length: [0.03, 0.042],
    tilt: [0.3, 1.05],
    dark: 0.45,
  },
  romaine: {
    count: [4, 7, 10],
    inner: { width: 0.42, cup: 0.6, curl: -0.15 },
    outer: { width: 0.44, cup: 0.35, curl: 0.15, ruffle: 0.15, waves: 6 },
    length: [0.08, 0.096],
    tilt: [0.08, 0.27],
    dark: 0.4,
  },
  endive: {
    count: [6, 13, 20],
    inner: { width: 0.3, cup: 0.2, curl: -0.1, ruffle: 1.4, waves: 15, rows: 8, profile: 'lance' },
    outer: { width: 0.34, curl: 0.3, ruffle: 1.6, waves: 17, rows: 8, profile: 'lance' },
    length: [0.03, 0.042],
    tilt: [0.5, 1.2],
    dark: 0.5,
  },
}

/** Adds `n` leaves spiralling out from the heart, inner ones small and upright, outer ones big and flat. */
function spiral(kit: Kit, g: T.Group, spec: RosetteSpec, n: number, scale: number, style: PlantStyle, rand: () => number, from = 0) {
  const inner = blade(kit, spec.inner)
  const outer = blade(kit, spec.outer)
  const turn = rand() * Math.PI * 2
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? lerp(from, 1, i / (n - 1)) : 1
    const color = t > 0.4 && rand() < spec.dark ? style.leafDark : style.leaf
    g.add(leaf(kit, t < 0.5 ? inner : outer, leafMat(kit, color), {
      around: turn + i * GOLDEN + jitter(rand, 0.25),
      tilt: lerp(spec.tilt[0], spec.tilt[1], t) + jitter(rand, 0.08),
      length: scale * lerp(spec.length[0], spec.length[1], t) * (0.92 + rand() * 0.16),
      height: (1 - t) * 0.004 * scale,
      twist: jitter(rand, 0.15),
    }))
  }
}

/** Lettuces. Variants: loose-leaf (default), 'frilly', 'romaine', 'head', 'endive'. */
const rosette: PlantBuilder = (kit, stage, style, rand) => {
  if (stage === 'sprout') return sprout(kit, style, rand)
  const g = new kit.THREE.Group()
  const s = GROW[stage]
  const v = style.variant
  if (v === 'head' && stage !== 'young') {
    // A tight ball of wrapped leaves, a few hugging it, and loose wrappers round it.
    const r = 0.021 * s
    const heart = new kit.THREE.Mesh(ball(kit, 1), leafMat(kit, style.leaf))
    heart.userData.role = 'leaf'
    heart.scale.set(r, r * 0.88, r)
    heart.position.y = r * 0.8
    heart.rotation.y = rand() * Math.PI
    g.add(heart)
    const hug = blade(kit, { width: 1, cup: 0.9, curl: -0.6, profile: 'round' })
    const turn = rand() * Math.PI * 2
    for (let i = 0; i < 4; i++) {
      g.add(leaf(kit, hug, leafMat(kit, style.leaf), {
        around: turn + i * Math.PI / 2 + jitter(rand, 0.2), tilt: 0.55 + jitter(rand, 0.08), length: r * 1.9, height: r * 0.1,
      }))
    }
    spiral(kit, g, { ...ROSETTES.loose, tilt: [1.05, 1.35], length: [0.033, 0.037], dark: 0.6 }, STAGE_INDEX[stage] === 2 ? 8 : 6, s, style, rand, 0.5)
    return g
  }
  const spec = ROSETTES[v === 'frilly' || v === 'romaine' || v === 'endive' ? v : 'loose']
  spiral(kit, g, spec, spec.count[STAGE_INDEX[stage]], s, style, rand)
  return g
}

interface UprightSpec {
  count: [number, number, number]
  length: [number, number]
  tilt: [number, number]
  dark: number
  roughness?: number
}

const UPRIGHTS: Record<'smooth' | 'curly' | 'lacinato', UprightSpec & { shape: BladeShape }> = {
  smooth: { count: [4, 7, 9], shape: { width: 0.55, stalk: 0.35, cup: 0.3, curl: 0.25 }, length: [0.052, 0.062], tilt: [0.2, 0.55], dark: 0.3 },
  curly: { count: [4, 6, 8], shape: { width: 0.6, stalk: 0.3, cup: 0.6, curl: 0.3, ruffle: 1, waves: 10, rows: 8 }, length: [0.05, 0.06], tilt: [0.15, 0.5], dark: 0.4 },
  lacinato: { count: [4, 6, 8], shape: { width: 0.3, stalk: 0.15, cup: 0.25, curl: 0.3, ruffle: 0.35, waves: 14, rows: 8, profile: 'lance' }, length: [0.072, 0.084], tilt: [0.08, 0.34], dark: 0.6 },
}

/** Curly kale: a ruffled blade with two more ruffled lobes heaped on it. */
function kaleLeaf(kit: Kit): T.BufferGeometry {
  return kit.geometry('leafy:kale', () => {
    const { THREE } = kit
    const main = bladeGeometry(THREE, UPRIGHTS.curly.shape)
    const lobes = [-1, 1].map((side) => {
      const lobe = bladeGeometry(THREE, { width: 0.5, cup: 0.6, curl: 0.2, ruffle: 1, waves: 9 })
      lobe.scale(0.55, 0.55, 0.55)
      lobe.rotateZ(side * 0.55)
      lobe.translate(0, 0.42, 0.02)
      return lobe
    })
    return merge(THREE, [main, ...lobes])
  })
}

/** Leaves on stalks rising from the centre: a stalked leaf turned `around`, leaned `tilt`. */
function stalked(kit: Kit, o: { around: number, tilt: number, stalk: number, rx: number, rz: number, stalkMat: T.Material, bladeGeo: T.BufferGeometry, bladeMat: T.Material, blade: number, rib?: number, taper?: number }): T.Group {
  const p = pivot(kit, o.around, o.tilt)
  // The stalk runs on up the blade as its midrib, so chard and bok choy show their coloured ribs.
  p.add(stalkMesh(kit, o.stalkMat, o.stalk + (o.rib ?? 0) * o.blade, o.rx, o.rz, o.taper))
  const b = new kit.THREE.Mesh(o.bladeGeo, o.bladeMat)
  b.userData.role = 'leaf'
  b.scale.setScalar(o.blade)
  b.position.y = o.stalk
  p.add(b)
  return p
}

/** Greens on stalks. Variants: smooth spinach/sorrel/mustard (default), 'curly', 'lacinato', 'chard', 'celery'. */
const upright: PlantBuilder = (kit, stage, style, rand) => {
  if (stage === 'sprout') return sprout(kit, style, rand)
  const g = new kit.THREE.Group()
  const s = GROW[stage]
  const k = STAGE_INDEX[stage]
  const turn = rand() * Math.PI * 2
  const v = style.variant
  if (v === 'chard') {
    const n = [4, 6, 8][k]
    const geo = blade(kit, { width: 0.62, cup: 0.25, ruffle: 0.2, waves: 7 })
    const stalkMat = kit.material(style.accent ?? '#e8e4c8', { roughness: 0.45, double: true })
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 1
      g.add(stalked(kit, {
        around: turn + i * GOLDEN + jitter(rand, 0.2),
        tilt: lerp(0.1, 0.5, t) + jitter(rand, 0.08),
        stalk: s * lerp(0.03, 0.034, t) * (0.9 + rand() * 0.2),
        rx: 0.0022 * s,
        rz: 0.0016 * s,
        rib: 0.6,
        taper: 0.35,
        stalkMat,
        bladeGeo: geo,
        bladeMat: leafMat(kit, t > 0.4 && rand() < 0.3 ? style.leafDark : style.leaf, 0.45),
        blade: s * lerp(0.042, 0.05, t) * (0.92 + rand() * 0.16),
      }))
    }
    return g
  }
  if (v === 'celery') {
    const n = [4, 6, 8][k]
    const tuft = blade(kit, { width: 0.75, cup: 0.15, curl: 0.2, ruffle: 0.6, waves: 5, rows: 4 })
    const stalkMat = kit.material(style.accent ?? '#c7dc9e', { roughness: 0.6, double: true })
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 1
      const length = s * lerp(0.07, 0.085, t) * (0.92 + rand() * 0.16)
      const p = pivot(kit, turn + i * GOLDEN + jitter(rand, 0.2), lerp(0.06, 0.28, t) + jitter(rand, 0.05))
      p.add(stalkMesh(kit, stalkMat, length, 0.0028 * s + 0.0006, 0.0022 * s + 0.0005, 0.75))
      const spin = rand() * Math.PI * 2
      for (let j = 0; j < 3; j++) {
        p.add(leaf(kit, tuft, leafMat(kit, j === 0 || rand() < 0.7 ? style.leaf : style.leafDark), {
          around: spin + j * 2.1, tilt: 0.75 + jitter(rand, 0.15), length: (0.012 + 0.008 * s) * (0.9 + rand() * 0.2), height: length * 0.97,
        }))
      }
      g.add(p)
    }
    return g
  }
  const spec = UPRIGHTS[v === 'curly' || v === 'lacinato' ? v : 'smooth']
  const geo = v === 'curly' ? kaleLeaf(kit) : blade(kit, spec.shape)
  const n = spec.count[k]
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 1
    g.add(leaf(kit, geo, leafMat(kit, t > 0.3 && rand() < spec.dark ? style.leafDark : style.leaf), {
      around: turn + i * GOLDEN + jitter(rand, 0.25),
      tilt: lerp(spec.tilt[0], spec.tilt[1], t) + jitter(rand, 0.08),
      length: s * lerp(spec.length[0], spec.length[1], t) * (0.92 + rand() * 0.16),
      twist: jitter(rand, 0.12),
    }))
  }
  return g
}

/** Bok choy and its kin: spoon leaves on thick pale stalks in a vase. Variant 'tatsoi': a flat rosette of small round spoons. */
const bokchoy: PlantBuilder = (kit, stage, style, rand) => {
  if (stage === 'sprout') return sprout(kit, style, rand)
  const g = new kit.THREE.Group()
  const s = GROW[stage]
  const k = STAGE_INDEX[stage]
  const turn = rand() * Math.PI * 2
  const stalkMat = kit.material(style.accent ?? '#e4efd6', { roughness: 0.55, double: true })
  const tatsoi = style.variant === 'tatsoi'
  const n = tatsoi ? [5, 9, 13][k] : [4, 6, 8][k]
  const geo = tatsoi
    ? blade(kit, { width: 0.95, cup: 0.4, curl: -0.15, profile: 'round' })
    : blade(kit, { width: 0.72, cup: 0.45, curl: 0.15, profile: 'spoon' })
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 1
    const dark = t > 0.4 && rand() < 0.35
    g.add(stalked(kit, tatsoi
      ? {
          around: turn + i * GOLDEN + jitter(rand, 0.2),
          tilt: lerp(0.6, 1.35, t) + jitter(rand, 0.08),
          stalk: s * 0.016 * (0.9 + rand() * 0.2),
          rx: 0.0014 * s + 0.0003,
          rz: 0.001 * s + 0.0003,
          rib: 0.3,
          stalkMat,
          bladeGeo: geo,
          bladeMat: leafMat(kit, dark ? style.leafDark : style.leaf, 0.5),
          blade: s * lerp(0.018, 0.024, t) * (0.9 + rand() * 0.2),
        }
      : {
          around: turn + i * GOLDEN + jitter(rand, 0.2),
          tilt: lerp(0.1, 0.42, t) + jitter(rand, 0.05),
          stalk: s * lerp(0.032, 0.036, t) * (0.92 + rand() * 0.16),
          rx: 0.0048 * s + 0.0006,
          rz: 0.0022 * s + 0.0004,
          rib: 0.5,
          taper: 0.55,
          stalkMat,
          bladeGeo: geo,
          bladeMat: leafMat(kit, dark ? style.leafDark : style.leaf, 0.6),
          blade: s * lerp(0.044, 0.05, t) * (0.92 + rand() * 0.16),
        }))
  }
  return g
}

/** A cached clump of fine grass blades, unit height, laid out by its own fixed seed so every plant shares it. */
function grassClump(kit: Kit, variant: number): T.BufferGeometry {
  return kit.geometry(`leafy:grass:${variant}`, () => {
    const r = seeded(9173 + variant * 101)
    const pos: number[] = []
    for (let b = 0; b < 30; b++) {
      const a = r() * Math.PI * 2
      const base = Math.sqrt(r()) * 0.1
      const len = 0.7 + r() * 0.3
      const tilt = r() * 0.3
      const droop = 0.05 + r() * 0.2
      const w = 0.018 + r() * 0.008
      const ox = Math.cos(a)
      const oz = Math.sin(a)
      // A point `f` of the way up the blade, `side` across it; the blade faces outward.
      const at = (f: number, side: number) => {
        const out = base + len * f * Math.sin(tilt) + droop * len * f * f * 0.4
        const y = len * f * Math.cos(tilt) - droop * len * f * f * 0.3
        const half = w * (1 - f * 0.6) * side
        return [ox * out - oz * half, y, oz * out + ox * half]
      }
      const [l0, r0, l1, r1, tip] = [at(0, -1), at(0, 1), at(0.5, -1), at(0.5, 1), at(1, 0)]
      pos.push(...l0, ...r0, ...r1, ...l0, ...r1, ...l1, ...l1, ...r1, ...tip)
    }
    const g = new kit.THREE.BufferGeometry()
    g.setAttribute('position', new kit.THREE.Float32BufferAttribute(pos, 3))
    g.computeVertexNormals()
    return g
  })
}

/** Chives (default, purple flower heads at full when `accent` is set), 'onion', and wheatgrass 'grass'. */
const strap: PlantBuilder = (kit, stage, style, rand) => {
  const g = new kit.THREE.Group()
  const v = style.variant
  if (stage === 'sprout') {
    // Monocots come up as a thin loop rather than two round seed leaves: two fine blades.
    const geo = strapLeaf(kit, 0.15)
    const mat = leafMat(kit, style.leaf)
    const around = rand() * Math.PI
    for (const k of [0, 1]) {
      const m = leaf(kit, geo, mat, { around: around + k * Math.PI, tilt: 0.25 + jitter(rand, 0.1), length: 0.016 + rand() * 0.004 })
      m.scale.x *= 0.5
      m.scale.z *= 0.5
      g.add(m)
    }
    return g
  }
  const s = GROW[stage]
  const k = STAGE_INDEX[stage]
  const turn = rand() * Math.PI * 2
  if (v === 'grass') {
    const n = [2, 3, 4][k]
    for (let i = 0; i < n; i++) {
      const m = new kit.THREE.Mesh(grassClump(kit, i % 3), leafMat(kit, i === 1 ? style.leafDark : style.leaf))
      m.userData.role = 'leaf'
      m.scale.setScalar(s * 0.085 * (0.9 + rand() * 0.12))
      m.rotation.y = turn + i * 2.1
      const a = turn + i * GOLDEN
      m.position.set(Math.cos(a) * 0.004 * s, 0, Math.sin(a) * 0.004 * s)
      g.add(m)
    }
    return g
  }
  const onion = v === 'onion'
  const n = onion ? [3, 5, 7][k] : [5, 10, 15][k]
  const thick = onion ? 1.1 : 0.45
  const length = onion ? [0.078, 0.091] : [0.07, 0.086]
  const geo = strapLeaf(kit, 0.2)
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 1
    const a = turn + i * GOLDEN
    const m = leaf(kit, geo, leafMat(kit, rand() < 0.3 ? style.leafDark : style.leaf), {
      around: a + jitter(rand, 0.2),
      tilt: lerp(0.05, onion ? 0.35 : 0.5, t) + jitter(rand, 0.06),
      length: s * lerp(length[1], length[0], t) * (0.92 + rand() * 0.1),
    })
    m.scale.x *= thick
    m.scale.z *= thick
    m.position.set(Math.cos(a) * 0.003 * s, 0, Math.sin(a) * 0.003 * s)
    g.add(m)
  }
  if (onion) {
    const shank = stalkMesh(kit, kit.material(style.accent ?? '#e9efdc', { double: true }), 0.014 * s, 0.006 * s, 0.006 * s, 0.85)
    g.add(shank)
  }
  if (!onion && stage === 'full' && style.accent) {
    const head = ball(kit, 1)
    for (let i = 0; i < 3; i++) {
      const p = pivot(kit, turn + i * 2.1 + jitter(rand, 0.3), 0.12 + rand() * 0.15)
      const h = 0.084 + rand() * 0.006
      const st = stalkMesh(kit, leafMat(kit, style.leaf), h, 0.0011, 0.0011, 0.8)
      st.userData.role = 'leaf'
      const f = new kit.THREE.Mesh(head, kit.material(style.accent, { roughness: 0.9 }))
      f.userData.role = 'flower'
      f.scale.setScalar(0.0055)
      f.position.y = h
      p.add(st, f)
      g.add(p)
    }
  }
  return g
}

/** Watercress leaf: a short stem with pairs of round leaflets and a larger one at the tip. */
function sprig(kit: Kit): T.BufferGeometry {
  return kit.geometry('leafy:sprig', () => {
    const { THREE } = kit
    const parts = [bladeGeometry(THREE, { width: 0.06, rows: 2, cols: 3, profile: 'lance' })]
    const leaflet = (length: number, y: number, angle: number) => {
      const p = bladeGeometry(THREE, { width: 0.85, cup: 0.4, profile: 'round', rows: 4, cols: 3 })
      p.scale(length, length, length)
      p.rotateZ(angle)
      p.translate(0, y, 0)
      parts.push(p)
    }
    for (const y of [0.3, 0.52]) {
      leaflet(0.3, y, 1.05)
      leaflet(0.3, y, -1.05)
    }
    leaflet(0.42, 0.62, 0)
    const g = merge(THREE, parts)
    // Ascend at the tip, as watercress does.
    const p = g.getAttribute('position') as T.BufferAttribute
    for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) + 0.25 * p.getY(i) ** 2)
    g.computeVertexNormals()
    return g
  })
}

/** Watercress: round leaflets on short sprawling stems, a low mound. */
const cress: PlantBuilder = (kit, stage, style, rand) => {
  if (stage === 'sprout') return sprout(kit, style, rand, 0.008)
  const g = new kit.THREE.Group()
  const s = GROW[stage]
  const n = [4, 8, 12][STAGE_INDEX[stage]]
  const geo = sprig(kit)
  const turn = rand() * Math.PI * 2
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 1
    g.add(leaf(kit, geo, leafMat(kit, rand() < 0.35 ? style.leafDark : style.leaf, 0.6), {
      around: turn + i * GOLDEN + jitter(rand, 0.25),
      tilt: lerp(0.45, 1.15, t) + jitter(rand, 0.1),
      length: s * lerp(0.034, 0.042, t) * (0.9 + rand() * 0.2),
      height: (1 - t) * 0.006 * s,
      twist: jitter(rand, 0.2),
    }))
  }
  return g
}

/** Builders for leafy greens, by archetype. */
export const LEAFY_BUILDERS: Record<'rosette' | 'upright' | 'bokchoy' | 'strap' | 'cress', PlantBuilder> = {
  rosette,
  upright,
  bokchoy,
  strap,
  cress,
}
