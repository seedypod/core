/**
 * hald's boot log: a line per boot of `key=value` fields after a timestamp, which
 * outlives the journal. Used to judge the USB hub, and a cable swap, over recent boots.
 */

/** Boots the hub rate covers: enough to see a change, recent enough to reflect it. */
const RECENT_BOOTS = 20

export interface BootLogSummary {
  /** Boots on record. */
  boots: number
  /** Over recent boots where it's known, how often the hub came up by itself. */
  hub: { up: number, of: number } | null
}

const field = (line: string, key: string) => new RegExp(`(?:^| )${key}=(\\S+)`).exec(line)?.[1]

export function summariseBootLog(text: string): BootLogSummary {
  const lines = text.split('\n').filter(l => l.trim())
  const hubs = lines.slice(-RECENT_BOOTS).map(l => field(l, 'hub')).filter(h => h === '0' || h === '1')
  return { boots: lines.length, hub: hubs.length ? { up: hubs.filter(h => h === '1').length, of: hubs.length } : null }
}
