/**
 * The five 3D charts, each built on the shared base: Today's lanes, the tank
 * with its glass cylinder, the light's day, leaf cover per pod and the sensor
 * ridgeline. Each factory takes its card's canvas host and returns a Viz.
 */
import type * as THREE from 'three'
import { createBase, floorGrid, inkMix, ribbon, type Base, type BaseSpec, type Env, type Frame, type Ink, type Label, type Viz } from './base'
import { clamp01, easeOutCubic, lerp, pointEase } from './motion'
import { DAY_TICKS, type LightData, type PodsData, type SensorsData, type Tick, type TankData, type TodayData, type Tone } from './shape'

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

export const TODAY_SPEC: BaseSpec = { need: 14, camera: { position: [0, 4.6, 9.6], target: [0, 0.2, -1.2] }, bounds: [[-6, -0.3, -2.75], [6, 1.3, 0.6]] }

/** Light, Water and Air stacked in depth with their labels, and a translucent "now" plane; the day's events are a flat strip under it. */
export function createTodayViz(container: HTMLElement, env?: Env): Viz<TodayData> {
  const W = 12
  const x0 = -W / 2
  const LANE_Z = [-2.4, -1.2, 0]
  /** The front lane, where the hour axis sits. */
  const FRONT_Z = 0
  const H = 0.9
  let data: TodayData | null = null
  const ribbons: ReturnType<typeof ribbon>[] = []
  const laneLabels: Label[] = []
  const base = createBase(container, TODAY_SPEC, draw, env)

  floorGrid(base, { x0, x1: x0 + W, z0: LANE_Z[0] as number - 0.35, z1: FRONT_Z + 0.35, xs: [0, 0.25, 0.5, 0.75, 1].map(a => x0 + a * W), zs: LANE_Z })
  ;['Light', 'Water', 'Air'].forEach((name, i) => {
    const z = LANE_Z[i] as number
    ribbons.push(ribbon(base, { x0, width: W, z, height: H, ink: (['amber', 'blue', 'cream'] as const)[i] as Ink, n: 97 }))
    const l = base.label(name, { ink: 'fg2', size: 0.2, align: 'left', valign: 'bottom', priority: 2 })
    l.sprite.position.set(x0, H + 0.08, z)
    base.root.add(l.sprite)
    laneLabels.push(l)
  })
  const ticks = axis(base, { x0, width: W, y: -0.05, z: FRONT_Z + 0.45, size: 0.19 })
  ticks.set([0, 6, 12, 18, 24].map(h => ({ at: h / 24, label: `${String(h).padStart(2, '0')}:00` })))

  // The now plane stands across every lane; hidden until there's a now to stand at.
  const depth = FRONT_Z - (LANE_Z[0] as number) + 0.7
  const nowPlane = base.plane(depth, H + 0.25, 'fg1', 0.07)
  nowPlane.rotation.y = Math.PI / 2
  const nowEdge = base.line([[0, 0, 0], [0, 0, depth]], 'fg2', 0.6)
  const nowLabel = base.label('now', { ink: 'fg1', size: 0.2, align: 'center', valign: 'bottom', priority: 4 })
  base.root.add(nowLabel.sprite)

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
      nowPlane.position.set(nowX, (H + 0.25) / 2, ((LANE_Z[0] as number) - 0.35 + FRONT_Z + 0.35) / 2)
      nowEdge.position.set(nowX, H + 0.25, (LANE_Z[0] as number) - 0.35)
      nowLabel.sprite.position.set(nowX, H + 0.3, (LANE_Z[0] as number) - 0.35)
    }
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

