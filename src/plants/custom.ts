/**
 * Custom catalog plants (#130): what a person or an agent adds on the unit
 * for crops Gardyn's list lacks. They are stored locally (`custom_plants`) and
 * merged after the built-in plants, which stay read-only.
 */
import { z } from 'zod'
import type { CustomPlant, Store } from '../store/types'
import { type Catalog, Category, makeCatalog, type Plant, Succession, Zone } from './catalog'

const Months = z.number().int().min(0).max(24)

const fields = {
  name: z.string().trim().min(1).max(60),
  category: Category,
  zone: Zone,
  /** First harvest window in months after starting the yCube, [from, to]. */
  harvestMonths: z.tuple([Months, Months]),
  careLevel: z.enum(['beginner', 'intermediate', 'expert']).nullable(),
  /** 'large' plants shade neighbours, so the planner spaces them apart. */
  size: z.enum(['large', 'normal']),
  succession: Succession,
}

/** The fields a new custom plant is written with; `succession` defaults from its category. */
export const CustomPlantFields = z.object({ ...fields, careLevel: fields.careLevel.default(null), size: fields.size.default('normal'), succession: fields.succession.optional() })

/** An edit: only the fields given change. */
export const CustomPlantPatch = z.object(fields).partial()

/** Gardyn's succession group for a category, as scripts/plants/build-catalog.py infers it for plants its table doesn't name. */
export const SUCCESSION_BY_CATEGORY: Record<Category, Succession> = {
  lettuce: 'fast-greens',
  green: 'fast-greens',
  vegetable: 'fast-greens',
  herb: 'long-greens-herbs',
  legume: 'fast-fruiting',
  fruiting: 'long-fruiting',
  flower: 'flowers',
}

/** Catalog id for a name: lower-case ASCII words joined by hyphens, as the built-in ids are ("Jalapeño" → "jalapeno"). */
export function plantSlug(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function customToPlant(c: CustomPlant): Plant {
  return {
    id: c.id,
    name: c.name,
    category: c.category,
    zone: c.zone,
    harvestMonths: c.harvestMonths,
    harvestEstimated: false,
    careLevel: c.careLevel,
    yield: null,
    succession: c.succession,
    successionInferred: false,
    size: c.size,
    placement: null,
    gardynHandle: null,
    inStore: false,
    custom: true,
  }
}

/** The built-in plants plus this unit's custom ones. */
export function catalogFor(store: Pick<Store, 'customPlants'>): Catalog {
  return makeCatalog(store.customPlants.list().map(customToPlant))
}
