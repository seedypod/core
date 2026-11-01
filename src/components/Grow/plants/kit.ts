/**
 * The contract every plant model is built against: a kit of shared
 * geometries and materials, a growth stage, a style from the catalog, and a
 * seeded random so each pod's plant varies but never changes between renders.
 * Models are procedural (no downloaded meshes), so the whole catalog costs a
 * few kilobytes of code and loads with the tower on a Pi.
 */
import type * as T from 'three'

export type Three = typeof T

/**
 * The three.js classes plant models build with, read off the namespace by
 * name: holding the whole namespace in the kit would stop the bundler dropping
 * the parts of three.js nothing uses. Add a name here to use a new class.
 */
export type PlantThree = Pick<Three, 'Box3' | 'BufferAttribute' | 'BufferGeometry' | 'CatmullRomCurve3' | 'Color' | 'ConeGeometry' | 'CylinderGeometry' | 'DoubleSide' | 'Euler' | 'Float32BufferAttribute' | 'FrontSide' | 'Group' | 'IcosahedronGeometry' | 'LatheGeometry' | 'Matrix4' | 'Mesh' | 'MeshStandardMaterial' | 'OctahedronGeometry' | 'PlaneGeometry' | 'Quaternion' | 'Shape' | 'ShapeGeometry' | 'TubeGeometry' | 'Vector2' | 'Vector3'>

/** Growth stages, as the tower maps them from status, age and measured green (towerLayout's PlantForm). */
export type Stage = 'sprout' | 'young' | 'bush' | 'full'
export const STAGES: Stage[] = ['sprout', 'young', 'bush', 'full']

export interface PlantStyle {
  /** Main leaf colour. */
  leaf: string
  /** Second leaf colour: undersides, older leaves, veins, a variegated mix. */
  leafDark: string
  /** Fruit, flower or stem colour, where the archetype has one. */
  accent?: string
  /** A second accent: a flower's centre, a fruit's ripening colour. */
  accent2?: string
  /** Archetype-specific variant, e.g. 'long' for banana peppers or 'round' for cherry tomatoes. */
  variant?: string
}

export interface Kit {
  THREE: PlantThree
  /** A geometry built once under `key` and shared by every plant; the kit disposes it. Key it by everything that shapes it. */
  geometry: <G extends T.BufferGeometry>(key: string, make: () => G) => G
  /** A flat-shaded standard material per colour and options, shared by every plant. */
  material: (color: string, o?: { roughness?: number, emissive?: string, emissiveIntensity?: number, double?: boolean }) => T.MeshStandardMaterial
  dispose: () => void
}

/**
 * Builds one plant at one stage. The group's origin is the top of the cup,
 * +y pointing out of it; a full leafy plant is about 0.06–0.09 m across, a
 * fruiting or flowering one up to 0.16 m tall (0.22 m for a sunflower).
 * Meshes that are leaves carry `userData.role = 'leaf'` so the tower can yellow
 * a sick plant; fruit and flowers carry 'fruit' and 'flower'.
 */
export type PlantBuilder = (kit: Kit, stage: Stage, style: PlantStyle, rand: () => number) => T.Group

/** What one plant costs to draw at its largest stage; tests hold every builder to it. */
export const BUDGET = { meshes: 48, triangles: 2400 }

export function createKit(THREE: Three): Kit {
  const geometries = new Map<string, T.BufferGeometry>()
  const materials = new Map<string, T.MeshStandardMaterial>()
  const picked: PlantThree = {
    Box3: THREE.Box3,
    BufferAttribute: THREE.BufferAttribute,
    BufferGeometry: THREE.BufferGeometry,
    CatmullRomCurve3: THREE.CatmullRomCurve3,
    Color: THREE.Color,
    ConeGeometry: THREE.ConeGeometry,
    CylinderGeometry: THREE.CylinderGeometry,
    DoubleSide: THREE.DoubleSide,
    Euler: THREE.Euler,
    Float32BufferAttribute: THREE.Float32BufferAttribute,
    FrontSide: THREE.FrontSide,
    Group: THREE.Group,
    IcosahedronGeometry: THREE.IcosahedronGeometry,
    LatheGeometry: THREE.LatheGeometry,
    Matrix4: THREE.Matrix4,
    Mesh: THREE.Mesh,
    MeshStandardMaterial: THREE.MeshStandardMaterial,
    OctahedronGeometry: THREE.OctahedronGeometry,
    PlaneGeometry: THREE.PlaneGeometry,
    Quaternion: THREE.Quaternion,
    Shape: THREE.Shape,
    ShapeGeometry: THREE.ShapeGeometry,
    TubeGeometry: THREE.TubeGeometry,
    Vector2: THREE.Vector2,
    Vector3: THREE.Vector3,
  }
  return {
    THREE: picked,
    geometry<G extends T.BufferGeometry>(key: string, make: () => G): G {
      let g = geometries.get(key)
      if (!g) {
        g = make()
        geometries.set(key, g)
      }
      return g as G
    },
    material(color, o = {}) {
      const key = `${color}|${o.roughness ?? 0.8}|${o.emissive ?? ''}|${o.emissiveIntensity ?? 0}|${o.double ? 2 : 1}`
      let m = materials.get(key)
      if (!m) {
        m = new THREE.MeshStandardMaterial({
          color,
          roughness: o.roughness ?? 0.8,
          metalness: 0,
          flatShading: true,
          side: o.double ? THREE.DoubleSide : THREE.FrontSide,
          ...(o.emissive ? { emissive: o.emissive, emissiveIntensity: o.emissiveIntensity ?? 0.2 } : {}),
        })
        materials.set(key, m)
      }
      return m
    },
    dispose() {
      for (const g of geometries.values()) g.dispose()
      for (const m of materials.values()) m.dispose()
      geometries.clear()
      materials.clear()
    },
  }
}

/** A small deterministic random (mulberry32), so a pod's plant looks the same on every load. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Mesh count, triangles and bounding size of a built plant, for budgets and tests. */
export function measure(THREE: Three, group: T.Object3D): { meshes: number, triangles: number, size: T.Vector3 } {
  let meshes = 0
  let triangles = 0
  group.updateMatrixWorld(true)
  group.traverse((o) => {
    const m = o as T.Mesh
    if (!m.isMesh) return
    meshes++
    const g = m.geometry
    triangles += (g.index ? g.index.count : g.attributes.position.count) / 3
  })
  return { meshes, triangles, size: new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3()) }
}
