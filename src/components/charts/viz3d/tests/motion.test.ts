import { describe, expect, it } from 'vitest'
import { clamp01, dragSpin, easeOutCubic, fitScale, initialPhase, labelHeight, LOAD_MS, MAX_TIP, nextPhase, pointEase, progressAt, pulse, releaseSpin, restingSpin, SPIN_PER_PX, spinMoving, stepSpin, TIP_PER_PX, tweenAt, TWEEN_MS, visibleSize, waveY, type Spin } from '../motion'

describe('easing and progress', () => {
  it('clamps and eases out', () => {
    expect([clamp01(-1), clamp01(0.4), clamp01(3)]).toEqual([0, 0.4, 1])
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(1)).toBe(1)
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875)
    expect(easeOutCubic(2)).toBe(1)
  })

  it('runs P from 0 to 1 over the load time, on the wall clock, and skips it with reduced motion', () => {
    expect(progressAt(null, 5000)).toBe(0)
    expect(progressAt(1000, 1000)).toBe(0)
    expect(progressAt(1000, 1000 + LOAD_MS / 2)).toBeCloseTo(0.5)
    expect(progressAt(1000, 1000 + LOAD_MS * 4)).toBe(1)
    expect(progressAt(1000, 1000, true)).toBe(1)
  })

  it('turns each point from the wave to its value left to right, every point there by P = 1', () => {
    expect(pointEase(0, 0, 100)).toBe(0)
    expect(pointEase(0, 99, 100)).toBe(0)
    // Half way, the left end is all but there and the right end has only started.
    expect(pointEase(0.5, 0, 100)).toBeGreaterThan(0.9)
    expect(pointEase(0.5, 99, 100)).toBeLessThan(0.6)
    expect(pointEase(0.5, 0, 100)).toBeGreaterThan(pointEase(0.5, 50, 100))
    for (const i of [0, 50, 99]) expect(pointEase(1, i, 100)).toBe(1)
    expect(pointEase(0.4, 0, 0)).toBeCloseTo(easeOutCubic(0.6))
  })

  it('makes a low travelling wave and a pulse that moves pod to pod', () => {
    const ys = Array.from({ length: 50 }, (_, i) => waveY(i, 50, 1.2))
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0.04 - 1e-9)
    expect(Math.max(...ys)).toBeLessThanOrEqual(0.16 + 1e-9)
    expect(waveY(10, 50, 0)).not.toBeCloseTo(waveY(10, 50, 0.5))
    expect(pulse(0, 0)).toBeCloseTo(0.5)
    expect(pulse(3, 1)).not.toBeCloseTo(pulse(4, 1))
  })

  it('tweens a refresh, finished with reduced motion or none running', () => {
    expect(tweenAt(null, 100)).toBe(1)
    expect(tweenAt(100, 100)).toBe(0)
    expect(tweenAt(100, 100 + TWEEN_MS)).toBe(1)
    expect(tweenAt(100, 100, true)).toBe(1)
  })
})

describe('fitting', () => {
  it('scales the scene down only when the need is wider than the view', () => {
    expect(fitScale(20, 10)).toBe(1)
    expect(fitScale(8, 10)).toBe(0.8)
    expect(fitScale(0, 10)).toBe(1)
    expect(fitScale(10, 0)).toBe(1)
  })

  it('measures the view at a distance', () => {
    const { width, height } = visibleSize(90, 2, 1)
    expect(height).toBeCloseTo(2)
    expect(width).toBeCloseTo(4)
  })

  it('grows a label to the minimum on a small canvas and leaves it on a big one', () => {
    // 100 px tall showing 5 units: 0.05 units a pixel, so 11 px is 0.55.
    expect(labelHeight(0.2, 11, 100, 5, 1)).toBeCloseTo(0.55)
    // A scene scaled to half needs twice the local size for the same pixels.
    expect(labelHeight(0.2, 11, 100, 5, 0.5)).toBeCloseTo(1.1)
    expect(labelHeight(0.2, 11, 1000, 5, 1)).toBe(0.2)
    expect(labelHeight(0.2, 11, 0, 5, 1)).toBe(0.2)
  })
})

