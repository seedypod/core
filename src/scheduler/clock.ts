/**
 * A Pi has no RTC, so after a power cut the clock restarts from the last saved
 * time until NTP answers, and core now starts before Wi-Fi. A unit that stays
 * offline never syncs, so the wait is short: a pump that runs late beats one that
 * never runs. Node-only; the browser demo has no such clock.
 */
import { existsSync } from 'node:fs'
import { uptime } from 'node:os'

const GRACE_S = 180
/** systemd-timesyncd creates this once it has synchronised. */
const SYNCED = '/run/systemd/timesync/synchronized'

export function nodeClockTrusted(deps: { synced?: () => boolean, uptimeS?: () => number } = {}): boolean {
  return (deps.uptimeS ?? uptime)() >= GRACE_S || (deps.synced ?? (() => existsSync(SYNCED)))()
}
