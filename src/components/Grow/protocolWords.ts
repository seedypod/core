/**
 * The grow protocol (ADR-0030) in words, shared by its card on Grow and its
 * line on Water so both say the same thing.
 */
import { fmtDay } from '@/src/components/Water/pumpCycles'
import { daysLabel } from '@/src/lib/days'
import type { AppRouter } from '@/src/server/routers/app'
import type { inferRouterOutputs } from '@trpc/server'

export type ProtocolReport = inferRouterOutputs<AppRouter>['protocol']['current']
export type ProtocolStageView = ProtocolReport['stages'][number]
export type StageWater = ProtocolStageView['water']

/** "Tue 17 Nov" for a plain date on the unit's calendar. */
export const plainDay = (date: string) => fmtDay(new Date(`${date}T00:00:00Z`), 'UTC')

/** A stage's days: "0–7", "22 on". */
export const stageDays = (s: Pick<ProtocolStageView, 'from' | 'to'>) => (s.to === null ? `${s.from} on` : `${s.from}–${s.to}`)

/** "1 × 15 min, Mondays", "3 × 6 min daily". */
export function waterWords(w: Pick<StageWater, 'runs' | 'durationS' | 'days' | 'weekly'>): string {
  const per = `${w.runs.length} × ${Math.round(w.durationS / 60)} min`
  return w.weekly ? `${per}, ${daysLabel(w.days)}` : `${per} daily`
}

/** The stage after the current one, if there is one. */
export const nextStage = (r: ProtocolReport) => r.stages.find(s => s.state === 'next' && s.startsOn !== null) ?? null

/**
 * The stage and the protocol's day, counted as the track counts them, from
 * day 0 on the sowing day: "Germination, day 2 of 7" in a stage of days 0–7,
 * "Maintenance, day 30" in the ongoing one. It's the sidebar's "Day 2" until
 * Hold or Advance moves the protocol's clock off the plants' age.
 */
export function stageDayWords(r: Pick<ProtocolReport, 'day'>, stage: Pick<ProtocolStageView, 'name' | 'to'>): string {
  return `${stage.name}, day ${r.day ?? 0}${stage.to === null ? '' : ` of ${stage.to}`}`
}

/** Where the protocol is, in a line: "Germination, day 2 of 7 · Seedlings starts Tue 17 Nov". */
export function whereWords(r: ProtocolReport): string {
  const stage = r.stages.find(s => s.id === r.stage)
  if (!stage || r.dayInStage === null) return 'Starts when pods are planted'
  const at = stageDayWords(r, stage)
  if (r.hold) return `${at} · held${r.hold.days ? ` ${r.hold.days} d` : ''}`
  // A change is only promised when the protocol is the one watering.
  if (r.water === 'none') return `${at} · not watering yet`
  if (!r.following || r.water !== 'preset') return `${at} · watering stays as it is`
  const next = nextStage(r)
  return next?.startsOn ? `${at} · ${next.name} starts ${plainDay(next.startsOn)}` : `${at} · ongoing`
}