describe('phases', () => {
  it('sweeps on first data, tweens on a refresh, and starts over on loading', () => {
    let p = initialPhase()
    expect(p).toEqual({ state: 'loading', readyAt: null, tweenAt: null })
    p = nextPhase(p, { kind: 'data' }, 100)
    expect(p).toEqual({ state: 'ready', readyAt: 100, tweenAt: null })
    p = nextPhase(p, { kind: 'data' }, 900)
    expect(p).toEqual({ state: 'ready', readyAt: 100, tweenAt: 900 })
    expect(nextPhase(p, { kind: 'state', state: 'ready' }, 1000)).toBe(p)
    p = nextPhase(p, { kind: 'state', state: 'loading' }, 1200)
    expect(p).toEqual({ state: 'loading', readyAt: null, tweenAt: null })
    p = nextPhase(p, { kind: 'state', state: 'ready' }, 1300)
    expect(p).toEqual({ state: 'ready', readyAt: 1300, tweenAt: null })
  })

  it('keeps when data came through empty and error', () => {
    const ready = nextPhase(initialPhase(), { kind: 'data' }, 100)
    expect(nextPhase(ready, { kind: 'state', state: 'error' }, 200)).toEqual({ state: 'error', readyAt: 100, tweenAt: null })
    expect(nextPhase(initialPhase(), { kind: 'state', state: 'empty' }, 200)).toEqual({ state: 'empty', readyAt: null, tweenAt: null })
    // Data after an error sweeps in afresh.
    expect(nextPhase({ state: 'error', readyAt: 100, tweenAt: null }, { kind: 'data' }, 300)).toEqual({ state: 'ready', readyAt: 300, tweenAt: null })
  })
})

describe('spin', () => {
  it('turns with a sideways drag, tips a little with a mouse only, and clamps the tip', () => {
    let s = restingSpin()
    s = dragSpin(s, 50, 20, true)
    expect(s.y).toBeCloseTo(50 * SPIN_PER_PX)
    expect(s.x).toBeCloseTo(20 * TIP_PER_PX)
    expect(s.dragging).toBe(true)
    s = dragSpin(s, 0, 1000, true)
    expect(s.x).toBe(MAX_TIP)
    expect(dragSpin(restingSpin(), 10, 300, false).x).toBe(0)
  })

  it('coasts on after release and slows to a stop, or stops dead with reduced motion', () => {
    let s = releaseSpin(dragSpin(restingSpin(), 40, 0, false), false)
    expect(s.dragging).toBe(false)
    const start = s.y
    s = stepSpin(s, false)
    expect(s.y).toBeGreaterThan(start)
    for (let i = 0; i < 200 && spinMoving(s); i++) s = stepSpin(s, false)
    expect(spinMoving(s)).toBe(false)
    expect(s.vy).toBe(0)
    expect(releaseSpin(dragSpin(restingSpin(), 40, 0, false), true).vy).toBe(0)
    // Held, it doesn't coast.
    const held = dragSpin(restingSpin(), 40, 0, false)
    expect(stepSpin(held, false)).toBe(held)
    expect(stepSpin(restingSpin(), false)).toEqual(restingSpin())
  })

  it('eases home to the camera\'s view, or snaps there with reduced motion', () => {
    let s: Spin = { ...dragSpin(restingSpin(), 100, 20, true), dragging: false, vy: 0, homing: true }
    s = stepSpin(s, false)
    expect(Math.abs(s.y)).toBeLessThan(1)
    for (let i = 0; i < 100 && spinMoving(s); i++) s = stepSpin(s, false)
    expect(s).toEqual(restingSpin())
    expect(stepSpin({ ...s, y: 2, homing: true }, true)).toEqual(restingSpin())
  })
})
