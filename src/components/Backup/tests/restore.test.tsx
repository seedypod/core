// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RestorePanel, RestoreProgress } from '../RestorePanel'

const { data, calls } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: { browse: vi.fn(), fromBucket: vi.fn() },
}))

vi.mock('@/src/utils/trpc', () => {
  const query = (name: string) => ({ useQuery: () => ({ data: data.get(name), error: data.get(`${name}Error`) ?? null, isError: !!data.get(`${name}IsError`) }) })
  const mutation = (name: 'browse' | 'fromBucket') => ({
    useMutation: () => ({ isPending: false, data: data.get(`${name}Result`), error: data.get(`${name}Error`) ?? null, mutate: (input?: unknown) => calls[name](input) }),
  })
  return {
    apiBase: () => '',
    trpc: { backup: { list: query('list'), restoreInfo: query('info'), browse: mutation('browse'), restoreFromBucket: mutation('fromBucket') } },
  }
})

beforeEach(() => {
  data.clear()
  for (const f of Object.values(calls)) f.mockReset()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const pick = (name = 'b.tar.gz') => fireEvent.change(screen.getByLabelText('Backup file'), { target: { files: [new File(['x'], name)] } })

describe('RestorePanel', () => {
  it('says when the saved bucket has no backups, or could not be listed', () => {
    data.set('list', [])
    const { unmount } = render(<RestorePanel savedMirror confirm onStarted={vi.fn()} />)
    expect(screen.getByText('No backups in this bucket yet.')).toBeTruthy()
    unmount()
    data.set('list', undefined)
    data.set('listError', { message: 'mirror LIST backups/: 403 AccessDenied' })
    render(<RestorePanel savedMirror confirm onStarted={vi.fn()} />)
    expect(screen.getByText('mirror LIST backups/: 403 AccessDenied')).toBeTruthy()
  })

  it('shows a failed browse of a bucket typed in', () => {
    data.set('browseError', { message: 'mirror LIST backups/: 404 NoSuchBucket' })
    render(<RestorePanel savedMirror={false} confirm={false} onStarted={vi.fn()} />)
    expect(screen.getByText('mirror LIST backups/: 404 NoSuchBucket')).toBeTruthy()
  })

  it('asks first when the unit is set up, and Cancel leaves it alone', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    render(<RestorePanel savedMirror confirm onStarted={vi.fn()} />)
    pick('seedypod-backup-kitchen-20261031-030000.tar.gz')
    fireEvent.click(screen.getByRole('button', { name: 'Restore this file' }))
    expect(screen.getByText(/^Restore seedypod-backup-kitchen-20261031-030000\.tar\.gz\?/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.queryByText(/^Restore seedypod-backup/)).toBeNull()
  })

  it('reports a network failure and an error without a body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('Failed to fetch')
    }))
    const { unmount } = render(<RestorePanel savedMirror={false} confirm={false} onStarted={vi.fn()} />)
    pick()
    fireEvent.click(screen.getByRole('button', { name: 'Restore this file' }))
    await waitFor(() => expect(screen.getByText('Failed to fetch')).toBeTruthy())
    unmount()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 500 })))
    render(<RestorePanel savedMirror={false} confirm={false} onStarted={vi.fn()} />)
    pick()
    fireEvent.click(screen.getByRole('button', { name: 'Restore this file' }))
    await waitFor(() => expect(screen.getByText('restore failed (500)')).toBeTruthy())
  })

  it('shows a refused bucket restore', () => {
    data.set('list', [{ key: 'backups/a.tar.gz', name: 'a.tar.gz', unit: null, createdAt: '2026-10-31T03:00:00Z', size: 900 }])
    render(<RestorePanel savedMirror confirm={false} onStarted={vi.fn()} />)
    expect(screen.getByText('unknown unit · 1 kB')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(calls.fromBucket).toHaveBeenCalledWith({ key: 'backups/a.tar.gz', config: undefined })
  })
})

describe('RestoreProgress', () => {
  const at = (ms: number) => new Date(Date.now() + ms).toISOString()

  it('names the helper\'s step, or says the unit is restarting while core is down', () => {
    data.set('info', { available: true, status: { op: 'restore', state: 'stopping', at: at(0) }, undo: null })
    const { unmount } = render(<RestoreProgress />)
    expect(screen.getByRole('status').textContent).toBe('Stopping the unit…')
    unmount()
    data.set('info', undefined)
    data.set('infoIsError', true)
    render(<RestoreProgress />)
    expect(screen.getByRole('status').textContent).toBe('The unit is restarting…')
  })

  it('ignores a status from before it started', () => {
    data.set('info', { available: true, status: { op: 'restore', state: 'done', at: at(-60_000) }, undo: null })
    render(<RestoreProgress />)
    expect(screen.getByRole('status').textContent).toBe('Starting…')
  })

  it('reloads once the restore is done', () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    data.set('info', { available: true, status: { op: 'restore', state: 'done', at: at(0) }, undo: null })
    render(<RestoreProgress />)
    expect(screen.getByRole('status').textContent).toBe('Done. Reloading…')
    expect(assign).toHaveBeenCalledWith('/')
  })

  it('shows a failed undo with its reason', () => {
    data.set('info', { available: true, status: { op: 'undo', state: 'failed', at: at(0), error: 'the services did not start' }, undo: null })
    render(<RestoreProgress undo />)
    expect(screen.getByText('Undo failed: the services did not start. The unit is back on what it had before.')).toBeTruthy()
  })
})
