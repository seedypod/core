/**
 * The numbers care advice may use, each with the knowledge note it comes from
 * (ADR-0029). Core never states a dose or target that isn't here, and a test
 * checks every cited note and heading exists, so a renamed note fails CI.
 */

/** A knowledge note and the section the advice comes from. */
export interface Citation {
  /** Path in the repo, e.g. `knowledge/nutrients/gardyn-feeding-guidance.md`. */
  note: string
  /** The heading, as written in the note. */
  section: string
  url: string
}

const REPO = 'https://github.com/seedypod/core/blob/dev/'

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
export const anchor = (heading: string) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-')

export function cite(note: string, section: string): Citation {
  return { note, section, url: `${REPO}${note}#${anchor(section)}` }
}

const GARDYN = 'knowledge/nutrients/gardyn-feeding-guidance.md'
const COMMUNITY = 'knowledge/nutrients/community-nutrients.md'
const GERMINATION = 'knowledge/plants/germination.md'

export const CITE = {
  /** "Tank volumes: Home 5 gal full, Studio 4 gal full; keep the tank at least half full." */
  tankHalfFull: cite(GARDYN, 'Gardyn feeding guidance'),
  /** Sprout dose once most yCubes have sprouted (usually within 2 weeks); per-gallon doses by stage. */
  plantFood: cite(GARDYN, 'Plant food'),
  /** Top off weekly; refresh every 4 weeks, every 2 with four or more fruiting plants; no cleaning interval. */
  tankCadence: cite(GARDYN, 'Tank cadence'),
  /** pH 5.5–6.5 and EC by crop, from Gardyn's blog. */
  phEc: cite(GARDYN, 'pH and EC'),
  /** Teaspoon doses are not interchangeable between products; dose to an EC target with a probe. */
  dosesByProduct: cite(COMMUNITY, 'Doses owners use on a Gardyn'),
  /** Owners who meter run pH 5.9–6.2 and leafy greens at EC 1.3–1.6. */
  ownerTargets: cite(COMMUNITY, 'Targets owners report'),
  /** Cardboard covers off before germinating; around 70°F at 65–75% humidity. */
  germinationStart: cite(GERMINATION, 'Before germinating'),
  /** Check daily for sprouts; some take up to 21 days; too much water slows them. */
  sprouting: cite(GERMINATION, 'Sprouting'),
  /** yCovers only after thinning: covers trap moisture around the seed. */
  yCovers: cite(GERMINATION, 'Thinning and yCovers'),
  /** Judge the watering by the roots: dry and brittle wants more, pooled water less. */
  roots: cite('knowledge/watering/schedules.md', 'Judging a schedule'),
} as const

/** Below this the tank is under half full. */
export const TANK_MIN_PCT = 50
/** Gardyn tops off weekly. */
export const TOP_OFF_DAYS = 7
/** Gardyn refreshes at least every 28 days, every 14 with four or more fruiting plants. */
export const REFRESH_DAYS = 28
export const REFRESH_FRUITING_DAYS = 14
export const FRUITING_FOR_FAST_REFRESH = 4
/** The sprout dose, the first feed, comes once most yCubes have sprouted, usually within 2 weeks. */
export const SPROUT_DOSE_DAYS = 14

export const PH_RANGE = { min: 5.5, max: 6.5 } as const

export type CropGroup = 'seedlings' | 'leafy greens' | 'herbs' | 'fruiting crops'
/** EC in mS/cm by crop, from Gardyn's blog (tomatoes for fruiting). */
export const EC_TARGETS: Record<CropGroup, { min: number, max: number }> = {
  'seedlings': { min: 0.8, max: 1.2 },
  'leafy greens': { min: 1.2, max: 2.0 },
  'herbs': { min: 1.0, max: 2.0 },
  'fruiting crops': { min: 2.0, max: 3.5 },
}
