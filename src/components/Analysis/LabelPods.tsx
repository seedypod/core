import { ChevronLeft, ChevronRight, Tag } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { GhostIcon, InlineError } from '@/src/components/ds/core'
import { Pill, SegmentedControl } from '@/src/components/ds/forms'
import { fmtStamp } from '@/src/lib/timeAgo'
import { POD_LABELS, type PodLabelValue } from '@/src/store/types'
import { apiBase, trpc } from '@/src/utils/trpc'
import type { PodRegions } from '@/src/vision/regions'

type Camera = 'upper' | 'lower'

/** Each label's colour, from the pod and growth-stage tokens. */
export const LABEL_COLOR: Record<PodLabelValue, string> = {
  empty: 'var(--pod-empty)',
  sprouted: 'var(--growth-sprout)',
  growing: 'var(--pod-ok)',
  ready: 'var(--pod-ready)',
  unhealthy: 'var(--pod-attention)',
}
const name = (l: PodLabelValue) => l[0]?.toUpperCase() + l.slice(1)
const CAMERAS = [{ value: 'upper', label: 'Upper' }, { value: 'lower', label: 'Lower' }] as const
/** How far back the tagger can step, per camera. */
export const HISTORY = 48
const at = (n: number) => `${n * 100}%`

function Dot({ label }: { label: PodLabelValue }) {
  return <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: LABEL_COLOR[label] }} />
}

/**
 * Tag what each pod shows in a capture (#184), the ground truth a pod
 * classifier is trained on (ADR-0019). Pick a label, then tap pods: one tap
 * sets it, tapping a pod that already has it clears it, and a pod can be
 * retagged at any time. Labels go into the dataset export with each pod's crop.
 */
