// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Dashboard } from '../Dashboard'

const { data } = vi.hoisted(() => ({ data: new Map<string, unknown>() }))

vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: unknown }) => <a>{children as string}</a> }))

// Every procedure answers useQuery with data keyed by its path, and useMutation with a no-op.
vi.mock('@/src/utils/trpc', () => {
  const proc = (path: string) => ({
    useQuery: () => ({ data: data.get(path), refetch: vi.fn() }),
    useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  })
  const router = (prefix: string): unknown => new Proxy({}, { get: (_, k: string) => (k === 'useQuery' || k === 'useMutation' ? proc(prefix)[k] : router(prefix ? `${prefix}.${k}` : k)) })
  return { apiBase: () => '', trpc: new Proxy({}, { get: (_, k: string) => (k === 'useUtils' ? () => ({ settings: { invalidate: vi.fn() } }) : router(k)) }) }
})

afterEach(() => {
  cleanup()
  data.clear()
})

describe('Dashboard', () => {
  it('opens on Welcome until the unit is set up', () => {
    data.set('settings.get', { setupComplete: false })
    render(<Dashboard />)
    expect(screen.getByText('Welcome to seedypod')).toBeTruthy()
    expect(screen.queryByText('Grow light')).toBeNull()
  })

  it('shows the cards Home, with active alerts such as backup_stale, where there is no WebGL (jsdom)', async () => {
    data.set('settings.get', { setupComplete: true })
    data.set('alerts.list', [{ id: 1, kind: 'backup_stale', active: true, detail: 'No off-card backup yet.' }])
    render(<Dashboard />)
    expect(await screen.findByText('Grow light')).toBeTruthy()
    expect(screen.getByText('backup_stale: No off-card backup yet.')).toBeTruthy()
  })
})
