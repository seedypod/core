import { Check, ScanLine } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import { useState } from 'react'
import { Button, InlineError } from '@/src/components/ds/core'
import { TextField } from '@/src/components/ds/forms'
import { fmtStamp } from '@/src/lib/timeAgo'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'

type View = inferRouterOutputs<AppRouter>['vision']['podCodes']['pods'][number]

/** Each mark as a glyph, and as words for screen readers. */
const MARK: Record<string, { glyph: string, word: string }> = {
  'o': { glyph: '○', word: 'open' },
  '|': { glyph: '⦶', word: 'bar' },
  '/': { glyph: '⊘', word: 'slanted bar' },
  'h': { glyph: '◐', word: 'half' },
}

/** A code as the dots look: the four marks, then the solid dot. */
export function CodeGlyphs({ code }: { code: string }) {
  const marks = [...code].map(c => MARK[c] ?? { glyph: '?', word: 'unknown' })
  return (
    <span className="font-mono tracking-[0.15em]" aria-label={`${marks.map(m => m.word).join(', ')}, solid`} title={code}>
      {marks.map(m => m.glyph).join('')}
      ●
    </span>
  )
}

/** One pod's code: what it reads as, the plant it would be, and confirm or correct. */
function CodeRow({ pod, suggestions, onSave, saving }: { pod: View, suggestions: string[], onSave: (plant: string) => void, saving: boolean }) {
  const [fixing, setFixing] = useState(false)
  const [plant, setPlant] = useState(pod.confirmed ?? pod.recorded ?? '')
  const guess = pod.confirmed ?? pod.recorded
  return (
    <li className="flex flex-col gap-2 border-t border-line py-2.5 first:border-t-0" data-testid={`pod-code-${pod.slot}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px]">
        <span className="font-mono text-[11px] text-fg-3">{`Pod ${pod.slot}`}</span>
        <span className="text-fg-2">reads as</span>
        <CodeGlyphs code={pod.code} />
        <span className="text-fg-3">·</span>
        {pod.confirmed
          ? (
              <span className="flex items-center gap-1">
                {pod.confirmed}
                <Check size={13} className="text-ok" aria-label="confirmed" />
              </span>
            )
          : <span>{guess ? `${guess}?` : 'which plant?'}</span>}
        <span className="ml-auto flex gap-1.5">
          {!pod.confirmed && guess && <Button size="sm" variant="primary" disabled={saving} onClick={() => onSave(guess)}>Confirm</Button>}
          <Button size="sm" disabled={saving} onClick={() => setFixing(f => !f)}>{pod.confirmed || guess ? 'Correct' : 'Say which'}</Button>
        </span>
      </div>
      {fixing && (
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!plant.trim()) return
            onSave(plant.trim())
            setFixing(false)
          }}
        >
          <TextField label={`Pod ${pod.slot}'s plant`} mono={false} value={plant} onChange={setPlant} list={`pod-code-plants-${pod.slot}`} className="flex-1" />
          <datalist id={`pod-code-plants-${pod.slot}`}>
            {suggestions.map(s => <option key={s} value={s} />)}
          </datalist>
          <Button type="submit" size="sm" variant="primary" disabled={saving || !plant.trim()}>Save</Button>
        </form>
      )}
    </li>
  )
}

/**
 * yCube dot codes (#224), in Label pods: only pods a code was read under,
 * each with the plant its code is (once the owner has said) or the pod
 * record's plant as a guess. Confirm or correct saves the code → plant pair;
 * it never changes a pod's record or a plan. Read codes takes a full-size
 * still on each camera, which is slow on a Pi Zero.
 */
export function PodCodes() {
  const utils = trpc.useUtils()
  const codes = trpc.vision.podCodes.useQuery()
  const refresh = () => void utils.vision.podCodes.invalidate()
  const read = trpc.vision.readPodCodes.useMutation({ onSuccess: refresh })
  const confirm = trpc.vision.confirmPodCode.useMutation({ onSuccess: refresh })
  const data = codes.data
  if (!data || (!data.available && data.pods.length === 0)) return null
  const suggestions = [...new Set([...data.pods.flatMap(p => (p.recorded ? [p.recorded] : [])), ...data.pairs.map(p => p.plant)])].sort()
  const newest = data.pods.reduce<string | null>((a, p) => (a && a > p.ts ? a : p.ts), null)
  const failed = read.data?.filter(r => r.error)
  return (
    <section className="flex flex-col gap-2 rounded-[10px] border border-line p-3" aria-label="Pod codes">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto flex min-w-0 flex-col gap-[3px]">
          <span className="flex items-center gap-1.5 text-[13px] font-medium">
            <ScanLine size={14} className="text-fg-3" />
            Pod codes
          </span>
          <span className="text-xs text-fg-3">
            {newest ? `The dots under each yCube, read ${fmtStamp(newest)}. Confirm or correct what each code is; that teaches the unit, and changes no pod or plan.` : 'The dots under each yCube say what it is. Read them from full-size stills, then confirm what each code is.'}
          </span>
        </span>
        {data.available && <Button size="sm" icon={ScanLine} disabled={read.isPending} onClick={() => read.mutate()}>{read.isPending ? 'Reading…' : 'Read codes'}</Button>}
      </div>
      {data.pods.length > 0
        ? (
            <ul className="m-0 list-none p-0">
              {data.pods.map(p => <CodeRow key={`${p.slot}:${p.code}`} pod={p} suggestions={suggestions} saving={confirm.isPending} onSave={plant => confirm.mutate({ code: p.code, plant })} />)}
            </ul>
          )
        : newest === null && read.isSuccess && <span className="text-xs text-fg-3">No code could be read. Small or steeply angled pods, and a dark tower, read as nothing.</span>}
      {failed && failed.length > 0 && <span className="text-xs text-fg-3">{failed.map(f => `${f.camera === 'upper' ? 'Upper' : 'Lower'}: ${f.error}`).join(' · ')}</span>}
      {(read.error ?? confirm.error) && <InlineError>{(read.error ?? confirm.error)?.message}</InlineError>}
    </section>
  )
}
