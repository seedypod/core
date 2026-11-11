// @vitest-environment jsdom
/**
 * The five charts on three.js's real scene graph with a stand-in renderer
 * (jsdom has no WebGL): what each draws while loading, after data, and in
 * its empty and error states; that nothing projects outside the canvas at
 * card widths from 340 to 1200 px; and that no label is under 11 px.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import type { Env, Viz } from '../base'
import { createLightViz, createPodsViz, createSensorsViz, createTankViz, createTodayViz } from '../scenes'
import { DAY_TICKS, type LightData, type PodsData, type SensorsData, type TankData, type TodayData } from '../shape'

const state = vi.hoisted(() => ({ renders: 0, lost: 0, disposed: 0, clock: 0 }))

class FakeRenderer {
  domElement = document.createElement('canvas')
  setPixelRatio() {}
  setSize() {}
  setClearColor() {}
  render() {
    state.renders++
  }

  dispose() {
    state.disposed++
  }

  forceContextLoss() {
    state.lost++
  }
}

let frames: FrameRequestCallback[] = []
let made: { scene: THREE.Scene, camera: THREE.PerspectiveCamera } | null = null
const env: Env = {
  renderer: () => new FakeRenderer() as unknown as THREE.WebGLRenderer,
  now: () => state.clock,
  inspect: (scene, camera) => {
    made = { scene, camera }
  },
}

/** Runs queued animation frames, `ms` apart. */
function advance(ms: number, count = 1) {
  for (let i = 0; i < count; i++) {
    state.clock += ms
    const run = frames
    frames = []
    run.forEach(cb => cb(state.clock))
  }
}

let host: HTMLDivElement
function sized(width: number, aspect: number) {
  host = document.createElement('div')
  Object.defineProperty(host, 'clientWidth', { configurable: true, get: () => width })
  Object.defineProperty(host, 'clientHeight', { configurable: true, get: () => Math.round(width / aspect) })
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width, height: width / aspect, right: width, bottom: width / aspect, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  document.body.appendChild(host)
  return host
}

beforeEach(() => {
  Object.assign(state, { renders: 0, lost: 0, disposed: 0, clock: 0 })
  frames = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames = []
  })
  // A 2D context that measures every glyph at 0.6 em, as a monospace face does.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return {
      font: '48px mono',
      fillStyle: '#000000',
      textBaseline: 'middle',
      measureText: (t: string) => ({ width: t.length * 48 * 0.6 }),
      clearRect: () => {},
      fillRect: () => {},
      fillText: () => {},
      getImageData: () => ({ data: [200, 190, 170, 255] }),
    } as unknown as CanvasRenderingContext2D
  } as never)
})
afterEach(() => {
  host?.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function ramp<T>(n: number, f: (i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => f(i))
}

const TODAY: TodayData = {
  now: 0.75,
  lanes: [
    { key: 'light', label: 'Light', sub: '0–100%', tone: 'amber', values: ramp(97, i => (i > 28 && i < 84 ? 0.8 : 0)), dimFrom: 73 },
    { key: 'water', label: 'Water', sub: 'tank 20–60%', tone: 'blue', values: ramp(97, i => (i < 73 ? 0.5 - i / 400 : Number.NaN)) },
    { key: 'air', label: 'Air', sub: '20–28°C', tone: 'cream', values: ramp(97, i => (i < 73 ? 0.5 + 0.3 * Math.sin(i / 10) : Number.NaN)) },
  ],
  events: [
    { at: 0.33, tone: 'green', label: 'Pump' },
    { at: 0.34, tone: 'orange', label: 'Water low' },
    { at: 0.6, tone: 'amber', label: 'Warm day' },
    { at: 0.9, tone: 'muted', label: '' },
  ],
  ticks: DAY_TICKS,
}
const TANK: TankData = { levels: ramp(120, i => 0.8 - (i % 40) / 100), topUps: [40 / 119, 80 / 119], cutoff: 0.3, current: 0.4, ticks: ramp(5, k => ({ at: k / 4, label: ['Mon', 'Tue', 'Thu', 'Sat', 'Sun'][k] as string })), marks: { full: 'full · 2 in', now: 'now · 5.1 in', cutoff: 'cutoff 27% · 6.3 in', empty: 'empty · 7.9 in' }, pumping: true, runFrom: 0.9, runs: [0.2, 0.5, 0.8], upcoming: [0.3, 0.7], preview: [0.33, 0.58, 0.83] }
const LIGHT: LightData = { planned: ramp(97, i => (i > 28 && i < 84 ? 0.9 : 0)), actual: ramp(97, i => (i < 60 ? (i > 28 ? 0.9 : 0) : Number.NaN)), hold: { from: 0.55, until: 0.65 }, now: 0.62, nowLevel: 0.45, nowTime: '14:52', boost: 0.95, ticks: DAY_TICKS }
const PODS: PodsData = { towers: ['A', 'B', 'C'].map((l, t) => ({ label: `Tower ${l}`, pods: ramp(10, k => ((t * 10 + k) % 4 === 0 ? null : ((t * 10 + k) % 10) / 10)) })) }
const SENSORS: SensorsData = {
  series: ['Air temperature', 'Humidity', 'Board temperature', 'Distance to water', 'Tank', 'Pump voltage', 'Pump current', 'Pump power'].map((label, k) => ({ key: `s${k}`, label, group: k < 3 ? 'environment' : k < 5 ? 'water' : 'pump', values: ramp(100, i => 0.5 + 0.4 * Math.sin(i / 8 + k)), current: '25.9 °C' })),
  ticks: [{ at: 0, label: '−24h' }, { at: 0.5, label: '−12h' }, { at: 1, label: 'now' }],
}

/** A pointer event as a mouse sends it (jsdom has no PointerEvent). */
function pointer(target: EventTarget, type: string, x: number, y: number, pointerType = 'mouse') {
  target.dispatchEvent(Object.assign(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }), { pointerId: 1, pointerType }))
}

