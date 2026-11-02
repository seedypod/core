// @vitest-environment jsdom
/**
 * The plant renderer with three.js's real scene and models, and a stand-in
 * WebGLRenderer (jsdom has no WebGL).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ThreeModule from 'three'

const { gl } = vi.hoisted(() => ({ gl: { made: 0, renders: 0, sizes: [] as number[][], lost: 0, disposed: 0 } }))

vi.mock('three', async (orig) => {
  const real = await orig<typeof ThreeModule>()
  class FakeRenderer {
    domElement = Object.assign(document.createElement('canvas'), { toDataURL: () => `data:image/png;base64,${gl.renders}` })
    toneMapping = 0
    constructor() {
      gl.made++
    }

    setPixelRatio() {}
    setSize(w: number, h: number) {
      gl.sizes.push([w, h])
    }

    render() {
      gl.renders++
    }

    dispose() {
      gl.disposed++
    }

    forceContextLoss() {
      gl.lost++
    }
  }
  return { ...real, WebGLRenderer: FakeRenderer }
})

const { renderPlantImage, mountPlant } = await import('../plantRenderer')

let host: HTMLDivElement
let frames: FrameRequestCallback[]
const tick = (time: number) => {
  const due = frames
  frames = []
  for (const f of due) f(time)
}

beforeEach(() => {
  Object.assign(gl, { made: 0, renders: 0, sizes: [], lost: 0, disposed: 0 })
  frames = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: () => void) {}
    observe() {
      this.cb()
    }

    disconnect() {}
  })
  host = document.createElement('div')
  host.getBoundingClientRect = () => ({ width: 260, height: 150 }) as DOMRect
  document.body.appendChild(host)
})
afterEach(() => {
  host.remove()
  vi.unstubAllGlobals()
})

describe('renderPlantImage', () => {
  it('draws each still on one shared renderer at the size asked', () => {
    expect(renderPlantImage('Basil', 'bush', false, 96)).toBe('data:image/png;base64,1')
    expect(renderPlantImage('Sunflower', 'full', true, 64)).toBe('data:image/png;base64,2')
    expect(gl.made).toBe(1)
    expect(gl.sizes).toEqual([[96, 96], [64, 64]])
  })
})

describe('mountPlant', () => {
  it('puts one stage at a time on the turntable, turns it each frame, and frees it all on dispose', () => {
    const onFail = vi.fn()
    const m = mountPlant(host, { plant: 'Basil', seed: 3, turn: true, onFail })
    expect(host.querySelector('canvas')?.getAttribute('aria-hidden')).toBe('true')
    m.show('young')
    tick(1000)
    const young = m.turntable.children.at(-1)
    m.show('full')
    m.show('young')
    // The cup and the one model: a stage swapped back reuses its model.
    expect(m.turntable.children).toHaveLength(2)
    expect(m.turntable.children.at(-1)).toBe(young)
    const angle = m.turntable.rotation.y
    tick(1100)
    expect(m.turntable.rotation.y).toBeCloseTo(angle + 0.035)
    expect(frames).toHaveLength(1)
    host.querySelector('canvas')?.dispatchEvent(new Event('webglcontextlost'))
    expect(onFail).toHaveBeenCalled()
    m.dispose()
    expect([gl.disposed, gl.lost]).toEqual([1, 1])
    expect(host.querySelector('canvas')).toBeNull()
  })

  it('draws only on demand when it holds still, and not while the page is hidden', () => {
    const m = mountPlant(host, { plant: null, seed: 1, turn: false, onFail: vi.fn() })
    tick(0)
    const drawn = gl.renders
    m.show('sprout')
    tick(16)
    expect(gl.renders).toBe(drawn + 1)
    expect(frames).toHaveLength(0)
    expect(m.turntable.rotation.y).toBe(0.5)
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    m.show('bush')
    tick(32)
    expect(gl.renders).toBe(drawn + 1)
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
    tick(48)
    expect(gl.renders).toBe(drawn + 2)
    m.dispose()
  })
})
