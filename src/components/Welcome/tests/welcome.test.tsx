// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Welcome } from '../Welcome'

const { data, calls, handlers } = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  calls: { update: vi.fn(), browse: vi.fn(), fromBucket: vi.fn() },
  handlers: new Map<string, { onSuccess?: () => void, onError?: (e: Error) => void }>(),
}))

vi.mock('@/src/utils/trpc', () => {
  const query = (name: string) => ({ useQuery: () => ({ data: data.get(name), error: null, isError: false }) })
  const mutation = (name: 'update' | 'browse' | 'fromBucket') => ({
    useMutation: (opts?: { onSuccess?: () => void, onError?: (e: Error) => void }) => {
      handlers.set(name, opts ?? {})
      return { isPending: false, data: data.get(`${name}Result`), error: data.get(`${name}Error`) ?? null, mutate: (input?: unknown) => calls[name](input) }
    },
  })
  return {
    apiBase: () => '',
    trpc: {
      useUtils: () => ({ settings: { invalidate: vi.fn() } }),
      settings: { update: mutation('update') },
      backup: { restoreInfo: query('restoreInfo'), list: query('list'), browse: mutation('browse'), restoreFromBucket: mutation('fromBucket') },
    },
  }
})

beforeEach(() => {
  data.clear()
  handlers.clear()
  for (const f of Object.values(calls)) f.mockReset()
  data.set('restoreInfo', { available: true, status: null, undo: null })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement

describe('Welcome', () => {
  it('offers a new garden or a restore', () => {
    render(<Welcome />)
    fireEvent.click(screen.getByRole('button', { name: 'Set up a new garden' }))
    expect(calls.update).toHaveBeenCalledWith({ setupComplete: true })
    expect(screen.getByRole('button', { name: 'Restore from a backup' })).toBeTruthy()
  })

  it('lists a bucket from settings typed in here and restores the pick without asking', () => {
    data.set('browseResult', [
      { key: 'backups/seedypod-backup-kitchen-20261031-030000.tar.gz', name: 'x', unit: 'kitchen', createdAt: '2026-10-31T03:00:00Z', size: 2_400_000 },
      { key: 'backups/seedypod-backup-kitchen-20261030-030000.tar.gz', name: 'y', unit: 'kitchen', createdAt: '2026-10-30T03:00:00Z', size: 2_300_000 },
    ])
    render(<Welcome />)
    fireEvent.click(screen.getByRole('button', { name: 'Restore from a backup' }))
    const list = screen.getByRole('button', { name: 'List backups' }) as HTMLButtonElement
    expect(list.disabled).toBe(true)
    fireEvent.change(field('Endpoint'), { target: { value: 'https://r2.example.com' } })
    fireEvent.change(field('Bucket'), { target: { value: 'pods' } })
    fireEvent.change(field('Key prefix'), { target: { value: 'kitchen/' } })
    fireEvent.change(field('Access key id'), { target: { value: 'AK' } })
    fireEvent.change(field('Secret access key'), { target: { value: 'SK' } })
    fireEvent.click(list)
    const config = { endpoint: 'https://r2.example.com', bucket: 'pods', region: 'auto', prefix: 'kitchen/', accessKeyId: 'AK', secretAccessKey: 'SK' }
    expect(calls.browse).toHaveBeenCalledWith({ config })
    expect(screen.getAllByText('kitchen · 2.4 MB')).toHaveLength(1)
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[0] as HTMLElement)
    expect(calls.fromBucket).toHaveBeenCalledWith({ key: 'backups/seedypod-backup-kitchen-20261031-030000.tar.gz', config })
    handlers.get('fromBucket')?.onSuccess?.()
  })

  it('uploads a file and shows a refusal from the helper', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'This backup was made by seedypod core main@fff (database schema 9); this unit\'s core has schema 7.', code: 'newer-schema' }), { status: 409 }))
    vi.stubGlobal('fetch', fetch)
    render(<Welcome />)
    fireEvent.click(screen.getByRole('button', { name: 'Restore from a backup' }))
    const file = new File([new Uint8Array([0x1F, 0x8B])], 'seedypod-backup-kitchen-20261031-030000.tar.gz', { type: 'application/gzip' })
    fireEvent.change(screen.getByLabelText('Backup file'), { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: 'Restore this file' }))
    await waitFor(() => expect(screen.getByText(/^This backup was made by seedypod core main@fff/)).toBeTruthy())
    expect(fetch).toHaveBeenCalledWith('/api/backup/restore', expect.objectContaining({ method: 'POST', body: file }))
  })

  it('moves on to the progress view when the helper accepts the upload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 202 })))
    render(<Welcome />)
    fireEvent.click(screen.getByRole('button', { name: 'Restore from a backup' }))
    fireEvent.change(screen.getByLabelText('Backup file'), { target: { files: [new File(['x'], 'b.tar.gz')] } })
    fireEvent.click(screen.getByRole('button', { name: 'Restore this file' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Starting/))
  })

  it('says so when restore is not installed', () => {
    data.set('restoreInfo', { available: false, status: null, undo: null })
    render(<Welcome />)
    fireEvent.click(screen.getByRole('button', { name: 'Restore from a backup' }))
    expect(screen.getByText(/Restore isn't installed on this core/)).toBeTruthy()
  })
})
