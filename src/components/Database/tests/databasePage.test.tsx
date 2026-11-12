// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseReport, TableReport } from '@/src/db/inspect'
import { DatabasePage } from '../DatabasePage'

const { state, mutate, queries } = vi.hoisted(() => ({
  state: { db: undefined as unknown, dbError: null as { message: string } | null, flash: undefined as unknown, check: {} as { isPending?: boolean, data?: unknown, error?: { message: string } | null } },
  mutate: vi.fn(),
  queries: [] as Array<{ name: string, refetchInterval?: number }>,
}))

vi.mock('@tanstack/react-router', () => ({ Link: ({ to, hash, children, className }: { to: string, hash?: string, children: unknown, className?: string }) => <a href={`${to}#${hash}`} className={className}>{children as string}</a> }))

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    storage: {
      database: { useQuery: (_: unknown, o: { refetchInterval?: number }) => {
        queries.push({ name: 'database', ...o })
        return { data: state.db, error: state.dbError }
      } },
      flash: { useQuery: (_: unknown, o: { refetchInterval?: number }) => {
        queries.push({ name: 'flash', ...o })
        return { data: state.flash }
      } },
      checkDatabase: { useMutation: () => ({ isPending: false, data: undefined, error: null, ...state.check, mutate }) },
    },
  },
}))

const hourly = (n: number) => Array.from({ length: 24 }, (_, i) => (i === 23 ? n : 0))
const table = (name: string, o: Partial<TableReport> = {}): TableReport => ({
  name, rows: 100, bytes: 40960, timeColumn: 'ts', basis: 'inserted', lastWriteAt: new Date(Date.now() - 120_000).toISOString(), hourly: hourly(10), writes24h: 10, ...o,
})
const report = (o: Partial<DatabaseReport> = {}): DatabaseReport => ({
  at: new Date(Date.now() - 180_000).toISOString(), scanMs: 1400, path: 'data/seedypod.db', fileBytes: 5e6, walBytes: 1.2e6, journalMode: 'wal', pageSize: 4096, freePages: 3,
  migrations: { applied: 11, known: 11, latestTag: '0010_x', appliedTag: '0010_x' },
  tables: [table('schedules', { basis: 'changed', timeColumn: 'updatedAt', writes24h: 1, hourly: hourly(1) }), table('telemetry', { writes24h: 90, hourly: hourly(90), rows: 4200 })],
  integrity: null,
  ...o,
})

beforeEach(() => {
  state.db = report()
  state.dbError = null
  state.flash = { available: true, bytesPerDay: 3e8, basis: 'history', windowDays: 7 }
  state.check = {}
  mutate.mockReset()
  queries.length = 0
})
afterEach(cleanup)

