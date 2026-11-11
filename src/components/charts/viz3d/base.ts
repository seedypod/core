/**
 * The shared base under every 3D chart: a transparent renderer filling its
 * card, a fixed perspective camera, the scene fitted to the card's width, a
 * loop that runs only while something on screen moves, a drag that spins the
 * chart (and a double click that puts it back), theme colours from the app's tokens, canvas-texture labels kept
 * at least 11 px tall, and the building blocks (ribbon, line, floor grid,
 * ring, dot) the five charts are made of. Unlit materials only: no lights, no
 * shadows. Loaded with `import()` so three.js stays in its own chunk.
 */
import * as THREE from 'three'
import { clamp01, dragSpin, initialPhase, lerp, nextPhase, progressAt, releaseSpin, restingSpin, spinMoving, stepSpin, tweenAt, visibleSize, waveY, fitScale, labelHeight, pointEase, type Phase, type Spin, type VizState } from './motion'
import { resampleArray, type Tone } from './shape'

/** Every factory returns this. */
export interface Viz<D> {
  setState: (s: VizState) => void
  /** Stores the data, then shows it: the sweep on first data, a tween on a refresh. */
  setData: (data: D) => void
  /** Cancels the loop, disconnects observers and frees the GL context. */
  dispose: () => void
}

export type Ink = Tone | 'skeleton' | 'grid' | 'fg1' | 'fg2' | 'fg3' | 'tank' | 'reserve' | 'edge' | 'stub'

/** Each ink's token in web/src/globals.css, and the design's colour if the token is missing. */
const TOKENS: Record<Ink, [string, string]> = {
  cream: ['--meter', '#d9cfbb'],
  amber: ['--accent-light', '#e0b050'],
  blue: ['--accent-water', '#7fb0c8'],
  green: ['--pod-ok', '#8fbf8a'],
  orange: ['--pod-attention', '#e07a55'],
  muted: ['--text-3', '#847c6b'],
  skeleton: ['--border-2', '#3a362b'],
  grid: ['--border-1', '#2a271f'],
  fg1: ['--text-1', '#efe8da'],
  fg2: ['--text-2', '#b8af9c'],
  fg3: ['--text-3', '#847c6b'],
  tank: ['--tank-fill', '#a7d3f2'],
  reserve: ['--tank-reserve', '#b39a62'],
  edge: ['--viz-edge', '#5a5446'],
  stub: ['--viz-stub', '#4a4638'],
}

const FOV = 26
const MIN_LABEL_PX = 11
/** A label's canvas is this much taller than its font, for descenders and breathing room. */
const LABEL_LEADING = 1.35
const LABEL_FONT_PX = 48

export interface Frame {
  /** Seconds since the chart was made; frozen while in error. */
  t: number
  state: VizState
  /** Load progress 0..1. */
  p: number
  /** Refresh tween 0..1. */
  tween: number
  reduced: boolean
  /** Bumps when the theme changes, so settled parts repaint. */
  inkVersion: number
}

export interface BaseSpec {
  /** Scene width in world units that must always be visible. */
  need: number
  camera: { position: [number, number, number], target: [number, number, number] }
  /** The box the chart and its labels fill, so it stays in frame however it's turned. */
  bounds: [[number, number, number], [number, number, number]]
}

/** How much of the canvas the turned bounds may reach, in device coordinates. */
const FRAME = 0.97

/** For tests: a stand-in renderer and clock. */
export interface Env {
  renderer?: () => Pick<THREE.WebGLRenderer, 'domElement' | 'setPixelRatio' | 'setSize' | 'setClearColor' | 'render' | 'dispose' | 'forceContextLoss'>
  now?: () => number
  /** Handed the scene and camera once made, to measure what's on screen. */
  inspect?: (scene: THREE.Scene, camera: THREE.PerspectiveCamera) => void
}

export const reducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

let probe: CanvasRenderingContext2D | null | undefined
/** A CSS colour (any syntax the browser knows, oklch included) as a three.js colour, through a 1×1 canvas. */
function parseCss(raw: string, fallback: string): THREE.Color {
  if (probe === undefined) {
    try {
      probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    }
    catch {
      probe = null
    }
  }
  if (probe && raw) {
    probe.clearRect(0, 0, 1, 1)
    probe.fillStyle = fallback
    probe.fillStyle = raw
    probe.fillRect(0, 0, 1, 1)
    const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data
    return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace)
  }
  return new THREE.Color(/^#|^rgb/.test(raw) ? raw : fallback)
}

