import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installRecordingPolicy, policyPath, RecordingPolicy } from '../policy'

let dir: string
let path: string
let now: number
let mono: number

const policy = () => new RecordingPolicy({ path, now: () => now, monotonic: () => mono })
const write = (body: unknown) => writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recording-policy-'))
  path = join(dir, 'recording-policy.json')
  now = 1_000
  mono = 0
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('reading the policy', () => {
  it('is quiet without a file, and doesn\'t create one', () => {
    expect(policy().mode()).toBe('quiet')
    expect(existsSync(path)).toBe(false)
  })

  it('reads off', () => {
    write({ loggingMode: 'off' })
    expect(policy().mode()).toBe('off')
  })

  it('ends a debug window by itself, without writing', () => {
    write({ loggingMode: 'off', debugUntil: 2_000 })
    const p = policy()
    now = 1_999
    expect(p.mode()).toBe('debug')
    now = 2_000
    expect(p.mode()).toBe('off')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ debugUntil: 2_000 })
  })

  it('counts a window further off than the API allows as none', () => {
    write({ loggingMode: 'off', debugUntil: now + 240 * 60_000 + 1 })
    expect(policy().mode()).toBe('off')
    expect(policy().get().debugUntil).toBeNull()
    write({ loggingMode: 'off', debugUntil: now + 240 * 60_000 })
    expect(policy().mode()).toBe('debug')
  })

  it.each([
    ['broken JSON', '{broken'],
    ['not an object', '[1]'],
    ['null', 'null'],
    ['an unknown mode', { loggingMode: 'loud' }],
    ['a debugUntil that isn\'t a number', { loggingMode: 'off', debugUntil: 'soon' }],
    ['a negative debugUntil', { loggingMode: 'off', debugUntil: -1 }],
  ])('keeps warnings when the file has %s', (_, body) => {
    write(body)
    expect(policy().mode()).toBe('quiet')
  })

  it('rereads after a second and no sooner', () => {
    const p = policy()
    expect(p.mode()).toBe('quiet')
    write({ loggingMode: 'off' })
    mono = 500
    expect(p.mode()).toBe('quiet')
    mono = 1_000
    expect(p.mode()).toBe('off')
  })

  it('reads the real clocks by default', () => {
    write({ debugUntil: Date.now() + 60_000 })
    expect(new RecordingPolicy({ path }).mode()).toBe('debug')
  })
})

describe('changing the policy', () => {
  it('reports the state for a reader', () => {
    expect(policy().get()).toEqual({ mode: 'quiet', loggingMode: 'quiet', debugUntil: null })
  })

  it('sets a mode and shows it at once, leaving nothing but the file', () => {
    const p = policy()
    p.mode()
    expect(p.set({ mode: 'off' })).toEqual({ mode: 'off', loggingMode: 'off', debugUntil: null })
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it('opens a window that keeps the mode to go back to', () => {
    const p = policy()
    p.set({ mode: 'off' })
    const s = p.set({ debugMinutes: 10 })
    expect(s).toEqual({ mode: 'debug', loggingMode: 'off', debugUntil: new Date(1_000 + 600_000).toISOString() })
    now += 600_000
    expect(p.get()).toEqual({ mode: 'off', loggingMode: 'off', debugUntil: null })
  })

  it('closes a window', () => {
    const p = policy()
    p.set({ debugMinutes: 10 })
    expect(p.set({ debugMinutes: 0 })).toEqual({ mode: 'quiet', loggingMode: 'quiet', debugUntil: null })
  })

  it('keeps an open window when only the mode changes', () => {
    const p = policy()
    p.set({ debugMinutes: 10 })
    expect(p.set({ mode: 'off' })).toMatchObject({ mode: 'debug', loggingMode: 'off' })
  })

  it('makes a directory that isn\'t there yet', () => {
    path = join(dir, 'new/recording-policy.json')
    expect(policy().set({ mode: 'off' }).mode).toBe('off')
  })

  it('replaces a damaged file', () => {
    write('{broken')
    expect(policy().set({ mode: 'off' }).mode).toBe('off')
  })
})

describe('policyPath', () => {
  it('sits beside the database', () => {
    expect(policyPath({}, '/opt/seedypod/data/seedypod.db')).toBe('/opt/seedypod/data/recording-policy.json')
  })

  it('follows the environment', () => {
    expect(policyPath({ SEEDYPOD_RECORDING_POLICY_FILE: '/run/p.json' }, 'x.db')).toBe('/run/p.json')
  })
})

describe('installRecordingPolicy', () => {
  const levels = ['debug', 'info', 'log', 'warn', 'error'] as const
  const installed = (mode: 'quiet' | 'off' | 'debug') => {
    const spies = { debug: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const target = { ...spies }
    installRecordingPolicy({ mode: () => mode }, target)
    for (const l of levels) target[l]('hello', l)
    return levels.filter(l => spies[l].mock.calls.length > 0)
  }

  it('keeps warnings and errors in quiet', () => expect(installed('quiet')).toEqual(['warn', 'error']))
  it('keeps only errors in off', () => expect(installed('off')).toEqual(['error']))
  it('keeps everything in debug', () => expect(installed('debug')).toEqual(levels))

  it('passes the arguments through untouched', () => {
    const warn = vi.fn()
    const target = { debug: vi.fn(), info: vi.fn(), log: vi.fn(), warn, error: vi.fn() }
    installRecordingPolicy({ mode: () => 'quiet' }, target)
    target.warn('a', 1)
    expect(warn).toHaveBeenCalledWith('a', 1)
  })

  it('patches the real console by default', () => {
    const real = { ...console }
    try {
      installRecordingPolicy({ mode: () => 'off' })
      expect(console.warn).not.toBe(real.warn)
      expect(console.error).toBe(real.error)
    }
    finally {
      Object.assign(console, real)
    }
  })
})
