/**
 * The shared base under every 3D chart: a transparent renderer filling its
 * card, a fixed perspective camera, the scene fitted to the card's width, a
 * loop that runs only while the chart is on screen, pointer parallax with an
 * idle sway, theme colours from the app's tokens, canvas-texture labels kept
 * at least 11 px tall, and the building blocks (ribbon, line, floor grid,
 * ring, dot) the five charts are made of. Unlit materials only: no lights, no
 * shadows. Loaded with `import()` so three.js stays in its own chunk.
 */
import * as THREE from 'three'
import { clamp01, initialPhase, lerp, nextPhase, progressAt, tweenAt, visibleSize, waveY, fitScale, labelHeight, pointEase, type Phase, type VizState } from './motion'
import { resampleArray, type Tone } from './shape'

/** Every factory returns this. */
export interface Viz<D> {
  setState: (s: VizState) => void
  /** Stores the data, then shows it: the sweep on first data, a tween on a refresh. */
  setData: (data: D) => void
  setParallax: (on: boolean) => void
  /** Cancels the loop, disconnects observers and frees the GL context. */
  dispose: () => void
}

export type Ink = Tone | 'skeleton' | 'grid' | 'fg1' | 'fg2' | 'fg3' | 'tank'

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
  /** The box the chart and its labels fill, so it can be kept in frame at the parallax's furthest tilt. */
  bounds: [[number, number, number], [number, number, number]]
}

/** The furthest the pointer and the sway together turn a chart (radians). */
const MAX_TILT = { x: 0.09 + 0.015, y: 0.25 + 0.05 }
/** How much of the canvas the tilted bounds may reach, in device coordinates. */
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

