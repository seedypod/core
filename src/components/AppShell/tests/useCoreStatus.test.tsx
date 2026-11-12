// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCoreStatus } from '../useCoreStatus'

const { data } = vi.hoisted(() => ({ data: new Map<string, { data?: unknown, isError?: boolean }>() }))

vi.mock('@/src/utils/trpc', () => ({
  trpc: {
    system: { info: { useQuery: () => data.get('system.info') ?? {} } },
    settings: { get: { useQuery: () => data.get('settings.get') ?? {} } },
  },
}))

afterEach(() => data.clear())

describe('useCoreStatus', () => {
  it('names the unit, with its model, core version and whether the HAL is online', () => {
    data.set('settings.get', { data: { unitName: 'Kitchen Gardyn' } })
    data.set('system.info', { data: { coreVersion: 'dev', halOnline: true, system: { model: 'gardyn 3.0' } } })
    expect(renderHook(() => useCoreStatus()).result.current).toEqual({ name: 'Kitchen Gardyn', line: 'gardyn 3.0 · core dev · online', online: true })
  })

  it('falls back while loading, without a HAL, and when core is unreachable', () => {
    expect(renderHook(() => useCoreStatus()).result.current).toEqual({ name: 'seedypod', line: '…', online: false })
    data.set('system.info', { data: { coreVersion: 'dev', halOnline: false, system: null } })
    expect(renderHook(() => useCoreStatus()).result.current.line).toBe('no HAL · core dev · offline')
    data.set('system.info', { isError: true })
    expect(renderHook(() => useCoreStatus()).result.current.line).toBe('core unreachable')
  })
})
