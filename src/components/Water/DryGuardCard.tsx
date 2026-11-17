import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button, Card, InlineError } from '@/src/components/ds/core'
import { Stepper } from '@/src/components/ds/forms'
import { fmtClock } from '@/src/components/charts/format'
import type { DryGuard, Limits, PumpRun } from '@/src/hardware/contract'
import { withUnit } from '@/src/lib/sensorMeta'
import { trpc } from '@/src/utils/trpc'
import { brownoutLine, cmToPct, drewA, fmtAmps, fmtSeconds, guards, jitterCm, pctToCm, suggestCutoff } from './dryGuard'

const EYEBROW = 'font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-fg-3'
const CAPTION = 'text-[12px] text-fg-3'

const CHOICES: { value: DryGuard, title: string, line: string }[] = [
  { value: 'level', title: 'Tank level', line: 'Ultrasonic distance. Ripples, foam and splash can misread it.' },
  { value: 'current', title: 'Pump current', line: 'A pump sucking air draws less. Senses the actual dry run.' },
  { value: 'both', title: 'Both', line: 'Whichever trips first stops the pump.' },
]

interface Draft { guard?: DryGuard, currentA?: number, graceMs?: number, waterLowCm?: number, waterLowHoldMs?: number }

/**
 * The dry-run guard, in a card of its own below the tank: set once, checked
 * rarely. Each guard is drawn on the signal it watches, the current cutoff as a
 * line on the last run's trace with the grace shaded; the level cutoff is the
 * ring on the tank above, so here it's a number with the sensor's jitter. Only
 * the chosen guards' controls show; one that's off shrinks to what it still does. Nothing
 * here turns the guard off, and Cancel and Save show only after a change.
 */
