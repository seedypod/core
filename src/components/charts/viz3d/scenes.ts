/**
 * The five 3D charts, each built on the shared base: Today's lanes, the tank
 * with its glass cylinder, the light's day, leaf cover per pod and the sensor
 * ridgeline. Each factory takes its card's canvas host and returns a Viz.
 */
import type * as THREE from 'three'
import { createBase, floorGrid, inkMix, ribbon, type Base, type BaseSpec, type Env, type Frame, type Ink, type Label, type Viz } from './base'
import { clamp01, lerp, pointEase, pulse } from './motion'
import { type LightData, type PodsData, type SensorsData, type Tick, type TankData, type TodayData, type Tone } from './shape'

/** Tick labels along x: the first starts at its tick, the last ends at its, the rest centre on theirs, so none hangs past the ends. */
function axis(base: Base, o: { x0: number, width: number, y: number, z: number, size?: number }) {
  let labels: Label[] = []
  return {
    /** Recolours one tick's label, e.g. "now" while the pump runs. */
    ink(i: number, ink: Ink) {
      labels[i]?.setInk(ink)
    },
    set(ticks: Tick[]) {
      for (const l of labels) l.setVisible(false)
      labels = ticks.map((t, i) => {
        const l = labels[i] ?? base.label(t.label, { ink: 'fg3', size: o.size ?? 0.2, align: i === 0 ? 'left' : i === ticks.length - 1 ? 'right' : 'center', valign: 'top', priority: 3 })
        l.setText(t.label)
        // A day named twice in a row (a week's ticks fall mid-day) says it once.
        l.setVisible(t.label !== ticks[i - 1]?.label)
        l.sprite.center.x = t.at <= 0.001 ? 0 : t.at >= 0.999 ? 1 : 0.5
        l.sprite.position.set(o.x0 + t.at * o.width, o.y, o.z)
        base.root.add(l.sprite)
        return l
      })
      base.invalidate()
    },
  }
}

/** The common Viz plumbing: data stored, then shown. */
function viz<D>(base: Base, apply: (data: D) => void): Viz<D> {
  return {
    setState: base.setState,
    setData(data: D) {
      apply(data)
      base.dataArrived()
    },
    dispose: base.dispose,
  }
}

const TONE_INK: Record<Tone, Ink> = { cream: 'cream', amber: 'amber', blue: 'blue', green: 'green', orange: 'orange', muted: 'fg3' }

// ── Today ────────────────────────────────────────────────────────────────

export const TODAY_SPEC: BaseSpec = { need: 14, camera: { position: [0, 4.6, 9.6], target: [0, 0.2, -0.75] }, bounds: [[-6, -0.35, -2.75], [6, 1.5, 1.6]] }

