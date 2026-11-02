import { Link } from '@tanstack/react-router'
import { Aperture, CameraOff, Info, Maximize2, ScanEye } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/src/components/ds/core'
import { Modal } from '@/src/components/ds/feedback'
import { fmtStamp, timeAgo } from '@/src/lib/timeAgo'
import type { AppRouter } from '@/src/server/routers/app'
import { apiBase, trpc } from '@/src/utils/trpc'

type Cam = 'upper' | 'lower'
type Frame = inferRouterOutputs<AppRouter>['camera']['list'][number]
type Alert = inferRouterOutputs<AppRouter>['alerts']['list'][number]

const CAMS: Record<Cam, { name: string, pods: string }> = {
  upper: { name: 'Upper', pods: 'pods 1–15' },
  lower: { name: 'Lower', pods: 'pods 16–30' },
}
const DAY = 86_400_000
/** The strip groups frames into at most this many bars; the scrubber still reaches every frame. */
const MAX_BARS = 48

const srcOf = (f: Frame) => (f.path.startsWith('data:') ? f.path : `${apiBase()}${f.url}`)
const shortDate = (iso: string) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' })
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export interface CameraFailure { ts: string, message: string }

/**
 * Whether a camera's most recent capture failed, from the `camera_missing`
 * alert (the server's record, which names the camera) or this session's
 * failed capture. A frame newer than the failure means it has recovered.
 */
export function cameraFailure(camera: Cam, latest: Frame | undefined, alerts: Alert[], local: CameraFailure | null): CameraFailure | null {
  const alert = alerts.find(a => a.active && a.kind === 'camera_missing' && a.detail.startsWith(`${camera} `))
  const known = [alert && { ts: alert.raisedAt, message: alert.detail }, local].filter((f): f is CameraFailure => !!f)
  const newest = known.sort((a, b) => b.ts.localeCompare(a.ts))[0]
  // Prefer the alert's wording when both exist: it carries the byte count.
  const failure = alert && newest ? { ts: newest.ts, message: alert.detail } : newest
  if (!failure) return null
  return latest && latest.ts > failure.ts ? null : failure
}

/** What the failure means for the user: the byte count when the camera sent a stub, else the server's message. */
export function failureHint(message: string): string {
  const bytes = /returned (\d+) bytes/.exec(message)?.[1]
  return `${bytes ? `Last capture returned ${bytes} bytes.` : `Last capture failed: ${message}.`} Check the ribbon cable, then capture again.`
}

/** Split `n` frames into at most `max` runs of consecutive indices: [start, end] inclusive. */
export function buckets(n: number, max = MAX_BARS): Array<[number, number]> {
  const count = Math.min(n, max)
  return Array.from({ length: count }, (_, b) => [Math.floor((b * n) / count), Math.floor(((b + 1) * n) / count) - 1])
}

function useCamera(camera: Cam) {
  const utils = trpc.useUtils()
  const list = trpc.camera.list.useQuery({ camera, limit: 200 })
  const capture = trpc.camera.capture.useMutation({
    onSettled: () => {
      void utils.camera.invalidate()
      void utils.alerts.invalidate()
    },
  })
  const frames = [...(list.data ?? [])].reverse() // oldest → newest for the scrubber
  const local = capture.isError ? { ts: new Date(capture.submittedAt).toISOString(), message: capture.error.message } : null
  return { camera, frames, capture, local }
}

