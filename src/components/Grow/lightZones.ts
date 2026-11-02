/**
 * The light zones of a Gardyn tower, and which plants grow best in each
 * (Gardyn's light-zone guide). The light bars run up either side, so the
 * centre of the tower gets the most light and its edges the least, in a
 * pattern that differs between the Home and the Studio.
 */
import { nameMatcher } from './plants/catalog'
import { podPlaces, towerShape, type PodPlace } from './towerLayout'

export type LightZone = 'high' | 'medium' | 'low'
export type TowerModel = 'home' | 'studio'

export const ZONES: LightZone[] = ['high', 'medium', 'low']
export const ZONE_LABEL: Record<LightZone, string> = { high: 'High light', medium: 'Medium light', low: 'Low light' }
/** Gardyn's own zone colours, so the overlay reads like their diagram in either theme. */
export const ZONE_COLOR: Record<LightZone, string> = { high: '#c8472d', medium: '#f2ae7c', low: '#f0cd52' }

export const MODEL_NAME: Record<TowerModel, string> = { home: 'Gardyn Home', studio: 'Gardyn Studio' }
/** Where each zone sits, in the words of Gardyn's diagram for that model. */
export const ZONE_WHERE: Record<TowerModel, Record<LightZone, string>> = {
  home: { high: 'Center-most cluster of pods', medium: 'Pods encircling the center', low: 'Top and bottom rows across the columns' },
  studio: { high: 'Center-most cluster of pods', medium: 'Pods encircling the center', low: 'Lower left and upper right pods' },
}

/** A Home has three columns of 10, a Studio two of 8 (towerShape). */
export function towerModel(podCount: number): TowerModel {
  return towerShape(podCount).columns === 3 ? 'home' : 'studio'
}

/**
 * Each pod's zone, one string per column, top row first: H high, M medium,
 * L low, read off Gardyn's diagrams. A column's pods alternate sides, and the
 * high ones are those leaning in towards the centre.
 */
const GRID: Record<TowerModel, string[]> = {
  home: ['LMHMHMHMML', 'LMHHHHHHML', 'LMMHMHMHML'],
  studio: ['MMHMHMHL', 'LMMHMHMM'],
}
const LETTER: Record<string, LightZone> = { H: 'high', M: 'medium', L: 'low' }

/** The zone of the pod at `place`, or null off the grid (a tower of an unknown size). */
function zoneAt(model: TowerModel, place: Pick<PodPlace, 'column' | 'row'>): LightZone | null {
  return LETTER[GRID[model][place.column]?.[place.row] ?? ''] ?? null
}

/** The light zone of pod `slot` on a tower of `podCount` pods. */
export function podZone(podCount: number, slot: number): LightZone | null {
  const place = podPlaces(podCount)[slot - 1]
  return place ? zoneAt(towerModel(podCount), place) : null
}

/** Every pod's zone by slot. */
export function podZones(podCount: number): Map<number, LightZone> {
  const model = towerModel(podCount)
  const zones = new Map<number, LightZone>()
  for (const p of podPlaces(podCount)) {
    const z = zoneAt(model, p)
    if (z) zones.set(p.slot, z)
  }
  return zones
}

export interface ZoneGroup { group: string, plants: string[] }

/**
 * Which plants grow best in each zone, grouped as Gardyn lists them. "Peppers",
 * "Tomatoes" and the like stand for every variety, so an unlisted pepper still
 * finds the high zone.
 */
