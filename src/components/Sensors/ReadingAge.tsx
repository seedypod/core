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

/** What to say about readings shown together: the oldest's age, and whether any can't be trusted. */
export function readingAge(readings: Readings, now: number): { text: string, warn: boolean } {
  const held = readings.filter(r => !!r)
  if (!held.length) return { text: 'no reading', warn: false }
  const oldest = Math.min(...held.map(r => Date.parse(r.ts)))
  const updated = `updated ${secondsAgo(oldest, now)}`
  if (now - oldest > STALE_AFTER_MS || held.some(r => r.quality === 'stale')) return { text: `stale · ${updated}`, warn: true }
  if (held.some(r => r.quality === 'suspect')) return { text: `suspect · ${updated}`, warn: true }
  return { text: updated, warn: false }
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

/** "updated 8s ago", amber once stale or suspect. It ticks alone, so the page around it doesn't re-render. */
export function ReadingAge({ readings, className }: { readings: Readings, className?: string }) {
  const now = useNow(1000)
  const offset = useUnitClockOffset()
  const { text, warn } = readingAge(readings, now + offset)
  return <span data-testid="reading-age" className={cn('font-mono text-[10px]', warn ? 'text-warn' : 'text-fg-3', className)}>{text}</span>
}
