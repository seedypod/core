import { describe, expect, it } from 'vitest'
import { byWrites } from '../../components/Database/databaseView'
import { sectorsWritten } from '../../telemetry/flash'
import { demoDatabase, demoFlashSource } from '../database'

const NOW = new Date('2026-11-06T12:00:00Z')

describe('demo database', () => {
  it('tells the story of a unit whose telemetry is the busiest writer', async () => {
    const r = await demoDatabase(() => NOW).inspect()
    expect(byWrites(r.tables)[0]?.name).toBe('telemetry')
    for (const t of r.tables) {
      expect(t.hourly).toHaveLength(24)
      expect(t.writes24h).toBe(t.hourly?.reduce((a, b) => a + b, 0))
      expect(t.rows).toBeGreaterThan(0)
      expect(Date.parse(t.lastWriteAt as string)).toBeLessThan(NOW.getTime())
    }
    expect(r.fileBytes).toBeGreaterThan(r.tables.reduce((n, t) => n + (t.bytes as number), 0))
  })

  it('remembers an integrity check, and defaults to the wall clock', async () => {
    const d = demoDatabase()
    expect((await d.inspect()).integrity).toBeNull()
    const run = await d.checkIntegrity()
    expect(run.ok).toBe(true)
    expect((await d.inspect()).integrity).toEqual(run)
  })

  it('gives the write meter a card to read', () => {
    expect(sectorsWritten(demoFlashSource.read(demoFlashSource.statPath) as string)).toBeGreaterThan(0)
    expect(demoFlashSource.read('/sys/block/mmcblk0/size')?.trim()).toBe('62500000')
    expect(demoFlashSource.uptimeS()).toBe(3 * 86_400)
  })
})