export const PLANT_ZONES: Record<LightZone, ZoneGroup[]> = {
  high: [
    { group: 'Fruiting plants', plants: [
      'Peppers', 'Banana Pepper', 'Black Pearl Pepper', 'Burrito Pepper', 'Candy Cane Pepper', 'Goliath Pepper', 'Hungarian Hot Wax Pepper', 'Jalapeño', 'Lemon Hot Pepper', 'Poblano Pepper', 'Purple Cayenne Pepper', 'Shishito Pepper', 'Sweet Pepper',
      'Tomatoes', 'Red Cherry Tomato', 'Yellow Cherry Tomato',
      'Eggplants', 'Fairytale Eggplant', 'Mini Eggplant', 'Thai Eggplant',
      'Beans', 'Dragon Beans', 'Green Beans', 'Purple Beans', 'Yellow Beans',
      'Strawberries', 'Red Mini Strawberries', 'Yellow Mini Strawberry', 'Bare Root Strawberries',
      'Cape Gooseberry', 'Cucumber', 'Mini Okra', 'Mini Pumpkin', 'Mini Squash',
    ] },
    { group: 'Flowers', plants: ['Bi-Color Sunflower', 'Celosia Mix', 'Fuchsia Snapdragon', 'Purple Snapdragon', 'Scarlet Snapdragon', 'Stock Flower', 'Sunflower', 'Yellow Snapdragon', 'Zinnia', 'Portulaca Mix'] },
    { group: 'Herbs', plants: ['Holy Basil', 'Lavender', 'Stevia'] },
    { group: 'Lettuce & leafy greens', plants: ['Tokyo Bekana', 'Mini Broccoli', 'Mini Cauliflower'] },
  ],
  medium: [
    { group: 'Lettuce & leafy greens', plants: [
      'American Mustard', 'Breen', 'Bronze Arrow', 'Bull’s Blood Beets', 'Buttercrunch', 'Butterhead', 'Cardinale', 'Collard Greens', 'Endive Lettuce', 'Flashy Trout Back', 'Green Bok Choy', 'Green Cabbage', 'Green Mustard', 'Green Salanova', 'Green Tatsoi', 'Hon Tsai Tai', 'Iceberg', 'Kale', 'Kale Lacinato', 'Lollo Rossa', 'Monte Carlo', 'Muir Lettuce', 'Perpetual Spinach', 'Pink Celery', 'Purple Bok Choy', 'Purple Kohlrabi', 'Radicchio', 'Red Amaranth', 'Red Mustard', 'Red Oak Leaf Lettuce', 'Red Romaine', 'Red Sails Lettuce', 'Red Salad Bowl', 'Red Sorrel', 'Red Tatsoi', 'Red Swiss Chard', 'Romaine', 'Rouge d’Hiver', 'Sorrel', 'Wasabi Greens', 'Watercress', 'White Kohlrabi', 'Yellow Swiss Chard', 'Celery',
    ] },
    { group: 'Herbs', plants: ['Basil', 'Italian Parsley', 'Lime Basil', 'Mammoth Basil', 'Purple Basil', 'Sage', 'Savory', 'Shiso', 'Sweet Marjoram', 'Sweet Thai Basil', 'Tarragon'] },
    { group: 'Flowers', plants: ['Black Viola', 'Blue Cornflower', 'Blush Hibiscus', 'Borage', 'Canna Flower', 'Chamomile', 'Dianthus', 'Fiesta Gitana', 'Marietta Marigold', 'Matilda', 'Nasturtium', 'Night-Scented Stock', 'Pink Petunia', 'Purple Campanula', 'Purple Petunia', 'Radio Calendula', 'Red Hibiscus', 'Red Impatiens', 'Torenia', 'Violet Impatiens', 'Viola', 'White Petunia'] },
    { group: 'Fruiting plants', plants: ['Peas'] },
  ],
  low: [
    { group: 'Herbs', plants: ['Catnip', 'Chervil', 'Chives', 'Cilantro', 'Dill', 'Garlic Chives', 'Lemon Balm', 'Lemongrass', 'Mint', 'Oregano', 'Rosemary', 'Thyme'] },
    { group: 'Lettuce & leafy greens', plants: ['Arugula', 'Purslane', 'Wheatgrass', 'Bunching Onions'] },
  ],
}

/** Plant name → zone, every variety Gardyn lists. */
export const PLANT_ZONE_MAP: ReadonlyMap<string, LightZone> = new Map(ZONES.flatMap(z => PLANT_ZONES[z].flatMap(g => g.plants.map(p => [p, z] as const))))

