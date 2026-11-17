import type { DryGuard, Limits, PumpRun } from '@/src/hardware/contract'
import { pumpFault } from '@/src/lib/pumpFault'

/** A cutoff to suggest from a wet current: 85 % of it, to the stepper's 0.05 A, held to the bounds. */
export function suggestCutoff(wetA: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number((Math.round(wetA * 0.85 / 0.05) * 0.05).toFixed(2))))
}

/** Amps to two places, trailing zeros dropped: 0.8 → "0.8 A", 0.85 → "0.85 A". */
export function fmtAmps(a: number): string {
  return `${Number(a.toFixed(2))} A`
}

/**
 * "Brown-out guard: stops below 10.8 V for 0.3 s (set on the unit)", or what it
 * watches instead; `null` from a hald too old to have it.
 */
export function brownoutLine(limits: Pick<Limits, 'pumpBrownoutV' | 'pumpBrownoutMs' | 'pumpBrownoutPi'>): string | null {
  const { pumpBrownoutV: v, pumpBrownoutMs: ms, pumpBrownoutPi: pi } = limits
  if (ms === undefined) return null
  const watch = v !== undefined
    ? `stops below ${v} V for ${fmtSeconds(ms)}${pi ? ' or on the Pi\'s under-voltage flag' : ''}`
    : pi ? `stops on the Pi's under-voltage flag for ${fmtSeconds(ms)}` : 'off'
  return `Brown-out guard: ${watch} (set on the unit)`
}

/** Milliseconds as seconds: 1200 → "1.2 s", 5000 → "5 s". */
export function fmtSeconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))} s`
}

/** The sensor's distance (cm) at a tank %, from the calibration: the inverse of `cutoffPct`. */
export function pctToCm(pct: number, fullCm: number, emptyCm: number): number {
  return Number((emptyCm - (pct / 100) * (emptyCm - fullCm)).toFixed(1))
}

/** A distance (cm) as a tank %, unrounded; null without a calibration. */
export function cmToPct(cm: number, fullCm: number | undefined, emptyCm: number | undefined): number | null {
  if (fullCm === undefined || emptyCm === undefined || emptyCm <= fullCm) return null
  return Math.max(0, Math.min(100, ((emptyCm - cm) / (emptyCm - fullCm)) * 100))
}

/**
 * How far one ultrasonic read strays from the next (cm): half the 90th
 * percentile of the jumps between consecutive reads, so the tank's slow fall
 * while the pump runs doesn't count, nor one splash. Null with too few reads.
 */
export function jitterCm(distances: number[]): number | null {
  const d = distances.filter(Number.isFinite)
  if (d.length < 6) return null
  const jumps = d.slice(1).map((v, i) => Math.abs(v - (d[i] ?? v))).sort((a, b) => a - b)
  const p90 = jumps[Math.min(jumps.length - 1, Math.round(0.9 * (jumps.length - 1)))] ?? 0
  return Number((p90 / 2).toFixed(2))
}

/** What the current guard measured when it tripped: `pump drew 0.29 A, below …` → 0.29. */
export function drewA(fault: string | null | undefined): number | null {
  const m = fault?.match(/pump drew ([\d.]+) A/)
  return m ? Number(m[1]) : null
}

/** Which guards stop the pump in a mode. */
export function guards(mode: DryGuard): { current: boolean, level: boolean } {
  return { current: mode !== 'level', level: mode !== 'current' }
}

/** The idle chip: "current + level", "current", "level". */
export function guardChip(mode: DryGuard): string {
  return mode === 'both' ? 'current + level' : mode
}

/**
 * A pump stopped by a guard, in words: which one fired and what the other
 * signal read, which is the case for running both. Null for any other fault.
 */
export function tripWords(fault: string, run: PumpRun | null | undefined, limits: Limits | undefined, at: (iso: string) => string): string | null {
  const { reason, detail } = pumpFault(fault)
  if (reason !== 'dry-run') return null
  const ranS = run ? Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000) : null
  const when = run ? `${at(run.endedAt)} · ` : ''
  const after = ranS !== null ? ` after ${ranS} s` : ''
  const a = drewA(fault)
  if (a !== null) {
    const cutoff = limits?.pumpDryCurrentA
    const tank = run?.levelPct ?? null
    const level = limits?.waterLowCm != null && run?.levelCm != null && run.levelCm < limits.waterLowCm
      ? `. The tank read ${tank}%, so the level guard alone would have missed it.`
      : tank !== null ? `. The tank read ${tank}%.` : '.'
    return `${when}current fell to ${fmtAmps(a)}${cutoff ? ` (cutoff ${Number(cutoff.toFixed(2))})` : ''}${after}${level}`
  }
  const wet = run?.wetA
  return `${when}${detail ?? 'the tank level ran low'}${after}.${wet ? ` The pump was still drawing ${fmtAmps(wet)}.` : ''}`
}