export function resolveInks(el: Element): Record<Ink, THREE.Color> {
  const style = getComputedStyle(el)
  return Object.fromEntries((Object.keys(TOKENS) as Ink[]).map((k) => {
    const [token, fallback] = TOKENS[k]
    return [k, parseCss(style.getPropertyValue(token).trim(), fallback)]
  })) as Record<Ink, THREE.Color>
}

export interface Label {
  sprite: THREE.Sprite
  setText: (text: string) => void
  setInk: (ink: Ink) => void
  setVisible: (on: boolean) => void
}

export type Base = ReturnType<typeof createBase>

/** `draw` returns true while the chart itself still moves (a pulse, a flow), so the loop keeps going. */
export function createBase(container: HTMLElement, spec: BaseSpec, draw: (frame: Frame) => boolean | undefined, env: Env = {}) {
  const now = env.now ?? (() => performance.now())
  const renderer = env.renderer ? env.renderer() : new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
  const canvas = renderer.domElement
  canvas.setAttribute('aria-hidden', 'true')
  // pan-y: a vertical swipe still scrolls the page; only a sideways drag turns the chart.
  Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%', position: 'absolute', inset: '0', touchAction: 'pan-y', cursor: 'grab' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setClearColor(0x000000, 0)

  const scene = new THREE.Scene()
  const target = new THREE.Vector3(...spec.camera.target)
  const pivot = new THREE.Group()
  pivot.position.copy(target)
  const root = new THREE.Group()
  root.position.copy(target).multiplyScalar(-1)
  pivot.add(root)
  scene.add(pivot)
  const camera = new THREE.PerspectiveCamera(FOV, 2, 0.1, 200)
  camera.position.set(...spec.camera.position)
  camera.lookAt(target)

  let inks = resolveInks(container)
  const reduced = reducedMotion()
  const born = now()
  let phase: Phase = initialPhase()
  let frozenT = 0
  let spin: Spin = restingSpin()
  let wants = false
  let visible = typeof IntersectionObserver === 'undefined'
  let dirty = true
  let raf = 0
  let disposed = false
  let lastP = -1
  let inkVersion = 0
  const size = { width: 0, height: 0, scale: 1, fit: 1 }

  // ── Materials that follow the theme ────────────────────────────────────
  const tinted: Array<{ material: THREE.Material & { color: THREE.Color }, ink: Ink }> = []
  /** Colours a material with an ink and keeps it in step with the theme; again on the same material, re-inks it. */
  const tint = <M extends THREE.Material & { color: THREE.Color }>(material: M, ink: Ink): M => {
    material.color.copy(inks[ink])
    const had = tinted.find(t => t.material === material)
    if (had) had.ink = ink
    else tinted.push({ material, ink })
    return material
  }

  // ── Labels ─────────────────────────────────────────────────────────────
  interface LabelEntry { sprite: THREE.Sprite, size: number, aspect: number, priority: number, fit: boolean, text: () => string, redraw: () => void, wanted: () => boolean }
  const labels: LabelEntry[] = []
  let fontsReady = typeof document === 'undefined' || !document.fonts
  const font = `500 ${LABEL_FONT_PX}px "IBM Plex Mono", ui-monospace, monospace`

  /**
   * A text sprite; where labels collide on screen, the higher `priority` (then
   * the older) stays and the other hides. A `fit` label hangs outside the
   * chart's bounds, so the fit keeps room for it, shown or not yet.
   */
  const label = (text: string, o: { ink?: Ink, size?: number, align?: 'left' | 'center' | 'right', valign?: 'top' | 'middle' | 'bottom', priority?: number, fit?: boolean } = {}): Label => {
    const c = document.createElement('canvas')
    const texture = new THREE.CanvasTexture(c)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.minFilter = THREE.LinearFilter
    texture.generateMipmaps = false
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false })
    const sprite = new THREE.Sprite(material)
    sprite.center.set(o.align === 'left' ? 0 : o.align === 'right' ? 1 : 0.5, o.valign === 'top' ? 1 : o.valign === 'bottom' ? 0 : 0.5)
    sprite.renderOrder = 10
    const entry: LabelEntry = { sprite, size: o.size ?? 0.22, aspect: 1, priority: o.priority ?? 1, fit: o.fit ?? false, text: () => current, redraw: () => {}, wanted: () => shown && fontsReady && current.length > 0 }
    let current = text
    let ink: Ink = o.ink ?? 'fg3'
    let shown = true
    entry.redraw = () => {
      const ctx = c.getContext('2d')
      const h = Math.ceil(LABEL_FONT_PX * LABEL_LEADING)
      let w = Math.ceil(current.length * LABEL_FONT_PX * 0.62) + 8
      if (ctx) {
        ctx.font = font
        w = Math.ceil(ctx.measureText(current).width) + 8
      }
      c.width = Math.max(2, w)
      c.height = h
      entry.aspect = c.width / c.height
      if (ctx) {
        ctx.font = font
        ctx.textBaseline = 'middle'
        ctx.fillStyle = `#${inks[ink].getHexString(THREE.SRGBColorSpace)}`
        ctx.clearRect(0, 0, c.width, c.height)
        ctx.fillText(current, 4, h / 2)
      }
      texture.dispose()
      texture.needsUpdate = true
      sprite.visible = entry.wanted()
      scaleLabel(entry)
      if (entry.fit) fitted = ''
      invalidate()
    }
    labels.push(entry)
    labels.sort((a, b) => b.priority - a.priority)
    entry.redraw()
    return {
      sprite,
      setText: (next) => {
        if (next === current) return
        current = next
        entry.redraw()
      },
      setInk: (next) => {
        if (next === ink) return
        ink = next
        entry.redraw()
      },
      setVisible: (on) => {
        shown = on
        sprite.visible = entry.wanted()
      },
    }
  }
  if (!fontsReady) {
    void document.fonts.ready.then(() => {
      if (disposed) return
      fontsReady = true
      for (const l of labels) l.redraw()
    })
  }

  const worldPos = new THREE.Vector3()
  /** At least MIN_LABEL_PX of font on screen, measured where the label stands. */
  function scaleLabel(l: { sprite: THREE.Sprite, size: number, aspect: number }) {
    if (!size.height) {
      l.sprite.scale.set(l.size * l.aspect, l.size, 1)
      return
    }
    l.sprite.getWorldPosition(worldPos)
    const { height } = visibleSize(FOV, camera.aspect, camera.position.distanceTo(worldPos))
    const h = labelHeight(l.size, MIN_LABEL_PX * LABEL_LEADING, size.height, height, size.scale)
    l.sprite.scale.set(h * l.aspect, h, 1)
  }

  const placed: Array<[number, number, number, number]> = []
  const at = new THREE.Vector3()
  /** Hides each label that would overlap one already placed this frame, in priority order; 2 px apart at least. */
  function declutter() {
    if (!size.height) return
    placed.length = 0
    camera.updateMatrixWorld()
    for (const l of labels) {
      if (!l.wanted()) continue
      l.sprite.getWorldPosition(at)
      const { height } = visibleSize(FOV, camera.aspect, camera.position.distanceTo(at))
      const hPx = (l.sprite.scale.y * size.scale / height) * size.height
      const wPx = hPx * l.aspect
      at.project(camera)
      const x = ((at.x + 1) / 2) * size.width - l.sprite.center.x * wPx
      const y = ((1 - at.y) / 2) * size.height - (1 - l.sprite.center.y) * hPx
      // The text's own box: the canvas pads it top and bottom.
      const pad = (hPx * (1 - 1 / LABEL_LEADING)) / 2
      const box: [number, number, number, number] = [x, y + pad, x + wPx, y + hPx - pad]
      const hit = placed.some(b => box[0] < b[2] + 2 && box[2] + 2 > b[0] && box[1] < b[3] + 2 && box[3] + 2 > b[1])
      l.sprite.visible = !hit
      if (!hit) placed.push(box)
    }
  }

  // ── Building blocks ────────────────────────────────────────────────────
  const line = (points: Array<[number, number, number]>, ink: Ink, opacity = 1) => {
    const geometry = new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(...p)))
    const l = new THREE.Line(geometry, tint(new THREE.LineBasicMaterial({ transparent: opacity < 1, opacity }), ink))
    root.add(l)
    return l
  }
  const dashed = (points: Array<[number, number, number]>, ink: Ink, dash = 0.14, gap = 0.1, opacity = 1) => {
    const geometry = new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(...p)))
    const l = new THREE.Line(geometry, tint(new THREE.LineDashedMaterial({ dashSize: dash, gapSize: gap, transparent: opacity < 1, opacity }), ink))
    l.computeLineDistances()
    root.add(l)
    return l
  }
  const segments = (pairs: Array<[[number, number, number], [number, number, number]]>, ink: Ink, opacity = 1) => {
    const geometry = new THREE.BufferGeometry().setFromPoints(pairs.flat().map(p => new THREE.Vector3(...p)))
    const l = new THREE.LineSegments(geometry, tint(new THREE.LineBasicMaterial({ transparent: opacity < 1, opacity }), ink))
    root.add(l)
    return l
  }
  const ring = (radius: number, at: [number, number, number], ink: Ink, opacity = 1) => {
    const pts = Array.from({ length: 65 }, (_, i) => {
      const a = (i / 64) * Math.PI * 2
      return [at[0] + Math.cos(a) * radius, at[1], at[2] + Math.sin(a) * radius] as [number, number, number]
    })
    return line(pts, ink, opacity)
  }
  const dot = (radius: number, ink: Ink, opacity = 1) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), tint(new THREE.MeshBasicMaterial({ transparent: true, opacity }), ink))
    root.add(m)
    return m
  }
  const plane = (w: number, h: number, ink: Ink, opacity: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), tint(new THREE.MeshBasicMaterial({ transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }), ink))
    root.add(m)
    return m
  }

  // ── Sizing, fit and the loop ───────────────────────────────────────────
  function resize() {
    const width = container.clientWidth
    const height = container.clientHeight
    if (!width || !height) return
    Object.assign(size, { width, height })
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    const vis = visibleSize(FOV, camera.aspect, camera.position.distanceTo(target))
    size.fit = fitScale(vis.width, spec.need)
    fitted = ''
  }

  const corner = new THREE.Vector3()
  const turn = new THREE.Euler()
  let fitted = ''
  /** The need-based scale, shrunk while the chart is turned so the bounds' corners stay in frame. */
  function turnedFit(s: number, rx: number, ry: number): number {
    camera.updateMatrixWorld()
    turn.set(rx, ry, 0)
    const [lo, hi] = spec.bounds
    for (let pass = 0; pass < 4; pass++) {
      let worst = 0
      for (let k = 0; k < 8; k++) {
        corner.set(k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]).sub(target).multiplyScalar(s).applyEuler(turn).add(target).project(camera)
        worst = Math.max(worst, Math.abs(corner.x), Math.abs(corner.y))
      }
      if (worst <= FRAME) break
      s *= FRAME / worst
    }
    // Labels keep at least 11 px however small the scene, so one hanging off the side pulls the scene in by its anchor.
    if (!size.height) return s
    for (let pass = 0; pass < 4; pass++) {
      let k = 1
      for (const l of labels) {
        if (!l.fit || !l.text()) continue
        corner.copy(l.sprite.position).sub(target).multiplyScalar(s).applyEuler(turn).add(target)
        const { height } = visibleSize(FOV, camera.aspect, camera.position.distanceTo(corner))
        corner.project(camera)
        const hPx = Math.max((l.size * s / height) * size.height, MIN_LABEL_PX * LABEL_LEADING)
        const hN = (hPx / size.height) * 2
        const wN = hN * l.aspect / camera.aspect
        const reach = (anchor: number, before: number, after: number) => {
          if (anchor > 0 && anchor + after > FRAME) return Math.max(0.5, (FRAME - after) / anchor)
          if (anchor < 0 && anchor - before < -FRAME) return Math.max(0.5, (FRAME - before) / -anchor)
          return 1
        }
        k = Math.min(k, reach(corner.x, l.sprite.center.x * wN, (1 - l.sprite.center.x) * wN), reach(corner.y, l.sprite.center.y * hN, (1 - l.sprite.center.y) * hN))
      }
      if (k >= 0.999) break
      s *= k
    }
    return s
  }
  function place() {
    // Labels the fit makes room for move with their data, so where they stand is part of the key.
    const room = labels.filter(l => l.fit).map(l => `${l.sprite.position.x.toFixed(2)},${l.sprite.position.y.toFixed(2)},${l.aspect.toFixed(2)}`).join(';')
    const key = `${size.fit}:${size.height}:${spin.x}:${spin.y}:${room}`
    if (key === fitted) return
    fitted = key
    pivot.rotation.set(spin.x, spin.y, 0)
    size.scale = turnedFit(size.fit, spin.x, spin.y)
    pivot.scale.setScalar(size.scale)
  }

  function frame() {
    raf = 0
    if (disposed) return
    if (dirty) {
      resize()
      dirty = false
    }
    const time = now()
    const t = phase.state === 'error' ? frozenT : (reduced ? 0 : (time - born) / 1000)
    if (phase.state !== 'error') frozenT = t
    const p = phase.state === 'ready' ? progressAt(phase.readyAt, time, reduced) : 0
    const tween = tweenAt(phase.tweenAt, time, reduced)
    spin = stepSpin(spin, reduced)
    place()
    wants = draw({ t, state: phase.state, p, tween, reduced, inkVersion }) === true
    place()
    // Labels move with their data and the turn; each is sized for where it stands this frame, then the crowded ones give way.
    pivot.updateMatrixWorld(true)
    for (const l of labels) scaleLabel(l)
    declutter()
    renderer.render(scene, camera)
    lastP = p
    if (animating(time)) schedule()
  }

  /**
   * Whether another frame changes anything: the loading wave, the sweep, a
   * refresh's tween, a spin still moving, or the chart's own motion. A still
   * chart draws nothing until something changes.
   */
  function animating(time: number): boolean {
    if (!visible || disposed) return false
    if (dirty || spinMoving(spin) || wants) return true
    if (phase.state === 'loading') return !reduced
    return phase.state === 'ready' && (lastP < 1 || tweenAt(phase.tweenAt, time, reduced) < 1)
  }

  function schedule() {
    if (!raf && !disposed && visible) raf = requestAnimationFrame(frame)
  }
  /** One more frame, e.g. after a label redraw; a resize sets `dirty` itself. */
  const invalidate = () => schedule()
  const refit = () => {
    dirty = true
    schedule()
  }

  const resizeObserver = typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver(() => {
        dirty = true
        schedule()
      })
  resizeObserver?.observe(container)
  // Off screen nothing renders; the sweep runs on the wall clock, so it is done by the time the chart scrolls in.
  const intersection = typeof IntersectionObserver === 'undefined'
    ? null
    : new IntersectionObserver((entries) => {
        visible = entries.some(e => e.isIntersecting)
        if (visible) {
          dirty = true
          schedule()
        }
      })
  intersection?.observe(container)

  // Drag to spin. A touch that turns into a vertical scroll is cancelled by the browser (pan-y), which ends the drag.
  let grab: { id: number, x: number, y: number, tip: boolean } | null = null
  const onDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    grab = { id: e.pointerId, x: e.clientX, y: e.clientY, tip: e.pointerType === 'mouse' }
    spin = { ...spin, vy: 0, homing: false }
    canvas.setPointerCapture?.(e.pointerId)
    canvas.style.cursor = 'grabbing'
  }
  const onMove = (e: PointerEvent) => {
    if (!grab || e.pointerId !== grab.id) return
    spin = dragSpin(spin, e.clientX - grab.x, e.clientY - grab.y, grab.tip)
    grab.x = e.clientX
    grab.y = e.clientY
    schedule()
  }
  const onUp = (e: PointerEvent) => {
    if (!grab || e.pointerId !== grab.id) return
    grab = null
    spin = releaseSpin(spin, reduced)
    canvas.style.cursor = 'grab'
    schedule()
  }
  const onHome = () => {
    spin = { ...spin, vy: 0, homing: true }
    schedule()
  }
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onUp)
  canvas.addEventListener('dblclick', onHome)

  const recolor = () => {
    inks = resolveInks(container)
    inkVersion++
    for (const t of tinted) t.material.color.copy(inks[t.ink])
    for (const l of labels) l.redraw()
    invalidate()
  }
  const theme = typeof MutationObserver === 'undefined' ? null : new MutationObserver(recolor)
  theme?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })

  container.appendChild(canvas)
  env.inspect?.(scene, camera)
  schedule()

  return {
    THREE,
    scene,
    root,
    camera,
    canvas,
    inks: () => inks,
    tint,
    label,
    line,
    dashed,
    segments,
    ring,
    dot,
    plane,
    invalidate: refit,
    /** For tests: run one frame now. */
    step: frame,
    setState: (s: VizState) => {
      phase = nextPhase(phase, { kind: 'state', state: s }, now())
      refit()
    },
    dataArrived: () => {
      phase = nextPhase(phase, { kind: 'data' }, now())
      refit()
    },
    phase: () => phase,
    /** For tests: how the chart is turned now. */
    spin: () => spin,
    dispose: () => {
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      resizeObserver?.disconnect()
      intersection?.disconnect()
      theme?.disconnect()
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('dblclick', onHome)
      scene.traverse((o) => {
        const m = o as THREE.Mesh
        m.geometry?.dispose()
        const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : []
        for (const mat of mats) {
          ;(mat as THREE.SpriteMaterial).map?.dispose()
          mat.dispose()
        }
      })
      renderer.dispose()
      // Hand the context back now rather than at garbage collection, so page after page never hits the browser's cap.
      renderer.forceContextLoss()
      canvas.remove()
    },
  }
}