export function LabelPods({ boxes }: { boxes: (camera: Camera) => PodRegions }) {
  const utils = trpc.useUtils()
  const [camera, setCamera] = useState<Camera>('upper')
  const [index, setIndex] = useState(0)
  const [brush, setBrush] = useState<PodLabelValue>('growing')
  // Taps show at once; the server's answer replaces them when it comes back.
  const [local, setLocal] = useState<Record<string, PodLabelValue | null>>({})
  const [ratio, setRatio] = useState(4 / 3)
  const frames = trpc.camera.list.useQuery({ camera, limit: HISTORY })
  const list = frames.data ?? []
  const frame = list[Math.min(index, Math.max(0, list.length - 1))]
  const saved = trpc.vision.labels.useQuery({ captureId: frame?.id ?? '' }, { enabled: !!frame })
  const stats = trpc.vision.labelStats.useQuery()
  const set = trpc.vision.setLabel.useMutation({
    onSuccess: () => {
      void utils.vision.invalidate()
    },
    onError: (_e, v) => setLocal(m => Object.fromEntries(Object.entries(m).filter(([k]) => k !== `${v.captureId}#${v.slot}`))),
  })

  const labelOf = (slot: number): PodLabelValue | null => {
    const k = `${frame?.id}#${slot}`
    if (k in local) return local[k] ?? null
    return saved.data?.find(l => l.slot === slot)?.label ?? null
  }
  const tap = (slot: number) => {
    if (!frame) return
    const next = labelOf(slot) === brush ? null : brush
    setLocal(m => ({ ...m, [`${frame.id}#${slot}`]: next }))
    set.mutate({ captureId: frame.id, slot, label: next })
  }
  const go = (i: number) => {
    setIndex(i)
    setLocal({})
  }
  const regions = boxes(camera)
  const slots = Object.keys(regions).map(Number)
  const done = slots.filter(s => labelOf(s) !== null).length
  const counts = stats.data?.counts
  const total = stats.data?.pods ?? 0

  return (
    <div className="flex min-w-0 flex-col gap-4 rounded-[14px] border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="mr-auto flex min-w-0 flex-col gap-[3px]">
          <span className="flex items-center gap-1.5 text-[15px] font-medium">
            <Tag size={15} className="text-fg-3" />
            Label pods
          </span>
          <span className="text-xs text-fg-3">Tag what each pod shows. Labels go in the dataset export, to train a pod model.</span>
        </div>
        <SegmentedControl
          ariaLabel="Label camera"
          size="sm"
          options={CAMERAS}
          value={camera}
          onChange={(c) => {
            setCamera(c)
            go(0)
          }}
        />
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1.5 font-mono text-[11px] text-fg-3" aria-label="Label counts">
        {POD_LABELS.map(l => (
          <span key={l} className="flex items-center gap-1.5" data-testid={`count-${l}`}>
            <Dot label={l} />
            {`${name(l)} ${counts?.[l] ?? 0}`}
          </span>
        ))}
        <span className="ml-auto">{`${total} pod${total === 1 ? '' : 's'} labelled`}</span>
      </div>

      <div role="group" aria-label="Label to apply" className="flex flex-wrap gap-1.5">
        {POD_LABELS.map(l => (
          <Pill key={l} selected={brush === l} className="flex items-center gap-1.5 px-2.5 py-1 text-xs" onClick={() => setBrush(l)}>
            <Dot label={l} />
            {name(l)}
          </Pill>
        ))}
      </div>

      <figure className="m-0 flex min-w-0 flex-col gap-1.5">
        <div className="relative overflow-hidden rounded-[10px] bg-code" style={{ aspectRatio: ratio }}>
          {frame
            ? (
                <>
                  <img
                    src={frame.path.startsWith('data:') ? frame.path : `${apiBase()}${frame.url}`}
                    alt={`${camera} camera at ${frame.ts}`}
                    className="absolute inset-0 size-full"
                    onLoad={(e) => {
                      const { naturalWidth: w, naturalHeight: h } = e.currentTarget
                      if (w > 0 && h > 0) setRatio(w / h)
                    }}
                  />
                  <div className="absolute inset-0" data-testid="label-pods">
                    {slots.map((s) => {
                      const r = regions[s]
                      if (!r) return null
                      const l = labelOf(s)
                      return (
                        <button
                          key={s}
                          type="button"
                          data-slot={s}
                          aria-pressed={l !== null}
                          aria-label={`Pod ${s}: ${l ?? 'not labelled'}`}
                          className={cn('absolute cursor-pointer rounded-[3px] border-[1.5px] p-0 outline-none focus-visible:border-fg', l ? 'border-solid' : 'border-dashed border-fg-2/70 bg-transparent hover:bg-fg/10')}
                          style={{ left: at(r.x), top: at(r.y), width: at(r.w), height: at(r.h), ...(l ? { borderColor: LABEL_COLOR[l], background: `color-mix(in oklab, ${LABEL_COLOR[l]} 18%, transparent)` } : null) }}
                          onClick={() => tap(s)}
                        >
                          <span
                            className={cn('absolute left-0 top-0 whitespace-nowrap rounded-br-[4px] px-1 font-mono text-[10px] leading-[14px]', l ? 'text-inverse' : 'bg-code/80 text-fg-2')}
                            style={l ? { background: LABEL_COLOR[l] } : undefined}
                          >
                            {s}
                            {/* The fill says which label on a phone, where the word won't fit the box. */}
                            {l && <span className="hidden sm:inline">{` · ${l}`}</span>}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </>
              )
            : <div className="flex size-full items-center justify-center p-4 text-center text-[13px] text-fg-3">No photos from this camera yet.</div>}
        </div>
        <figcaption className="flex items-center gap-2 text-xs text-fg-3">
          <GhostIcon icon={ChevronLeft} label="Older photo" disabled={!frame || index >= list.length - 1} onClick={() => go(index + 1)} />
          <span className="min-w-0 flex-1 text-center">
            {frame
              ? (
                  <>
                    <span className="font-mono text-[11px]">{fmtStamp(frame.ts)}</span>
                    <span>{` · ${done} of ${slots.length} pods labelled`}</span>
                  </>
                )
              : '—'}
          </span>
          <GhostIcon icon={ChevronRight} label="Newer photo" disabled={index === 0} onClick={() => go(index - 1)} />
        </figcaption>
      </figure>
      {set.error && <InlineError>{set.error.message}</InlineError>}
    </div>
  )
}