export function DryGuardCard({ limits, run, pumpA, pumpOn, levelPct, distanceCm, distances, fullCm, emptyCm }: {
  limits: Limits | undefined
  run: PumpRun | null
  pumpA?: number
  pumpOn?: boolean
  levelPct?: number
  distanceCm?: number
  /** Recent distance reads (cm), for the sensor's jitter. */
  distances: number[]
  fullCm?: number
  emptyCm?: number
}) {
  const utils = trpc.useUtils()
  const set = trpc.pump.setGuard.useMutation({ onSuccess: () => utils.system.invalidate() })
  const [draft, setDraft] = useState<Draft>({})
  if (!limits?.pumpDryGuard) return null
  const choosable = limits.pumpDryGuardApp !== undefined
  const asked = limits.pumpDryGuardAsked ?? limits.pumpDryGuard
  const mode = draft.guard ?? asked
  const on = guards(mode)
  const changes: Draft = {
    guard: draft.guard !== undefined && draft.guard !== asked ? draft.guard : undefined,
    currentA: draft.currentA !== undefined && draft.currentA !== limits.pumpDryCurrentA ? draft.currentA : undefined,
    graceMs: draft.graceMs !== undefined && draft.graceMs !== limits.pumpDryGraceMs ? draft.graceMs : undefined,
    waterLowCm: draft.waterLowCm !== undefined && draft.waterLowCm !== limits.waterLowCm ? draft.waterLowCm : undefined,
    waterLowHoldMs: draft.waterLowHoldMs !== undefined && draft.waterLowHoldMs !== limits.waterLowHoldMs ? draft.waterLowHoldMs : undefined,
  }
  const dirty = Object.values(changes).some(v => v !== undefined)
  // What the unit says it falls back to, while nothing unsaved could change it.
  const fallback = !dirty && limits.pumpDryGuardWhy && limits.pumpDryGuard !== asked ? limits.pumpDryGuardWhy : null
  const cutoff = draft.currentA ?? limits.pumpDryCurrentA ?? null
  // Current without a cutoff runs on the tank level: say so before it's saved.
  const needsCutoff = on.current && choosable && cutoff === null
  const edit = (d: Draft) => setDraft(x => ({ ...x, ...d }))
  const brownout = brownoutLine(limits)

  const current = (
    <CurrentPanel
      limits={limits}
      run={run}
      cutoff={cutoff}
      graceMs={draft.graceMs ?? limits.pumpDryGraceMs}
      pumpA={pumpOn ? pumpA : undefined}
      enforced={on.current}
      editable={choosable}
      onEdit={edit}
    />
  )
  const level = (
    <LevelPanel
      limits={limits}
      waterLowCm={draft.waterLowCm ?? limits.waterLowCm ?? null}
      holdMs={draft.waterLowHoldMs ?? limits.waterLowHoldMs}
      levelPct={levelPct}
      distanceCm={distanceCm}
      jitter={jitterCm(distances)}
      fullCm={fullCm}
      emptyCm={emptyCm}
      enforced={on.level}
      onEdit={edit}
    />
  )

  return (
    <Card id="dry-guard" data-testid="dry-guard-card" className="@container scroll-mt-4 gap-0 overflow-hidden p-0">
      <div className="flex flex-col gap-4 px-[22px] pb-5 pt-[18px]">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-[17px] font-semibold">Dry-run guard</h2>
          <p className="text-[13px] text-fg-2">Stops the pump before it runs without water</p>
        </div>
        <div role="radiogroup" aria-label="Dry-run guard" className="grid grid-cols-1 gap-2.5 @min-[620px]:grid-cols-3">
          {CHOICES.map((c) => {
            const picked = mode === c.value
            const locked = !choosable || (limits.pumpDryGuardApp === false && c.value !== asked)
            return (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={picked}
                disabled={locked}
                onClick={() => edit({ guard: c.value })}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-card border p-3.5 text-left transition-colors disabled:cursor-default disabled:opacity-50',
                  picked ? 'border-pod-ok/70 bg-pod-ok/5' : 'border-line-2 bg-transparent hover:bg-active',
                )}
              >
                <span className={cn('mt-[3px] flex size-4 shrink-0 items-center justify-center rounded-full border', picked ? 'border-fg' : 'border-fg-3')}>
                  {picked && <span className="size-2 rounded-full bg-fg" />}
                </span>
                <span className="flex flex-col gap-1">
                  <span className="flex items-baseline gap-2 text-[14px] font-medium">
                    {c.title}
                    {c.value === 'both' && <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-pod-ok">Recommended</span>}
                  </span>
                  <span className="text-[12.5px] leading-snug text-fg-2">{c.line}</span>
                </span>
              </button>
            )
          })}
        </div>
        {!choosable && <p className={CAPTION}>{'This hald can\'t change the guard from here; update it. Until then hal.toml on the unit sets it.'}</p>}
        {limits.pumpDryGuardApp === false && <p data-testid="guard-locked" className={CAPTION}>Locked in hal.toml on the unit.</p>}
        {fallback && <p data-testid="guard-why" className="text-[12.5px] text-warn">{sentence(fallback)}</p>}
        {needsCutoff && !fallback && <p data-testid="needs-cutoff" className="text-[12.5px] text-warn">Pump current needs a cutoff. Until one is set the tank level guards alone.</p>}
      </div>

      {on.current && on.level
        ? (
            <div className="grid grid-cols-1 border-t border-line @min-[760px]:grid-cols-[1.25fr_1fr]">
              <div className="border-b border-line @min-[760px]:border-b-0 @min-[760px]:border-r">{current}</div>
              {level}
            </div>
          )
        : (
            <div className="flex flex-col border-t border-line">
              {on.current ? current : level}
              <div className="border-t border-line">{on.current ? level : current}</div>
            </div>
          )}

      <div className="flex flex-col gap-3 border-t border-line px-[22px] py-3.5 @min-[620px]:flex-row @min-[620px]:items-center @min-[620px]:justify-between">
        {brownout ? <span data-testid="brownout-guard" className="font-mono text-[12px] text-fg-3">{brownout}</span> : <span />}
        {dirty && (
          <span className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={set.isPending} onClick={() => setDraft({})}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={set.isPending} onClick={() => set.mutate(changes, { onSuccess: () => setDraft({}) })}>Save</Button>
          </span>
        )}
      </div>
      {set.error && <div className="px-[22px] pb-3.5"><InlineError>{set.error.message}</InlineError></div>}
    </Card>
  )
}

/** hald's reasons start lower-case: "tank level only: …" → "Tank level only: …". */
function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function Control({ label, children, note }: { label: string, children: ReactNode, note?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12.5px] text-fg-2">{label}</span>
      <span className="flex">{children}</span>
      {note && <span className={CAPTION}>{note}</span>}
    </div>
  )
}

/**
 * The pump-current guard on the last run's trace: the grace shaded, the cutoff
 * a line after it, the dry draw dashed under it when a trip has measured one.
 * Off, it shrinks to what the pump draws.
 */