describe('Database view', () => {
  it('sums up the file: size, WAL, journal mode, free pages and migrations', () => {
    render(<DatabasePage />)
    expect(screen.getByTestId('scanned').textContent).toBe('data/seedypod.db · scanned 3 min ago in 1.4 s')
    for (const text of ['5.0 MB', '1.2 MB', 'WAL', '12 kB', '11 / 11', '0010_x', 'Not checked']) expect(screen.getAllByText(text).length).toBeGreaterThan(0)
  })

  it('warns about pending migrations', () => {
    state.db = report({ migrations: { applied: 9, known: 11, latestTag: '0010_x', appliedTag: null } })
    render(<DatabasePage />)
    expect(screen.getByText('2 pending')).toBeTruthy()
  })

  it('puts the busiest writer first and names its share', () => {
    render(<DatabasePage />)
    const rows = screen.getAllByTestId(/^table-/).map(r => r.getAttribute('data-testid'))
    expect(rows).toEqual(['table-telemetry', 'table-schedules'])
    const card = screen.getByTestId('writers')
    expect(within(card).getByText(/91 rows in the last 24 h, about .* of row data\. telemetry wrote 99% of them\./)).toBeTruthy()
    const row = screen.getByTestId('table-telemetry')
    expect(within(row).getByRole('img', { name: '90 rows in the last 24 hours' })).toBeTruthy()
    expect(within(row).getByText('99%')).toBeTruthy()
    expect(within(row).getByText('41 kB')).toBeTruthy()
    expect(row.textContent).toContain('4,200 rows · last 2 min ago · new rows by ts')
  })

  it('says a table counts changes, not inserts, when its column moves on update', () => {
    render(<DatabasePage />)
    expect(screen.getByTestId('table-schedules').textContent).toContain('last change by updatedAt')
  })

  it('counts one row as one', () => {
    state.db = report({ tables: [table('device_settings', { rows: 1 })] })
    render(<DatabasePage />)
    expect(screen.getByTestId('table-device_settings').textContent).toContain('1 row ·')
  })

  it('titles each hour\'s bar with its count', () => {
    render(<DatabasePage />)
    const bars = within(screen.getByTestId('table-telemetry')).getByRole('img').children
    expect(bars).toHaveLength(24)
    expect(bars[23]?.getAttribute('title')).toBe('90 rows, this hour')
    expect(bars[0]?.getAttribute('title')).toBe('0 rows, 23 h ago')
  })

  it('shows a table with no time column as unknown, not zero', () => {
    state.db = report({ tables: [table('notes', { timeColumn: null, basis: null, lastWriteAt: null, hourly: null, writes24h: null })] })
    render(<DatabasePage />)
    const row = screen.getByTestId('table-notes')
    expect(within(row).getByText('no time column')).toBeTruthy()
    expect(within(row).getByText('—')).toBeTruthy()
    expect(within(row).queryByRole('img')).toBeNull()
    expect(screen.queryByText(/wrote/)).toBeNull()
  })

  it('explains the missing sizes on a SQLite without dbstat', () => {
    state.db = report({ tables: [table('telemetry', { bytes: null })] })
    render(<DatabasePage />)
    expect(screen.getByText(/no dbstat/)).toBeTruthy()
    expect(within(screen.getByTestId('table-telemetry')).getByText('—')).toBeTruthy()
    expect(screen.queryByText(/of row data/)).toBeNull()
  })

  it('says what the numbers count', () => {
    render(<DatabasePage />)
    expect(screen.getByText(/rows by the time stored in them, not commits/)).toBeTruthy()
  })

  it('sets the database against the whole card\'s writes', () => {
    render(<DatabasePage />)
    expect(screen.getByTestId('card-writes').textContent).toContain('The whole card takes 300 MB/day, averaged over 7 days')
    expect(screen.getByTestId('card-writes').textContent).toContain('whole 4 kB pages')
  })

  it('says when the rate is only since boot', () => {
    state.flash = { available: true, bytesPerDay: 3e8, basis: 'boot', windowDays: null }
    render(<DatabasePage />)
    expect(screen.getByTestId('card-writes').textContent).toContain('averaged since boot')
  })

  it('has nothing to compare with off a Pi', () => {
    state.flash = { available: false, bytesPerDay: null }
    render(<DatabasePage />)
    expect(screen.getByTestId('card-writes').textContent).toContain('no SD card counter')
  })

  it('polls no faster than the server\'s cache', () => {
    render(<DatabasePage />)
    for (const q of queries) expect(q.refetchInterval).toBeGreaterThanOrEqual(5 * 60_000)
  })

  it('runs an integrity check on demand and shows the result', () => {
    render(<DatabasePage />)
    fireEvent.click(screen.getByRole('button', { name: 'Check integrity' }))
    expect(mutate).toHaveBeenCalledOnce()
  })

  it('shows a passed check, from this visit or an earlier one', () => {
    const when = new Date(Date.now() - 60_000).toISOString()
    state.check = { data: { ok: true, detail: 'ok', checkedAt: when, ms: 6200 } }
    render(<DatabasePage />)
    expect(screen.getByText('OK')).toBeTruthy()
    expect(screen.getByText('quick_check · 1 min ago · 6.2 s')).toBeTruthy()
    cleanup()
    state.check = {}
    state.db = report({ integrity: { ok: true, detail: 'ok', checkedAt: when, ms: 100 } })
    render(<DatabasePage />)
    expect(screen.getByText('quick_check · 1 min ago · 0.1 s')).toBeTruthy()
  })

  it('shows what a failed check found', () => {
    state.check = { data: { ok: false, detail: 'Tree 12 page 40: btreeInitPage() returns error code 11', checkedAt: new Date().toISOString(), ms: 100 } }
    render(<DatabasePage />)
    expect(screen.getByText('Failed')).toBeTruthy()
    expect(screen.getByText(/btreeInitPage/)).toBeTruthy()
  })

  it('disables the button while checking, and shows a check that couldn\'t run', () => {
    state.check = { isPending: true, error: { message: 'database scan timed out after 300 s' } }
    render(<DatabasePage />)
    expect((screen.getByRole('button', { name: 'Checking…' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('database scan timed out after 300 s')).toBeTruthy()
  })

  it('says a scan is running until the first report arrives', () => {
    state.db = undefined
    render(<DatabasePage />)
    expect(screen.getByText(/Scanning the database/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Check integrity' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows why a scan failed', () => {
    state.db = undefined
    state.dbError = { message: 'database scan timed out after 300 s' }
    render(<DatabasePage />)
    expect(screen.getByText('database scan timed out after 300 s')).toBeTruthy()
    expect(screen.queryByText(/Scanning the database/)).toBeNull()
  })

  it('links back to the card', () => {
    render(<DatabasePage />)
    expect(screen.getByRole('link', { name: 'SD card' }).getAttribute('href')).toBe('/settings#storage')
  })
})