/** Light, Water and Air stacked in depth with their labels, the day's events on a fourth lane, and a translucent "now" plane. */
export function createTodayViz(container: HTMLElement, env?: Env): Viz<TodayData> {
  const W = 12
  const x0 = -W / 2
  const LANE_Z = [-2.4, -1.2, 0]
  const EVENTS_Z = 1.15
  const H = 0.9
  let data: TodayData | null = null
  const ribbons: ReturnType<typeof ribbon>[] = []
  const laneLabels: Label[] = []
  const markers: Array<{ mesh: THREE.Mesh, label: Label }> = []
  const base = createBase(container, TODAY_SPEC, draw, env)
  const T = base.THREE

  floorGrid(base, { x0, x1: x0 + W, z0: LANE_Z[0] as number - 0.35, z1: EVENTS_Z + 0.35, xs: [0, 0.25, 0.5, 0.75, 1].map(a => x0 + a * W), zs: [...LANE_Z, EVENTS_Z] })
  ;['Light', 'Water', 'Air'].forEach((name, i) => {
    const z = LANE_Z[i] as number
    ribbons.push(ribbon(base, { x0, width: W, z, height: H, ink: (['amber', 'blue', 'cream'] as const)[i] as Ink, n: 97 }))
    const l = base.label(name, { ink: 'fg2', size: 0.2, align: 'left', valign: 'bottom', priority: 2 })
    l.sprite.position.set(x0, H + 0.08, z)
    base.root.add(l.sprite)
    laneLabels.push(l)
  })
  const eventsLabel = base.label('Events', { ink: 'fg2', size: 0.2, align: 'left', valign: 'bottom', priority: 2 })
  eventsLabel.sprite.position.set(x0, 0.34, EVENTS_Z)
  base.root.add(eventsLabel.sprite)
  const ticks = axis(base, { x0, width: W, y: -0.05, z: EVENTS_Z + 0.45, size: 0.19 })
  ticks.set([0, 6, 12, 18, 24].map(h => ({ at: h / 24, label: `${String(h).padStart(2, '0')}:00` })))

  // The now plane stands across every lane; hidden until there's a now to stand at.
  const depth = EVENTS_Z - (LANE_Z[0] as number) + 0.7
  const nowPlane = base.plane(depth, H + 0.25, 'fg1', 0.07)
  nowPlane.rotation.y = Math.PI / 2
  const nowEdge = base.line([[0, 0, 0], [0, 0, depth]], 'fg2', 0.6)
  const nowLabel = base.label('now', { ink: 'fg1', size: 0.2, align: 'center', valign: 'bottom', priority: 4 })
  base.root.add(nowLabel.sprite)

  function marker() {
    const mesh = new T.Mesh(new T.OctahedronGeometry(0.1), new T.MeshBasicMaterial({ transparent: true }))
    base.root.add(mesh)
    const label = base.label('', { ink: 'fg2', size: 0.16, align: 'center', valign: 'bottom' })
    base.root.add(label.sprite)
    return { mesh, label }
  }

  const c = new T.Color()
  function draw(f: Frame): boolean {
    ribbons.forEach(r => r.update(f))
    const shown = f.state === 'ready' && data !== null
    const appear = shown ? clamp01(f.p * 1.5) : 0
    const nowX = x0 + (data?.now ?? 0) * W
    nowPlane.visible = shown
    nowEdge.visible = shown
    nowLabel.setVisible(shown)
    if (shown) {
      ;(nowPlane.material as THREE.MeshBasicMaterial).opacity = 0.07 * appear
      nowPlane.position.set(nowX, (H + 0.25) / 2, ((LANE_Z[0] as number) - 0.35 + EVENTS_Z + 0.35) / 2)
      nowEdge.position.set(nowX, H + 0.25, (LANE_Z[0] as number) - 0.35)
      nowLabel.sprite.position.set(nowX, H + 0.3, (LANE_Z[0] as number) - 0.35)
    }
    const events = data?.events ?? []
    while (markers.length < events.length) markers.push(marker())
    // Event labels give way to the lanes' names and to each other where they crowd (the base declutters).
    markers.forEach((m, i) => {
      const e = events[i]
      const on = shown && e !== undefined
      m.mesh.visible = on
      m.label.setVisible(on)
      if (!on || !e) return
      const k = pointEase(f.p, e.at * 96, 96)
      const x = x0 + e.at * W
      m.mesh.position.set(x, 0.13, EVENTS_Z)
      m.mesh.scale.setScalar(Math.max(0.001, k))
      const mat = m.mesh.material as THREE.MeshBasicMaterial
      mat.color.copy(inkMix(base, TONE_INK[e.tone], k, c))
      mat.opacity = e.label ? 1 : 0.55
      m.label.setText(e.label)
      m.label.sprite.position.set(x, 0.3, EVENTS_Z)
    })
    return false
  }

  return viz(base, (d: TodayData) => {
    data = d
    d.lanes.forEach((lane, i) => {
      ribbons[i]?.setValues(lane.values, { dimFrom: lane.dimFrom, ink: TONE_INK[lane.tone] })
      laneLabels[i]?.setText(`${lane.label} · ${lane.sub}`)
    })
    ticks.set(d.ticks)
  })
}

// ── Tank ─────────────────────────────────────────────────────────────────

export const TANK_SPEC: BaseSpec = { need: 11.4, camera: { position: [0.05, 4.1, 11.6], target: [0.05, 0.95, 0] }, bounds: [[-5.2, -0.4, -0.75], [4, 2.85, 0.75]] }
/** Below this card width the tank's scale drops the depths from its words. */
const NARROW_PX = 560