/** 45° hatching over the box [x0, x1] × [y0, y1]: one stroke every `step` along x, each clipped to the box. */
export function hatch(x0: number, x1: number, y0: number, y1: number, step: number): Array<[[number, number], [number, number]]> {
  const h = y1 - y0
  const out: Array<[[number, number], [number, number]]> = []
  if (h <= 0 || x1 <= x0 || step <= 0) return out
  // Each stroke rises one for one from (c, y0); the first starts left of the box so its top still crosses it.
  for (let c = x0 - h + step / 2; c < x1; c += step) {
    const a = Math.max(x0, c)
    const b = Math.min(x1, c + h)
    if (b > a) out.push([[a, y0 + a - c], [b, y0 + b - c]])
  }
  return out
}

export const TANK_SPEC: BaseSpec = { need: 11.4, camera: { position: [0.05, 4.1, 11.6], target: [0.05, 0.95, 0] }, bounds: [[-5.2, -0.4, -0.75], [4, 2.85, 0.75]] }
/** Below this card width the tank's scale drops the depths from its words. */
const NARROW_PX = 560

/**
 * The tank's level over the window and the glass of water now on one
 * vertical scale: the line (with a soft fill and its top-ups) runs into a
 * cylinder filled to the level now. One dashed cutoff line crosses both and
 * rings the glass; ticks down the glass's right side read full, now, cutoff
 * and empty. Scheduled runs tick the foot of the chart (today's still to
 * come hollow, after now). While the pump runs, the water this run drew down
 * is a blue tail into the glass, the last x label turns blue, and bubbles rise.
 * The water under the cutoff, which the pump won't draw, is hatched across
 * the chart and right round the glass; at or under it, the water
 * dims and "now" turns amber.
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
  // The reserve under the cutoff: strokes behind the history, and wrapped right round the glass (stronger, to read over the water) so a spin never hides them, rebuilt when the cutoff moves.
  const reserve = base.segments([], 'reserve', 0.55)
  const glassReserve = base.segments([], 'reserve', 0.8)
  reserve.renderOrder = 1
  glassReserve.renderOrder = 1
  let reserveAt: number | null = null
  // Whether "now" is inked amber, for the water under the cutoff.
  let nowLow = false
  function hatchReserve(cut: number) {
    const chart = hatch(x0, x0 + W, 0, cut, 0.16).map(([a, b]) => [[a[0], a[1], -0.03], [b[0], b[1], -0.03]] as [[number, number, number], [number, number, number]])
    // The glass's wall unrolled: hatched along its circumference, then each stroke in short pieces wrapped back onto the cylinder.
    const wall = (s: number, y: number): [number, number, number] => [CX + R * Math.sin(s / R), y, R * Math.cos(s / R)]
    const glassy = hatch(0, 2 * Math.PI * R, 0, cut, 0.12).flatMap(([a, b]) => Array.from({ length: 6 }, (_, i) => {
      const at = (k: number) => wall(a[0] + (b[0] - a[0]) * k / 6, a[1] + (b[1] - a[1]) * k / 6)
      return [at(i), at(i + 1)] as [[number, number, number], [number, number, number]]
    }))
    reserve.geometry.dispose()
    reserve.geometry = new T.BufferGeometry().setFromPoints(chart.flat().map(p => new T.Vector3(...p)))
    glassReserve.geometry.dispose()
    glassReserve.geometry = new T.BufferGeometry().setFromPoints(glassy.flat().map(p => new T.Vector3(...p)))
    reserveAt = cut
  }

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

  // Scheduled runs along the foot of the chart: done ones as small blue bars; today's still to come as hollow ones in the gap between now and the glass, which stands for the rest of the day.
  const RUN_H = 0.14
  const ranBars = Array.from({ length: 48 }, () => {
    const m = new T.Mesh(new T.PlaneGeometry(0.035, RUN_H), base.tint(new T.MeshBasicMaterial({ transparent: true, opacity: 0.8, side: T.DoubleSide, depthWrite: false }), 'blue'))
    m.visible = false
    base.root.add(m)
    return m
  })
  const comingBars = Array.from({ length: 8 }, () => {
    const l = base.line([[-0.03, 0, 0], [0.03, 0, 0], [0.03, RUN_H, 0], [-0.03, RUN_H, 0], [-0.03, 0, 0]], 'blue', 0.7)
    l.visible = false
    return l
  })
  const GAP0 = x0 + W + 0.08
  const GAP1 = CX - R - 0.08

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
    // At or under the cutoff the pump won't start: the water left is all reserve, so it dims under denser hatching and "now" turns amber.
    const low = shown && !!data?.low && data.cutoff !== null
    const h = Math.max(0.02, lerp(LOW, shown ? cur : LOW, e) * H)
    water.scale.set(1, h, 1)
    water.position.set(CX, h / 2, 0)
    ;(water.material as THREE.MeshBasicMaterial).color.copy(inkMix(base, 'tank', f.state === 'error' ? 0 : e, c))
    ;(water.material as THREE.MeshBasicMaterial).opacity = f.state === 'error' ? 0.25 : low ? 0.3 : 0.5
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
    reserve.visible = cut !== null && cut > 0
    glassReserve.visible = reserve.visible
    if (cut !== null) {
      cutRing.position.set(CX, cut, 0)
      cutLine.position.set(0, cut, 0)
      if (cut !== reserveAt) hatchReserve(cut)
    }
    reserve.material.opacity = low ? 0.85 : 0.55
    glassReserve.material.opacity = low ? 1 : 0.8
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
    marks.now.label.setInk(low ? 'amber' : 'fg1')
    if (low !== nowLow) base.tint(marks.now.tick.material, low ? 'amber' : 'fg1')
    nowLow = low
    mark('cutoff', cut, words?.cutoff ?? null)
    mark('empty', shown ? 0 : null, words?.empty ?? null)
    ranBars.forEach((m, i) => {
      const at = data?.runs[i]
      m.visible = shown && at !== undefined
      if (m.visible && at !== undefined) m.position.set(x0 + at * W, RUN_H / 2, 0.06)
    })
    comingBars.forEach((l, i) => {
      const at = data?.upcoming[i]
      l.visible = shown && at !== undefined
      if (l.visible && at !== undefined) l.position.set(GAP0 + at * (GAP1 - GAP0), 0, 0.06)
    })
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

export const LIGHT_SPEC: BaseSpec = { need: 11.4, camera: { position: [0.05, 4.1, 11.6], target: [0.05, 0.95, 0] }, bounds: [[-5.2, -0.4, -0.75], [4, 2.85, 0.75]] }

/**
 * The light's day and the lamp now on one vertical scale: the planned curve
 * as a line, what the LED gave as a ribbon up to now, a manual hold's window
 * on the floor and a pulsing dot at now, beside a glass tube lit to the level
 * now. One dashed Boost line, labelled once, crosses both; ticks down the
 * tube's right side read now and off.
 */
