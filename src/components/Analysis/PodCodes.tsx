import { Check, Download, ExternalLink, ScanLine, Share2 } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import { useState } from 'react'
import { Button, InlineError } from '@/src/components/ds/core'
import { TextField } from '@/src/components/ds/forms'
import { fmtStamp } from '@/src/lib/timeAgo'
import type { AppRouter } from '@/src/server/routers/app'
import { apiBase, trpc } from '@/src/utils/trpc'

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

/** The read codes still waiting on the grower: every one not confirmed yet. */
export const codesWaiting = (pods: Array<Pick<View, 'confirmed'>>) => pods.filter(p => !p.confirmed).length

/** One pod's code as a compact row: the pod, its dots, the plant it would be, ✓ to confirm, and fix to correct. */
function CodeRow({ pod, suggestions, onSave, saving }: { pod: View, suggestions: string[], onSave: (plant: string) => void, saving: boolean }) {
  const [fixing, setFixing] = useState(false)
  const [plant, setPlant] = useState(pod.guess ?? '')
  const guess = pod.guess
  return (
    <li className="flex flex-col gap-2 border-t border-line py-1.5 first:border-t-0" data-testid={`pod-code-${pod.slot}`}>
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span className="w-6 shrink-0 font-mono text-[11px] text-fg-3">
          <span className="sr-only">Pod </span>
          {pod.slot}
        </span>
        <CodeGlyphs code={pod.code} />
        <span className="min-w-0 flex-1 truncate">
          {pod.confirmed
            ? (
                <span className="flex items-center gap-1">
                  <span className="truncate">{pod.confirmed}</span>
                  <Check size={13} className="shrink-0 text-ok" aria-label="confirmed" />
                </span>
              )
            : pod.from === 'shared'
              ? <span title="Other units confirmed this code; confirm it is right here too">{`${guess} · known code`}</span>
              : guess ? `${guess}?` : 'which plant?'}
        </span>
        {!pod.confirmed && guess && <Button size="sm" icon={Check} className="px-2 py-1" aria-label={`Confirm pod ${pod.slot} as ${guess}`} disabled={saving} onClick={() => onSave(guess)} />}
        <button
          type="button"
          aria-label={`${pod.confirmed || guess ? 'Correct' : 'Say which plant is in'} pod ${pod.slot}`}
          aria-expanded={fixing}
          disabled={saving}
          className="shrink-0 cursor-pointer border-0 bg-transparent p-1 text-[11px] text-fg-2 underline hover:text-fg disabled:cursor-default disabled:opacity-45"
          onClick={() => setFixing(f => !f)}
        >
          {pod.confirmed || guess ? 'fix' : 'say which'}
        </button>
      </div>
      {pod.disagrees && <span className="text-xs text-pod-attention">{`Other units say this code is ${pod.shared}. Yours is kept.`}</span>}
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
 * Share pod codes (#259): a link to the pod-codes issue form, filled in with
 * the confirmed pairs. The owner's browser opens it and the owner submits it
 * on GitHub; the unit sends nothing. Each confirmed pod's crop is offered as
 * a download to drag into the form, since a form can't be pre-filled with files.
 */
function SharePodCodes() {
  const share = trpc.vision.podCodeShare.useQuery()
  const d = share.data
  if (!d) return null
  return (
    <div className="flex flex-col gap-1.5 border-t border-line pt-2.5 text-xs" data-testid="share-pod-codes">
      {d.url
        ? (
            <>
              <span className="text-fg-2">{`Opens a GitHub issue in your browser with your ${d.pairs.length} confirmed code${d.pairs.length === 1 ? '' : 's'}, this app's version and a one-way hash of the unit's id. Sign in and submit it there; nothing is sent from the unit.`}</span>
              <span>
                <a href={d.url} target="_blank" rel="noopener noreferrer" className="inline-flex">
                  <Button size="sm" variant="primary" icon={ExternalLink} tabIndex={-1}>Open the form</Button>
                </a>
              </span>
            </>
          )
        : <span className="text-fg-3">None of your confirmed codes is a plant in the catalog, so there is nothing to share.</span>}
      {d.skipped.length > 0 && <span className="text-fg-3">{`Left out, not in the plant catalog: ${d.skipped.map(p => p.plant).join(', ')}.`}</span>}
      {d.url && d.crops.length > 0 && (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-fg-3">Crops to drag into the form:</span>
          {d.crops.map(c => (
            <a key={c.slot} href={`${apiBase()}/api/vision/pod-codes/crops/pod-${c.slot}.jpg`} download={`pod-${c.slot}.jpg`} className="inline-flex">
              <Button size="sm" icon={Download} tabIndex={-1}>{`Pod ${c.slot} · ${c.plant}`}</Button>
            </a>
          ))}
        </span>
      )}
    </div>
  )
}

/**
 * yCube dot codes (#224), a card in Teach: only pods a code was read under,
 * one compact row each, with the plant its code is (once the owner has said),
 * else the shared table's plant as a known code (#259), else the pod record's
 * plant as a guess. ✓ or fix saves the owner's own code → plant pair;
 * it never changes a pod's record or a plan. Read codes takes a full-size
 * still on each camera, which is slow on a Pi Zero.
 */
export function PodCodes() {
  const utils = trpc.useUtils()
  const codes = trpc.vision.podCodes.useQuery()
  const refresh = () => void utils.vision.podCodes.invalidate()
  const read = trpc.vision.readPodCodes.useMutation({ onSuccess: refresh })
  const confirm = trpc.vision.confirmPodCode.useMutation({ onSuccess: refresh })
  const [sharing, setSharing] = useState(false)
  const data = codes.data
  if (!data || (!data.available && data.pods.length === 0)) return null
  const suggestions = [...new Set([...data.pods.flatMap(p => [p.recorded, p.shared].filter(x => x !== null)), ...data.pairs.map(p => p.plant)])].sort()
  const newest = data.pods.reduce<string | null>((a, p) => (a && a > p.ts ? a : p.ts), null)
  const failed = read.data?.filter(r => r.error)
  const waiting = codesWaiting(data.pods)
  return (
    <section className="flex flex-col gap-2 rounded-[12px] border border-line p-3.5" aria-label="Pod codes">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="mr-auto flex items-center gap-1.5 text-sm font-medium">
          <ScanLine size={14} className="self-center text-fg-3" />
          Pod codes
        </span>
        <span className="font-mono text-[11px] text-fg-3">{[waiting > 0 && `${waiting} to confirm`, newest && `read ${fmtStamp(newest)}`].filter(Boolean).join(' · ')}</span>
      </div>
      <span className="text-xs text-fg-3">
        {newest ? 'Confirm or fix what each code is: that teaches the unit, and changes no pod or plan.' : 'The dots under each yCube say what it is. Read them from full-size stills, then confirm what each code is.'}
      </span>
      {(data.available || data.pairs.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {data.available && <Button size="sm" icon={ScanLine} disabled={read.isPending} onClick={() => read.mutate()}>{read.isPending ? 'Reading…' : 'Read codes'}</Button>}
          {data.pairs.length > 0 && <Button size="sm" icon={Share2} aria-expanded={sharing} onClick={() => setSharing(v => !v)}>Share pod codes</Button>}
        </div>
      )}
      {sharing && data.pairs.length > 0 && <SharePodCodes />}
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
