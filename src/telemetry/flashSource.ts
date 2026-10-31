import { existsSync, readFileSync } from 'node:fs'
import { uptime } from 'node:os'
import type { FlashSource } from './flash'

/** The SD card on a Pi; `FLASH_STAT_PATH` points at another disk, or a fake in tests. Null when there is neither. */
export function nodeFlashSource(env: NodeJS.ProcessEnv = process.env): FlashSource | null {
  const statPath = env.FLASH_STAT_PATH || (existsSync('/sys/block/mmcblk0/stat') ? '/sys/block/mmcblk0/stat' : null)
  if (!statPath) return null
  return {
    statPath,
    read: (p) => {
      try {
        return readFileSync(p, 'utf8')
      }
      catch {
        return null
      }
    },
    uptimeS: uptime,
  }
}
