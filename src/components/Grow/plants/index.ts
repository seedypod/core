/**
 * Plant models for the tower: the catalog picks an archetype and colours for
 * a pod's plant name, and the archetype builds it at its growth stage.
 */
import type * as T from 'three'
import { FALLBACK, lookup, type Archetype } from './catalog'
import { FLOWER_BUILDERS } from './flowers'
import { FRUITING_BUILDERS } from './fruiting'
import { HERB_BUILDERS } from './herbs'
import { type Kit, type PlantBuilder, seeded, type Stage } from './kit'
import { LEAFY_BUILDERS } from './leafy'

export { createKit, type Kit, type Stage } from './kit'

const BUILDERS: Record<Archetype, PlantBuilder> = { ...LEAFY_BUILDERS, ...HERB_BUILDERS, ...FRUITING_BUILDERS, ...FLOWER_BUILDERS }

/** The model for a plant name at a stage; `seed` (the slot) varies it between pods and keeps it stable across loads. */
export function buildPlant(kit: Kit, plant: string | null, stage: Stage, seed: number): T.Group {
  const e = lookup(plant) ?? FALLBACK
  return BUILDERS[e.archetype](kit, stage, e.style, seeded(seed * 7919 + 17))
}
