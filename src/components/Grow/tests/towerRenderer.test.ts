// @vitest-environment jsdom
/**
 * The renderer with three.js's real scene, camera and raycaster, and a stand-in
 * WebGLRenderer (jsdom has no WebGL). Picking runs the real ray maths: the test
 * aims the pointer at a pod or part by projecting where it sits on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ThreeModule from 'three'
import type { TowerTarget } from '../towerScene'

const { renders } = vi.hoisted(() => ({ renders: { count: 0 } }))

vi.mock('three', async (orig) => {
  const real = await orig<typeof ThreeModule>()
  class FakeRenderer {
    domElement = document.createElement('canvas')
    shadowMap = { enabled: false, type: 0 }
    toneMapping = 0
    setPixelRatio() {}
    setSize() {}
    setClearColor() {}
    render() {
      renders.count++
    }

    dispose() {}
  }
  return { ...real, WebGLRenderer: FakeRenderer }
})

const THREE = await import('three')
const { mountTower, VIEW } = await import('../towerRenderer')

const W = 600
const H = 800
let host: HTMLDivElement

beforeEach(() => {
  renders.count = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: () => void) {}
    observe() {
      this.cb()
    }

    disconnect() {}
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  const rect = { left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  host.getBoundingClientRect = () => rect
  HTMLCanvasElement.prototype.getBoundingClientRect = () => rect
})
afterEach(() => {
  host.remove()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
})

const tick = () => new Promise(r => setTimeout(r, 40))
const pointer = (type: string, x: number, y: number, buttons = 0) => {
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, buttons })
  Object.assign(e, { pointerId: 1, pointerType: 'mouse' })
  return e
}

function mount() {
  const calls = { hover: [] as (TowerTarget | null)[], select: [] as TowerTarget[], ready: 0, fail: 0, rendered: 0 }
  const m = mountTower(host, {
    podCount: 30,
    onHover: t => calls.hover.push(t),
    onSelect: t => calls.select.push(t),
    onReady: () => calls.ready++,
    onFail: () => calls.fail++,
    onRender: () => calls.rendered++,
  })
  return { m, calls, canvas: host.querySelector('canvas') as HTMLCanvasElement }
}

/** Where the first visible mesh that matches sits on screen. */
function aim(m: ReturnType<typeof mountTower>, match: (o: InstanceType<typeof THREE.Mesh>) => boolean) {
  let found: InstanceType<typeof THREE.Mesh> | null = null
  m.scene.updateMatrixWorld(true)
  m.scene.traverse((o) => {
    if (!found && o instanceof THREE.Mesh && match(o)) found = o
  })
  if (!found) throw new Error('nothing matched')
  const p = new THREE.Box3().setFromObject(found).getCenter(new THREE.Vector3()).project(m.camera)
  return { x: (p.x + 1) / 2 * W, y: (1 - p.y) / 2 * H }
}

const allPods = Array.from({ length: 30 }, (_, i) => ({ slot: i + 1, status: 'growing' as const, plant: 'Kale', green: 0.5 }))

