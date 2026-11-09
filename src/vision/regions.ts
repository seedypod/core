/**
 * Where each pod sits in each camera's frame (#143): the box the analysers
 * score it on, the Analysis overlay draws and the Grow page crops to. Boxes are
 * fractions of the frame (0–1), so they hold at any capture resolution.
 *
 * The defaults are measured on a Gardyn Home 3.0's reference stills: one box
 * per cup, centred on its opening. The owner can move and resize any box per
 * camera (stored in settings as a calibration); the boxes they leave alone keep
 * the defaults.
 *
 * Slot numbering follows the rest of the app (towerLayout.ts): three columns
 * left to right as the cameras see them, counted across then down from the
 * top, so the upper camera sees rows 1–5 (slots 1–15) and the lower rows 6–10
 * (slots 16–30). Gardyn's own numbering is unverified until Phase 1
 * (docs/hardware/pin-map.md); if it differs, only this table's order changes.
 */
import { bounds, type Rect } from './greenArea'

export type Camera = 'upper' | 'lower'
/** Each pod's box as fractions of the frame, by slot. */
export type PodRegions = Record<number, Rect>
/** Boxes the owner has moved, per camera and slot; every other box keeps its default. */
export type RegionCalibration = Partial<Record<Camera, PodRegions>>

export const CAMERAS: Camera[] = ['upper', 'lower']

/** The slots a camera sees. */
export function cameraSlots(camera: Camera): number[] {
  const first = camera === 'upper' ? 1 : 16
  return Array.from({ length: 15 }, (_, i) => first + i)
}

/** The camera that sees a slot, or null for one past the tower's 30. */
export function cameraOf(slot: number): Camera | null {
  if (slot >= 1 && slot <= 15) return 'upper'
  if (slot >= 16 && slot <= 30) return 'lower'
  return null
}

/** Size of the reference stills the cups were measured on. */
export const REF = { width: 1280, height: 960 }

/**
 * Cup openings on the reference stills, in pixels: centre x, centre y, radius,
 * in slot order. Even rows lean out right of their column, odd rows left, so
 * every other cup is a stub seen from the side; its box sits on the stub's
 * end. The lower camera's first row is the tower's sixth (its fifth is the
 * upper camera's last, seen again at the top of the frame and skipped). Slot
 * 28's cup is below the lower frame; its box sits at the edge where its plant
 * comes into view.
 */
export const REFERENCE_CUPS: Record<Camera, Array<[number, number, number]>> = {
  upper: [
    [150, 195, 48], [420, 205, 75], [1010, 275, 75],
    [110, 385, 40], [283, 448, 42], [712, 530, 62],
    [228, 550, 42], [472, 655, 50], [855, 745, 50],
    [192, 642, 32], [378, 740, 38], [660, 830, 40],
    [305, 760, 35], [505, 850, 35], [765, 920, 35],
  ],
  lower: [
    [215, 445, 75], [748, 360, 68], [1048, 330, 42],
    [490, 650, 50], [858, 555, 42], [1068, 490, 30],
    [365, 855, 45], [705, 760, 45], [950, 655, 38],
    [530, 910, 30], [785, 815, 30], [968, 722, 25],
    [430, 945, 30], [670, 925, 30], [865, 840, 28],
  ],
}

/** A box is this many cup radii across: the rim, and room for leaves around it. */
const SPAN = 2.6
/** Smallest box side, as a fraction of the frame. */
export const MIN_SIDE = 0.01

const round4 = (n: number) => Math.round(n * 10_000) / 10_000

/** Keep a box inside the frame and at least MIN_SIDE across. */
export function clampRegion(r: Rect): Rect {
  const w = round4(Math.min(1, Math.max(MIN_SIDE, r.w)))
  const h = round4(Math.min(1, Math.max(MIN_SIDE, r.h)))
  return { x: round4(Math.min(1 - w, Math.max(0, r.x))), y: round4(Math.min(1 - h, Math.max(0, r.y))), w, h }
}

/** The measured boxes, per camera. */
export const DEFAULT_REGIONS: Record<Camera, PodRegions> = {
  upper: fromCups('upper'),
  lower: fromCups('lower'),
}

function fromCups(camera: Camera): PodRegions {
  const slots = cameraSlots(camera)
  const out: PodRegions = {}
  REFERENCE_CUPS[camera].forEach(([x, y, r], i) => {
    const side = r * SPAN
    out[slots[i] as number] = clampRegion({ x: (x - side / 2) / REF.width, y: (y - side / 2) / REF.height, w: side / REF.width, h: side / REF.height })
  })
  return out
}

/** One camera's boxes: the owner's where they moved one, the defaults elsewhere. */
export function podRegions(camera: Camera, calibration?: RegionCalibration | null): PodRegions {
  const own = calibration?.[camera] ?? {}
  const out: PodRegions = {}
  for (const slot of cameraSlots(camera)) out[slot] = own[slot] ?? (DEFAULT_REGIONS[camera][slot] as Rect)
  return out
}

/** Boxes in pixels for a frame of this size. */
export function toPixels(regions: PodRegions, width: number, height: number): Record<number, Rect> {
  const out: Record<number, Rect> = {}
  for (const [slot, r] of Object.entries(regions)) out[Number(slot)] = { x: r.x * width, y: r.y * height, w: r.w * width, h: r.h * height }
  return out
}

/**
 * A box as the whole-pixel crop the analysers read on a frame of this size
 * (#184): what a pod classifier should be trained on.
 */
export function cropPixels(r: Rect, width: number, height: number): Rect {
  const b = bounds({ x: r.x * width, y: r.y * height, w: r.w * width, h: r.h * height }, width, height)
  return { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 }
}
