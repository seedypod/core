import { describe, expect, it } from 'vitest'
import type { TableReport } from '@/src/db/inspect'
import { barHeights, byWrites, migrationNote, rowBytes24h, size, topWriter, totalWrites } from '../databaseView'

const table = (name: string, o: Partial<TableReport> = {}): TableReport => ({
  name, rows: 10, bytes: 1000, timeColumn: 'ts', basis: 'inserted', lastWriteAt: null, hourly: new Array<number>(24).fill(0), writes24h: 0, ...o,
})
const unknown = { timeColumn: null, basis: null, hourly: null, writes24h: null }

describe('byWrites', () => {
  it('puts the busiest writers first, then size, then name, with unknown writes last', () => {
    const tables = [
      table('quiet-small', { bytes: 10 }),
      table('unknown', { ...unknown, bytes: 1e9 }),
      table('busy', { writes24h: 100 }),
      table('quiet-b'),
      table('quiet-a'),
      table('quiet-sizeless', { bytes: null }),
      table('unknown-sizeless', { ...unknown, bytes: null }),
    ]
    const expected = ['busy', 'quiet-a', 'quiet-b', 'quiet-small', 'quiet-sizeless', 'unknown', 'unknown-sizeless']
    expect(byWrites(tables).map(t => t.name)).toEqual(expected)
    expect(byWrites([...tables].reverse()).map(t => t.name)).toEqual(expected)
  })
})

describe('totals', () => {
  it('adds what is known and doesn\'t count unknown tables as zero writes to report', () => {
    expect(totalWrites([table('a', { writes24h: 3 }), table('b', unknown)])).toBe(3)
  })

  it('weighs new rows at each table\'s average row size, leaving out in-place updates', () => {
    expect(rowBytes24h([
      table('new', { rows: 100, bytes: 5000, writes24h: 10 }),
      table('updated', { basis: 'changed', rows: 10, bytes: 1000, writes24h: 5 }),
      table('empty', { rows: 0, bytes: 4096 }),
      table('undated', { ...unknown }),
    ])).toBe(500)
  })

  it('has no row data figure without sizes', () => {
    expect(rowBytes24h([table('a', { bytes: null })])).toBeNull()
  })
})

describe('topWriter', () => {
  it('names the table behind most of the rows', () => {
    expect(topWriter([table('a', { writes24h: 9 }), table('b', { writes24h: 1 })])).toBe('a wrote 90% of them.')
  })

  it('says nothing when nothing wrote', () => {
    expect(topWriter([table('a')])).toBeNull()
    expect(topWriter([])).toBeNull()
  })
})

describe('migrationNote', () => {
  const m = { applied: 2, known: 2, latestTag: '0001_b', appliedTag: '0001_b' }

  it('names the applied migration', () => {
    expect(migrationNote(m)).toEqual({ text: '0001_b', warn: false })
    expect(migrationNote({ ...m, appliedTag: null })).toEqual({ text: '0001_b', warn: false })
    expect(migrationNote({ ...m, applied: 0, known: 0, latestTag: null, appliedTag: null })).toEqual({ text: 'none', warn: false })
  })

  it('warns when they differ', () => {
    expect(migrationNote({ ...m, applied: 1 })).toEqual({ text: '1 pending', warn: true })
    expect(migrationNote({ ...m, applied: 4 })).toEqual({ text: '2 applied by a newer build', warn: true })
  })
})

describe('barHeights', () => {
  it('scales to the table\'s busiest hour', () => {
    expect(barHeights([0, 5, 10])).toEqual([0, 0.5, 1])
  })

  it('stays flat for an idle table', () => {
    expect(barHeights([0, 0])).toEqual([0, 0])
  })
})

describe('size', () => {
  it('scales the unit', () => {
    expect([4096, 1.5e6, 2.4e7, 1.23e9, 3.21e10].map(size)).toEqual(['4 kB', '1.5 MB', '24 MB', '1.23 GB', '32.1 GB'])
  })
})