/**
 * The tank's level over the window and the glass of water now on one
 * vertical scale: the line (with a soft fill and its top-ups) runs into a
 * cylinder filled to the level now. One dashed cutoff line crosses both and
 * rings the glass; ticks down the glass's right side read full, now, cutoff
 * and empty. While the pump runs, the water this run drew down is a blue
 * tail into the glass, the last x label turns blue, and bubbles rise.
 */
export function createTankViz(container: HTMLElement, env?: Env): Viz<TankData> {
  const x0 = -5.2
  const W = 6.6
  const H = 2.6
  const CX = 2.9
  const R = 0.75
  const LOW = 0.12
  let data: TankData | null = null
  const base = createBase(container, TANK_SPEC, draw, env)
  const T = base.THREE
  const level = ribbon(base, { x0, width: W, z: 0, height: H, ink: 'cream', n: 120, fill: 0.2 })
  floorGrid(base, { x0, x1: x0 + W, z0: -0.6, z1: 0.6, xs: [0, 0.2, 0.4, 0.6, 0.8, 1].map(a => x0 + a * W), zs: [0] })
  base.segments([[[x0, H / 2, -0.02], [x0 + W, H / 2, -0.02]], [[x0, H, -0.02], [x0 + W, H, -0.02]]], 'grid')
  const ticks = axis(base, { x0, width: W, y: -0.05, z: 0.7, size: 0.19 })
  let tickLabels: Tick[] = []

  // The glass: a faint shell with its rim and base; the water inside it; the cutoff ring round it.
  const glass = new T.Mesh(new T.CylinderGeometry(R, R, H, 48, 1, true), base.tint(new T.MeshBasicMaterial({ transparent: true, opacity: 0.06, side: T.DoubleSide, depthWrite: false }), 'fg1'))
  glass.position.set(CX, H / 2, 0)
  base.root.add(glass)
  base.ring(R, [CX, H, 0], 'fg3', 0.7)
  base.ring(R, [CX, 0, 0], 'fg3', 0.7)
  const water = new T.Mesh(new T.CylinderGeometry(R * 0.94, R * 0.94, 1, 48), new T.MeshBasicMaterial({ transparent: true, opacity: 0.5, depthWrite: false }))
  base.root.add(water)
  const surface = base.ring(R * 0.94, [0, 0, 0], 'tank', 0.9)
  const cutRing = base.ring(R * 1.08, [0, 0, 0], 'amber', 0.95)
  // One dashed cutoff line, across the history and through the glass.
  const cutLine = base.dashed([[x0, 0, 0.01], [CX + R + 0.16, 0, 0.01]], 'amber', 0.14, 0.1, 0.8)
  // Where the line meets the glass: level with the end of the history, or, while pumping, the run's draw-down into the level now.
  const linkGeo = new T.BufferGeometry().setFromPoints([new T.Vector3(x0 + W, 0, 0), new T.Vector3(CX - R, 0, 0)])
  const link = new T.Line(linkGeo, new T.LineBasicMaterial({ transparent: true }))
  base.root.add(link)

  // The glass's scale, down its right side: a tick and a label each.
  const MARKS = ['full', 'now', 'cutoff', 'empty'] as const
  const SAMPLE = { full: 'full · 2.0 in', now: 'now · 5.1 in', cutoff: 'cutoff 27% · 6.3 in', empty: 'empty · 7.9 in' }
  const marks = Object.fromEntries(MARKS.map((k) => {
    const tick: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial> = base.line([[CX + R + 0.02, 0, 0], [CX + R + 0.16, 0, 0]], k === 'cutoff' ? 'amber' : k === 'now' ? 'fg1' : 'fg3', 0.9)
    // Placeholder text until data, so the fit makes room for the words from the start.
    const l = base.label(SAMPLE[k], { ink: k === 'cutoff' ? 'amber' : k === 'now' ? 'fg1' : 'fg3', size: 0.17, align: 'left', valign: 'middle', priority: k === 'now' ? 4 : k === 'cutoff' ? 3 : 2, fit: true })
    base.root.add(l.sprite)
    return [k, { tick, label: l }]
  })) as Record<typeof MARKS[number], { tick: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>, label: Label }>

  const dots = Array.from({ length: 16 }, () => {
    const d = base.dot(0.07, 'green')
    d.visible = false
    return d
  })
  // While the pump runs, a few bubbles rise through the water and its surface rocks: a cue, cheap to draw.
  const bubbles = Array.from({ length: 7 }, (_, i) => {
    const b = base.dot(0.045, 'fg1', 0.7)
    b.visible = false
    return { mesh: b, a: (i / 7) * Math.PI * 2, r: R * (0.25 + 0.5 * ((i * 37) % 7) / 7), speed: 0.45 + ((i * 53) % 7) / 14 }
  })

  const c = new T.Color()
  function mark(k: typeof MARKS[number], y: number | null, text: string | null) {
    const m = marks[k]
    const on = y !== null && text !== null
    m.tick.visible = on
    m.label.setVisible(on)
    if (!on) return
    m.tick.position.set(0, y, 0)
    m.label.setText(text)
    m.label.sprite.position.set(CX + R + 0.22, y, 0)
  }

  function draw(f: Frame): boolean {
    level.update(f)
    const shown = f.state === 'ready' && data !== null
    // The glass fills last, as the line reaches it.
    const e = shown ? pointEase(f.p, 119, 120) : 0
    const cur = data?.current ?? LOW
    const h = Math.max(0.02, lerp(LOW, shown ? cur : LOW, e) * H)
    water.scale.set(1, h, 1)
    water.position.set(CX, h / 2, 0)
    ;(water.material as THREE.MeshBasicMaterial).color.copy(inkMix(base, 'tank', f.state === 'error' ? 0 : e, c))
    ;(water.material as THREE.MeshBasicMaterial).opacity = f.state === 'error' ? 0.25 : 0.5
    const pumping = shown && !!data?.pumping
    const rock = pumping && !f.reduced ? 0.025 * Math.sin(f.t * 5) : 0
    surface.position.set(CX, h + rock, 0)
    surface.rotation.z = rock * 0.6
    surface.visible = shown
    for (const b of bubbles) {
      b.mesh.visible = pumping && h > 0.15
      if (!b.mesh.visible) continue
      const rise = f.reduced ? 0.5 : (f.t * b.speed + b.a) % 1
      b.mesh.position.set(CX + Math.cos(b.a + f.t * 0.3) * b.r, 0.05 + rise * (h - 0.1), Math.sin(b.a + f.t * 0.3) * b.r)
    }
    const cut = shown && data?.cutoff != null ? data.cutoff * H : null
    cutRing.visible = cut !== null
    cutLine.visible = cut !== null
    if (cut !== null) {
      cutRing.position.set(CX, cut, 0)
      cutLine.position.set(0, cut, 0)
    }
    link.visible = shown && data?.current != null
    if (link.visible) {
      const pos = linkGeo.getAttribute('position') as THREE.BufferAttribute
      pos.setXYZ(0, x0 + W, pumping ? level.yAt(1) : h, 0)
      pos.setXYZ(1, CX - R, h, 0)
      pos.needsUpdate = true
      linkGeo.computeBoundingSphere()
      const mat = link.material as THREE.LineBasicMaterial
      mat.color.copy(base.inks()[pumping ? 'blue' : 'fg3'])
      mat.opacity = pumping ? 1 : 0.6
    }
    // On a narrow card the scale's words lose their depths, so the glass keeps its size.
    const words = data ? (container.clientWidth < NARROW_PX && data.marks.short ? data.marks.short : data.marks) : null
    mark('full', shown ? H : null, words?.full ?? null)
    mark('now', shown && data?.current != null ? h : null, words?.now ?? null)
    mark('cutoff', cut, words?.cutoff ?? null)
    mark('empty', shown ? 0 : null, words?.empty ?? null)
    // While watering, "now" at the end of the time axis is blue like the tail.
    const last = tickLabels.length - 1
    ticks.ink(last, pumping ? 'blue' : 'fg3')
    dots.forEach((d, i) => {
      const at = data?.topUps[i]
      d.visible = shown && at !== undefined
      if (!d.visible || at === undefined) return
      d.position.set(x0 + at * W, level.yAt(at), 0.03)
      d.scale.setScalar(Math.max(0.001, pointEase(f.p, at * 120, 120)))
    })
    return pumping && !f.reduced
  }

  return viz(base, (d: TankData) => {
    data = d
    level.setValues(d.levels, { tailFrom: d.runFrom === null ? undefined : Math.round(d.runFrom * (Math.max(2, d.levels.length) - 1)), tailInk: 'blue' })
    tickLabels = d.ticks
    ticks.set(d.ticks)
  })
}

