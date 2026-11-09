import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type DebugModule, HapDebug, hapDebugModule, MAX_DEBUG_MINUTES } from '../debug'

afterEach(() => {
  vi.useRealTimers()
})

/** A namespace logger from hap-nodejs's copy of `debug`, as its modules create them. */
function hapLogger(name: string) {
  const req = createRequire(createRequire(import.meta.url).resolve('hap-nodejs'))
  return (req('debug') as (ns: string) => (...a: unknown[]) => void)(name)
}

describe('HapDebug', () => {
  it('resolves the debug instance hap-nodejs itself loads', () => {
    const req = createRequire(createRequire(import.meta.url).resolve('hap-nodejs'))
    expect(hapDebugModule()).toBe(req('debug'))
  })

  it('logs what hap-nodejs logs while open, then shuts by itself and restores debug', () => {
    vi.useFakeTimers()
    const lines: string[] = []
    const mod = hapDebugModule()
    const before = mod.log
    const d = new HapDebug({ log: m => lines.push(m), now: () => Date.parse('2026-11-09T10:00:00Z') })
    const hapLog = hapLogger('HAP-NodeJS:Accessory')
    const other = hapLogger('elsewhere')
    hapLog('before %s', 'opening')
    expect(d.set(5)).toEqual({ until: '2026-11-09T10:05:00.000Z' })
    hapLog('[%s] Snapshot request for aid %d', 'Gardyn', 5)
    other('not ours')
    expect(lines[0]).toBe('homekit: HAP debug log on for 5 min')
    expect(lines.slice(1)).toEqual([expect.stringMatching(/^homekit debug: .*HAP-NodeJS:Accessory \[Gardyn\] Snapshot request for aid 5/)])
    vi.advanceTimersByTime(5 * 60_000)
    expect(lines.at(-1)).toBe('homekit: HAP debug log off (window ended)')
    expect(d.status()).toEqual({ until: null })
    hapLog('after')
    expect(lines).toHaveLength(3)
    expect(mod.log).toBe(before)
  })

  it('clamps to an hour, extends an open window, and shuts on 0', () => {
    vi.useFakeTimers()
    let t = 0
    const mod: DebugModule = { enable: vi.fn(), disable: vi.fn(() => 'other:*'), log: vi.fn() }
    const lines: string[] = []
    const d = new HapDebug({ log: m => lines.push(m), load: () => mod, now: () => t })
    expect(d.set(600).until).toBe(new Date(MAX_DEBUG_MINUTES * 60_000).toISOString())
    t = 1000
    expect(d.set(0.2).until).toBe(new Date(1000 + 60_000).toISOString())
    expect(mod.enable).toHaveBeenCalledTimes(1)
    expect(d.set(0)).toEqual({ until: null })
    // What was enabled before comes back.
    expect(mod.enable).toHaveBeenLastCalledWith('other:*')
    expect(lines).toEqual(['homekit: HAP debug log on for 60 min', 'homekit: HAP debug log on for 1 min', 'homekit: HAP debug log off (turned off)'])
    d.off('again')
    expect(lines).toHaveLength(3)
  })

  it('leaves nothing enabled when nothing was before', () => {
    const mod: DebugModule = { enable: vi.fn(), disable: vi.fn(() => ''), log: vi.fn() }
    const d = new HapDebug({ log: () => undefined, load: () => mod })
    d.set(1)
    d.off('test')
    expect(mod.enable).toHaveBeenCalledTimes(1)
  })
})