interface Case<D> { name: string, make: (el: HTMLElement, env: Env) => Viz<D>, aspect: number, data: D }
const CASES = [
  { name: 'today', make: createTodayViz, aspect: 3, data: TODAY },
  { name: 'tank', make: createTankViz, aspect: 2, data: TANK },
  { name: 'light', make: createLightViz, aspect: 2, data: LIGHT },
  { name: 'pods', make: createPodsViz, aspect: 2.4, data: PODS },
  { name: 'sensors', make: createSensorsViz, aspect: 2.5, data: SENSORS },
] as Array<Case<unknown>>

/** The scene graph behind the newest viz. */
function sceneOf(): { scene: THREE.Scene, camera: THREE.PerspectiveCamera } {
  if (!made) throw new Error('no viz made')
  return made
}

/** Every visible thing's extent in normalised device coordinates, and the smallest label on screen in px. */
function measure(width: number, height: number) {
  const { scene, camera } = sceneOf()
  scene.updateMatrixWorld(true)
  camera.updateMatrixWorld()
  let lo = { x: Infinity, y: Infinity }
  let hi = { x: -Infinity, y: -Infinity }
  let minLabelPx = Infinity
  const boxes: Array<[number, number, number, number]> = []
  const v = new THREE.Vector3()
  const grow = (x: number, y: number) => {
    lo = { x: Math.min(lo.x, x), y: Math.min(lo.y, y) }
    hi = { x: Math.max(hi.x, x), y: Math.max(hi.y, y) }
  }
  const visible = (o: THREE.Object3D) => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false
    return true
  }
  scene.traverse((o) => {
    if (!visible(o)) return
    if (o instanceof THREE.Sprite) {
      o.getWorldPosition(v)
      const dist = camera.position.distanceTo(v)
      const visH = 2 * dist * Math.tan((camera.fov * Math.PI) / 360)
      const s = new THREE.Vector3()
      o.getWorldScale(s)
      const hPx = (s.y / visH) * height
      minLabelPx = Math.min(minLabelPx, hPx / 1.35)
      v.project(camera)
      const hN = (s.y / visH) * 2
      const wN = (s.x / (visH * camera.aspect)) * 2
      const left = v.x - o.center.x * wN
      const bottom = v.y - o.center.y * hN
      // The text's box in px, inside the canvas's padding.
      const pad = (hPx * (1 - 1 / 1.35)) / 2
      boxes.push([((left + 1) / 2) * width, ((1 - bottom - hN) / 2) * height + pad, ((left + wN + 1) / 2) * width, ((1 - bottom) / 2) * height - pad])
      grow(left, bottom)
      grow(left + wN, bottom + hN)
      return
    }
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
    const pos = g?.getAttribute?.('position')
    if (!pos) return
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).project(camera)
      grow(v.x, v.y)
    }
  })
  const overlaps = boxes.flatMap((a, i) => boxes.slice(i + 1).filter(b => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]).map(b => [a, b]))
  return { lo, hi, minLabelPx, width, height, overlaps: overlaps.length }
}