export function createLightViz(container: HTMLElement, env?: Env): Viz<LightData> {
  const x0 = -5.2
  const W = 6.6
  const H = 2.6
  const CX = 2.9
  const R = 0.32
  let data: LightData | null = null
  const base = createBase(container, LIGHT_SPEC, draw, env)
  const T = base.THREE
  const actual = ribbon(base, { x0, width: W, z: 0, height: H, ink: 'amber', n: 97, fill: 0.26 })
  floorGrid(base, { x0, x1: x0 + W, z0: -0.7, z1: 0.7, xs: [0, 0.25, 0.5, 0.75, 1].map(a => x0 + a * W), zs: [0] })
  base.segments([[[x0, H / 2, -0.02], [x0 + W, H / 2, -0.02]], [[x0, H, -0.02], [x0 + W, H, -0.02]]], 'grid')
  const ticks = axis(base, { x0, width: W, y: -0.05, z: 0.8, size: 0.19 })
  ticks.set(DAY_TICKS)

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

  // The lamp: a slim glass tube, lit from the floor to the level now.
  const tube = new T.Mesh(new T.CylinderGeometry(R, R, H, 32, 1, true), base.tint(new T.MeshBasicMaterial({ transparent: true, opacity: 0.06, side: T.DoubleSide, depthWrite: false }), 'fg1'))
  tube.position.set(CX, H / 2, 0)
  base.root.add(tube)
  base.ring(R, [CX, H, 0], 'fg3', 0.7)
  base.ring(R, [CX, 0, 0], 'fg3', 0.7)
  const glow = new T.Mesh(new T.CylinderGeometry(R * 0.9, R * 0.9, 1, 32), new T.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false }))
  base.root.add(glow)
  const glowTop = base.ring(R * 0.9, [0, 0, 0], 'amber', 0.9)
  // The one reference line: Boost, across the day and through the tube.
  const boostLine = base.dashed([[x0, 0, 0.01], [CX + R + 0.16, 0, 0.01]], 'amber', 0.14, 0.1, 0.8)
  // From the dot at now along to the tube, at the level now.
  const link = base.line([[0, 0, 0.02], [1, 0, 0.02]], 'fg3', 0.45)

  // Boost's one label sits over its line at the start of the day, clear of the lamp's ticks.
  const boostLabel = base.label('Boost 95%', { ink: 'amber', size: 0.17, align: 'left', valign: 'bottom', priority: 3 })
  base.root.add(boostLabel.sprite)
  const MARKS = ['now', 'off'] as const
  const marks = Object.fromEntries(MARKS.map((k) => {
    const tick: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial> = base.line([[CX + R + 0.02, 0, 0], [CX + R + 0.16, 0, 0]], k === 'now' ? 'fg1' : 'fg3', 0.9)
    const l = base.label(k === 'now' ? 'now · 00:00' : 'off', { ink: k === 'now' ? 'fg1' : 'fg3', size: 0.17, align: 'left', valign: 'middle', priority: k === 'now' ? 4 : 2, fit: true })
    base.root.add(l.sprite)
    return [k, { tick, label: l }]
  })) as Record<typeof MARKS[number], { tick: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>, label: Label }>
  function mark(k: typeof MARKS[number], y: number | null, text: string) {
    const m = marks[k]
    m.tick.visible = y !== null
    m.label.setVisible(y !== null)
    if (y === null) return
    m.tick.position.set(0, y, 0)
    m.label.setText(text)
    m.label.sprite.position.set(CX + R + 0.22, y, 0)
  }

  const c = new T.Color()
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
    // The tube lights last, as the ribbon reaches now.
    const e = shown ? pointEase(f.p, 96, 97) : 0
    const level = shown && data ? data.nowLevel : 0
    const lit = Math.max(0.001, level * e * H)
    glow.visible = shown && level > 0
    glow.scale.set(1, lit, 1)
    glow.position.set(CX, lit / 2, 0)
    ;(glow.material as THREE.MeshBasicMaterial).color.copy(inkMix(base, 'amber', e, c))
    glowTop.visible = glow.visible
    glowTop.position.set(CX, lit, 0)
    const boost = shown && data ? data.boost * H : null
    boostLine.visible = boost !== null
    if (boost !== null) boostLine.position.set(0, boost, 0)
    boostLabel.setVisible(boost !== null)
    if (boost !== null) {
      boostLabel.setText(`Boost ${Math.round((data?.boost ?? 0) * 100)}%`)
      boostLabel.sprite.position.set(x0 + 0.05, boost + 0.04, 0.01)
    }
    mark('now', shown ? lit : null, `now · ${data?.nowTime ?? ''}`)
    mark('off', shown ? 0 : null, 'off')
    dot.visible = shown
    stem.visible = shown
    link.visible = shown
    if (shown && data) {
      const x = x0 + data.now * W
      const y = data.nowLevel * H
      const beat = f.reduced ? 1 : 1 + 0.28 * Math.sin(f.t * 3.4)
      dot.position.set(x, y, 0.03)
      dot.scale.setScalar(Math.max(0.001, appear * beat))
      stem.position.set(x, 0, 0.03)
      stem.scale.set(1, Math.max(0.001, y), 1)
      link.position.set(x, y, 0)
      link.scale.set(Math.max(0.001, CX - R - x), 1, 1)
    }
    // The now dot keeps pulsing.
    return shown && !f.reduced
  }

  return viz(base, (d: LightData) => {
    data = d
    actual.setValues(d.actual)
    plannedFrom = plannedTo.length ? plannedTo : []
    plannedTo = d.planned.length === 97 ? d.planned : Array.from({ length: 97 }, (_, i) => d.planned[Math.round((i / 96) * (d.planned.length - 1))] ?? 0)
    ticks.set(d.ticks)
  })
}