// ── Light ────────────────────────────────────────────────────────────────

export const LIGHT_SPEC: BaseSpec = { need: 11.2, camera: { position: [0, 4.6, 11.8], target: [0, 1.3, 0] }, bounds: [[-5, -0.35, -0.7], [5, 3.1, 0.8]] }

/** The day's planned curve as a line, what the LED gave as a ribbon up to now, a manual hold's window on the floor, and a pulsing dot at now. */
export function createLightViz(container: HTMLElement, env?: Env): Viz<LightData> {
  const x0 = -5
  const W = 10
  const H = 2.8
  let data: LightData | null = null
  const base = createBase(container, LIGHT_SPEC, draw, env)
  const T = base.THREE
  const actual = ribbon(base, { x0, width: W, z: 0, height: H, ink: 'amber', n: 97, fill: 0.26 })
  floorGrid(base, { x0, x1: x0 + W, z0: -0.7, z1: 0.7, xs: [0, 0.25, 0.5, 0.75, 1].map(a => x0 + a * W), zs: [0] })
  base.segments([[[x0, H / 2, -0.02], [x0 + W, H / 2, -0.02]], [[x0, H, -0.02], [x0 + W, H, -0.02]]], 'grid')
  const top = base.label('100%', { ink: 'fg3', size: 0.19, align: 'left', valign: 'bottom' })
  top.sprite.position.set(x0, H + 0.04, 0)
  base.root.add(top.sprite)
  const ticks = axis(base, { x0, width: W, y: -0.05, z: 0.8, size: 0.19 })
  ticks.set([0, 6, 12, 18, 24].map(h => ({ at: h / 24, label: `${String(h).padStart(2, '0')}:00` })))

  const plannedGeo = new T.BufferGeometry()
  plannedGeo.setAttribute('position', new T.BufferAttribute(new Float32Array(97 * 3), 3))
  const planned = new T.Line(plannedGeo, base.tint(new T.LineBasicMaterial({ transparent: true, opacity: 0 }), 'amber'))
  planned.renderOrder = 3
  base.root.add(planned)
  let plannedFrom: number[] = []
  let plannedTo: number[] = []

  const hold = base.plane(1, 1.2, 'amber', 0.16)
  hold.rotation.x = -Math.PI / 2
  const holdEdge = base.segments([[[0, 0, -0.6], [0, 0, 0.6]], [[1, 0, -0.6], [1, 0, 0.6]]], 'amber', 0.6)
  const holdLabel = base.label('hold', { ink: 'amber', size: 0.17, align: 'left', valign: 'top' })
  base.root.add(holdLabel.sprite)
  const dot = base.dot(0.1, 'amber')
  const stem = base.line([[0, 0, 0], [0, 1, 0]], 'fg3', 0.6)
  const nowLabel = base.label('', { ink: 'fg1', size: 0.22, align: 'center', valign: 'bottom', priority: 4 })
  base.root.add(nowLabel.sprite)

  function draw(f: Frame): boolean {
    actual.update(f)
    const shown = f.state === 'ready' && data !== null
    const appear = shown ? clamp01(f.p * 1.5) : 0
    planned.visible = shown
    if (shown) {
      const pos = plannedGeo.getAttribute('position') as THREE.BufferAttribute
      for (let i = 0; i < 97; i++) {
        const to = plannedTo[i] ?? 0
        const v = Number.isFinite(plannedFrom[i]) ? lerp(plannedFrom[i] as number, to, f.tween) : to
        pos.setXYZ(i, x0 + (i / 96) * W, v * H, 0.02)
      }
      pos.needsUpdate = true
      plannedGeo.computeBoundingSphere()
      ;(planned.material as THREE.LineBasicMaterial).opacity = 0.85 * appear
    }
    const h = shown ? data?.hold ?? null : null
    hold.visible = h !== null
    holdEdge.visible = h !== null
    holdLabel.setVisible(h !== null)
    if (h) {
      const w = Math.max(0.02, (h.until - h.from) * W)
      hold.scale.set(w, 1, 1)
      hold.position.set(x0 + h.from * W + w / 2, 0.005, 0)
      ;(hold.material as THREE.MeshBasicMaterial).opacity = 0.16 * appear
      holdEdge.scale.set(w, 1, 1)
      holdEdge.position.set(x0 + h.from * W, 0.005, 0)
      holdLabel.sprite.position.set(x0 + h.from * W + 0.04, 0, 0.62)
    }
    dot.visible = shown
    stem.visible = shown
    nowLabel.setVisible(shown)
    if (shown && data) {
      const x = x0 + data.now * W
      const y = data.nowLevel * H
      const beat = f.reduced ? 1 : 1 + 0.28 * Math.sin(f.t * 3.4)
      dot.position.set(x, y, 0.03)
      dot.scale.setScalar(Math.max(0.001, appear * beat))
      stem.position.set(x, 0, 0.03)
      stem.scale.set(1, Math.max(0.001, y), 1)
      nowLabel.sprite.position.set(x, y + 0.16, 0.03)
    }
    // The now dot keeps pulsing.
    return shown && !f.reduced
  }

  return viz(base, (d: LightData) => {
    data = d
    actual.setValues(d.actual)
    plannedFrom = plannedTo.length ? plannedTo : []
    plannedTo = d.planned.length === 97 ? d.planned : Array.from({ length: 97 }, (_, i) => d.planned[Math.round((i / 96) * (d.planned.length - 1))] ?? 0)
    nowLabel.setText(`now ${d.nowLabel}`)
    ticks.set(d.ticks)
  })
}

