import { describe, expect, it } from 'vitest'
import { nodeClockTrusted } from '../clock'

describe('nodeClockTrusted', () => {
  it('waits just after boot, until NTP answers', () => {
    expect(nodeClockTrusted({ uptimeS: () => 60, synced: () => false })).toBe(false)
    expect(nodeClockTrusted({ uptimeS: () => 60, synced: () => true })).toBe(true)
  })

  it('gives up waiting after 3 minutes, so an offline unit still runs its schedules', () => {
    expect(nodeClockTrusted({ uptimeS: () => 180, synced: () => false })).toBe(true)
  })

  it('reads the real uptime and sync flag by default', () => {
    expect(nodeClockTrusted()).toBeTypeOf('boolean')
  })
})
