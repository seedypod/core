// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StarterRules, type Starter } from '../StarterRules'

const { data } = vi.hoisted(() => ({ data: new Map<string, unknown>() }))

vi.mock('@/src/utils/trpc', () => ({
  trpc: { care: { starterRules: { useQuery: () => ({ data: data.get('starters') }) } } },
}))

const cite = { note: 'knowledge/nutrients/gardyn-feeding-guidance.md', section: 'pH and EC', url: 'https://github.com/seedypod/core/blob/dev/knowledge/nutrients/gardyn-feeding-guidance.md#ph-and-ec' }
const rule = (name: string, value: number) => ({ name, priority: 50, cooldownMin: 240, trigger: { kind: 'tick' as const, everyMin: 15 }, conditions: { kind: 'and' as const, conditions: [{ kind: 'compare' as const, op: '<' as const, left: { kind: 'signal' as const, signal: 'sensor.water_level_pct' }, right: { kind: 'literal' as const, value } }] }, actions: [{ kind: 'notify' as const, message: name }] })
const starter = (id: Starter['id'], extra: Partial<Starter> = {}): Starter => ({ id, title: `${id} title`, description: `${id} description`, sensors: [], unavailable: null, added: false, citations: [cite], rule: rule(`${id} rule`, 50), ...extra })

afterEach(() => {
  cleanup()
  data.clear()
})

describe('StarterRules', () => {
  it('opens a starter in the builder, prefilled, with its notes linked', () => {
    const onOpen = vi.fn()
    data.set('starters', [starter('tank_half'), starter('ph_range', { unavailable: 'no pH probe' }), starter('ec_low', { added: true })])
    render(<StarterRules onOpen={onOpen} />)
    const tank = within(screen.getByTestId('starter-tank_half'))
    expect(tank.getByRole('link', { name: 'pH and EC' }).getAttribute('href')).toBe(cite.url)
    fireEvent.click(tank.getByRole('button'))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ name: 'tank_half rule', rows: [expect.objectContaining({ signal: 'sensor.water_level_pct', op: '<', value: 50 })] }))
    const ph = within(screen.getByTestId('starter-ph_range'))
    expect(ph.getByText('no pH probe')).toBeTruthy()
    expect((ph.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
    expect(within(screen.getByTestId('starter-ec_low')).getByText('added')).toBeTruthy()
  })

  it('goes away once every starter the unit can run is added, and before they load', () => {
    data.set('starters', [starter('tank_half', { added: true }), starter('ph_range', { unavailable: 'no pH probe' })])
    render(<StarterRules onOpen={vi.fn()} />)
    expect(screen.queryByText('Starter rules')).toBeNull()
    cleanup()
    data.delete('starters')
    render(<StarterRules onOpen={vi.fn()} />)
    expect(screen.queryByText('Starter rules')).toBeNull()
  })
})
