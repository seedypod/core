// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lastUpdate, ReadingAge, readingAge, ReadingFlag, readingFlag, ReadingsUpdated, STALE_AFTER_MS } from '../ReadingAge'

const { clock } = vi.hoisted(() => ({ clock: { data: undefined as { ts: string } | undefined, dataUpdatedAt: 0 } }))

vi.mock('@/src/utils/trpc', () => ({ trpc: { system: { healthcheck: { useQuery: () => clock } } } }))

const NOW = Date.parse('2026-11-06T12:00:00Z')
const taken = (msAgo: number, quality: 'good' | 'stale' | 'suspect' = 'good') => ({ ts: new Date(NOW - msAgo).toISOString(), quality })

describe('readingAge', () => {
  it('says plainly when there is nothing to date', () => {
    expect(readingAge([], NOW)).toEqual({ text: 'no reading', warn: false })
    expect(readingAge([undefined], NOW)).toEqual({ text: 'no reading', warn: false })
  })

  it('stays calm through a late tick and goes stale past the limit', () => {
    expect(readingAge([taken(STALE_AFTER_MS)], NOW)).toEqual({ text: 'updated 30s ago', warn: false })
    expect(readingAge([taken(STALE_AFTER_MS + 1000)], NOW)).toEqual({ text: 'stale · updated 31s ago', warn: true })
  })

  it('goes by the oldest of readings shown together, past any missing one', () => {
    expect(readingAge([taken(2_000), undefined, taken(120_000)], NOW)).toEqual({ text: 'stale · updated 2m ago', warn: true })
  })

  it('trusts the quality hald reports', () => {
    expect(readingAge([taken(1_000, 'suspect')], NOW)).toEqual({ text: 'suspect · updated 1s ago', warn: true })
    expect(readingAge([taken(1_000, 'stale')], NOW)).toEqual({ text: 'stale · updated 1s ago', warn: true })
  })

  it('reads old and suspect as stale', () => {
    expect(readingAge([taken(60_000, 'suspect')], NOW).text).toBe('stale · updated 1m ago')
  })
})

describe('readingFlag', () => {
  it('says nothing about fresh readings, or none', () => {
    expect(readingFlag([], NOW)).toBeNull()
    expect(readingFlag([undefined, taken(2_000)], NOW)).toBeNull()
  })

  it('flags the group by its oldest reading and the quality hald reports', () => {
    expect(readingFlag([taken(2_000), taken(STALE_AFTER_MS + 1000)], NOW)).toBe('stale')
    expect(readingFlag([taken(2_000, 'stale')], NOW)).toBe('stale')
    expect(readingFlag([taken(2_000), taken(1_000, 'suspect')], NOW)).toBe('suspect')
  })
})

describe('lastUpdate', () => {
  it('has nothing to date without a reading', () => {
    expect(lastUpdate([], NOW)).toBeNull()
    expect(lastUpdate([undefined], NOW)).toBeNull()
  })

  it('goes by the newest reading, amber only once that one is stale too', () => {
    expect(lastUpdate([taken(120_000), undefined, taken(4_000)], NOW)).toEqual({ text: 'updated 4s ago', warn: false })
    expect(lastUpdate([taken(4_000, 'stale')], NOW)).toEqual({ text: 'updated 4s ago', warn: false })
    expect(lastUpdate([taken(120_000), taken(STALE_AFTER_MS + 1000)], NOW)).toEqual({ text: 'updated 31s ago', warn: true })
  })
})

describe('ReadingAge', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    Object.assign(clock, { data: undefined, dataUpdatedAt: 0 })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })
  const shown = () => screen.getByTestId('reading-age')

  it('ticks by itself, without its parent rendering again', () => {
    const parent = vi.fn()
    function Parent() {
      parent()
      return <ReadingAge readings={[taken(8_000)]} />
    }
    render(<Parent />)
    expect(shown().textContent).toBe('updated 8s ago')
    act(() => void vi.advanceTimersByTime(3_000))
    expect(shown().textContent).toBe('updated 11s ago')
    expect(parent).toHaveBeenCalledTimes(1)
  })

  it('turns amber as a reading passes the limit, with no new data', () => {
    render(<ReadingAge readings={[taken(29_000)]} />)
    expect(shown().className).toContain('text-fg-3')
    act(() => void vi.advanceTimersByTime(3_000))
    expect(shown().className).toContain('text-warn')
  })

  it('measures against the unit\'s clock, so a browser hours ahead shows no false alarm', () => {
    // The unit's clock runs 3 h behind this browser; it stamped this reading 8 s ago by its own time.
    const behind = 3 * 3_600_000
    Object.assign(clock, { data: { ts: new Date(NOW - behind).toISOString() }, dataUpdatedAt: NOW })
    render(<ReadingAge readings={[taken(behind + 8_000)]} />)
    expect(shown().textContent).toBe('updated 8s ago')
  })

  it('shows a flag only once a reading passes the limit, by itself', () => {
    render(<ReadingFlag readings={[taken(29_000)]} className="text-right" />)
    expect(screen.queryByTestId('reading-flag')).toBeNull()
    act(() => void vi.advanceTimersByTime(3_000))
    const flag = screen.getByTestId('reading-flag')
    expect(flag.textContent).toBe('stale')
    expect(flag.className).toContain('text-warn')
    expect(flag.className).toContain('text-right')
  })

  it('ticks one updated line for a group, turning amber when the newest goes quiet', () => {
    render(<ReadingsUpdated readings={[taken(60_000), taken(28_000)]} />)
    const line = () => screen.getByTestId('readings-updated')
    expect(line().textContent).toBe('updated 28s ago')
    expect(line().className).toContain('text-fg-3')
    act(() => void vi.advanceTimersByTime(3_000))
    expect(line().textContent).toBe('updated 31s ago')
    expect(line().className).toContain('text-warn')
  })

  it('renders no updated line without a reading', () => {
    render(<ReadingsUpdated readings={[]} />)
    expect(screen.queryByTestId('readings-updated')).toBeNull()
  })

  it('reads a clock running ahead of the browser the same way', () => {
    const ahead = 3 * 3_600_000
    Object.assign(clock, { data: { ts: new Date(NOW + ahead).toISOString() }, dataUpdatedAt: NOW })
    render(<ReadingAge readings={[taken(-ahead + 8_000)]} />)
    expect(shown().textContent).toBe('updated 8s ago')
  })
})