export function createBase(container: HTMLElement, spec: BaseSpec, draw: (frame: Frame) => void, env: Env = {}) {
  const now = env.now ?? (() => performance.now())
  const renderer = env.renderer ? env.renderer() : new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
  const canvas = renderer.domElement
  canvas.setAttribute('aria-hidden', 'true')
  Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%', position: 'absolute', inset: '0' })
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
  let parallax = !reduced
  const tilt = { x: 0, y: 0, tx: 0, ty: 0 }
  let visible = typeof IntersectionObserver === 'undefined'
  let dirty = true
  let raf = 0
  let disposed = false
  let lastP = -1
  let inkVersion = 0
  const size = { width: 0, height: 0, scale: 1 }

  // ── Materials that follow the theme ────────────────────────────────────
  const tinted: Array<{ material: THREE.Material & { color: THREE.Color }, ink: Ink }> = []
  const tint = <M extends THREE.Material & { color: THREE.Color }>(material: M, ink: Ink): M => {
    material.color.copy(inks[ink])
    tinted.push({ material, ink })
    return material
  }

  // ── Labels ─────────────────────────────────────────────────────────────
  interface LabelEntry { sprite: THREE.Sprite, size: number, aspect: number, priority: number, redraw: () => void, wanted: () => boolean }
  const labels: LabelEntry[] = []
  let fontsReady = typeof document === 'undefined' || !document.fonts
  const font = `500 ${LABEL_FONT_PX}px "IBM Plex Mono", ui-monospace, monospace`

  /** A text sprite; where labels collide on screen, the higher `priority` (then the older) stays and the other hides. */
  const label = (text: string, o: { ink?: Ink, size?: number, align?: 'left' | 'center' | 'right', valign?: 'top' | 'middle' | 'bottom', priority?: number } = {}): Label => {
    const c = document.createElement('canvas')
    const texture = new THREE.CanvasTexture(c)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.minFilter = THREE.LinearFilter
    texture.generateMipmaps = false
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false })
    const sprite = new THREE.Sprite(material)
    sprite.center.set(o.align === 'left' ? 0 : o.align === 'right' ? 1 : 0.5, o.valign === 'top' ? 1 : o.valign === 'bottom' ? 0 : 0.5)
    sprite.renderOrder = 10
    const entry: LabelEntry = { sprite, size: o.size ?? 0.22, aspect: 1, priority: o.priority ?? 1, redraw: () => {}, wanted: () => shown && fontsReady && current.length > 0 }
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
    size.scale = tiltFit(fitScale(vis.width, spec.need))
    pivot.scale.setScalar(size.scale)
    pivot.updateMatrixWorld(true)
    for (const l of labels) scaleLabel(l)
  }

  const corner = new THREE.Vector3()
  const turn = new THREE.Euler()
  /** Shrinks `s` until the bounds' corners stay in frame at every extreme tilt (only ever shrinks, as `need` does). */
  function tiltFit(s: number): number {
    if (!parallax) return s
    camera.updateMatrixWorld()
    const [lo, hi] = spec.bounds
    for (let pass = 0; pass < 4; pass++) {
      let worst = 0
      for (const tx of [-MAX_TILT.x, MAX_TILT.x]) {
        for (const ty of [-MAX_TILT.y, MAX_TILT.y]) {
          turn.set(tx, ty, 0)
          for (let k = 0; k < 8; k++) {
            corner.set(k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]).sub(target).multiplyScalar(s).applyEuler(turn).add(target).project(camera)
            worst = Math.max(worst, Math.abs(corner.x), Math.abs(corner.y))
          }
        }
      }
      if (worst <= FRAME) break
      s *= FRAME / worst
    }
    return s
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
    // Pointer tilt eases 6% a frame; a slow sway keeps a still chart alive.
    const sway = parallax ? { x: Math.sin(t * 0.23) * 0.015, y: Math.sin(t * 0.31) * 0.05 } : { x: 0, y: 0 }
    tilt.x += ((parallax ? tilt.tx : 0) - tilt.x) * 0.06
    tilt.y += ((parallax ? tilt.ty : 0) - tilt.y) * 0.06
    pivot.rotation.set(tilt.x + sway.x, tilt.y + sway.y, 0)
    draw({ t, state: phase.state, p, tween, reduced, inkVersion })
    // Labels move with their data and the tilt; each is sized for where it stands this frame, then the crowded ones give way.
    pivot.updateMatrixWorld(true)
    for (const l of labels) scaleLabel(l)
    declutter()
    renderer.render(scene, camera)
    lastP = p
    if (animating(time)) schedule()
  }

  /** Whether another frame changes anything: always with motion, and with reduced motion only while something is dirty. */
  function animating(time: number): boolean {
    if (!visible) return false
    if (!reduced) return true
    return dirty || (phase.state === 'ready' && (lastP < 1 || tweenAt(phase.tweenAt, time, reduced) < 1))
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

  const onPointer = (e: PointerEvent) => {
    if (!parallax || e.pointerType === 'touch') return
    const r = container.getBoundingClientRect()
    if (!r.width || !r.height) return
    const nx = clamp01((e.clientX - r.left) / r.width) * 2 - 1
    const ny = clamp01((e.clientY - r.top) / r.height) * 2 - 1
    tilt.ty = nx * 0.25
    tilt.tx = ny * 0.09
  }
  const onLeave = () => {
    tilt.tx = 0
    tilt.ty = 0
  }
  container.addEventListener('pointermove', onPointer)
  container.addEventListener('pointerleave', onLeave)

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
    setParallax: (on: boolean) => {
      parallax = on && !reduced
      if (!parallax) onLeave()
      refit()
    },
    dispose: () => {
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      resizeObserver?.disconnect()
      intersection?.disconnect()
      theme?.disconnect()
      container.removeEventListener('pointermove', onPointer)
      container.removeEventListener('pointerleave', onLeave)
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
    setValues(values: number[], opts: { dimFrom?: number, ink?: Ink } = {}) {
      const next = Math.max(2, values.length)
      // The old values, at the new length, are where a refresh tweens from.
      const old = resampleArray(shown, next)
      if (next !== n) build(next)
      from = old
      target = values.length >= 2 ? [...values] : resampleArray(values, n)
      dimFrom = opts.dimFrom ?? Infinity
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
        c.copy(grey).lerp(color, mix)
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
