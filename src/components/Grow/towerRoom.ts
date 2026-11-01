/**
 * A room for the tower to stand in (after sleepypod's roomBackdrop): a plank
 * floor, a wall with a baseboard that stays behind the tower as you turn it,
 * soft haze, and a warm wash on the wall that follows the grow light.
 */
import type * as T from 'three'
import type { Three } from './towerScene'

export const ROOM = {
  /** The wall stands this far behind the tower, along the line of sight. */
  wallDistance: 1.25,
  wallWidth: 9,
  wallHeight: 4,
  fogNear: 3.5,
  fogFar: 9,
} as const

interface RoomColors { wall: string, floor: string, plank: string, baseboard: string, haze: string, glowOpacity: number }
const DARK: RoomColors = { wall: '#1a1a1e', floor: '#121110', plank: '#161413', baseboard: '#222227', haze: '#0f0f11', glowOpacity: 0.35 }
const LIGHT: RoomColors = { wall: '#ebe7e0', floor: '#cdbfa9', plank: '#c3b39b', baseboard: '#f6f4f0', haze: '#f2efea', glowOpacity: 0.22 }

/** Floorboards: long planks with staggered joints, drawn once and tiled. */
function plankTexture(THREE: Three, c: RoomColors) {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = c.floor
    ctx.fillRect(0, 0, 256, 256)
    for (let row = 0; row < 8; row++) {
      ctx.fillStyle = row % 2 ? c.plank : c.floor
      ctx.fillRect(0, row * 32, 256, 31)
      ctx.fillStyle = 'rgba(0,0,0,0.18)'
      ctx.fillRect(0, row * 32 + 31, 256, 1)
      const joint = (row * 97) % 256
      ctx.fillRect(joint, row * 32, 1, 31)
    }
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(6, 6)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** A soft radial wash, tinted by the material's colour. */
function glowTexture(THREE: Three) {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.5, 'rgba(255,255,255,0.35)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 64)
  }
  return new THREE.CanvasTexture(canvas)
}

export function createRoom(THREE: Three, scene: T.Scene, renderer: T.WebGLRenderer, light: boolean, towerHeight: number) {
  let colors = light ? LIGHT : DARK
  const group = new THREE.Group()
  let planks = plankTexture(THREE, colors)
  const floorGeo = new THREE.PlaneGeometry(16, 16)
  const floorMat = new THREE.MeshStandardMaterial({ map: planks, roughness: 0.9 })
  const floor = new THREE.Mesh(floorGeo, floorMat)
  floor.rotation.x = -Math.PI / 2
  floor.position.y = -0.002
  floor.receiveShadow = true
  group.add(floor)

  const wall = new THREE.Group()
  const wallGeo = new THREE.PlaneGeometry(ROOM.wallWidth, ROOM.wallHeight)
  const wallMat = new THREE.MeshStandardMaterial({ color: colors.wall, roughness: 1 })
  const wallMesh = new THREE.Mesh(wallGeo, wallMat)
  wallMesh.position.y = ROOM.wallHeight / 2
  wallMesh.receiveShadow = true
  const boardGeo = new THREE.BoxGeometry(ROOM.wallWidth, 0.09, 0.02)
  const boardMat = new THREE.MeshStandardMaterial({ color: colors.baseboard, roughness: 0.6 })
  const board = new THREE.Mesh(boardGeo, boardMat)
  board.position.set(0, 0.045, 0.01)
  const glowTex = glowTexture(THREE)
  const glowGeo = new THREE.PlaneGeometry(2.2, 2.2)
  const glowMat = new THREE.MeshBasicMaterial({ map: glowTex, color: '#ffd9a8', transparent: true, opacity: 0, depthWrite: false })
  const glow = new THREE.Mesh(glowGeo, glowMat)
  glow.position.set(0, towerHeight * 0.6, 0.005)
  wall.add(wallMesh, board, glow)
  group.add(wall)

  const fog = new THREE.Fog(colors.haze, ROOM.fogNear, ROOM.fogFar)
  scene.fog = fog
  scene.add(group)
  let level = 0
  const paint = () => {
    wallMat.color.set(colors.wall)
    boardMat.color.set(colors.baseboard)
    fog.color.set(colors.haze)
    renderer.setClearColor(colors.haze, 1)
    glowMat.opacity = colors.glowOpacity * level
  }
  paint()

  return {
    /** Keep the wall squarely behind the tower as seen from this azimuth. */
    follow(azimuth: number) {
      wall.position.set(-ROOM.wallDistance * Math.sin(azimuth), 0, -ROOM.wallDistance * Math.cos(azimuth))
      wall.rotation.y = azimuth
    },
    /** 0–1: how bright the grow light's wash on the wall is. */
    setLight(next: number) {
      level = Math.max(0, Math.min(1, next))
      glowMat.opacity = colors.glowOpacity * level
    },
    recolor(nextLight: boolean) {
      colors = nextLight ? LIGHT : DARK
      planks.dispose()
      planks = plankTexture(THREE, colors)
      floorMat.map = planks
      floorMat.needsUpdate = true
      paint()
    },
    dispose() {
      scene.remove(group)
      scene.fog = null
      for (const d of [floorGeo, floorMat, planks, wallGeo, wallMat, boardGeo, boardMat, glowTex, glowGeo, glowMat]) d.dispose()
    },
  }
}