// ── Leaf cover per pod ───────────────────────────────────────────────────

export const PODS_SPEC: BaseSpec = { need: 10, camera: { position: [0, 2.1, 10.8], target: [0, 1.45, 0] }, bounds: [[-3.9, -0.4, -0.66], [3.9, 3.4, 0.7]] }

/** Three towers of pods, turning slowly; each pod a sphere sized by its leaf cover, an empty one a small grey bead. */
export function createPodsViz(container: HTMLElement, env?: Env): Viz<PodsData> {
  const TOWERS = 3
  const PER = 10
  const GAP = 3.2
  const TOP = 3.1
  const PITCH = 0.31
  const RADIUS = 0.42
  let data: PodsData | null = null
  const base = createBase(container, PODS_SPEC, draw, env)
  const T = base.THREE
  const sphere = new T.SphereGeometry(1, 18, 12)
  const towers = Array.from({ length: TOWERS }, (_, t) => {
    const group = new T.Group()
    group.position.set((t - (TOWERS - 1) / 2) * GAP, 0, 0)
    base.root.add(group)
    const post = new T.Mesh(new T.CylinderGeometry(0.05, 0.05, TOP + 0.25, 10), base.tint(new T.MeshBasicMaterial(), 'grid'))
    post.position.y = (TOP + 0.25) / 2
    group.add(post)
    base.ring(0.62, [group.position.x, 0, 0], 'grid')
    const label = base.label(`Tower ${String.fromCharCode(65 + t)}`, { ink: 'fg2', size: 0.2, align: 'center', valign: 'top', priority: 3 })
    label.sprite.position.set(group.position.x, -0.12, 0.7)
    base.root.add(label.sprite)
    const pods = Array.from({ length: PER }, (_, k) => {
      const a = k * ((Math.PI * 2) / 5) + t * 0.7
      const mesh = new T.Mesh(sphere, new T.MeshBasicMaterial({ transparent: true }))
      const at = new T.Vector3(Math.cos(a) * RADIUS, TOP - k * PITCH, Math.sin(a) * RADIUS)
      mesh.position.copy(at)
      group.add(mesh)
      const arm = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(0, at.y, 0), at]), base.tint(new T.LineBasicMaterial({ transparent: true, opacity: 0.8 }), 'grid'))
      group.add(arm)
      return mesh
    })
    return { group, pods, label }
  })

  const c = new T.Color()
  function draw(f: Frame): boolean {
    const shown = f.state === 'ready' && data !== null
    towers.forEach((tw, t) => {
      const cover = data?.towers[t]?.pods ?? []
      tw.label.setVisible(true)
      if (data?.towers[t]) tw.label.setText(data.towers[t].label)
      tw.pods.forEach((mesh, k) => {
        const i = t * PER + k
        const idle = 0.075 * (f.state === 'loading' && !f.reduced ? 0.8 + 0.45 * pulse(i, f.t) : 1)
        const v = cover[k]
        const has = shown && k < cover.length
        const e = has ? pointEase(f.p, i, TOWERS * PER) : 0
        const r = has && v !== null && v !== undefined ? 0.07 + 0.17 * Math.sqrt(v) : 0.075
        mesh.visible = !shown || k < cover.length
        mesh.scale.setScalar(lerp(idle, r, e))
        const mat = mesh.material as THREE.MeshBasicMaterial
        mat.color.copy(inkMix(base, 'green', v === null || v === undefined ? 0 : e, c))
        mat.opacity = f.state === 'error' ? 0.35 : f.state === 'empty' ? 0.5 : 1
      })
    })
    return false
  }

  return viz(base, (d: PodsData) => {
    data = d
  })
}

