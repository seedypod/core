import { Camera } from 'lucide-react'
import { useState } from 'react'
import { Button, Card, CardHeader, InlineError } from '@/src/components/ds/core'
import { Slider } from '@/src/components/ds/forms'
import { PageHeader } from '@/src/components/ds/layout'
import { apiBase, trpc } from '@/src/utils/trpc'

function CameraCard({ camera }: { camera: 'upper' | 'lower' }) {
  const utils = trpc.useUtils()
  const list = trpc.camera.list.useQuery({ camera, limit: 200 })
  const capture = trpc.camera.capture.useMutation({ onSuccess: () => utils.camera.invalidate() })
  const frames = [...(list.data ?? [])].reverse() // oldest → newest for the scrubber
  const [idx, setIdx] = useState<number | null>(null)
  const i = idx ?? Math.max(0, frames.length - 1)
  const frame = frames[i]
  const src = frame ? (frame.path.startsWith('data:') ? frame.path : `${apiBase()}${frame.url}`) : null
  return (
    <Card>
      <CardHeader
        title={`${camera[0]?.toUpperCase()}${camera.slice(1)} camera`}
        subtitle={frame ? new Date(frame.ts).toLocaleString() : 'no frames yet'}
        icon={Camera}
        right={<Button size="sm" onClick={() => capture.mutate({ camera })} disabled={capture.isPending}>{capture.isPending ? 'Capturing…' : 'Capture now'}</Button>}
      />
      <div className="mt-3 aspect-[12/5] w-full overflow-hidden rounded-[var(--radius-ctl)] bg-code">
        {src ? <img src={src} alt={`${camera} camera at ${frame?.ts}`} className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-[12px] text-fg-3">No image</div>}
      </div>
      {frames.length > 1 && (
        <div className="mt-3">
          <Slider value={i} min={0} max={frames.length - 1} onChange={setIdx} label="Timelapse position" />
          <div className="mt-1 flex justify-between font-mono text-[11px] text-fg-3">
            <span>{new Date(frames[0]?.ts ?? 0).toLocaleDateString()}</span>
            <span>
              {frames.length}
              {' '}
              frames
            </span>
            <span>{new Date(frames[frames.length - 1]?.ts ?? 0).toLocaleDateString()}</span>
          </div>
        </div>
      )}
      {capture.error && <InlineError className="mt-2">{capture.error.message}</InlineError>}
    </Card>
  )
}

export function CamerasPage() {
  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-4">
      <PageHeader title="Cameras" />
      <CameraCard camera="upper" />
      <CameraCard camera="lower" />
    </div>
  )
}