// ── Leaf cover per pod ───────────────────────────────────────────────────

export const PODS_SPEC: BaseSpec = { need: 10.5, camera: { position: [0, 0.5, 13], target: [0, -0.15, 0] }, bounds: [[-5.2, -2.85, -1.25], [5.2, 2.3, 1.25]] }

/**
 * The tower's columns as wire-edged tapered posts, one per column the data
 * has (a Home's three of 10, a Studio's two of 8; three of 10 while
 * loading), "Tower 1…" under each. Each pod is a stub off its column, turned
 * a little further round each row, holding a wireframe leaf sized by its leaf
 * cover; an empty pod is the grey stub alone. While loading the leaves pulse
 * small in turn, then grow to their cover and turn green in a sweep.
 */
export function createPodsViz(container: HTMLElement, env?: Env): Viz<PodsData> {
  const TOP_Y = 1.8
  const PITCH = 0.4
  let data: PodsData | null = null
  let count = 0
  let per = 0
  const base = createBase(container, PODS_SPEC, draw, env)
  const T = base.THREE
  const column = new T.CylinderGeometry(0.2, 0.26, 4.3, 24)
  const edges = new T.EdgesGeometry(column)
  const stubGeo = new T.CylinderGeometry(0.09, 0.09, 0.3, 12)
  const ico = new T.IcosahedronGeometry(1, 1)
  const wire = new T.WireframeGeometry(ico)
  interface Pod { holder: THREE.Group, leaf: THREE.Group, line: THREE.LineBasicMaterial, fill: THREE.MeshBasicMaterial }
  const towers: Array<{ group: THREE.Group, label: Label, pods: Pod[] }> = []

  function tower(k: number) {
    const group = new T.Group()
    base.root.add(group)
    group.add(new T.Mesh(column, base.tint(new T.MeshBasicMaterial(), 'grid')), new T.LineSegments(edges, base.tint(new T.LineBasicMaterial(), 'edge')))
    const label = base.label(`Tower ${k + 1}`, { ink: 'fg3', size: 0.22, align: 'center', valign: 'middle', priority: 3 })
    base.root.add(label.sprite)
    return { group, label, pods: [] as Pod[] }
  }
  function pod(k: number, i: number, group: THREE.Group): Pod {
    // Each row turns a little further round the column; the stub lies along the holder's x.
    const holder = new T.Group()
    holder.rotation.y = i * 2.4 + k
    holder.position.y = TOP_Y - i * PITCH
    const stub = new T.Mesh(stubGeo, base.tint(new T.MeshBasicMaterial(), 'stub'))
    stub.rotation.z = Math.PI / 2
    stub.position.x = 0.36
    const line = new T.LineBasicMaterial({ transparent: true })
    const fill = new T.MeshBasicMaterial({ transparent: true, opacity: 0.22, depthWrite: false })
    const leaf = new T.Group()
    leaf.add(new T.Mesh(ico, fill), new T.LineSegments(wire, line))
    holder.add(stub, leaf)
    group.add(holder)
    return { holder, leaf, line, fill }
  }
  /** `n` columns of `rows` pods, spread across the scene; the rest of the pool hidden. */
  function layout(n: number, rows: number) {
    if (n === count && rows === per) return
    count = n
    per = rows
    while (towers.length < n) towers.push(tower(towers.length))
    const gap = n <= 2 ? 4 : 3.2
    towers.forEach((tw, k) => {
      const on = k < n
      tw.group.visible = on
      tw.label.setVisible(on)
      if (!on) return
      const x = (k - (n - 1) / 2) * gap
      tw.group.position.set(x, 0, 0)
      tw.label.sprite.position.set(x, -2.6, 0)
      while (tw.pods.length < rows) tw.pods.push(pod(k, tw.pods.length, tw.group))
      tw.pods.forEach((p, i) => {
        p.holder.visible = i < rows
      })
    })
    base.invalidate()
  }
  layout(3, 10)

  const c = new T.Color()
  function draw(f: Frame): boolean {
    const shown = f.state === 'ready' && data !== null
    const total = Math.max(1, count * per)
    const inks = base.inks()
    towers.forEach((tw, k) => {
      if (k >= count) return
      const cover = data?.towers[k]?.pods ?? []
      if (data?.towers[k]) tw.label.setText(data.towers[k].label)
      tw.pods.forEach((p, i) => {
        if (i >= per) return
        const idx = k * per + i
        const v = shown ? cover[i] : undefined
        // The sweep: each leaf turns a beat after the one before it.
        const e = shown ? easeOutCubic(f.p * 1.6 - (idx / total) * 0.6) : 0
        const skeleton = f.state === 'loading' && !f.reduced ? 0.07 + 0.03 * Math.sin(f.t * 4 - idx * 0.5) : 0.07
        // An empty or unmeasured pod has no leaf: it shrinks away as the data lands.
        const to = typeof v === 'number' ? 0.05 + v * 0.3 : 0
        const scale = skeleton * (1 - e) + to * e
        p.leaf.visible = scale > 0.002
        p.leaf.scale.setScalar(Math.max(0.001, scale))
        p.leaf.position.x = 0.52 + scale
        c.copy(inks.edge).lerp(inks.green, typeof v === 'number' ? e : 0)
        p.line.color.copy(c)
        p.fill.color.copy(c)
        p.line.opacity = f.state === 'error' ? 0.35 : 1
        p.fill.opacity = f.state === 'error' ? 0.08 : 0.22
      })
    })
    return false
  }

  return viz(base, (d: PodsData) => {
    data = d
    layout(Math.max(1, d.towers.length), Math.max(1, ...d.towers.map(t => t.pods.length)))
  })
}