function CurrentPanel({ limits, run, cutoff, graceMs, pumpA, enforced, editable, onEdit }: {
  limits: Limits
  run: PumpRun | null
  cutoff: number | null
  graceMs: number | undefined
  pumpA?: number
  enforced: boolean
  editable: boolean
  onEdit: (d: Draft) => void
}) {
  const wet = run?.wetA ?? null
  const now = pumpA !== undefined && pumpA > 0 ? pumpA : null
  if (!enforced) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 px-[22px] py-3.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-[14px] font-medium">{'Pump current won\'t stop the pump'}</span>
          <span className={CAPTION}>{'It\'s still read while the pump runs.'}</span>
        </div>
        <span className="font-mono text-[12px] text-fg-3">{now !== null ? `now ${fmtAmps(now)}` : wet !== null ? `last run ${fmtAmps(wet)}` : '—'}</span>
      </div>
    )
  }
  const { pumpDryCurrentMinA: min, pumpDryCurrentMaxA: max, pumpDryGraceMinMs: gMin, pumpDryGraceMaxMs: gMax } = limits
  const dry = drewA(run?.fault)
  const suggested = wet !== null && min !== undefined && max !== undefined ? suggestCutoff(wet, min, max) : null
  return (
    <div className="flex flex-col gap-4 px-[22px] py-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className={EYEBROW}>Pump current</span>
        <span className="font-mono text-[11.5px] text-fg-3">{run ? `last run · ${fmtWhenShort(run.startedAt)}` : 'no run yet'}</span>
      </div>
      {run && run.samples.length > 1
        ? <CurrentTrace run={run} cutoff={cutoff} graceMs={graceMs ?? 0} dry={dry} />
        : <p className="flex h-[150px] items-center justify-center rounded-card border border-dashed border-line-2 text-center text-[12px] text-fg-3">Run the pump once to see its current here.</p>}
      <div className="grid grid-cols-1 gap-4 @min-[420px]:grid-cols-2">
        {editable && min !== undefined && max !== undefined && (
          <Control label={`Cutoff · ${Number(min)}–${Number(max)} A`} note={cutoffNote(cutoff, wet, dry)}>
            {cutoff === null
              ? <span className="font-mono text-[13px] text-fg-3">not set</span>
              : <Stepper label="Pump current cutoff" value={cutoff} step={0.05} min={min} max={max} format={fmtAmps} onChange={a => onEdit({ currentA: Number(a.toFixed(2)) })} />}
          </Control>
        )}
        {graceMs !== undefined && gMin !== undefined && gMax !== undefined && (
          <Control label={`Grace · ${fmtSeconds(gMin).replace(' s', '')}–${fmtSeconds(gMax)}`} note="Skips the start-up spike">
            <Stepper label="Grace before the pump-current check" value={graceMs} step={100} min={gMin} max={gMax} format={fmtSeconds} onChange={ms => onEdit({ graceMs: ms })} />
          </Control>
        )}
      </div>
      {editable && suggested !== null && suggested !== cutoff && (
        <div>
          <Button size="sm" variant="secondary" onClick={() => onEdit({ currentA: suggested })} title={`85 % of the last run's ${fmtAmps(wet ?? 0)}`}>Set from last run</Button>
        </div>
      )}
    </div>
  )
}

/** "85% of wet, clear of dry", or what's wrong with it. */
function cutoffNote(cutoff: number | null, wet: number | null, dry: number | null): ReactNode {
  if (cutoff === null) return wet !== null ? 'Set it from the last run' : 'Run the pump once, then set it from that run'
  if (wet === null) return 'Between the wet and the dry draw'
  if (cutoff >= wet) return <span className="text-warn">At or above the wet draw: it would stop a healthy pump</span>
  const share = `${Math.round((cutoff / wet) * 100)}% of wet`
  if (dry === null) return share
  return cutoff > dry ? `${share}, clear of dry` : <span className="text-warn">{`${share}, at or under dry: it won't trip`}</span>
}

function fmtWhenShort(iso: string): string {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return `${today ? 'today' : d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${fmtClock(d.getHours() * 60 + d.getMinutes())}`
}