/** Where a plant should go beyond its zone, as Gardyn advises it. */
export interface PlacementNote {
  note: string
  /** The pods it should go in, when the tower has them. */
  prefer?: (place: PodPlace, model: TowerModel, rows: number) => boolean
}
const NOTES: Record<string, PlacementNote> = {
  Cucumber: {
    note: 'Place it at the bottom of the middle column, so the vine grows upward into higher light as it matures.',
    // A Studio has no middle column; there it goes by its zone.
    prefer: (p, model, rows) => model === 'home' && p.column === 1 && p.row >= rows - 2,
  },
}

const match = nameMatcher([...PLANT_ZONE_MAP.keys()].map(name => ({ name })))

export interface PlantLight { name: string, zone: LightZone, placement?: PlacementNote }

/** The zone a pod's plant grows best in, from its closest listed variety; null for a plant Gardyn doesn't list. */
export function plantLight(plant: string | null | undefined): PlantLight | null {
  const name = match(plant)?.name
  const zone = name ? PLANT_ZONE_MAP.get(name) : undefined
  return name && zone ? { name, zone, placement: NOTES[name] } : null
}

const RANK: Record<LightZone, number> = { low: 0, medium: 1, high: 2 }

export interface Placement {
  plant: PlantLight
  pod: LightZone
  /** Whether the pod suits the plant: its zone, or the pods its placement note names. */
  fits: boolean
  /** Which way a pod that doesn't fit is off. */
  light: 'right' | 'too-dim' | 'too-bright'
  /** Pods that would suit it, from `among` (say, the empty ones). */
  better: number[]
}

/** How well pod `slot` suits `plant`, and which of `among` would suit it; null for an unlisted plant or a pod off the grid. */
export function placement(podCount: number, slot: number, plant: string | null | undefined, among: number[] = []): Placement | null {
  const want = plantLight(plant)
  const places = podPlaces(podCount)
  const place = places[slot - 1]
  if (!want || !place) return null
  const model = towerModel(podCount)
  const { rows } = towerShape(podCount)
  const pod = zoneAt(model, place)
  if (!pod) return null
  const prefer = want.placement?.prefer
  const preferred = prefer && places.some(p => prefer(p, model, rows)) ? prefer : null
  const suits = (p: PodPlace) => (preferred ? preferred(p, model, rows) : zoneAt(model, p) === want.zone)
  const fits = suits(place)
  const light = fits || RANK[pod] === RANK[want.zone] ? 'right' : RANK[pod] < RANK[want.zone] ? 'too-dim' : 'too-bright'
  const better = fits
    ? []
    : among.filter(s => s !== slot).filter((s) => {
        const p = places[s - 1]
        return p ? suits(p) : false
      })
  return { plant: want, pod, fits, light, better }
}

/** One sentence on a placement that doesn't fit: what the plant wants, and where it would get it. */
export function placementAdvice(p: Placement): string {
  const here = p.light === 'too-dim' ? `; this pod gets ${p.pod}` : p.light === 'too-bright' ? `; this pod gets ${p.pod}, more than it needs` : ''
  return [
    `${p.plant.name} grows best in ${p.plant.zone} light${here}.`,
    p.plant.placement?.note,
    p.better.length > 0 ? `Free pods that suit it: ${p.better.slice(0, 6).join(', ')}.` : null,
  ].filter(Boolean).join(' ')
}

/** A pod's light zone, and when its plant would do better elsewhere, a sentence saying where. */
export interface PodLight { zone: LightZone, advice?: string }

/** Pod `slot`'s zone on a tower of `pods`, with advice when `plant` (its own by default) suits another zone; empty pods are offered instead. */
export function podLight(pods: { slot: number, status: string, plant?: string | null }[], slot: number, plant = pods.find(p => p.slot === slot)?.plant): PodLight | null {
  const zone = podZone(pods.length, slot)
  if (!zone) return null
  const free = pods.filter(p => p.status === 'empty').map(p => p.slot)
  const fit = placement(pods.length, slot, plant, free)
  return { zone, advice: fit && !fit.fits ? placementAdvice(fit) : undefined }
}
