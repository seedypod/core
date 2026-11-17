import { describe, expect, it } from 'vitest'
import { brownoutLine, cmToPct, drewA, fmtAmps, fmtSeconds, guardChip, guards, jitterCm, pctToCm, suggestCutoff, tripWords } from '../dryGuard'
import { cutoffPct } from '../pumpCycles'

describe('dry-run guard helpers', () => {
  it('suggests 85 % of the wet current, to 0.05 A, inside the bounds', () => {
    expect(suggestCutoff(0.93, 0.3, 3)).toBe(0.8)
    expect(suggestCutoff(0.53, 0.3, 3)).toBe(0.45)
    expect(suggestCutoff(0.2, 0.3, 3)).toBe(0.3)
    expect(suggestCutoff(9, 0.3, 3)).toBe(3)
    expect([fmtAmps(0.8), fmtAmps(0.85), fmtAmps(1), fmtSeconds(3000), fmtSeconds(1250)]).toEqual(['0.8 A', '0.85 A', '1 A', '3 s', '1.3 s'])
  })

  it('turns a tank % into the sensor\'s distance and back, matching the cutoff % the page shows', () => {
    expect(pctToCm(27, 5, 20)).toBe(15.9)
    expect(cutoffPct(pctToCm(27, 5, 20), 5, 20)).toBe(27)
    expect(cmToPct(16, 5, 20)).toBeCloseTo(26.67, 2)
    expect(cmToPct(16, undefined, 20)).toBeNull()
    expect(cmToPct(16, 20, 5)).toBeNull()
  })

  it('measures jitter from read-to-read jumps, so a draining tank and one splash don\'t count', () => {
    // A steady fall of 0.1 cm a read with ±0.4 of noise on top.
    const reads = Array.from({ length: 40 }, (_, i) => 10 + i * 0.1 + (i % 2 ? 0.4 : -0.4))
    expect(jitterCm(reads)).toBeCloseTo(0.45, 2)
    expect(jitterCm(Array.from({ length: 40 }, (_, i) => 10 + i * 0.1))).toBeCloseTo(0.05, 2)
    expect(jitterCm([1, 2, 3])).toBeNull()
  })

  it('reads the current a trip measured, and names the guards in a mode', () => {
    expect(drewA('dry-run: pump drew 0.29 A, below 0.45 A for 0.3 s: it\'s pulling air')).toBe(0.29)
    expect(drewA('dry-run')).toBeNull()
    expect(guards('both')).toEqual({ current: true, level: true })
    expect(guards('current')).toEqual({ current: true, level: false })
    expect([guardChip('both'), guardChip('level'), guardChip('current')]).toEqual(['current + level', 'level', 'current'])
    expect(brownoutLine({ pumpBrownoutV: 10.8, pumpBrownoutMs: 300, pumpBrownoutPi: false })).toBe('Brown-out guard: stops below 10.8 V for 0.3 s (set on the unit)')
    expect(brownoutLine({})).toBeNull()
    expect(brownoutLine({ pumpBrownoutV: 10.8, pumpBrownoutMs: 300, pumpBrownoutPi: true })).toBe('Brown-out guard: stops below 10.8 V for 0.3 s or on the Pi\'s under-voltage flag (set on the unit)')
    expect(brownoutLine({ pumpBrownoutMs: 300, pumpBrownoutPi: true })).toBe('Brown-out guard: stops on the Pi\'s under-voltage flag for 0.3 s (set on the unit)')
    expect(brownoutLine({ pumpBrownoutMs: 300 })).toBe('Brown-out guard: off (set on the unit)')
  })

  it('says which guard fired and what the other signal read', () => {
    const run = { startedAt: '2026-11-16T20:00:00Z', endedAt: '2026-11-16T20:00:42Z', everyMs: 100, samples: [], wetA: 0.53, endedBy: 'fault' as const, fault: null, levelPct: 31, levelCm: 15.4 }
    const at = () => '20:00'
    const limits = { pumpMaxRunS: 900, pumpMaxDuty: 100, waterLowCm: 16, pumpDryCurrentA: 0.45 }
    expect(tripWords('dry-run: pump drew 0.29 A, below 0.45 A for 0.3 s: it\'s pulling air', run, limits, at))
      .toBe('20:00 · current fell to 0.29 A (cutoff 0.45) after 42 s. The tank read 31%, so the level guard alone would have missed it.')
    // The tank was past the level cutoff too: no claim the level guard would have missed it.
    expect(tripWords('dry-run: pump drew 0.29 A', { ...run, levelCm: 17 }, limits, at)).toMatch(/after 42 s\. The tank read 31%\.$/)
    expect(tripWords('dry-run: tank level read 16.2 cm, past 16 cm for 10 s', run, limits, at)).toBe('20:00 · Tank level read 16.2 cm, past 16 cm for 10 s after 42 s. The pump was still drawing 0.53 A.')
    // Without the run or the cutoff, it says only what it knows.
    expect(tripWords('dry-run: pump drew 0.29 A', null, undefined, at)).toBe('current fell to 0.29 A.')
    expect(tripWords('dry-run: pump drew 0.29 A', { ...run, levelPct: null, levelCm: null }, { ...limits, pumpDryCurrentA: null }, at)).toBe('20:00 · current fell to 0.29 A after 42 s.')
    expect(tripWords('dry-run', { ...run, wetA: null }, limits, at)).toMatch(/^20:00 · .* after 42 s\.$/)
    expect(tripWords('over-temp', run, limits, at)).toBeNull()
    expect(tripWords('brown-out: supply fell to 10.2 V for 0.3 s', run, limits, at)).toBeNull()
  })
})