// ── Sensors ──────────────────────────────────────────────────────────────

export const SENSORS_SPEC: BaseSpec = { need: 11, camera: { position: [0, 8.2, 6.2], target: [0, 0.15, -1.9] }, bounds: [[-5.3, -0.45, -4.3], [5.3, 1.3, 0.7]] }

const GROUP_INK = { environment: 'cream', water: 'blue', pump: 'green' } as const

/** Every sensor as a ridge in its own range, back to front, its name at the left and its reading now at the right end; any number of rows within the same depth. */
export function createSensorsViz(container: HTMLElement, env?: Env): Viz<SensorsData> {
  const x0 = -5
  const W = 10
  const ROWS = 8
  const GAP = 0.55
  const H = 0.75
  let data: SensorsData | null = null
  const base = createBase(container, SENSORS_SPEC, draw, env)
  // Up to eight rows sit GAP apart; more (pH, EC and water temperature probes) share the same depth, so the scene keeps to its bounds.
  const DEPTH = (ROWS - 1) * GAP
  const zOf = (k: number, n: number) => -(n - 1 - k) * Math.min(GAP, n > 1 ? DEPTH / (n - 1) : GAP)
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
      // A row past the data's has no reading to show either.
      if (!on) r.now.setVisible(false)
    })
    grid.scale.z = Math.min(1, Math.max(1, n) / ROWS)
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
