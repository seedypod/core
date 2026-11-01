/**
 * Shared low-poly parts for plant models. Each is unit-sized and cached in the
 * kit, so a model places and scales instances rather than building geometry.
 */
import type * as T from 'three'
import type { Kit } from './kit'

/**
 * A leaf blade: unit length along +y from its base at the origin, `width` wide
 * (relative to length), bent back along its length by `curl` (0 flat, 1 a
 * strong arch) and cupped across by `cup`. Lies in the xy plane facing +z.
 */
export function leafBlade(kit: Kit, width = 0.45, curl = 0.3, cup = 0.15): T.BufferGeometry {
  const key = `leaf:${width.toFixed(2)}:${curl.toFixed(2)}:${cup.toFixed(2)}`
  return kit.geometry(key, () => {
    const { THREE } = kit
    const s = new THREE.Shape()
    const w = width / 2
    s.moveTo(0, 0)
    s.bezierCurveTo(w * 1.2, 0.2, w * 1.1, 0.7, 0, 1)
    s.bezierCurveTo(-w * 1.1, 0.7, -w * 1.2, 0.2, 0, 0)
    const g = new THREE.ShapeGeometry(s, 4)
    const p = g.attributes.position as T.BufferAttribute
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i)
      const y = p.getY(i)
      p.setZ(i, -curl * y * y * 0.6 + cup * (x * x) / Math.max(w * w, 1e-6) * 0.08)
    }
    g.computeVertexNormals()
    return g
  })
}

/** A strap leaf (grass, chive, onion): unit length, narrow, tapering to a point, arched by `curl`. */
export function strapLeaf(kit: Kit, curl = 0.25): T.BufferGeometry {
  return kit.geometry(`strap:${curl.toFixed(2)}`, () => {
    const { THREE } = kit
    const g = new THREE.ConeGeometry(0.06, 1, 4, 3, true)
    g.translate(0, 0.5, 0)
    const p = g.attributes.position as T.BufferAttribute
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i)
      p.setZ(i, p.getZ(i) - curl * y * y)
    }
    g.computeVertexNormals()
    return g
  })
}

/** A low-poly ball (detail 0 or 1): fruit, buds, flower centres, a head of cauliflower. */
export function ball(kit: Kit, detail: 0 | 1 = 1): T.BufferGeometry {
  return kit.geometry(`ball:${detail}`, () => new kit.THREE.IcosahedronGeometry(1, detail))
}

/** A stem: unit height from the origin up, radius 1 at the base tapering to `taper`. Scale x/z for thickness. */
export function stem(kit: Kit, taper = 0.6): T.BufferGeometry {
  return kit.geometry(`stem:${taper.toFixed(2)}`, () => {
    const g = new kit.THREE.CylinderGeometry(taper, 1, 1, 5, 1, true)
    g.translate(0, 0.5, 0)
    return g
  })
}

/** A cone pointing +y from its base at the origin: pepper and bean pods, flower spikes. */
export function cone(kit: Kit, segments = 6): T.BufferGeometry {
  return kit.geometry(`cone:${segments}`, () => {
    const g = new kit.THREE.ConeGeometry(1, 1, segments, 1)
    g.translate(0, 0.5, 0)
    return g
  })
}

/** A flat disc of `petals` rounded petals around the origin, facing +y: daisy-like flowers. */
export function petalRing(kit: Kit, petals = 8): T.BufferGeometry {
  return kit.geometry(`petals:${petals}`, () => {
    const { THREE } = kit
    const s = new THREE.Shape()
    for (let i = 0; i <= petals * 8; i++) {
      const a = (i / (petals * 8)) * Math.PI * 2
      const r = 0.55 + 0.45 * Math.abs(Math.cos((a * petals) / 2))
      const x = Math.cos(a) * r
      const y = Math.sin(a) * r
      if (i === 0) s.moveTo(x, y)
      else s.lineTo(x, y)
    }
    const g = new THREE.ShapeGeometry(s, 1)
    g.rotateX(-Math.PI / 2)
    return g
  })
}

/**
 * Places a leaf blade on a plant: at `height` up the stem, turned `around`
 * radians about +y, tipped out from vertical by `out` radians, `length` long.
 */
export function placeLeaf(kit: Kit, geometry: T.BufferGeometry, material: T.Material, o: { around: number, out: number, length: number, height?: number, twist?: number }): T.Mesh {
  const { THREE } = kit
  const pivot = new THREE.Mesh(geometry, material)
  pivot.userData.role = 'leaf'
  pivot.scale.setScalar(o.length)
  pivot.position.y = o.height ?? 0
  pivot.rotation.order = 'YXZ'
  pivot.rotation.set(o.out, o.around, o.twist ?? 0)
  return pivot
}
