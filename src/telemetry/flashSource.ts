import { existsSync, readFileSync, statfsSync } from 'node:fs'
import { uptime } from 'node:os'
import type { DiskUsage, FlashSource } from './flash'

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

/** Used and free space on the filesystem holding `dir`; null when it can't be read. Free is what an unprivileged writer gets. */
export function nodeDiskUsage(dir: string, statfs: typeof statfsSync = statfsSync): () => DiskUsage | null {
  return () => {
    try {
      const s = statfs(dir)
      return { usedBytes: (s.blocks - s.bfree) * s.bsize, freeBytes: s.bavail * s.bsize }
    }
    catch {
      return null
    }
  }
}
