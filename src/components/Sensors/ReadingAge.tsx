import { useNow } from '@/src/components/System/useNow'
import type { Reading } from '@/src/hardware/contract'
import { cn } from '@/lib/utils'
import { secondsAgo } from '@/src/lib/timeAgo'
import { trpc } from '@/src/utils/trpc'

/** hald's default `telemetry_interval_s`, which it doesn't report. */
const TELEMETRY_MS = 10_000
/** Three ticks missed. One late tick on a busy single core is not news. */
export const STALE_AFTER_MS = 3 * TELEMETRY_MS
const CLOCK_MS = 10 * 60_000

type Readings = ReadonlyArray<Pick<Reading, 'ts' | 'quality'> | undefined>

const held = (readings: Readings) => readings.filter(r => !!r)

/** Whether readings shown together can't be trusted: any gone quiet or marked stale by hald, else any suspect. */
export function readingFlag(readings: Readings, now: number): 'stale' | 'suspect' | null {
  const shown = held(readings)
  if (!shown.length) return null
  const oldest = Math.min(...shown.map(r => Date.parse(r.ts)))
  if (now - oldest > STALE_AFTER_MS || shown.some(r => r.quality === 'stale')) return 'stale'
  if (shown.some(r => r.quality === 'suspect')) return 'suspect'
  return null
}

/** What to say about readings shown together: the oldest's age, and whether any can't be trusted. */
export function readingAge(readings: Readings, now: number): { text: string, warn: boolean } {
  const shown = held(readings)
  if (!shown.length) return { text: 'no reading', warn: false }
  const updated = `updated ${secondsAgo(Math.min(...shown.map(r => Date.parse(r.ts))), now)}`
  const flag = readingFlag(shown, now)
  return flag ? { text: `${flag} · ${updated}`, warn: true } : { text: updated, warn: false }
}

/** When the newest reading came in, amber once even that one has gone quiet; null with none to date. */
export function lastUpdate(readings: Readings, now: number): { text: string, warn: boolean } | null {
  const shown = held(readings)
  if (!shown.length) return null
  const newest = Math.max(...shown.map(r => Date.parse(r.ts)))
  return { text: `updated ${secondsAgo(newest, now)}`, warn: now - newest > STALE_AFTER_MS }
}

/**
 * How far the unit's clock runs ahead of this browser's. Readings are stamped by
 * the unit, which has no battery clock and may have no internet to set it by,
 * so comparing them to the browser's time alone could mark every reading stale.
 * This is core's clock and the stamps are hald's, one clock on the supported
 * single-Pi install. With hald on another host, ages are off by the difference
 * between the two; fixing that means core stamping each reading as it arrives,
 * a change to the shared contract.
 */
function useUnitClockOffset(): number {
  const unit = trpc.system.healthcheck.useQuery(undefined, { staleTime: CLOCK_MS, refetchInterval: CLOCK_MS })
  return unit.data ? Date.parse(unit.data.ts) - unit.dataUpdatedAt : 0
}

/** The time by the unit's clock, re-read every second. */
function useUnitNow(): number {
  const now = useNow(1000)
  return now + useUnitClockOffset()
}

/** "updated 8s ago", amber once stale or suspect. It ticks alone, so the page around it doesn't re-render. */
export function ReadingAge({ readings, className }: { readings: Readings, className?: string }) {
  const { text, warn } = readingAge(readings, useUnitNow())
  return <span data-testid="reading-age" className={cn('font-mono text-[10px]', warn ? 'text-warn' : 'text-fg-3', className)}>{text}</span>
}

/** An amber "stale" or "suspect" on readings that can't be trusted, and nothing while they're fresh. */
export function ReadingFlag({ readings, className }: { readings: Readings, className?: string }) {
  const flag = readingFlag(readings, useUnitNow())
  return flag && <span data-testid="reading-flag" className={cn('font-mono text-[10px] text-warn', className)}>{flag}</span>
}

/** One "updated 4s ago" for a group of readings, going by the newest; nothing until there is one. */
export function ReadingsUpdated({ readings, className }: { readings: Readings, className?: string }) {
  const update = lastUpdate(readings, useUnitNow())
  return update && <span data-testid="readings-updated" className={cn('font-mono text-[10px]', update.warn ? 'text-warn' : 'text-fg-3', className)}>{update.text}</span>
}