describe.each(CASES)('$name chart', ({ make, aspect, data }) => {
  it.each([340, 600, 1200])('fits a %i px card with every label at least 11 px', (width) => {
    const el = sized(width, aspect)
    const viz = make(el, env)
    viz.setData(data)
    advance(16)
    advance(200, 10)
    const m = measure(width, Math.round(width / aspect))
    if (process.env.VIZ_MEASURE) console.log(JSON.stringify(m))
    expect(m.lo.x).toBeGreaterThanOrEqual(-1)
    expect(m.hi.x).toBeLessThanOrEqual(1)
    expect(m.lo.y).toBeGreaterThanOrEqual(-1)
    expect(m.hi.y).toBeLessThanOrEqual(1)
    expect(m.minLabelPx).toBeGreaterThanOrEqual(10.99)
    // Crowded labels give way rather than print over each other.
    expect(m.overlaps).toBe(0)
    viz.dispose()
  })

  it.each([[340, 60, 0], [340, 157, 40], [1200, -300, -40], [1200, 90, 0]])('still fits a %i px card spun by a %i px drag (and %i px up or down)', (width, dx, dy) => {
    const el = sized(width, aspect)
    const viz = make(el, env)
    viz.setData(data)
    const canvas = el.querySelector('canvas') as HTMLCanvasElement
    pointer(canvas, 'pointerdown', 100, 50)
    pointer(canvas, 'pointermove', 100 + dx, 50 + dy)
    advance(16, 3)
    const m = measure(width, Math.round(width / aspect))
    expect(Math.max(-m.lo.x, m.hi.x, -m.lo.y, m.hi.y)).toBeLessThanOrEqual(1)
    expect(m.minLabelPx).toBeGreaterThanOrEqual(10.99)
    viz.dispose()
  })

  it('renders frames while loading, then every state, and frees its context on dispose', () => {
    const el = sized(600, aspect)
    const viz = make(el, env)
    advance(16, 3)
    expect(state.renders).toBe(3)
    expect(el.querySelector('canvas')).toBeTruthy()
    viz.setState('empty')
    advance(16)
    viz.setState('error')
    advance(16, 2)
    viz.setState('loading')
    advance(16)
    viz.setData(data)
    advance(16)
    advance(700, 3)
    // A refresh tweens rather than restarting the sweep.
    viz.setData(data)
    advance(100, 8)
    const canvas = el.querySelector('canvas') as HTMLCanvasElement
    pointer(canvas, 'pointerdown', 10, 10)
    pointer(canvas, 'pointermove', 60, 10)
    pointer(canvas, 'pointerup', 60, 10)
    canvas.dispatchEvent(new MouseEvent('dblclick'))
    advance(16)
    const before = state.renders
    viz.dispose()
    advance(16, 3)
    expect(state.renders).toBe(before)
    expect(state.disposed).toBe(1)
    expect(state.lost).toBe(1)
    expect(el.querySelector('canvas')).toBeNull()
  })
})

describe('scenes sized by their data', () => {
  const visibleSprites = () => {
    const { scene } = sceneOf()
    scene.updateMatrixWorld(true)
    let n = 0
    scene.traverse((o) => {
      let on = true
      for (let p: THREE.Object3D | null = o; p; p = p.parent) on &&= p.visible
      if (o instanceof THREE.Sprite && on) n++
    })
    return n
  }

  it('draws a Studio as two columns of 8, and back to three for a Home', () => {
    const el = sized(600, 2.4)
    const viz = createPodsViz(el, env)
    viz.setData({ towers: [{ label: 'Tower A', pods: Array(8).fill(0.4) }, { label: 'Tower B', pods: Array(8).fill(null) }] })
    advance(16)
    advance(700, 3)
    // Two tower labels, no third.
    expect(visibleSprites()).toBe(2)
    const { scene } = sceneOf()
    const spheres = () => scene.getObjectsByProperty('type', 'Mesh').filter(m => (m as THREE.Mesh).geometry instanceof THREE.SphereGeometry && m.visible && m.parent?.visible)
    expect(spheres()).toHaveLength(16)
    viz.setData(PODS)
    advance(700, 3)
    expect(visibleSprites()).toBe(3)
    expect(spheres()).toHaveLength(30)
    viz.dispose()
  })

  it('fits eleven sensor rows in the frame, and hides the readings of rows a shorter list drops', () => {
    const el = sized(600, 2.5)
    const viz = createSensorsViz(el, env)
    const eleven = { ...SENSORS, series: [...SENSORS.series, ...SENSORS.series.slice(0, 3).map((r, i) => ({ ...r, key: `x${i}`, label: ['pH', 'EC', 'Water temperature'][i] as string }))] }
    viz.setData(eleven)
    advance(16)
    advance(700, 3)
    const m = measure(600, 240)
    expect(Math.max(-m.lo.x, m.hi.x, -m.lo.y, m.hi.y)).toBeLessThanOrEqual(1)
    viz.setData({ ...SENSORS, series: SENSORS.series.slice(0, 3) })
    advance(700, 3)
    // Three names, three readings and three ticks at most; nothing left over from the eleven.
    expect(visibleSprites()).toBeLessThanOrEqual(9)
    viz.dispose()
  })
})