/**
 * A series drawn as a ribbon: a translucent fill from the floor up to the
 * line, and the line on top, along x from `x0` for `width` at depth `z`.
 * While loading it is the grey travelling wave; on data each point eases into
 * its value (and its colour) a beat after the one to its left; a refresh
 * tweens old values to new. Gaps (NaN) fold down to the floor and fade out.
 */
export function ribbon(base: Base, o: { x0: number, width: number, z: number, height: number, ink: Ink, fill?: number, n?: number }) {
  const { THREE: T } = base
  const fillAlpha = o.fill ?? 0.22
  let n = 0
  let target: number[] = []
  let from: number[] = []
  let shown: number[] = []
  let dimFrom = Infinity
  let tailFrom = Infinity
  let tailInk: Ink = 'blue'
  let ink: Ink = o.ink
  let settled = false
  let painted = -1
  const fillGeo = new T.BufferGeometry()
  const lineGeo = new T.BufferGeometry()
  const fill = new T.Mesh(fillGeo, new T.MeshBasicMaterial({ vertexColors: true, transparent: true, side: T.DoubleSide, depthWrite: false }))
  const top = new T.Line(lineGeo, new T.LineBasicMaterial({ vertexColors: true, transparent: true }))
  fill.renderOrder = 1
  top.renderOrder = 2
  base.root.add(fill, top)

  function build(count: number) {
    n = Math.max(2, count)
    fillGeo.setAttribute('position', new T.BufferAttribute(new Float32Array(n * 6), 3))
    fillGeo.setAttribute('color', new T.BufferAttribute(new Float32Array(n * 8), 4))
    const index: number[] = []
    for (let i = 0; i < n - 1; i++) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2)
    fillGeo.setIndex(index)
    lineGeo.setAttribute('position', new T.BufferAttribute(new Float32Array(n * 3), 3))
    lineGeo.setAttribute('color', new T.BufferAttribute(new Float32Array(n * 4), 4))
    shown = resampleArray(shown, n)
    from = resampleArray(from, n)
    target = resampleArray(target, n)
  }
  build(o.n ?? 96)

  const c = new T.Color()
  return {
    fill,
    top,
    /** `dimFrom`: from this index on it's a plan, drawn dimmer. `tailFrom`: from this index on it's drawn in `tailInk`. */
    setValues(values: number[], opts: { dimFrom?: number, ink?: Ink, tailFrom?: number, tailInk?: Ink } = {}) {
      const next = Math.max(2, values.length)
      // The old values, at the new length, are where a refresh tweens from.
      const old = resampleArray(shown, next)
      if (next !== n) build(next)
      from = old
      target = values.length >= 2 ? [...values] : resampleArray(values, n)
      dimFrom = opts.dimFrom ?? Infinity
      tailFrom = opts.tailFrom ?? Infinity
      tailInk = opts.tailInk ?? 'blue'
      if (opts.ink) ink = opts.ink
      settled = false
    },
    /** The value shown at fraction `x` (0..1) along the ribbon, in world y; in a gap, the last value before it. */
    yAt(x: number) {
      for (let i = Math.round(clamp01(x) * (n - 1)); i >= 0; i--) {
        const v = shown[i] as number
        if (Number.isFinite(v)) return v * o.height
      }
      return 0
    },
    update(f: Frame) {
      if (settled && painted === f.inkVersion && f.state === 'ready' && f.p >= 1 && f.tween >= 1) return
      painted = f.inkVersion
      const inks = base.inks()
      const grey = inks.skeleton
      const color = inks[ink]
      const pos = fillGeo.getAttribute('position') as THREE.BufferAttribute
      const col = fillGeo.getAttribute('color') as THREE.BufferAttribute
      const lpos = lineGeo.getAttribute('position') as THREE.BufferAttribute
      const lcol = lineGeo.getAttribute('color') as THREE.BufferAttribute
      for (let i = 0; i < n; i++) {
        const x = o.x0 + (i / (n - 1)) * o.width
        const wave = waveY(i, n, f.t)
        let y = wave
        let alpha = 1
        let mix = 0
        if (f.state === 'empty') {
          y = 0.004
          alpha = 0.6
        }
        else if (f.state === 'error') {
          alpha = 0.35
        }
        else if (f.state === 'ready') {
          const e = pointEase(f.p, i, n)
          const to = target[i] as number
          const was = from[i] as number
          const v = Number.isFinite(to) ? (Number.isFinite(was) ? lerp(was, to, f.tween) : to) : Number.NaN
          if (Number.isFinite(v)) {
            y = lerp(wave, v, e)
            shown[i] = v
          }
          else {
            y = wave * (1 - e)
            alpha = 1 - e
            shown[i] = Number.NaN
          }
          mix = e * (i >= dimFrom ? 0.5 : 1)
        }
        c.copy(grey).lerp(i >= tailFrom ? inks[tailInk] : color, mix)
        const yy = y * o.height
        pos.setXYZ(i * 2, x, yy, o.z)
        pos.setXYZ(i * 2 + 1, x, 0, o.z)
        col.setXYZW(i * 2, c.r, c.g, c.b, alpha * fillAlpha)
        col.setXYZW(i * 2 + 1, c.r, c.g, c.b, alpha * fillAlpha * 0.15)
        lpos.setXYZ(i, x, yy, o.z)
        lcol.setXYZW(i, c.r, c.g, c.b, alpha)
      }
      pos.needsUpdate = true
      col.needsUpdate = true
      lpos.needsUpdate = true
      lcol.needsUpdate = true
      fillGeo.computeBoundingSphere()
      lineGeo.computeBoundingSphere()
      settled = f.state === 'ready' && f.p >= 1 && f.tween >= 1
    },
  }
}

export type Ribbon = ReturnType<typeof ribbon>

/** A floor grid: lines across the depth at each x, and along x at each z. */
export function floorGrid(base: Base, o: { x0: number, x1: number, z0: number, z1: number, xs: number[], zs: number[], y?: number }) {
  const y = o.y ?? 0
  return base.segments([
    ...o.xs.map(x => [[x, y, o.z0], [x, y, o.z1]] as [[number, number, number], [number, number, number]]),
    ...o.zs.map(z => [[o.x0, y, z], [o.x1, y, z]] as [[number, number, number], [number, number, number]]),
  ], 'grid')
}

/** The colour of an ink part-way from the skeleton grey, as hex for a material. */
export function inkMix(base: Base, ink: Ink, e: number, out: THREE.Color): THREE.Color {
  const inks = base.inks()
  return out.copy(inks.skeleton).lerp(inks[ink], clamp01(e))
}
