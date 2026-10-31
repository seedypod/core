import { Sun } from 'lucide-react'
import { useState } from 'react'
import { Button, Card, CardHeader, GrowBackdrop, SectionLabel, StatusDot } from '@/src/components/ds/core'
import { Slider, Toggle } from '@/src/components/ds/forms'
import { PageHeader } from '@/src/components/ds/layout'
import { fmtClock, LineChart } from '@/src/components/charts/LineChart'
import { CurveEditor } from '@/src/components/Schedule/CurveEditor'
import { trpc } from '@/src/utils/trpc'

export function LightPage() {
  const light = trpc.light.get.useQuery()
  const schedules = trpc.schedules.list.useQuery()
  const utils = trpc.useUtils()
  const setLight = trpc.light.set.useMutation({ onSuccess: () => utils.light.invalidate() })
  const owner = trpc.light.owner.useQuery(undefined, { refetchInterval: 15_000 })
  const resume = trpc.light.resume.useMutation({ onSuccess: () => utils.light.invalidate() })
  const o = owner.data
  const upsert = trpc.schedules.upsert.useMutation({ onSuccess: () => utils.schedules.invalidate() })
  const lightHours = trpc.telemetry.lightHours.useQuery()
  const [draft, setDraft] = useState<number | null>(null)
  const l = light.data
  const level = draft ?? l?.level ?? 0
  const curves = (schedules.data ?? []).filter(s => s.kind === 'light')
  const minutesNow = new Date().getHours() * 60 + new Date().getMinutes()

  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-4">
      <PageHeader title="Grow light" />
      <Card backdrop={<GrowBackdrop brightness={l?.on ? l.level : null} minutes={minutesNow} off={!l?.on} />}>
        <CardHeader title={l?.on ? `${l.level}%` : 'Off'} subtitle={l ? `since ${new Date(l.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '…'} icon={Sun} right={<Toggle on={!!l?.on} size="md" label="Light power" onChange={on => setLight.mutate({ on })} />} />
        <div className="mt-4">
          <Slider
            value={level}
            onChange={setDraft}
            onCommit={(v) => {
              setDraft(null)
              setLight.mutate({ level: v })
            }}
            label="Brightness"
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-fg-3">
          <span>
            {o?.source === 'manual'
              ? `Your change holds until ${new Date(o.manualUntil ?? '').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, then the schedule or Autopilot takes over.`
              : o?.source === 'autopilot'
                ? 'Autopilot is setting the light. A change here holds for 30 minutes.'
                : 'Following the schedule. A change here holds for 30 minutes.'}
          </span>
          {o?.source === 'manual' && <Button size="sm" variant="ghost" disabled={resume.isPending} onClick={() => resume.mutate()}>Resume</Button>}
        </div>
        {lightHours.data && <p className="mt-1 text-[12px] text-fg-3">{`LED hours: ${lightHours.data.hours.toLocaleString()} (${lightHours.data.pctUsed}% of rated life).`}</p>}
      </Card>

      <SectionLabel right={<Button size="sm" onClick={() => upsert.mutate({ id: `curve-${Date.now().toString(36)}`, kind: 'light', name: 'New curve', enabled: false, days: 127, spec: { setpoints: [{ minute: 420, level: 0 }, { minute: 480, level: 80 }, { minute: 1200, level: 80 }, { minute: 1260, level: 0 }] } })}>Add curve</Button>}>Light curves</SectionLabel>
      {curves.length === 0 && <Card dashed><p className="text-[13px] text-fg-2">No curves yet. A curve is a set of setpoints by time of day; brightness ramps between them, so sunrise and sunset are free.</p></Card>}
      {curves.map(s => (
        <Card key={s.id} highlight={s.enabled}>
          <CardHeader title={s.name} subtitle={`${s.spec && 'setpoints' in s.spec ? s.spec.setpoints.length : 0} setpoints`} right={<StatusDot tone={s.enabled ? 'ok' : 'muted'} label={s.enabled ? 'active' : 'off'} />} />
          {'setpoints' in s.spec && (
            <>
              <LineChart className="mt-3" height={120} yMin={0} yMax={100} formatX={fmtClock} formatY={y => `${Math.round(y)}%`} fill series={[{ name: s.name, points: Array.from({ length: 97 }, (_, i) => i * 15).map(m => ({ x: m, y: levelAt(s.spec as { setpoints: { minute: number, level: number }[] }, m) })) }]} />
              <CurveEditor schedule={{ id: s.id, kind: 'light', name: s.name, enabled: s.enabled, days: s.days, spec: s.spec }} onSave={next => upsert.mutate(next)} />
            </>
          )}
        </Card>
      ))}
    </div>
  )
}

/** Client-side copy of the scheduler's interpolation for instant previews. */
export function levelAt(spec: { setpoints: { minute: number, level: number }[] }, minute: number): number {
  const pts = [...spec.setpoints].sort((a, b) => a.minute - b.minute)
  const first = pts[0]
  const last = pts[pts.length - 1]
  if (!first || !last) return 0
  if (pts.length === 1) return first.level
  const m = minute % 1440
  if (m < first.minute || m >= last.minute) {
    const span = first.minute + 1440 - last.minute
    const into = m >= last.minute ? m - last.minute : m + 1440 - last.minute
    return Math.round(last.level + (first.level - last.level) * (span === 0 ? 0 : into / span))
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    if (a && b && m >= a.minute && m < b.minute) return Math.round(a.level + (b.level - a.level) * ((m - a.minute) / (b.minute - a.minute)))
  }
  return last.level
}