describe('the shared base', () => {
  it('stops rendering off screen and resumes, done loading, when scrolled in', () => {
    let seen: (entries: Array<{ isIntersecting: boolean }>) => void = () => {}
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: typeof seen) {
        seen = cb
      }

      observe() {}
      disconnect() {}
    })
    const el = sized(600, 2)
    const viz = createTankViz(el, env)
    seen([{ isIntersecting: false }])
    viz.setData(TANK)
    advance(16, 3)
    expect(state.renders).toBe(0)
    // The sweep runs on the wall clock: 2 s later, scrolled in, the first frame is the finished chart.
    state.clock += 2000
    seen([{ isIntersecting: true }])
    advance(16)
    expect(state.renders).toBe(1)
    const { scene } = sceneOf()
    const water = scene.getObjectsByProperty('type', 'Mesh').find(o => (o as THREE.Mesh).geometry instanceof THREE.CylinderGeometry && ((o as THREE.Mesh).geometry as THREE.CylinderGeometry).parameters.openEnded === false)
    // 40% of the 2.6-unit glass.
    expect(water?.scale.y).toBeCloseTo(0.4 * 2.6, 2)
    viz.dispose()
  })

  it('spins with a drag, coasts after release, stops drawing once still, and goes home on a double click', () => {
    const el = sized(600, 3)
    const viz = createTodayViz(el, env)
    viz.setData(TODAY)
    advance(700, 3)
    // Settled with nothing moving, the loop stops.
    advance(16, 2)
    expect(frames).toHaveLength(0)
    const canvas = el.querySelector('canvas') as HTMLCanvasElement
    expect(canvas.style.touchAction).toBe('pan-y')
    pointer(canvas, 'pointerdown', 100, 50)
    expect(canvas.style.cursor).toBe('grabbing')
    pointer(canvas, 'pointermove', 160, 50)
    // Another pointer's moves don't turn it.
    canvas.dispatchEvent(Object.assign(new MouseEvent('pointermove', { clientX: 900 }), { pointerId: 2, pointerType: 'touch' }))
    advance(16)
    const { scene } = sceneOf()
    const pivot = scene.children[0] as THREE.Object3D
    expect(pivot.rotation.y).toBeCloseTo(0.6)
    pointer(canvas, 'pointerup', 160, 50)
    advance(16)
    expect(pivot.rotation.y).toBeGreaterThan(0.6)
    advance(16, 200)
    expect(frames).toHaveLength(0)
    canvas.dispatchEvent(new MouseEvent('dblclick'))
    advance(16, 100)
    expect(pivot.rotation.y).toBe(0)
    // A right click doesn't grab.
    canvas.dispatchEvent(Object.assign(new MouseEvent('pointerdown', { button: 2 }), { pointerId: 1, pointerType: 'mouse' }))
    expect(canvas.style.cursor).toBe('grab')
    viz.dispose()
  })

  it('keeps drawing while the pump runs, for the tank\'s flow cue', () => {
    const el = sized(600, 2)
    const viz = createTankViz(el, env)
    viz.setData({ ...TANK, pumping: true })
    advance(700, 3)
    advance(16, 5)
    expect(frames).toHaveLength(1)
    viz.setData({ ...TANK, pumping: false })
    advance(700, 3)
    advance(16, 2)
    expect(frames).toHaveLength(0)
    viz.dispose()
  })

  it('renders only on change with reduced motion: a still skeleton, no sweep', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), addEventListener() {}, removeEventListener() {} }))
    const el = sized(600, 2)
    const viz = createLightViz(el, env)
    advance(16, 5)
    expect(state.renders).toBe(1)
    viz.setData(LIGHT)
    advance(16, 5)
    // The data, then once more as the lamp's words land and refit; then nothing.
    const settled = state.renders
    expect(settled).toBeLessThanOrEqual(3)
    advance(16, 10)
    expect(state.renders).toBe(settled)
    viz.dispose()
  })

  it('recolours from the theme tokens when the theme changes', async () => {
    const el = sized(600, 2)
    const viz = createLightViz(el, env)
    advance(16)
    document.documentElement.dataset.theme = 'light'
    await new Promise(r => setTimeout(r, 0))
    advance(16)
    expect(state.renders).toBeGreaterThanOrEqual(2)
    delete document.documentElement.dataset.theme
    viz.dispose()
  })
})