// ── Sensors ──────────────────────────────────────────────────────────────

export const SENSORS_SPEC: BaseSpec = { need: 11, camera: { position: [0, 8.2, 6.2], target: [0, 0.15, -1.9] }, bounds: [[-5.3, -0.45, -4.3], [5.3, 1.3, 0.7]] }

const GROUP_INK = { environment: 'cream', water: 'blue', pump: 'green' } as const

/** Every sensor as a ridge in its own range, back to front, its name at the left and its reading now at the right end. */
export function createSensorsViz(container: HTMLElement, env?: Env): Viz<SensorsData> {
  const x0 = -5
  const W = 10
  const ROWS = 8
  const GAP = 0.55
  const H = 0.75
  let data: SensorsData | null = null
  const base = createBase(container, SENSORS_SPEC, draw, env)
  const zOf = (k: number, n: number) => -(n - 1 - k) * GAP
  const rows: Array<{ ridge: ReturnType<typeof ribbon>, name: Label, now: Label }> = []
  const grid = floorGrid(base, { x0, x1: x0 + W, z0: zOf(0, ROWS) - 0.3, z1: 0.3, xs: [x0, x0 + W / 2, x0 + W], zs: [] })
  const ticks = axis(base, { x0, width: W, y: -0.05, z: 0.45, size: 0.19 })

  function row(k: number) {
    const ridge = ribbon(base, { x0, width: W, z: 0, height: H, ink: 'cream', n: 100, fill: 0.3 })
    const name = base.label('', { ink: 'fg2', size: 0.18, align: 'left', valign: 'bottom', priority: 2 })
    const now = base.label('', { ink: 'fg1', size: 0.18, align: 'right', valign: 'bottom', priority: 2 })
    base.root.add(name.sprite, now.sprite)
    rows[k] = { ridge, name, now }
    return rows[k]
  }
  function layout(n: number) {
    while (rows.length < n) row(rows.length)
    rows.forEach((r, k) => {
      const z = zOf(k, n)
      const on = k < n
      r.ridge.fill.visible = on
      r.ridge.top.visible = on
      r.ridge.fill.position.z = z
      r.ridge.top.position.z = z
      r.name.setVisible(on)
      r.name.sprite.position.set(x0, 0.04, z)
    })
    grid.scale.z = Math.max(1, n) / ROWS
    base.invalidate()
  }
  layout(ROWS)

  function draw(f: Frame): boolean {
    const n = data?.series.length || ROWS
    rows.forEach((r, k) => {
      if (k >= n) return
      r.ridge.update(f)
      const shown = f.state === 'ready' && data !== null
      r.now.setVisible(shown)
      if (shown) r.now.sprite.position.set(x0 + W, r.ridge.yAt(1) + 0.05, zOf(k, n))
    })
    return false
  }

  return viz(base, (d: SensorsData) => {
    data = d
    layout(d.series.length || ROWS)
    d.series.forEach((s, k) => {
      const r = rows[k]
      if (!r) return
      r.ridge.setValues(s.values, { ink: GROUP_INK[s.group] })
      r.name.setText(s.label)
      r.now.setText(s.current)
    })
    ticks.set(d.ticks)
  })
}
