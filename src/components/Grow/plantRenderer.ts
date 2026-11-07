/**
 * Draws one plant model outside the tower: stills for thumbnails on a single
 * shared offscreen renderer, and a slowly turning model for Grow's pod panel.
 * Loaded with `import()` like the tower, so three.js stays in its own chunk.
 */
import * as THREE from 'three'
import { buildPlant, createKit, type Stage } from './plants'

const deg = Math.PI / 180
const isLight = () => document.documentElement.dataset.theme === 'light'

/** The tower's studio light, a touch brighter on a dark theme so dark leaves still read against it. */
function addLights(scene: THREE.Scene, light: boolean) {
  const hemi = new THREE.HemisphereLight('#fbf7f0', '#55555c', light ? 1.8 : 2.4)
  const key = new THREE.DirectionalLight('#fff6ea', 2.2)
  key.position.set(1.5, 3, 2.2)
  const fill = new THREE.DirectionalLight('#dfe8ff', 0.6)
  fill.position.set(-2, 1.5, 1)
  scene.add(hemi, key, fill)
  return hemi
}

/** Aims `camera` at `box` from a little above, near enough that the box's bounding sphere fills `fill` of the frame. */
function frame(camera: THREE.PerspectiveCamera, box: THREE.Box3, fill: number) {
  const sphere = box.getBoundingSphere(new THREE.Sphere())
  const r = Math.max(sphere.radius, 0.005)
  const d = r / Math.sin((camera.fov * deg) / 2) / fill
  camera.position.set(sphere.center.x, sphere.center.y + d * Math.sin(20 * deg), sphere.center.z + d * Math.cos(20 * deg))
  camera.near = d / 20
  camera.far = d * 4
  camera.lookAt(sphere.center)
  camera.updateProjectionMatrix()
}

let still: { renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, hemi: THREE.HemisphereLight, kit: ReturnType<typeof createKit> } | null = null

/**
 * `plant` at `stage` as a PNG data URL, `size` pixels square on a clear ground
 * and framed to fill it. Every still shares one renderer and kit, made on the
 * first call; throws when the browser can't give it a WebGL context.
 */
export function renderPlantImage(plant: string, stage: Stage, light: boolean, size: number): string {
  if (!still) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power' })
    renderer.setPixelRatio(1)
    renderer.toneMapping = THREE.NeutralToneMapping
    const scene = new THREE.Scene()
    still = { renderer, scene, camera: new THREE.PerspectiveCamera(30, 1, 0.01, 10), hemi: addLights(scene, light), kit: createKit(THREE) }
  }
  const { renderer, scene, camera, hemi, kit } = still
  hemi.intensity = light ? 1.8 : 2.4
  renderer.setSize(size, size, false)
  const model = buildPlant(kit, plant, stage, 1)
  model.rotation.y = 0.5
  scene.add(model)
  frame(camera, new THREE.Box3().setFromObject(model), 1)
  renderer.render(scene, camera)
  scene.remove(model)
  return renderer.domElement.toDataURL('image/png')
}

export interface PlantMountOptions {
  plant: string | null
  /** The pod's slot: the same seed the tower builds it with, so it's the same plant. */
  seed: number
  /** Turn slowly; false under prefers-reduced-motion. */
  turn: boolean
  onFail: () => void
}

/** Radians a second the model turns. */
const TURN = 0.35

/**
 * A pod's plant on a small turntable in `host`, framed for its harvest-ready
 * size so every stage shows at its size beside it. Draws on demand, and every
 * frame only while it turns and the page is visible.
 */
export function mountPlant(host: HTMLElement, o: PlantMountOptions) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
  const canvas = renderer.domElement
  canvas.setAttribute('aria-hidden', 'true')
  Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.toneMapping = THREE.NeutralToneMapping

  const kit = createKit(THREE)
  const scene = new THREE.Scene()
  addLights(scene, isLight())
  const turntable = new THREE.Group()
  turntable.rotation.y = 0.5
  scene.add(turntable)
  const cupGeo = new THREE.CylinderGeometry(0.024, 0.019, 0.014, 24)
  const cupMat = new THREE.MeshStandardMaterial({ color: isLight() ? '#d6d0c6' : '#4a4a50', roughness: 0.6 })
  const cup = new THREE.Mesh(cupGeo, cupMat)
  cup.position.y = -0.007
  turntable.add(cup)

  const models = new Map<Stage, THREE.Group>()
  const model = (stage: Stage) => {
    let m = models.get(stage)
    if (!m) {
      m = buildPlant(kit, o.plant, stage, o.seed)
      models.set(stage, m)
    }
    return m
  }
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 10)
  frame(camera, new THREE.Box3().setFromObject(model('full')).expandByObject(cup), 0.95)

  let frameId = 0
  let last = 0
  const render = (time: number) => {
    frameId = 0
    if (document.hidden) return
    if (o.turn) {
      turntable.rotation.y += last ? Math.min(0.1, (time - last) / 1000) * TURN : 0
      last = time
    }
    renderer.render(scene, camera)
    if (o.turn) requestRender()
  }
  const requestRender = () => {
    if (!frameId) frameId = requestAnimationFrame(render)
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
  const visibility = () => {
    last = 0
    if (!document.hidden) requestRender()
  }
  const lost = (e: Event) => {
    e.preventDefault()
    o.onFail()
  }
  document.addEventListener('visibilitychange', visibility)
  canvas.addEventListener('webglcontextlost', lost)
  host.appendChild(canvas)
  resize()

  return {
    /** For tests: what's on the turntable. */
    turntable,
    /** Swaps the model on the turntable for `stage`'s. */
    show(stage: Stage) {
      for (const m of models.values()) turntable.remove(m)
      turntable.add(model(stage))
      requestRender()
    },
    dispose() {
      cancelAnimationFrame(frameId)
      observer.disconnect()
      document.removeEventListener('visibilitychange', visibility)
      canvas.removeEventListener('webglcontextlost', lost)
      kit.dispose()
      cupGeo.dispose()
      cupMat.dispose()
      renderer.dispose()
      // Hand the context back now: browsers cap live contexts, and the panel mounts one per pod opened.
      renderer.forceContextLoss()
      canvas.remove()
    },
  }
}

export type PlantMount = ReturnType<typeof mountPlant>