/** Both timelapse cameras: the latest frame or why there isn't one, a scrubbable strip of past frames, and capture on demand. */
export function CamerasPage() {
  const upper = useCamera('upper')
  const lower = useCamera('lower')
  const settings = trpc.settings.get.useQuery()
  const alerts = trpc.alerts.list.useQuery({ activeOnly: true })
  const [now] = useState(() => Date.now())
  const interval = settings.data?.captureIntervalMin ?? 0
  const recent = [...upper.frames, ...lower.frames].filter(f => now - Date.parse(f.ts) <= 2 * DAY).length
  const busy = upper.capture.isPending || lower.capture.isPending
  const captureBoth = () => {
    upper.capture.mutateAsync({ camera: 'upper' }).catch(() => undefined).finally(() => lower.capture.mutate({ camera: 'lower' }))
  }

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-[240px] flex-1 flex-col gap-1">
          <h1 className="text-2xl font-semibold">Cameras</h1>
          <p className="text-[13px] text-fg-2">
            {`${interval > 0 ? `Timelapse every ${interval} min` : 'Timelapse off'} · ${recent} frame${recent === 1 ? '' : 's'} in the last 2 days`}
          </p>
        </div>
        <Button variant="primary" icon={Aperture} disabled={busy} onClick={captureBoth}>{busy ? 'Capturing…' : 'Capture both'}</Button>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(380px,100%),1fr))] gap-5">
        {[upper, lower].map(c => (
          <CameraCard
            key={c.camera}
            camera={c.camera}
            frames={c.frames}
            failure={cameraFailure(c.camera, c.frames.at(-1), alerts.data ?? [], c.local)}
            now={now}
            pending={c.capture.isPending}
            onCapture={() => c.capture.mutate({ camera: c.camera })}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[13px] text-fg-2">
        <Info size={16} className="shrink-0" />
        <span className="min-w-[200px] flex-1">Frames feed leaf-cover analysis for each pod.</span>
        <Link to="/analysis" className="text-link hover:text-fg">Open Analysis →</Link>
        <Link to="/settings" hash="cameras" className="text-link hover:text-fg">Capture settings →</Link>
      </div>
    </div>
  )
}

function CameraCard({ camera, frames, failure, now, pending, onCapture }: {
  camera: Cam
  frames: Frame[]
  failure: CameraFailure | null
  now: number
  pending: boolean
  onCapture: () => void
}) {
  const [idx, setIdx] = useState<number | null>(null)
  const [zoom, setZoom] = useState(false)
  const i = idx ?? Math.max(0, frames.length - 1)
  const frame = frames[i]
  const latest = frames.at(-1)
  // A failure replaces the latest frame; scrubbing back still shows the old ones.
  const showFailure = !!failure && idx === null
  const bars = buckets(frames.length)
  const cam = CAMS[camera]

  return (
    <div className={cn('flex min-w-0 flex-col overflow-hidden rounded-[14px] border bg-surface', failure ? 'border-pod-attention/45' : 'border-line')} data-testid={`camera-${camera}`}>
      <div className="relative flex aspect-[4/3] items-center justify-center bg-code">
        {showFailure
          ? (
              <div className="flex flex-col items-center gap-2.5 p-6 text-center text-[13px] text-fg-2">
                <CameraOff size={16} className="text-pod-attention" />
                <div className="font-medium text-fg">{latest ? `No frame since ${clock(latest.ts)}` : 'No frames yet'}</div>
                <p className="max-w-[280px] leading-normal">{failureHint(failure.message)}</p>
              </div>
            )
          : frame
            ? <img src={srcOf(frame)} alt={`${camera} camera at ${frame.ts}`} className="size-full object-cover" />
            : <span className="font-mono text-xs text-pod-empty">No frames yet</span>}
        <span className="absolute left-3 top-3 flex items-center gap-1.5 rounded-md bg-app/80 px-2 py-1 text-[11px] text-fg">
          <span className={cn('size-1.5 rounded-full', failure ? 'bg-pod-attention' : 'bg-pod-ok')} />
          {`${cam.name} · ${cam.pods}`}
        </span>
        {frame && !showFailure && (
          <span className="absolute bottom-3 right-3 flex gap-1.5">
            <Link to="/analysis" aria-label="Open in Analysis" className="flex rounded-md bg-app/80 p-[5px] text-fg hover:bg-app"><ScanEye size={16} /></Link>
            <button type="button" aria-label="Enlarge" onClick={() => setZoom(true)} className="flex cursor-pointer rounded-md border-0 bg-app/80 p-[5px] text-fg hover:bg-app"><Maximize2 size={16} /></button>
          </span>
        )}
      </div>

      <div className="flex flex-col gap-3 px-[18px] py-4">
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-medium">{`${cam.name} camera`}</span>
            {showFailure
              ? <span className="font-mono text-[11px] text-pod-attention">{`capture failed · ${timeAgo(failure.ts, now)}`}</span>
              : <span className="font-mono text-[11px] text-fg-3">{frame ? `${fmtStamp(frame.ts)} · ${timeAgo(frame.ts, now)}` : 'no frames yet'}</span>}
          </div>
          <Button className="px-3 py-1.5" disabled={pending} onClick={onCapture}>{pending ? 'Capturing…' : failure ? 'Retry' : 'Capture now'}</Button>
        </div>

        {(frames.length > 0 || failure) && (
          <div className="flex flex-col gap-1.5">
            <div className="relative flex h-5 items-end gap-[3px]">
              {bars.map(([a, b]) => {
                const on = !showFailure && i >= a && i <= b
                return <span key={a} className={cn('h-3 flex-1 rounded-[2px]', on ? 'h-5 bg-meter' : 'bg-line-2')} />
              })}
              {/* The server keeps only good frames, so the one failure it knows of is the latest attempt. */}
              {failure && <span data-testid="failed-capture" className="h-5 flex-1 rounded-[2px] bg-pod-attention" />}
              {frames.length > 1 && (
                <input
                  type="range"
                  aria-label={`${cam.name} timelapse position`}
                  min={0}
                  max={frames.length - 1}
                  value={i}
                  onChange={e => setIdx(Number(e.target.value))}
                  className="absolute inset-0 size-full cursor-pointer opacity-0"
                  style={failure ? { width: `${(bars.length / (bars.length + 1)) * 100}%` } : undefined}
                />
              )}
            </div>
            <div className="flex justify-between font-mono text-[10px] text-fg-3">
              <span>{frames[0] ? shortDate(frames[0].ts) : ''}</span>
              <span>{failure ? 'latest capture failed' : idx !== null && frame ? fmtStamp(frame.ts) : frames.length > 1 ? 'drag to scrub' : ''}</span>
              <span>now</span>
            </div>
          </div>
        )}
      </div>

      {zoom && frame && (
        <Modal open onClose={() => setZoom(false)} title={`${cam.name} camera · ${fmtStamp(frame.ts)}`} width={960}>
          <img src={srcOf(frame)} alt={`${camera} camera at ${frame.ts}`} className="w-full rounded-ctl" />
        </Modal>
      )}
    </div>
  )
}
