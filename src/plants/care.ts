/**
 * Care and harvest notes per plant, rewritten from the Care & Harvest section
 * of each plant's page in Gardyn's help centre (knowledge/plants/plant-pages.md).
 * Server-only: the prose stays out of the web bundle, which asks for it by id.
 */
import { z } from 'zod'
import raw from './care.json'

export const CareNotes = z.object({
  harvest: z.string().optional(),
  prune: z.string().optional(),
  support: z.string().optional(),
  pollinate: z.string().optional(),
  health: z.string().optional(),
  /** Needs beyond the temperature range: heat that bolts it, a fuller tank. */
  climate: z.string().optional(),
})
export type CareNotes = z.infer<typeof CareNotes>

const Care = z.object({ version: z.literal(1), source: z.string(), note: z.string(), plants: z.record(z.string(), CareNotes) })
const care = Care.parse(raw)

/** A built-in plant's notes; null for a custom plant or one whose page has none. */
export function careNotes(id: string): CareNotes | null {
  const n = care.plants[id]
  return n && Object.keys(n).length ? n : null
}
