/**
 * Small stills of plant models for lists and callouts: each catalog plant is
 * rendered once per stage and theme on one shared offscreen renderer, and the
 * picture reused wherever it shows. An unrecognised plant gets no picture (a
 * neutral shape stands in), so the generic model never passes for a variety.
 */
import { type CatalogEntry, lookup } from './plants/catalog'
import type { Stage } from './plants/kit'
import type * as PlantRendererModule from './plantRenderer'

/** Pixels square each still is drawn at: sharp at 40 px on a 2× screen. */
export const THUMB_PX = 96

/** Whether the browser has WebGL at all; as with the tower, a context that then fails is caught where it's made. */
export const webGL = () => typeof window !== 'undefined' && typeof window.WebGLRenderingContext !== 'undefined'

let loading: Promise<typeof PlantRendererModule> | null = null
/** Fetches the plant renderer (and three.js, shared with the tower's chunk) once. */
export const loadPlantRenderer = () => (loading ??= import('./plantRenderer').then((m) => {
  noteThreeLoaded()
  return m
}))

let onThree = () => {}
let three = new Promise<void>((resolve) => {
  onThree = resolve
})
/** For whatever fetches three.js: thumbnails waiting on it can render now. */
export const noteThreeLoaded = () => onThree()
/** Resolves once three.js is on the page for some other reason, for a thumbnail not worth the download itself. */
export const threeLoaded = () => three

const pending = new Map<string, Promise<string | null>>()
const done = new Map<string, string>()
let broken = false

const keyOf = (e: CatalogEntry, stage: Stage, light: boolean) => `${e.name}|${stage}|${light ? 'light' : 'dark'}`

/** A still's cache key: its catalog entry, stage and theme; null for a plant the catalog doesn't know. */
export function thumbKey(plant: string | null | undefined, stage: Stage, light: boolean): string | null {
  const e = lookup(plant)
  return e ? keyOf(e, stage, light) : null
}

/** The still already rendered under `key`, so a remount shows it without a blank frame. */
export const cachedThumb = (key: string | null): string | null => (key ? done.get(key) ?? null : null)

/**
 * A data URL of the plant's still, rendered on first ask and shared after; null
 * for an unrecognised plant, or once rendering has failed (no WebGL).
 */
export function plantThumb(plant: string | null | undefined, stage: Stage, light: boolean): Promise<string | null> {
  const e = lookup(plant)
  if (!e || broken || !webGL()) return Promise.resolve(null)
  const key = keyOf(e, stage, light)
  let p = pending.get(key)
  if (!p) {
    p = loadPlantRenderer()
      .then((m) => {
        const url = m.renderPlantImage(e.name, stage, light, THUMB_PX)
        done.set(key, url)
        return url
      })
      .catch(() => {
        broken = true
        return null
      })
    pending.set(key, p)
  }
  return p
}

/** Forgets every still and any failure, for tests. */
export function clearThumbs() {
  pending.clear()
  done.clear()
  broken = false
  three = new Promise((resolve) => {
    onThree = resolve
  })
}