describe('mountTower', () => {
  it('renders once on demand, marks the host ready, and stops when disposed', async () => {
    const { m, calls, canvas } = mount()
    expect(canvas.getAttribute('aria-hidden')).toBe('true')
    await tick()
    expect(calls.ready).toBe(1)
    expect(host.dataset.ready).toBe('true')
    const before = renders.count
    m.update({ pods: allPods, waterPct: 50, lightLevel: 80, hovered: null, selected: 1 })
    await tick()
    expect(renders.count).toBeGreaterThan(before)
    // The tank eases to its level, then drawing stops until something changes.
    await new Promise(r => setTimeout(r, 2500))
    const settled = renders.count
    await new Promise(r => setTimeout(r, 50))
    expect(renders.count).toBe(settled)
    m.dispose()
    expect(host.querySelector('canvas')).toBeNull()
    expect(host.dataset.ready).toBeUndefined()
  })

  it('hovers and picks a pod with a click that did not drag', async () => {
    const { m, calls, canvas } = mount()
    m.update({ pods: allPods, waterPct: 50, lightLevel: 80, hovered: null, selected: null })
    await tick()
    const at = aim(m, o => o.userData.slot === 7 && o.geometry.type === 'CylinderGeometry')
    canvas.dispatchEvent(pointer('pointermove', at.x, at.y))
    expect(calls.hover.at(-1)).toEqual({ kind: 'pod', slot: 7 })
    expect(canvas.style.cursor).toBe('pointer')
    canvas.dispatchEvent(pointer('pointerdown', at.x, at.y, 1))
    canvas.dispatchEvent(pointer('pointerup', at.x, at.y))
    expect(calls.select).toEqual([{ kind: 'pod', slot: 7 }])
    canvas.dispatchEvent(pointer('pointerleave', 0, 0))
    expect(calls.hover.at(-1)).toBeNull()
    m.dispose()
  })

  it('reports after each frame where a pod sits on screen, so a callout can follow it', async () => {
    const { m, calls, canvas } = mount()
    m.update({ pods: allPods, waterPct: 50, lightLevel: 80, hovered: null, selected: 7 })
    await tick()
    expect(calls.rendered).toBeGreaterThan(0)
    const a = m.anchor(7)
    const collar = aim(m, o => o.userData.slot === 7 && o.geometry.type === 'TorusGeometry')
    expect(a?.x).toBeCloseTo(collar.x, 0)
    expect(a?.y).toBeCloseTo(collar.y, 0)
    expect(m.anchor(99)).toBeNull()
    // Behind the camera, or beside the frame, a pod has no anchor.
    m.camera.position.set(0, 0.8, 3)
    m.camera.lookAt(0, 0.8, 10)
    expect(m.anchor(7)).toBeNull()
    m.camera.lookAt(5, 0.8, 3)
    expect(m.anchor(7)).toBeNull()
    expect(canvas).toBeTruthy()
    m.dispose()
  })

  it('names the light bars and the tank as parts', async () => {
    const { m, calls, canvas } = mount()
    await tick()
    for (const part of ['light', 'tank'] as const) {
      const at = aim(m, o => o.userData.part === part && o.geometry.type !== 'CylinderGeometry')
      canvas.dispatchEvent(pointer('pointermove', at.x, at.y))
      expect(calls.hover.at(-1)).toEqual({ kind: 'part', part })
    }
    m.dispose()
  })

  it('turns on drag without picking, zooms on ⌘-scroll only, and resets on double-click', async () => {
    const { m, calls, canvas } = mount()
    await tick()
    const start = m.camera.position.clone()
    canvas.dispatchEvent(pointer('pointerdown', 300, 400, 1))
    canvas.dispatchEvent(pointer('pointermove', 360, 420, 1))
    canvas.dispatchEvent(pointer('pointerup', 360, 420))
    expect(m.camera.position.distanceTo(start)).toBeGreaterThan(0.1)
    expect(calls.select).toEqual([])
    const plain = new WheelEvent('wheel', { deltaY: 100, cancelable: true })
    canvas.dispatchEvent(plain)
    expect(plain.defaultPrevented).toBe(false)
    const before = m.camera.position.length()
    const zoom = new WheelEvent('wheel', { deltaY: -200, ctrlKey: true, cancelable: true })
    canvas.dispatchEvent(zoom)
    expect(zoom.defaultPrevented).toBe(true)
    expect(m.camera.position.length()).toBeLessThan(before)
    canvas.dispatchEvent(new MouseEvent('dblclick'))
    expect(m.camera.position.distanceTo(start)).toBeLessThan(1e-6)
    expect(VIEW.minDistance).toBeLessThan(VIEW.distance)
    m.dispose()
  })

  it('recolours for the theme and reports a lost WebGL context', async () => {
    const { m, calls, canvas } = mount()
    await tick()
    const base = renders.count
    document.documentElement.dataset.theme = 'light'
    await tick()
    await tick()
    expect(renders.count).toBeGreaterThan(base)
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    expect(calls.fail).toBe(1)
    m.dispose()
  })
})
