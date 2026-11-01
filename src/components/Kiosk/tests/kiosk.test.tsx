// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KioskPage } from '../KioskPage'

const { q } = vi.hoisted(() => ({
  q: {
    latest: { data: undefined as Record<string, { value: number, unit: string, ts: string }> | undefined },
    light: { data: undefined as { on: boolean, level: number } | undefined },
    pump: { data: undefined as { on: boolean, remainingS?: number, fault?: string | null } | undefined },
    alerts: { data: undefined as Array<{ id: number, kind: string, detail: string }> | undefined },
    system: { data: undefined as { system: { caps: { sensors: string[] } } } | undefined },
  },
}))

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    sensors: { latest: { useQuery: () => q.latest } },
    light: { get: { useQuery: () => q.light } },
    pump: { get: { useQuery: () => q.pump } },
    alerts: { list: { useQuery: () => q.alerts } },
    system: { info: { useQuery: () => q.system } },
    telemetry: { history: { useQuery: () => ({ data: [{ ts: '2026-10-31T10:00:00Z', value: 40 }, { ts: '2026-10-31T11:00:00Z', value: 42 }] }) } },
  },
}))

const fresh = () => new Date().toISOString()
const tile = (label: string) => screen.getByText(label).closest('div[class*="rounded"]') as HTMLElement

beforeEach(() => {
  q.latest.data = {
    water_level_pct: { value: 42, unit: '%', ts: fresh() },
    air_temp: { value: 22.5, unit: '°C', ts: new Date(Date.now() - 10 * 60_000).toISOString() },
    humidity: { value: 55, unit: '%', ts: fresh() },
    ph: { value: 6.1, unit: 'pH', ts: fresh() },
  }
  q.light.data = { on: true, level: 80 }
  q.pump.data = { on: true, remainingS: 12 }
  q.alerts.data = [{ id: 1, kind: 'water_low', detail: 'tank at 12%' }]
  q.system.data = { system: { caps: { sensors: ['air_temp', 'ph'] } } }
})
afterEach(cleanup)

describe('KioskPage', () => {
  it('shows big numbers with sparklines, water quality from caps, and active alerts', () => {
    render(<KioskPage />)
    expect(screen.getByText('42%')).toBeTruthy()
    expect(screen.getByText('22.5°')).toBeTruthy()
    expect(screen.getByText('80%')).toBeTruthy()
    expect(screen.getByText('12s')).toBeTruthy()
    expect(screen.getByText('6.1')).toBeTruthy()
    expect(document.querySelectorAll('svg path').length).toBeGreaterThanOrEqual(3)
    expect(screen.getByText(/water low/)).toBeTruthy()
  })

  it('dims a tile whose reading is stale', () => {
    render(<KioskPage />)
    expect(tile('Air').dataset.stale).toBe('true')
    expect(tile('Tank').dataset.stale).toBeUndefined()
  })

  it('falls back to dashes, off, FAULT and no alert box', () => {
    q.latest.data = undefined
    q.light.data = { on: false, level: 0 }
    q.pump.data = { on: false, fault: 'overcurrent' }
    q.alerts.data = []
    q.system.data = undefined
    render(<KioskPage />)
    expect(screen.getAllByText('—')).toHaveLength(3)
    expect(screen.getByText('off')).toBeTruthy()
    expect(screen.getByText('FAULT')).toBeTruthy()
    expect(screen.queryByText(/—\s/)).toBeNull()
  })

  it('says idle when the pump is off without a fault', () => {
    q.pump.data = { on: false, fault: null }
    render(<KioskPage />)
    expect(screen.getByText('idle')).toBeTruthy()
  })
})
