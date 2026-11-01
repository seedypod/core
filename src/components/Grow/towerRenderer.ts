/**
 * Renders the tower into a host element (after sleepypod's BedView3D): soft
 * studio lighting, a shadow on a transparent floor, render on demand, and an
 * orbit you drag. Loaded with `import()` so three.js stays in its own chunk,
 * served by the unit itself (no CDN: many units sit on LANs without internet).
 */
import * as THREE from 'three'
import { createTower, DARK_PALETTE, LIGHT_PALETTE, type TowerState } from './towerScene'

export interface TowerMountOptions {
  podCount: number
  onHover: (slot: number | null) => void
  onSelect: (slot: number) => void
  onReady: () => void
  onFail: () => void
}

const deg = Math.PI / 180
export const VIEW = {
  azimuth: -18 * deg,
  elevation: 8 * deg,
  distance: 3.3,
  maxAzimuth: 70 * deg,
  minElevation: -5 * deg,
  maxElevation: 40 * deg,
  minDistance: 1.6,
  maxDistance: 4.5,
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const isLight = () => document.documentElement.dataset.theme === 'light'

export function mountTower(host: HTMLElement, o: TowerMountOptions) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
  const canvas = renderer.domElement
  canvas.setAttribute('aria-hidden', 'true')
  canvas.style.display = 'block'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.touchAction = 'pan-y'
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  const scene = new THREE.Scene()
  const tower = createTower(THREE, o.podCount, isLight() ? LIGHT_PALETTE : DARK_PALETTE)
  scene.add(tower.root)
  const lookY = tower.shape.height * 0.47

  const floorGeo = new THREE.PlaneGeometry(8, 8)
  const floorMat = new THREE.ShadowMaterial({ opacity: 0.3 })
  const floor = new THREE.Mesh(floorGeo, floorMat)
  floor.rotation.x = -Math.PI / 2
  floor.receiveShadow = true
  scene.add(floor)
  const hemi = new THREE.HemisphereLight('#fbf7f0', '#55555c', 1.8)
  scene.add(hemi)
  const key = new THREE.DirectionalLight('#fff6ea', 2.2)
  key.position.set(1.5, 3, 2.2)
  key.castShadow = true
  key.shadow.mapSize.set(1024, 1024)
  Object.assign(key.shadow.camera, { left: -1.5, right: 1.5, top: 2.2, bottom: -0.5, near: 0.5, far: 8 })
  key.shadow.camera.updateProjectionMatrix()
  key.shadow.bias = -0.0005
  scene.add(key)
  const fill = new THREE.DirectionalLight('#dfe8ff', 0.6)
  fill.position.set(-2, 1.5, 1)
  scene.add(fill)

  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 20)
  const view = { azimuth: VIEW.azimuth, elevation: VIEW.elevation, distance: VIEW.distance }
  const place = () => {
    const ground = view.distance * Math.cos(view.elevation)
    camera.position.set(ground * Math.sin(view.azimuth), lookY + view.distance * Math.sin(view.elevation), ground * Math.cos(view.azimuth))
    camera.lookAt(0, lookY, 0)
  }
  place()

  let frame = 0
  let ready = false
  const render = () => {
    frame = 0
    if (document.hidden) return
    renderer.render(scene, camera)
    if (!ready) {
      ready = true
      host.dataset.ready = 'true'
      o.onReady()
    }
  }
  const requestRender = () => {
    if (!frame) frame = requestAnimationFrame(render)
  }

  const resize = () => {
    const { width, height } = host.getBoundingClientRect()
    if (!width || !height) return
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    requestRender()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(host)

  // Picking: hover highlights a pod, a click that didn't drag selects it.
  const ray = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  const pick = (e: PointerEvent | MouseEvent): number | null => {
    const r = canvas.getBoundingClientRect()
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    ray.setFromCamera(pointer, camera)
    return tower.slotOf(ray.intersectObjects(tower.pickables, false)[0]?.object)
  }
  let drag: { x: number, y: number, moved: boolean } | null = null
  let hovered: number | null = null
  const onDown = (e: PointerEvent) => {
    drag = { x: e.clientX, y: e.clientY, moved: false }
    canvas.setPointerCapture?.(e.pointerId)
  }
  const onMove = (e: PointerEvent) => {
    if (drag && (e.buttons & 1 || e.pointerType === 'touch')) {
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
      if (drag.moved) {
        view.azimuth = clamp(view.azimuth - dx * 0.008, -VIEW.maxAzimuth, VIEW.maxAzimuth)
        view.elevation = clamp(view.elevation + dy * 0.005, VIEW.minElevation, VIEW.maxElevation)
        drag.x = e.clientX
        drag.y = e.clientY
        place()
        requestRender()
      }
      return
    }
    const slot = pick(e)
    if (slot !== hovered) {
      hovered = slot
      canvas.style.cursor = slot === null ? 'grab' : 'pointer'
      o.onHover(slot)
    }
  }
  const onUp = (e: PointerEvent) => {
    if (drag && !drag.moved) {
      const slot = pick(e)
      if (slot !== null) o.onSelect(slot)
    }
    drag = null
  }
  const onLeave = () => {
    if (hovered !== null) {
      hovered = null
      o.onHover(null)
    }
  }
  // ⌘/Ctrl + wheel (and trackpad pinch) zooms; a plain wheel scrolls the page.
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    view.distance = clamp(view.distance * Math.exp(e.deltaY * 0.002), VIEW.minDistance, VIEW.maxDistance)
    place()
    requestRender()
  }
  const onDouble = () => {
    Object.assign(view, { azimuth: VIEW.azimuth, elevation: VIEW.elevation, distance: VIEW.distance })
    place()
    requestRender()
  }
  const lost = (e: Event) => {
    e.preventDefault()
    o.onFail()
  }
  const visibility = () => {
    if (!document.hidden) requestRender()
  }
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointerleave', onLeave)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('dblclick', onDouble)
  canvas.addEventListener('webglcontextlost', lost)
  document.addEventListener('visibilitychange', visibility)
  const theme = new MutationObserver(() => {
    const light = isLight()
    tower.recolor(light ? LIGHT_PALETTE : DARK_PALETTE)
    floorMat.opacity = light ? 0.16 : 0.3
    requestRender()
  })
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  canvas.style.cursor = 'grab'
  host.appendChild(canvas)
  resize()

  return {
    update(state: TowerState) {
      tower.update(state)
      requestRender()
    },
    dispose() {
      cancelAnimationFrame(frame)
      observer.disconnect()
      theme.disconnect()
      document.removeEventListener('visibilitychange', visibility)
      canvas.removeEventListener('webglcontextlost', lost)
      tower.dispose()
      floorGeo.dispose()
      floorMat.dispose()
      renderer.dispose()
      canvas.remove()
      delete host.dataset.ready
    },
  }
}

export type TowerMount = ReturnType<typeof mountTower>