/** The first 12 s of the last run: the trace, the grace shaded and labelled, the cutoff after it, wet and dry marked. */
function CurrentTrace({ run, cutoff, graceMs, dry }: { run: PumpRun, cutoff: number | null, graceMs: number, dry: number | null }) {
  const W = 520
  const H = 190
  const left = 34
  const right = 112
  const y0 = 10
  const bottom = 24
  const spanS = 12
  const peak = Math.max(...run.samples.map(s => s[1] ?? 0), run.wetA ?? 0, cutoff ?? 0)
  const yMax = Math.max(1, Math.ceil(peak * 1.25 * 2) / 2)
  const x = (ms: number) => left + (Math.min(ms, spanS * 1000) / (spanS * 1000)) * (W - left - right)
  const y = (a: number) => y0 + (1 - a / yMax) * (H - y0 - bottom)
  const pts = run.samples.filter(s => s[1] !== null && s[0] <= spanS * 1000).map(s => `${x(s[0]).toFixed(1)},${y(s[1] ?? 0).toFixed(1)}`).join(' ')
  const gx = x(graceMs)
  const end = x(spanS * 1000)
  const wet = run.wetA
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full max-w-[560px]" role="img" aria-label={`Pump current over the last run's first ${spanS} s${wet ? `: ${fmtAmps(wet)} wet` : ''}${cutoff ? `, cutoff ${fmtAmps(cutoff)}` : ''}`} fontFamily="var(--font-mono)" fontSize="10.5">
      <rect x={left} y={y0} width={gx - left} height={H - y0 - bottom} fill="var(--color-fg-3)" opacity="0.07" />
      <line x1={gx} x2={gx} y1={y0} y2={H - bottom} stroke="var(--color-line-2)" strokeDasharray="2 3" />
      <text x={left + 6} y={y0 + 13} fill="var(--color-fg-3)">{`grace ${fmtSeconds(graceMs)}`}</text>
      <text x={left + 6} y={y0 + 26} fill="var(--color-fg-3)">not checked</text>
      {[0, yMax / 2, yMax].map(v => (
        <g key={v}>
          <line x1={left} x2={end} y1={y(v)} y2={y(v)} stroke="var(--color-line)" opacity={v === 0 ? 1 : 0.6} />
          <text x={left - 6} y={y(v) + 3.5} textAnchor="end" fill="var(--color-fg-3)">{v === 0 ? '0' : `${Number(v.toFixed(1))}`.replace(/^0\./, '.')}</text>
        </g>
      ))}
      {[0, 3, 6, 9, 12].map(s => <text key={s} x={x(s * 1000)} y={H - 8} textAnchor="middle" fill="var(--color-fg-3)">{s === 0 ? '0 s' : s === spanS ? `${s} s` : s}</text>)}
      {cutoff !== null && (
        <>
          <rect x={gx} y={y(cutoff)} width={end - gx} height={H - bottom - y(cutoff)} fill="var(--tank-reserve)" opacity="0.07" />
          <line x1={gx} x2={end} y1={y(cutoff)} y2={y(cutoff)} stroke="var(--tank-reserve)" strokeWidth="1.6" />
          <line x1={left} x2={gx} y1={y(cutoff)} y2={y(cutoff)} stroke="var(--tank-reserve)" strokeDasharray="3 4" opacity="0.5" />
          <text x={end - 4} y={H - bottom - 6} textAnchor="end" fill="var(--tank-reserve)">stops if it drops here</text>
        </>
      )}
      {dry !== null && <line x1={left} x2={end} y1={y(dry)} y2={y(dry)} stroke="var(--color-fg-3)" strokeDasharray="4 4" opacity="0.7" />}
      <polyline points={pts} fill="none" stroke="var(--accent-water)" strokeWidth="1.6" strokeLinejoin="round" />
      <g>
        {wet !== null && <text x={end + 8} y={y(wet) + 3.5} fill="var(--accent-water)">{`wet ${fmtAmps(wet)}`}</text>}
        {cutoff !== null && <text x={end + 8} y={y(cutoff) + (wet !== null && Math.abs(y(wet) - y(cutoff)) < 13 ? 14 : 3.5)} fill="var(--tank-reserve)">{`cutoff ${Number(cutoff.toFixed(2))}`}</text>}
        {dry !== null && <text x={end + 8} y={y(dry) + 3.5} fill="var(--color-fg-3)">{`dry ≈ ${Number(dry.toFixed(2))}`}</text>}
      </g>
    </svg>
  )
}

/**
 * The tank-level guard: the cutoff and how long a low read must last, with the
 * reading, the sensor's jitter and the margin above the cutoff in one line (the
 * tank above draws the ring). Off, it shrinks to its warning level.
 */
function LevelPanel({ limits, waterLowCm, holdMs, levelPct, distanceCm, jitter, fullCm, emptyCm, enforced, onEdit }: {
  limits: Limits
  waterLowCm: number | null
  holdMs: number | undefined
  levelPct?: number
  distanceCm?: number
  jitter: number | null
  fullCm?: number
  emptyCm?: number
  enforced: boolean
  onEdit: (d: Draft) => void
}) {
  const calibrated = fullCm !== undefined && emptyCm !== undefined && emptyCm > fullCm
  const cutPct = waterLowCm !== null ? cmToPct(waterLowCm, fullCm, emptyCm) : null
  const settable = calibrated && limits.waterLowMinCm !== undefined && limits.waterLowMaxCm !== undefined
  // A cm bound nearer the sensor is a higher %: the cm max is the % min.
  const minPct = settable ? Math.ceil(cmToPct(limits.waterLowMaxCm ?? 0, fullCm, emptyCm) ?? 0) : 0
  const maxPct = settable ? Math.floor(cmToPct(limits.waterLowMinCm ?? 0, fullCm, emptyCm) ?? 100) : 100
  const setPct = (pct: number) => {
    if (!calibrated) return
    const clamped = Math.max(minPct, Math.min(maxPct, Math.round(pct)))
    onEdit({ waterLowCm: pctToCm(clamped, fullCm, emptyCm) })
  }
  const cutStepper = cutPct !== null && settable
    ? <Stepper label={enforced ? 'Tank level cutoff' : 'Warn at'} value={Math.round(cutPct)} step={1} min={minPct} max={maxPct} format={v => `${v}%`} onChange={setPct} />
    : <span className="font-mono text-[13px] text-fg-3">{cutPct !== null ? `${Math.round(cutPct)}%` : '—'}</span>
  if (!enforced) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 px-[22px] py-3.5">
        <div className="flex flex-col gap-0.5">
          <span className="text-[14px] font-medium">{'Tank level won\'t stop the pump'}</span>
          <span className={CAPTION}>It still adds “Top off the tank” to Needs you.</span>
        </div>
        <span className="flex items-center gap-2.5">
          <span className="text-[12.5px] text-fg-2">Warn at</span>
          {cutStepper}
        </span>
      </div>
    )
  }
  const { waterLowHoldMinMs: hMin, waterLowHoldMaxMs: hMax } = limits
  return (
    <div className="flex flex-col gap-4 px-[22px] py-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className={EYEBROW}>Tank level</span>
        <span className="font-mono text-[11.5px] text-fg-3">ultrasonic</span>
      </div>
      <p data-testid="level-readout" className="font-mono text-[12px] leading-relaxed text-fg-3">
        <span className="text-fg">{`now ${levelPct !== undefined ? `${Math.round(levelPct)}%` : '—'}`}</span>
        {distanceCm !== undefined && ` · ${withUnit(distanceCm, 'cm')}`}
        {jitter ? ` · jitter ±${withUnit(jitter, 'cm')}` : ''}
        {cutPct !== null && waterLowCm !== null && (
          <>
            <br />
            <span className="text-[var(--tank-reserve)]">{`cutoff ${Math.round(cutPct)}% · ${withUnit(waterLowCm, 'cm')}`}</span>
            {levelPct !== undefined && ` · ${Math.max(0, Math.round(levelPct - cutPct))} points of water above it`}
          </>
        )}
      </p>
      <div className="grid grid-cols-1 gap-4 @min-[420px]:grid-cols-2">
        <Control label="Cutoff" note={settable ? 'The ring on the tank above' : calibrated ? undefined : 'Calibrate the tank in Settings to set it here'}>{cutStepper}</Control>
        {holdMs !== undefined && hMin !== undefined && hMax !== undefined && (
          <Control label="Must stay below" note="Ignores one-off bad reads">
            <Stepper label="Must stay below" value={holdMs} step={1000} min={hMin} max={hMax} format={ms => (ms === 0 ? 'off' : fmtSeconds(ms))} onChange={ms => onEdit({ waterLowHoldMs: ms })} />
          </Control>
        )}
      </div>
    </div>
  )
}
